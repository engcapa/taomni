import type { LspChangeAnnotation, LspFileTextEdits, LspWorkspaceEdit, LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import type { SaveCommitResult } from "../saveCommit";
import { type WorkspaceEditPreview } from "../workspaceEditPreview";

export type WorkspaceEditApplyOutcome =
  | {
    operationIndex: number;
    path: string;
    status: "applied-open";
    dirty: boolean;
    /**
     * ED-MAIN-001: whether the in-memory buffer text actually changed. A
     * `none` value keeps an edit that resolves to identical text from being
     * counted as a mutation when a later await fails.
     */
    bufferEffect?: "none" | "performed";
  }
  | { operationIndex: number; path: string; status: "applied-disk"; result?: SaveCommitResult; }
  | { operationIndex: number; path: string; status: "applied-create"; }
  | { operationIndex: number; path: string; status: "applied-rename"; }
  | { operationIndex: number; path: string; status: "applied-delete"; }
  | { operationIndex: number; path: string; status: "noop"; }
  | { operationIndex: number | null; path: string; status: "skipped"; reason: string; }
  | {
    operationIndex: number | null;
    path: string;
    status: "failed";
    reason: string;
    /**
     * ED-MAIN-001: the in-memory buffer effect that already happened before a
     * later await failed. `performed` means the buffer text changed even though
     * the operation is reported as failed; absent means no buffer mutation.
     */
    bufferEffect?: "none" | "performed";
    /**
     * ED-IMPROVE-002: the write's own effect fact when it reached a disk
     * boundary. `unknown` means the OS write may have happened even though the
     * operation failed. Absent means the failure had no disk boundary (for
     * example a pre-mutation validation failure).
     */
    diskEffect?: "none" | "unknown";
    /**
     * ED-REPAIR-001: post-image and buffer identities captured when an open
     * buffer mutation succeeded in memory but persisting it failed known-zero.
     */
    expectedPostText?: string;
    openBufferKey?: string;
    openBufferVersion?: number | null;
  };

/**
 * ED-IMPROVE-002: thrown by the open-buffer save hook when the shared save
 * committer returns a non-committed result, so the applier can keep the typed
 * disk effect instead of flattening `unknown` into a plain failure.
 */
export class WorkspaceEditOpenBufferSaveFailure extends Error {
  readonly diskEffect: "none" | "unknown";

  constructor(message: string, diskEffect: "none" | "unknown") {
    super(message);
    this.name = "WorkspaceEditOpenBufferSaveFailure";
    this.diskEffect = diskEffect;
  }
}

export interface WorkspaceEditApplyResponse {
  applied: boolean;
  failureReason: string | null;
  failedChange: number | null;
}

/**
 * Typed result of one settled resource operation (§8.19.1). Resource hooks
 * report success/failure through the shell, so the applier assembles the
 * same fact shape the save committer produces for text writes.
 */
export type ResourceOperationResult =
  | { kind: "committed"; diskEffect: "committed"; path: string; }
  | {
    kind: "conflict" | "failed";
    diskEffect: "none" | "unknown";
    path: string;
    message: string;
    recoveryId: string | null;
  };

/** Per-operation effect fact (§8.19.1 WorkspaceEditOperationEffect). */
export interface WorkspaceEditOperationEffect {
  operationId: string;
  index: number;
  kind: "text" | "create" | "rename" | "delete";
  sourcePath: string | null;
  targetPath: string;
  /**
   * Full typed result when a disk transaction ran (closed-file write or
   * open-clean save pipeline). Null means the operation changed only
   * in-memory state (open dirty buffer) — no disk/provider effect occurred.
   */
  result: SaveCommitResult | ResourceOperationResult | null;
  undoState: "available" | "unavailable";
  bufferEffect?: "none" | "performed";
  diskEffect?: "none" | "unknown" | "committed";
}

/** Whole-transaction apply result (§8.19.1 WorkspaceEditApplyResultV2). */
export interface WorkspaceEditApplyResultV2 {
  transactionId: string;
  disposition: "committed" | "partial" | "blocked" | "cancelled";
  effects: readonly WorkspaceEditOperationEffect[];
  nextOperationIndex: number | null;
  resumeToken: string | null;
}

export type WorkspaceEditOperationRetryKind =
  | "retry-full"
  | "retry-save-only"
  | "unretryable";

export interface RetryOpenBufferSaveInput {
  operationIndex: number;
  document: LspFileTextEdits;
  expectedPostText: string;
  expectedKey?: string;
  expectedVersion?: number | null;
  hooks: WorkspaceEditApplyHooks;
}

export interface WorkspaceEditApplyHooks {
  /** Resolve absolute path from a file URI / server path. */
  resolvePath: (file: LspFileTextEdits) => string | null;
  /** Return open buffer text + dirty flag, or null if not open. */
  getOpenBuffer: (absolutePath: string) => {
    text: string;
    dirty: boolean;
    key: string;
    version?: number | null;
    revision?: number | null;
    /** True only when the LSP server has this exact buffer text. */
    lspSynced?: boolean;
  } | null;
  /**
   * Apply text to an open buffer.
   * For dirty buffers this leaves the buffer dirty; for clean buffers the
   * applier will call `saveOpenBuffer` immediately afterwards (§5.2.9).
   */
  applyToOpenBuffer: (key: string, nextText: string) => void;
  /**
   * Persist an open clean buffer after applying edits.
   * Must write `nextText` to disk and leave the open buffer clean (dirty=false).
   */
  saveOpenBuffer: (key: string, nextText: string) => Promise<void>;
  /** Read disk contents for a closed file. */
  readDisk: (absolutePath: string) => Promise<{
    text: string;
    hash: string;
    eol?: "lf" | "crlf" | "cr";
    encoding?: string;
    bom?: boolean;
  } | null>;
  /**
   * Write disk contents for a closed file through the shared save committer
   * (§8.19.1): the hook returns the full typed effect result — including
   * unknown-effect read-back classification and recovery ledger rows — and
   * the caller must consume it instead of assuming success.
   */
  writeDisk: (
    absolutePath: string,
    text: string,
    expectedHash: string | null,
    encoding?: string,
    bom?: boolean,
    eol?: "lf" | "crlf" | "cr",
  ) => Promise<SaveCommitResult>;
  /** Apply LSP CreateFile semantics and synchronize workspace UI state. */
  createFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "create"; }>) => Promise<void>;
  /** Apply LSP RenameFile semantics and synchronize workspace UI state. */
  renameFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "rename"; }>) => Promise<void>;
  /** Apply LSP DeleteFile semantics and synchronize workspace UI state. */
  deleteFile?: (operation: Extract<LspWorkspaceEditOperation, { kind: "delete"; }>) => Promise<void>;
  /** Confirm a multi-file/resource edit before the first mutation. */
  confirmWorkspaceEdit?: (
    preview: WorkspaceEditPreview,
    edit: LspWorkspaceEdit,
  ) => Promise<boolean | LspWorkspaceEdit>;
  /** Confirm server-declared change annotations before any mutation is applied. */
  confirmChangeAnnotations?: (annotations: LspChangeAnnotation[]) => Promise<boolean>;
  /** Final consistency barrier after dialogs and immediately before mutation. */
  preflightMutation?: () => Promise<void> | void;
  /** Synchronous whole-set guard at the actual mutation boundary, after reads. */
  assertMutationBoundary?: () => void;
  /**
   * Validate every operation path before confirmation or mutation. Semantic
   * refactors use this to enforce workspace-root ownership and reject loose
   * file fallbacks for provider-supplied edits.
   */
  validateOperationPaths?: (operations: readonly LspWorkspaceEditOperation[]) => string | null;
  /**
   * Observes the edit actually applied after preview filtering/unchecking —
   * resume slicing must use this edit, never the pre-confirmation original.
   */
  onActiveEditResolved?: (edit: LspWorkspaceEdit) => void;
  /**
   * ED-REPAIR-002: Precondition assertion before an individual text document
   * edit is applied. Called before modifying open buffers or reading disk.
   */
  assertTextDocumentPreconditions?: (
    path: string,
    open: { text: string; dirty: boolean; key: string; version?: number | null; revision?: number | null; lspSynced?: boolean; } | null,
  ) => void;
}

/**
 * ED-IMPROVE-002: structured whole-transaction facts reported by the shell's
 * apply owner. Workflow callers use these to separate execution status from
 * the effect actually observed (none/performed/partial/unknown) and to name
 * the success history entry or the pending recovery entry.
 */
export interface WorkspaceEditApplyTransactionSummary {
  effect: "none" | "performed" | "partial" | "unknown";
  postcondition: "verified" | "mismatch" | "unreadable" | "not-applied";
  historyId: string | null;
  recoveryId: string | null;
  affectedPaths: readonly string[];
  reason: string | null;
}
