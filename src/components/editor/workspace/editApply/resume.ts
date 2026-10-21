import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type RetryOpenBufferSaveInput, type WorkspaceEditApplyOutcome, WorkspaceEditOpenBufferSaveFailure, type WorkspaceEditOperationRetryKind } from "./model";

export function workspaceEditResumeToken(transactionId: string, operationIndex: number): string {
  return `${transactionId}:${operationIndex}`;
}

export function parseWorkspaceEditResumeToken(token: string): {
  transactionId: string;
  operationIndex: number;
} | null {
  const match = token.match(/^(.*):(\d+)$/);
  if (!match || !match[1]) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { transactionId: match[1], operationIndex: index };
}

/**
 * Slice an edit to the operations from `startOperationIndex` onward so a
 * resume re-runs only the unapplied suffix. Fresh per-operation hash/version
 * re-validation happens naturally because every remaining text operation
 * re-reads disk or re-checks the open buffer before writing (§8.19.1).
 */
export function sliceWorkspaceEditForResume(
  edit: LspWorkspaceEdit,
  startOperationIndex: number,
): LspWorkspaceEdit {
  if (edit.operations?.length) {
    return { ...edit, operations: edit.operations.slice(startOperationIndex) };
  }
  return { ...edit, documentEdits: edit.documentEdits.slice(startOperationIndex) };
}

/**
 * ED-REPAIR-001: classify whether a failed boundary can be retried and which
 * retry strategy is required. A buffer effect that already modified in-memory
 * text must never re-apply text operations; it may only retry safe persistence.
 * An unknown disk effect must never be blindly retried.
 */
export function classifyWorkspaceEditOperationRetry(
  outcome: WorkspaceEditApplyOutcome,
): WorkspaceEditOperationRetryKind {
  if (outcome.status !== "failed") {
    return "unretryable";
  }
  if (outcome.diskEffect === "unknown") {
    return "unretryable";
  }
  if (outcome.bufferEffect === "performed" && outcome.diskEffect === "none") {
    if (outcome.expectedPostText === undefined) {
      return "unretryable";
    }
    return "retry-save-only";
  }
  if (outcome.bufferEffect !== "performed") {
    return "retry-full";
  }
  return "unretryable";
}

/**
 * ED-REPAIR-001: retry persisting an open clean buffer whose in-memory edit
 * already succeeded, without re-applying the text edit. Validates document
 * session, version, unmodified post-image buffer text, and disk preconditions
 * before attempting the save.
 */
export async function retryOpenBufferSave(
  input: RetryOpenBufferSaveInput,
): Promise<WorkspaceEditApplyOutcome> {
  const { operationIndex, document, expectedPostText, expectedKey, expectedVersion, hooks } = input;
  const path = hooks.resolvePath(document);
  if (!path) {
    return {
      operationIndex,
      path: document.uri,
      status: "failed",
      reason: "unresolvable path",
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  const initial = hooks.getOpenBuffer(path);
  const open = initial ? { ...initial } : null;
  if (!open) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: "document is no longer open in buffer; cannot safely retry save",
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  if (expectedKey && open.key !== expectedKey) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: "buffer session changed; cannot safely retry save",
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  if (expectedVersion != null && open.version !== expectedVersion) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: `document version mismatch (expected ${expectedVersion}, current ${open.version ?? "unknown"})`,
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  if (document.version != null && open.version !== document.version) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: `document version mismatch (expected ${document.version}, current ${open.version ?? "unknown"})`,
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  if (open.text !== expectedPostText) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: "buffer content has changed (new user typing detected); retry aborted to protect newer edits",
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  try {
    const disk = await hooks.readDisk(path);
    if (!disk) {
      return {
        operationIndex,
        path,
        status: "failed",
        reason: "file not found on disk during retry precheck",
        diskEffect: "none",
        bufferEffect: "performed",
      };
    }
  } catch (err) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: `disk precondition check failed: ${err instanceof Error ? err.message : String(err)}`,
      diskEffect: "none",
      bufferEffect: "performed",
    };
  }
  try {
    // readDisk yields to editor input, tab changes, and LSP version updates.
    // Validate the frozen session again in the same turn that starts the save.
    const current = hooks.getOpenBuffer(path);
    if (!current || current.key !== open.key || current.text !== expectedPostText
      || current.version !== open.version || current.revision !== open.revision) {
      throw new Error("buffer session or content changed during retry precheck; retry aborted to protect newer edits");
    }
    await hooks.saveOpenBuffer(open.key, open.text);
    return {
      operationIndex,
      path,
      status: "applied-open",
      dirty: false,
      bufferEffect: "performed",
    };
  } catch (error) {
    return {
      operationIndex,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      diskEffect: error instanceof WorkspaceEditOpenBufferSaveFailure ? error.diskEffect : "none",
      bufferEffect: "performed",
      expectedPostText,
      openBufferKey: open.key,
      openBufferVersion: open.version,
    };
  }
}
