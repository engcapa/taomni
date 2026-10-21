import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type WorkspaceEditPreview } from "../workspaceEditPreview";

export interface ReplaceInFilesMatch {
  filePath: string;
  fileUri?: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  matchedText: string;
}

export interface BuildReplaceEditParams {
  matches: readonly ReplaceInFilesMatch[];
  replacementText: string;
}

export interface FileRevisionGuard {
  path: string;
  expectedHash?: string | null;
  actualHash?: string | null;
  isDirty?: boolean;
}

export interface ConflictCheckResult {
  canCommit: boolean;
  conflicts: Array<{ path: string; reason: string; }>;
}

export interface ReplaceMatchFreshnessConflict {
  path: string;
  reason: string;
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
  readonly getCurrentRoots: () => readonly { path: string; }[];
  readonly getOpenFileState: (path: string) => { documentRevision: number | null; dirty: boolean; readOnly?: boolean; } | null;
  readonly readFile: (rootPath: string, relativePath: string) => Promise<{ text: string; hash: string; encoding?: string; bom?: boolean; }>;
  readonly isLocked?: () => boolean;
}

export interface ReplaceSelectionValidation {
  ok: boolean;
  reason?: string;
}

export interface ReplacePreflightFileInput {
  path: string;
  exists: boolean;
  diskHash: string | null;
  diskText: string | null;
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr" | null;
  isOpen: boolean;
  openBufferRevision: number | null;
  openBufferDirty: boolean;
  openBufferReadOnly: boolean;
}

export interface ReplacePreflightConflict {
  path: string;
  reason: string;
}

export interface ReplacePreflightResult {
  canCommit: boolean;
  conflicts: readonly ReplacePreflightConflict[];
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
