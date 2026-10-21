import type { LspFileTextEdits, LspTextEdit, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { offsetFromLspPositionInStringStrict } from "../lspTextEdits";
import { buildWorkspaceEditPreview, filterWorkspaceEditByUsages } from "../workspaceEditPreview";
import {
  type BuildReplaceEditParams,
  type ConflictCheckResult,
  type FileRevisionGuard,
  type ReplaceInFilesMatch,
  type ReplaceInFilesPlan,
  type ReplaceMatchFreshnessConflict,
} from "./model";
import { replacePreimagePathKey } from "./preimages";

/**
 * Builds an LSP WorkspaceEdit from multi-file search matches and replacement text.
 */
export function buildReplaceInFilesWorkspaceEdit(params: BuildReplaceEditParams): LspWorkspaceEdit {
  const groupedByPath = new Map<string, { path: string; uri: string; edits: LspTextEdit[]; }>();

  for (const match of params.matches) {
    const canonicalKey = replacePreimagePathKey(match.filePath);
    const uri = match.fileUri || `file://${match.filePath.replace(/\\/g, "/")}`;
    if (!groupedByPath.has(canonicalKey)) {
      groupedByPath.set(canonicalKey, { path: match.filePath, uri, edits: [] });
    }

    const entry = groupedByPath.get(canonicalKey)!;
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
  const documentEdits: LspFileTextEdits[] = Array.from(groupedByPath.values()).map(
    ({ path, uri, edits }) => ({ uri, path, version: null, edits }),
  );

  return {
    documentEdits,
  };
}

/**
 * Validates file revisions and dirty state before executing Replace in Files transaction.
 */
export function validateReplacePreconditions(
  guards: readonly FileRevisionGuard[],
  allowDirty: boolean = false,
): ConflictCheckResult {
  const conflicts: Array<{ path: string; reason: string; }> = [];

  for (const g of guards) {
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
    const start = match.startCharacter;
    const end = match.endCharacter;
    if (
      match.startLine !== match.endLine
      || !Number.isInteger(match.startLine)
      || match.startLine < 0
      || !Number.isInteger(match.endLine)
      || match.endLine < 0
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end < start
    ) {
      conflicts.push({
        path: match.filePath,
        reason: `Match "${match.matchedText}" changed since search (line ${match.startLine + 1})`,
      });
      continue;
    }
    // ED-REPAIR-003: strict LF/CRLF/CR-aware position mapping that returns null
    // on disappeared or shortened lines, invalid line numbers, or out-of-range
    // character offsets instead of clamping.
    const startOffset = offsetFromLspPositionInStringStrict(diskText, {
      line: match.startLine,
      character: start,
    });
    const endOffset = offsetFromLspPositionInStringStrict(diskText, {
      line: match.endLine,
      character: end,
    });
    if (
      startOffset === null
      || endOffset === null
      || endOffset < startOffset
      || diskText.slice(startOffset, endOffset) !== match.matchedText
    ) {
      conflicts.push({
        path: match.filePath,
        reason: `Match "${match.matchedText}" changed since search (line ${match.startLine + 1})`,
      });
    }
  }
  return conflicts;
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
