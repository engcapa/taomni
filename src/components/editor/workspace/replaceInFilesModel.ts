/**
 * ED-FIND-004: Replace in Files preview, exclude, conflict guard, and transactional commit.
 * Prohibits blind silent Replace All; requires structured WorkspaceEdit preview with
 * per-occurrence exclusion, dirty/disk hash conflict protection, and single-step undo.
 */

import type { LspFileTextEdits, LspTextEdit, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../lib/editor/workspaceSearch";
import { fsPathComparisonKey, relativePathWithinRoot } from "./codeWorkspaceModel";
import type { FindInFilesScopePlan } from "./findInFilesScopeModel";
import { offsetFromLspPositionInStringStrict } from "./lspTextEdits";
import {
  buildWorkspaceEditPreview,
  filterWorkspaceEditByUsages,
  workspaceEditOperations,
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

/** Absolute host path for a search match (mirrors buildReplaceEdits). */
export function replaceMatchAbsolutePath(match: WorkspaceSearchMatch): string {
  return match.path
    ? `${match.rootPath.replace(/\\/g, "/").replace(/\/+$/, "")}/${match.path.replace(/^\/+/, "")}`
    : match.rootPath;
}

/**
 * ED-IMPROVE-004: the Rust search backend reports Unicode code-point offsets
 * (see workspace_search.rs char_offset), while LSP ranges and the editor use
 * UTF-16 code units. This is the single conversion used by preview,
 * navigation, freshness and commit so every consumer agrees.
 */
export function codePointOffsetToUtf16Offset(lineText: string, offset: number): number {
  const converted = codePointOffsetToUtf16OffsetChecked(lineText, offset);
  return converted ?? Math.max(0, Math.min(lineText.length, Math.trunc(offset) || 0));
}

/**
 * ED-MAIN-004: strict conversion that never silently clamps. Returns null for
 * negative, non-integer, NaN, or past-the-line code-point offsets so callers
 * can surface a reason instead of writing at a different valid position.
 */
export function codePointOffsetToUtf16OffsetChecked(
  lineText: string,
  offset: number,
): number | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let utf16 = 0;
  let codePoints = 0;
  while (utf16 < lineText.length && codePoints < offset) {
    const code = lineText.codePointAt(utf16);
    if (code === undefined) return null;
    utf16 += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  return codePoints === offset ? utf16 : null;
}

/**
 * Thrown when a backend search match carries illegal code-point coordinates.
 * The panel and commit owners catch it and surface a zero-commit reason.
 */
export class InvalidSearchMatchCoordinatesError extends Error {
  readonly path: string;

  constructor(path: string, lineNumber: number, offset: number) {
    const detail = (!Number.isInteger(lineNumber) || lineNumber < 1)
      ? `an invalid line number ${lineNumber}`
      : `an invalid offset ${offset}`;
    super(`Search match at ${path}:${lineNumber} has ${detail}; replace refused`);
    this.name = "InvalidSearchMatchCoordinatesError";
    this.path = path;
  }
}

/**
 * ED-FIND-004 / ED-REPAIR-003: shared search-match mapping used by the preview
 * dialog owner and the commit owner so both sides agree on file paths, ranges,
 * and the matched text the freshness recheck compares against disk. Validates
 * that lineNumber is a positive integer and code-point offsets are valid.
 */
export function searchMatchesToReplaceInputs(matches: readonly WorkspaceSearchMatch[]): ReplaceInFilesMatch[] {
  return matches.map((match) => {
    const absolute = replaceMatchAbsolutePath(match);
    if (!Number.isInteger(match.lineNumber) || match.lineNumber < 1) {
      throw new InvalidSearchMatchCoordinatesError(absolute, match.lineNumber, match.matchStart);
    }
    const line = match.lineNumber - 1;
    // ED-MAIN-004: validate the raw code-point offsets before conversion. A
    // negative/fractional/NaN/past-the-line/reversed match must not be clamped
    // into a different valid range.
    const startCharacter = codePointOffsetToUtf16OffsetChecked(match.lineText, match.matchStart);
    const endCharacter = codePointOffsetToUtf16OffsetChecked(match.lineText, match.matchEnd);
    if (
      startCharacter === null
      || endCharacter === null
      || endCharacter < startCharacter
    ) {
      const badOffset = startCharacter === null ? match.matchStart : match.matchEnd;
      throw new InvalidSearchMatchCoordinatesError(absolute, match.lineNumber, badOffset);
    }
    return {
      filePath: absolute,
      fileUri: `file://${absolute}`,
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter,
      matchedText: match.lineText.slice(startCharacter, endCharacter),
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
  const groupedByPath = new Map<string, { path: string; uri: string; edits: LspTextEdit[] }>();

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

export interface FileRevisionGuard {
  path: string;
  expectedHash?: string | null;
  actualHash?: string | null;
  isDirty?: boolean;
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

// ---------------------------------------------------------------------------
// ED-IMPROVE-005: one frozen preview snapshot drives the whole commit. Scope,
// query/options, replacement, selected match keys and the source edit
// signature are captured before the preview opens; the commit validates the
// selected edits against that snapshot and can never expand the set from a
// refreshed search, changed scope or newly added files.
// ---------------------------------------------------------------------------

export interface ReplaceScopeIdentity {
  kind: string;
  roots: readonly string[];
  explicitFiles: readonly string[];
  fileMask: string | null;
  generation: number | null;
}

export interface ReplaceQueryIdentity {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
}

/**
 * ED-MAIN-005: the per-file preimage captured when the preview opens. The
 * commit feeds the disk hashes back to the applier as the write precondition so
 * the old ranges can never be re-anchored onto text read again later.
 */
export interface ReplaceFilePreimage {
  path: string;
  uri: string;
  /** Hash of the preview-read text; the applier's disk precondition. */
  textHash: string;
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf" | "cr" | null;
  bufferRevision: number | null;
  dirty: boolean;
  readOnly: boolean;
  workspaceInstanceId: string;
}

export interface ReplacePrepareRequestIdentity {
  token: number;
  workspaceInstanceId: string;
  scope: ReplaceScopeIdentity;
  query: ReplaceQueryIdentity;
  replacement: string;
  matchKeys: readonly string[];
  matchCount: number;
  preparedAt: number;
}

export interface ReplacePrepareOptions {
  token?: number;
  workspaceInstanceId?: string;
  signal?: AbortSignal;
}

export interface ReplacePreviewSnapshot {
  scope: ReplaceScopeIdentity;
  query: ReplaceQueryIdentity;
  replacement: string;
  /** Stable UTF-16 usage keys for every frozen match. */
  matchKeys: readonly string[];
  matchCount: number;
  editSignature: string;
  capturedAt: number;
  /** Optional for legacy snapshots; ED-MAIN-005 fills it at preview time. */
  preimages?: readonly ReplaceFilePreimage[];
  /** ED-REPAIR-005: request identity frozen at prepare start. */
  requestIdentity?: ReplacePrepareRequestIdentity;
}

export interface CollectReplacePreimagesParams {
  readonly paths: readonly string[];
  readonly options?: ReplacePrepareOptions;
  readonly initialWorkspaceInstanceId: string;
  readonly getCurrentWorkspaceInstanceId: () => string;
  readonly getCurrentRoots: () => readonly { path: string }[];
  readonly getOpenFileState: (path: string) => { documentRevision: number | null; dirty: boolean; readOnly?: boolean } | null;
  readonly readFile: (rootPath: string, relativePath: string) => Promise<{ text: string; hash: string; encoding?: string; bom?: boolean }>;
  readonly isLocked?: () => boolean;
}

/**
 * ED-REPAIR-005: Collect replace preimages while enforcing workspace instance,
 * roots, and open buffer revision/dirty integrity across all async reads.
 * Any mid-read mutation or abort cancels/refuses the prepare cleanly with zero writes.
 */
export async function collectReplacePreimages(
  params: CollectReplacePreimagesParams,
): Promise<readonly ReplaceFilePreimage[]> {
  const {
    paths,
    options,
    initialWorkspaceInstanceId,
    getCurrentWorkspaceInstanceId,
    getCurrentRoots,
    getOpenFileState,
    readFile,
    isLocked,
  } = params;

  if (options?.signal?.aborted) {
    throw new Error("Replace preview cancelled");
  }
  if (options?.workspaceInstanceId && options.workspaceInstanceId !== initialWorkspaceInstanceId) {
    throw new Error("Replace preview refused: workspace instance mismatch");
  }

  const initialRoots = getCurrentRoots();
  const initialOpenMap = new Map<string, { revision: number | null; dirty: boolean }>();
  for (const absolute of paths) {
    const open = getOpenFileState(absolute);
    initialOpenMap.set(absolute, {
      revision: open?.documentRevision ?? null,
      dirty: open?.dirty ?? false,
    });
  }

  const preimages: ReplaceFilePreimage[] = [];
  for (const absolute of paths) {
    if (options?.signal?.aborted) {
      throw new Error("Replace preview cancelled");
    }
    if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId) {
      throw new Error("Replace preview cancelled: workspace changed during prepare");
    }
    const currentRoots = getCurrentRoots();
    const containing = currentRoots.find(
      (root) => relativePathWithinRoot(root.path, absolute) !== null,
    );
    if (!containing) {
      throw new Error(`Replace preview refused: ${absolute} is outside the workspace`);
    }
    const relative = relativePathWithinRoot(containing.path, absolute) ?? "";
    const disk = await readFile(containing.path, relative);
    if (options?.signal?.aborted) {
      throw new Error("Replace preview cancelled");
    }
    if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId) {
      throw new Error("Replace preview cancelled: workspace changed during prepare");
    }
    const openAfter = getOpenFileState(absolute);
    const initialOpen = initialOpenMap.get(absolute);
    const afterRevision = openAfter?.documentRevision ?? null;
    const afterDirty = openAfter?.dirty ?? false;
    if (initialOpen && (afterRevision !== initialOpen.revision || afterDirty !== initialOpen.dirty)) {
      throw new Error(`Replace preview refused: ${absolute} was modified during prepare; please retry`);
    }
    const eol = disk.text.includes("\r\n")
      ? ("crlf" as const)
      : disk.text.includes("\r") && !disk.text.includes("\n")
        ? ("cr" as const)
        : ("lf" as const);
    preimages.push({
      path: absolute,
      uri: `file://${absolute}`,
      textHash: disk.hash,
      encoding: disk.encoding ?? "UTF-8",
      bom: disk.bom ?? false,
      eol,
      bufferRevision: afterRevision,
      dirty: afterDirty,
      readOnly: !!openAfter?.readOnly || !!isLocked?.(),
      workspaceInstanceId: initialWorkspaceInstanceId,
    });
  }

  // After all awaits complete, re-verify workspace instance, roots, and buffer states
  if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId || getCurrentRoots() !== initialRoots) {
    throw new Error("Replace preview cancelled: workspace state changed during prepare");
  }
  for (const [absolute, initialOpen] of initialOpenMap.entries()) {
    const openAfter = getOpenFileState(absolute);
    const afterRevision = openAfter?.documentRevision ?? null;
    const afterDirty = openAfter?.dirty ?? false;
    if (afterRevision !== initialOpen.revision || afterDirty !== initialOpen.dirty) {
      throw new Error(`Replace preview refused: ${absolute} was modified during prepare; please retry`);
    }
  }

  return preimages;
}

/**
 * ED-REPAIR-006: canonical path comparison key that preserves case on POSIX,
 * normalizes Windows drive/separator and UNC syntax, and handles file:// URIs.
 */
export function replacePreimagePathKey(path: string): string {
  return fsPathComparisonKey(path);
}

export function findReplacePreimage(
  snapshot: Pick<ReplacePreviewSnapshot, "preimages">,
  path: string,
): ReplaceFilePreimage | null {
  const key = replacePreimagePathKey(path);
  return snapshot.preimages?.find((preimage) => replacePreimagePathKey(preimage.path) === key) ?? null;
}

/**
 * ED-MAIN-005: per-file precondition map consumed by the applier. Only files
 * with a captured preimage get an expected hash; legacy snapshots stay on the
 * existing freshness gate.
 * ED-REPAIR-006: canonical path keys preserve case on POSIX and normalize on
 * Windows/UNC. Conflicting preimages for the same canonical path throw an explicit conflict.
 */
export function replacePreimageExpectedHashes(
  snapshot: Pick<ReplacePreviewSnapshot, "preimages">,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const preimage of snapshot.preimages ?? []) {
    const key = replacePreimagePathKey(preimage.path);
    const existing = map.get(key);
    if (existing !== undefined && existing !== preimage.textHash) {
      throw new Error(
        `Conflicting replace preimages for canonical path "${key}": expected hash "${existing}" contradicts "${preimage.textHash}"`,
      );
    }
    map.set(key, preimage.textHash);
  }
  return map;
}

export function replaceScopeIdentityFromPlan(
  plan: FindInFilesScopePlan,
): ReplaceScopeIdentity {
  return {
    kind: plan.kind,
    roots: plan.status === "ready" ? [...plan.roots] : [],
    explicitFiles: plan.status === "ready" ? [...(plan.explicitFiles ?? [])] : [],
    fileMask: plan.fileMask ?? null,
    generation: plan.generation ?? null,
  };
}

export function replaceMatchStableKey(match: ReplaceInFilesMatch): string {
  return `${match.filePath}:${match.startLine}:${match.startCharacter}:${match.endLine}:${match.endCharacter}`;
}

/** Deterministic signature of every text edit in a WorkspaceEdit. */
export function replaceEditSignature(edit: LspWorkspaceEdit): string {
  return workspaceEditOperations(edit).map((operation) => {
    if (operation.kind !== "text") {
      const path = operation.kind === "rename"
        ? `${operation.oldPath ?? operation.oldUri}->${operation.newPath ?? operation.newUri}`
        : operation.path ?? operation.uri;
      return `${operation.kind}:${path}`;
    }
    const path = operation.document.path ?? operation.document.uri;
    const edits = operation.document.edits
      .map((item) => [
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.newText,
      ].join(":"))
      .join("|");
    return `${operation.kind}:${path}#${edits}`;
  }).join(";");
}

export interface ReplaceSelectionValidation {
  ok: boolean;
  reason?: string;
}

/**
 * ED-IMPROVE-005: the commit may only deliver selections that exist in the
 * frozen snapshot, one edit per selected match, all carrying the frozen
 * replacement text. Any drift is an internal conflict, never a partial write.
 */
function replaceEditKey(path: string, edit: LspTextEdit): string {
  return [
    replacePreimagePathKey(path),
    edit.range.start.line,
    edit.range.start.character,
    edit.range.end.line,
    edit.range.end.character,
  ].join(":");
}

export function validateReplacePreviewSelection(
  snapshot: ReplacePreviewSnapshot,
  selectedMatchKeys: ReadonlySet<string>,
  filteredEdit: LspWorkspaceEdit,
  sourceEdit?: LspWorkspaceEdit,
): ReplaceSelectionValidation {
  const frozenKeys = new Set(snapshot.matchKeys);
  for (const key of selectedMatchKeys) {
    if (!frozenKeys.has(key)) {
      return {
        ok: false,
        reason: `Selection ${key} is not part of the frozen replace preview; reopen the preview`,
      };
    }
  }
  const textOperations = workspaceEditOperations(filteredEdit).filter(
    (operation) => operation.kind === "text",
  );
  const edits = textOperations.flatMap((operation) => (
    operation.kind === "text" ? operation.document.edits : []
  ));
  if (edits.length !== selectedMatchKeys.size) {
    return {
      ok: false,
      reason: `Frozen selection has ${selectedMatchKeys.size} matches but the edit carries ${edits.length}; reopen the preview`,
    };
  }
  for (const edit of edits) {
    if (edit.newText !== snapshot.replacement) {
      return {
        ok: false,
        reason: "The edit text differs from the frozen replacement; reopen the preview",
      };
    }
  }
  // ED-MAIN-005: each filtered edit must be the exact frozen path/range from the
  // original plan, not a same-count selection that swapped a path or range.
  if (sourceEdit) {
    const sourceKeys = new Set<string>();
    for (const operation of workspaceEditOperations(sourceEdit)) {
      if (operation.kind !== "text") continue;
      const path = operation.document.path ?? operation.document.uri;
      for (const edit of operation.document.edits) sourceKeys.add(replaceEditKey(path, edit));
    }
    for (const operation of textOperations) {
      if (operation.kind !== "text") continue;
      const path = operation.document.path ?? operation.document.uri;
      for (const edit of operation.document.edits) {
        if (!sourceKeys.has(replaceEditKey(path, edit))) {
          return {
            ok: false,
            reason: `Frozen edit ${path}:${edit.range.start.line}:${edit.range.start.character} is not part of the original replace plan; reopen the preview`,
          };
        }
      }
    }
  }
  return { ok: true };
}

/** Minimal structural view of one applier outcome (per-document operation). */
export interface ReplaceApplyOutcomeLike {
  path: string;
  status: string;
  reason?: string;
}

export interface ReplaceCommitReport {
  ok: boolean;
  /** Occurrences actually written: planned matches inside applied files. */
  appliedCount: number;
  /** Planned files with at least one applied operation. */
  fileCount: number;
  plannedCount: number;
  plannedFileCount: number;
  /** "path: reason" for every failed or skipped operation. */
  blockers: string[];
  /** One-line user report; never claims completion beyond the real ledger. */
  message: string;
}

const APPLIED_OUTCOME_STATUSES = new Set([
  "applied-open",
  "applied-disk",
  "applied-create",
  "applied-rename",
  "applied-delete",
]);

/**
 * ED-AUDIT-003: the applier's per-operation ledger is the only truth for what
 * actually changed. A failed or skipped document must surface the real applied
 * set — the report never claims the planned counts when effects stopped early,
 * and a declined retry leaves the replace preview open with the blocker list.
 */
export function summarizeReplaceCommitReport(
  outcomes: readonly ReplaceApplyOutcomeLike[],
  matches: readonly ReplaceInFilesMatch[],
): ReplaceCommitReport {
  const appliedPaths = new Set<string>();
  const blockers: string[] = [];
  for (const outcome of outcomes) {
    if (APPLIED_OUTCOME_STATUSES.has(outcome.status)) {
      appliedPaths.add(fsPathComparisonKey(outcome.path));
    }
    if (outcome.status === "failed" || outcome.status === "skipped") {
      blockers.push(`${outcome.path}: ${outcome.reason ?? "blocked"}`);
    }
  }
  const plannedKeys = Array.from(new Set(matches.map((match) => fsPathComparisonKey(match.filePath))));
  const appliedCount = matches.filter((match) => appliedPaths.has(fsPathComparisonKey(match.filePath))).length;
  const fileCount = plannedKeys.filter((key) => appliedPaths.has(key)).length;
  const ok = blockers.length === 0;
  const occurrence = (count: number) => `${count} occurrence${count === 1 ? "" : "s"}`;
  const file = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
  let message: string;
  if (ok) {
    message = `Replaced ${occurrence(appliedCount)} in ${file(fileCount)} — Ctrl+Z to undo`;
  } else if (appliedCount === 0) {
    message = `Replace blocked, nothing applied: ${blockers.join("; ")}`;
  } else {
    message = `Replace partially applied: ${appliedCount} of ${matches.length} occurrences in ${fileCount} of ${plannedKeys.length} files; blocked: ${blockers.join("; ")}`;
  }
  return {
    ok,
    appliedCount,
    fileCount,
    plannedCount: matches.length,
    plannedFileCount: plannedKeys.length,
    blockers,
    message,
  };
}
