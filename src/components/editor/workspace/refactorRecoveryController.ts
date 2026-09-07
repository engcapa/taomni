import type {
  RefactorRecoveryDocumentSnapshotV2,
  RefactorRecoveryJournalEntryV2,
} from "./refactorPlan";
import { sha256Hex } from "./projectAnalysisModel";

/**
 * ED-AUDIT-014 recovery lifecycle for text-only refactor journals.
 *
 * The controller owns precondition classification and verified restore; the
 * shell (CodeWorkspaceTab) supplies the real read/write transaction paths.
 * It never overwrites third-party content and only reports success after an
 * independent read-back confirms every preimage.
 */

export type RefactorRecoveryPreconditionState =
  | "already-restored" // current content hash equals the recorded preHash
  | "restorable" // current content hash equals the recorded postHash
  | "conflict" // third-party content; zero-overwrite boundary
  | "unreadable"; // read failed; cannot classify

export interface RefactorRecoveryPrecondition {
  uri: string;
  canonicalPath: string | null;
  state: RefactorRecoveryPreconditionState;
  currentHash: string | null;
}

export interface RefactorRecoveryPreconditionSummary {
  documents: RefactorRecoveryPrecondition[];
  overall: "already-restored" | "restorable" | "conflict" | "unreadable";
}

export async function classifyRefactorRecoveryPreconditions(
  entry: RefactorRecoveryJournalEntryV2,
  readText: (canonicalPath: string) => Promise<{ text: string } | null>,
): Promise<RefactorRecoveryPreconditionSummary> {
  const documents: RefactorRecoveryPrecondition[] = [];
  let sawConflict = false;
  let sawUnreadable = false;
  let sawRestorable = false;
  for (const doc of entry.documents) {
    const target = doc.canonicalPath || doc.uri;
    let state: RefactorRecoveryPreconditionState;
    let currentHash: string | null = null;
    try {
      const current = await readText(target);
      if (current === null) {
        state = "unreadable";
        sawUnreadable = true;
      } else {
        currentHash = sha256Hex(current.text);
        if (currentHash === doc.preHash) {
          state = "already-restored";
        } else if (currentHash === doc.postHash) {
          state = "restorable";
          sawRestorable = true;
        } else {
          state = "conflict";
          sawConflict = true;
        }
      }
    } catch {
      state = "unreadable";
      sawUnreadable = true;
    }
    documents.push({ uri: doc.uri, canonicalPath: doc.canonicalPath, state, currentHash });
  }
  const overall: RefactorRecoveryPreconditionSummary["overall"] = sawConflict
    ? "conflict"
    : sawUnreadable
      ? "unreadable"
      : sawRestorable
        ? "restorable"
        : "already-restored";
  return { documents, overall };
}

export interface RefactorRecoveryExecution {
  /** `rolled-back` only when every document is confirmed at its preHash. */
  state: "rolled-back" | "pending";
  restoredUris: string[];
  /** Documents already at their preHash before any write (idempotent re-runs). */
  skippedUris: string[];
  conflicts: Array<{ uri: string; canonicalPath: string | null; currentHash: string | null }>;
  failures: Array<{ uri: string; canonicalPath: string | null; reason: string }>;
}

export interface RefactorRecoveryExecuteHooks {
  /**
   * Writes `doc.preText` through the shell's existing encoding writer /
   * transaction path. Must throw on failure; the controller records it.
   */
  restoreText: (doc: RefactorRecoveryDocumentSnapshotV2) => Promise<void>;
  /** Independent read-back of the just-restored file; null means unreadable. */
  readBack: (doc: RefactorRecoveryDocumentSnapshotV2) => Promise<{ text: string } | null>;
}

/**
 * Executes a verified restore over the classified preconditions. Documents
 * classified `conflict` or `unreadable` are never written. A failed restore
 * keeps the remaining documents untouched (pending state survives for retry).
 */
export async function executeRefactorRecovery(
  entry: RefactorRecoveryJournalEntryV2,
  preconditions: RefactorRecoveryPreconditionSummary,
  hooks: RefactorRecoveryExecuteHooks,
): Promise<RefactorRecoveryExecution> {
  const byUri = new Map(preconditions.documents.map((doc) => [doc.uri, doc]));
  const execution: RefactorRecoveryExecution = {
    state: "rolled-back",
    restoredUris: [],
    skippedUris: [],
    conflicts: [],
    failures: [],
  };
  for (const doc of entry.documents) {
    const precondition = byUri.get(doc.uri);
    const state = precondition?.state ?? "unreadable";
    if (state === "already-restored") {
      execution.skippedUris.push(doc.uri);
      continue;
    }
    if (state === "conflict") {
      execution.conflicts.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        currentHash: precondition?.currentHash ?? null,
      });
      continue;
    }
    if (state === "unreadable") {
      execution.failures.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        reason: "current content unreadable; restore aborted for this file",
      });
      continue;
    }
    try {
      await hooks.restoreText(doc);
      const readBack = await hooks.readBack(doc);
      const restoredHash = readBack === null ? null : sha256Hex(readBack.text);
      if (restoredHash !== doc.preHash) {
        execution.failures.push({
          uri: doc.uri,
          canonicalPath: doc.canonicalPath,
          reason: restoredHash === null
            ? "read-back after restore failed"
            : "read-back hash does not match the recorded preimage",
        });
        continue;
      }
      execution.restoredUris.push(doc.uri);
    } catch (error) {
      execution.failures.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = execution.restoredUris.length + execution.skippedUris.length === entry.documents.length
    && execution.conflicts.length === 0
    && execution.failures.length === 0;
  execution.state = complete ? "rolled-back" : "pending";
  return execution;
}
