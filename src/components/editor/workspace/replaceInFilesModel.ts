/**
 * ED-FIND-004: Replace in Files preview, exclude, conflict guard, and transactional commit.
 * Prohibits blind silent Replace All; requires structured WorkspaceEdit preview with
 * per-occurrence exclusion, dirty/disk hash conflict protection, and single-step undo.
 */

import type {
  LspFileTextEdits,
  LspRange,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../lib/editor/workspaceSearch";
import type { FindInFilesScopeKind } from "./findInFilesScopeModel";
import { fsPathComparisonKey } from "./codeWorkspaceModel";
import {
  buildWorkspaceEditPreview,
  filterWorkspaceEditByUsages,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export interface ReplaceInFilesMatch {
  filePath: string;
  fileUri?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  matchedText: string;
}

export interface ReplaceInFilesScopeSnapshot {
  kind: FindInFilesScopeKind;
  workspaceRoots: readonly { id: string; path: string }[];
  plannedRoots: readonly string[];
  explicitFiles: readonly string[];
  fileMask: string | null;
  generation?: number;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
}

export interface ReplaceInFilesFilePreimage {
  path: string;
  hash: string | null;
  dirty: boolean;
  readOnly: boolean;
  size: number | null;
  availability: "ready" | "oversize" | "unreadable";
  reason?: string;
}

/** Immutable inputs captured before the preview can be committed. */
export interface ReplaceInFilesPreviewSnapshot {
  replacementText: string;
  scope: ReplaceInFilesScopeSnapshot;
  filePreimages: readonly ReplaceInFilesFilePreimage[];
}

export type ReplaceInFilesPreparationResult =
  | { ok: true; snapshot: ReplaceInFilesPreviewSnapshot }
  | { ok: false; message: string };

export function classifyReplacePreimageError(error: unknown): {
  availability: "oversize" | "unreadable";
  reason: string;
} {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    availability: /exceeds text editor limit|too large/i.test(reason) ? "oversize" : "unreadable",
    reason,
  };
}

export function replaceScopeConflict(
  scope: ReplaceInFilesScopeSnapshot,
  currentRoots: readonly { id: string; path: string }[],
  currentFacts?: { generation: number; status: string; isStale: boolean } | null,
): string | null {
  const rootIdentity = (root: { id: string; path: string }) => (
    `${root.id}:${fsPathComparisonKey(root.path)}`
  );
  const expectedRoots = scope.workspaceRoots.map(rootIdentity).sort().join("\u0000");
  const actualRoots = currentRoots.map(rootIdentity).sort().join("\u0000");
  if (expectedRoots !== actualRoots) {
    return "Workspace roots changed after the search; run the search again";
  }
  if (
    scope.generation !== undefined
    && (
      !currentFacts
      || currentFacts.status !== "ready"
      || currentFacts.isStale
      || currentFacts.generation !== scope.generation
    )
  ) {
    const liveGeneration = currentFacts?.generation ?? "unknown";
    return `Search scope became stale (G${scope.generation} -> G${liveGeneration}); run the search again`;
  }
  return null;
}

/** Convert the search backend's code-point offset to an LSP UTF-16 offset. */
export function utf16OffsetFromCodePoint(text: string, offset: number): number {
  const codePoints = Array.from(text);
  const normalized = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const bounded = Math.min(codePoints.length, Math.max(0, normalized));
  return codePoints.slice(0, bounded).join("").length;
}

/** Map one backend search match to the UTF-16 range consumed by the editor. */
export function workspaceSearchMatchRange(match: WorkspaceSearchMatch): LspRange {
  const line = Math.max(0, match.lineNumber - 1);
  return {
    start: {
      line,
      character: utf16OffsetFromCodePoint(match.lineText, match.matchStart),
    },
    end: {
      line,
      character: utf16OffsetFromCodePoint(match.lineText, match.matchEnd),
    },
  };
}

/** Absolute host path for a search match (mirrors buildReplaceEdits). */
export function replaceMatchAbsolutePath(match: WorkspaceSearchMatch): string {
  return match.path
    ? `${match.rootPath.replace(/\\/g, "/").replace(/\/+$/, "")}/${match.path.replace(/^\/+/, "")}`
    : match.rootPath;
}

/**
 * ED-FIND-004: shared search-match mapping used by the preview dialog owner
 * and the commit owner so both sides agree on file paths, ranges, and the
 * matched text the freshness recheck compares against disk.
 */
export function searchMatchesToReplaceInputs(matches: readonly WorkspaceSearchMatch[]): ReplaceInFilesMatch[] {
  return matches.map((match) => {
    const absolute = replaceMatchAbsolutePath(match);
    const range = workspaceSearchMatchRange(match);
    return {
      filePath: absolute,
      fileUri: `file://${absolute}`,
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
      matchedText: Array.from(match.lineText).slice(match.matchStart, match.matchEnd).join(""),
    };
  });
}

export interface BuildReplaceEditParams {
  matches: readonly ReplaceInFilesMatch[];
  replacementText: string;
}

/**
 * Builds an LSP WorkspaceEdit from multi-file search matches and replacement text.
 */
export function buildReplaceInFilesWorkspaceEdit(params: BuildReplaceEditParams): LspWorkspaceEdit {
  const groupedByPath = new Map<string, { uri: string; edits: LspTextEdit[] }>();

  for (const match of params.matches) {
    const uri = match.fileUri || `file://${match.filePath.replace(/\\/g, "/")}`;
    if (!groupedByPath.has(match.filePath)) {
      groupedByPath.set(match.filePath, { uri, edits: [] });
    }

    const entry = groupedByPath.get(match.filePath)!;
    entry.edits.push({
      range: {
        start: { line: match.startLine, character: match.startCharacter },
        end: { line: match.endLine, character: match.endCharacter },
      },
      newText: params.replacementText,
    });
  }

  // LspFileTextEdits is the app's normalized per-document shape (uri + resolved
  // path + optional version), not the wire-level VersionedTextDocumentIdentifier.
  // A null version accepts the current document version.
  const documentEdits: LspFileTextEdits[] = Array.from(groupedByPath.entries()).map(
    ([path, { uri, edits }]) => ({ uri, path, version: null, edits }),
  );

  return {
    documentEdits,
  };
}

export interface FileRevisionGuard {
  path: string;
  expectedHash?: string | null;
  actualHash?: string | null;
  isDirty?: boolean;
  isReadOnly?: boolean;
}

export interface ConflictCheckResult {
  canCommit: boolean;
  conflicts: Array<{ path: string; reason: string }>;
}

/**
 * Validates file revisions and dirty state before executing Replace in Files transaction.
 */
export function validateReplacePreconditions(
  guards: readonly FileRevisionGuard[],
  allowDirty: boolean = false,
): ConflictCheckResult {
  const conflicts: Array<{ path: string; reason: string }> = [];

  for (const g of guards) {
    if (g.isReadOnly) {
      conflicts.push({
        path: g.path,
        reason: "File is read-only and cannot be replaced",
      });
    }

    if (!allowDirty && g.isDirty) {
      conflicts.push({
        path: g.path,
        reason: "File has unsaved modifications in open buffer",
      });
    }

    if (g.expectedHash && g.actualHash && g.expectedHash !== g.actualHash) {
      conflicts.push({
        path: g.path,
        reason: `File modified on disk (hash mismatch: expected ${g.expectedHash.slice(0, 8)}, found ${g.actualHash.slice(0, 8)})`,
      });
    }
  }

  return {
    canCommit: conflicts.length === 0,
    conflicts,
  };
}

export interface ReplaceMatchFreshnessConflict {
  path: string;
  reason: string;
}

/**
 * ED-FIND-004 A2: pre-commit recheck that every match still sits on current
 * disk text. Catches external edits (and files deleted) between search and
 * commit without trusting the preview snapshot. Pure and unit-tested; the
 * caller supplies current disk text per affected path.
 */
export function verifyReplaceMatchFreshness(
  diskTexts: ReadonlyMap<string, string>,
  matches: readonly ReplaceInFilesMatch[],
): ReplaceMatchFreshnessConflict[] {
  const conflicts: ReplaceMatchFreshnessConflict[] = [];
  for (const match of matches) {
    const diskText = diskTexts.get(match.filePath);
    if (diskText === undefined) {
      conflicts.push({
        path: match.filePath,
        reason: "File is no longer readable on disk since search",
      });
      continue;
    }
    const lines = diskText.split(/\r\n|\r|\n/);
    const line = lines[match.startLine];
    if (
      line === undefined ||
      match.startLine !== match.endLine ||
      line.slice(match.startCharacter, match.endCharacter) !== match.matchedText
    ) {
      conflicts.push({
        path: match.filePath,
        reason: `Match "${match.matchedText}" changed since search (line ${match.startLine + 1})`,
      });
    }
  }
  return conflicts;
}

function replaceEditSignature(edit: LspWorkspaceEdit): string {
  return JSON.stringify(edit.documentEdits.map((document) => ({
    path: fsPathComparisonKey(document.path ?? document.uri),
    edits: document.edits.map((textEdit) => ({
      start: textEdit.range.start,
      end: textEdit.range.end,
      newText: textEdit.newText,
    })),
  })).sort((left, right) => left.path.localeCompare(right.path)));
}

/** Ensure the edit passed to the writer is exactly the selected match set. */
export function replaceEditMatchesSelection(
  edit: LspWorkspaceEdit,
  matches: readonly ReplaceInFilesMatch[],
  replacementText: string,
): boolean {
  const expected = buildReplaceInFilesWorkspaceEdit({ matches, replacementText });
  return replaceEditSignature(edit) === replaceEditSignature(expected);
}

export interface ReplaceInFilesPlan {
  transactionId: string;
  originalEdit: LspWorkspaceEdit;
  filteredEdit: LspWorkspaceEdit;
  preview: WorkspaceEditPreview;
  excludedUsageIds: ReadonlySet<string>;
  totalMatches: number;
  includedMatches: number;
}

/**
 * Creates or updates a Replace in Files plan with usage exclusion.
 */
export function createReplaceInFilesPlan(
  originalEdit: LspWorkspaceEdit,
  excludedUsageIds: ReadonlySet<string> = new Set(),
): ReplaceInFilesPlan {
  const filteredEdit = filterWorkspaceEditByUsages(originalEdit, excludedUsageIds);
  const preview = buildWorkspaceEditPreview(filteredEdit, { label: "Replace in Files" });

  const totalPreview = buildWorkspaceEditPreview(originalEdit, { label: "Replace in Files (Total)" });

  return {
    transactionId: `replace-in-files-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    originalEdit,
    filteredEdit,
    preview,
    excludedUsageIds,
    totalMatches: totalPreview.textEditCount,
    includedMatches: preview.textEditCount,
  };
}
