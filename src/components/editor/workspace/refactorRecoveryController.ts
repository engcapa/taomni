import { normalizeFsPath, relativePathWithinRoot } from "./codeWorkspaceModel";
import {
  clearRefactorRecoveryJournal,
  listPendingRefactorRecoveryJournals,
  recordRefactorRecoveryJournal,
  replayRefactorRecoveryJournal,
  type RefactorRecoveryJournalEntry,
  type RefactorRecoveryJournalRecord,
  type RefactorRecoveryReplayHandlers,
  type RefactorRecoveryReplayResult,
} from "./refactorPlan";

export interface RefactorRecoveryControllerOptions {
  workspaceId: string;
  workspaceRoot: string;
  storage?: Storage;
}

/**
 * Owns the lifecycle of v2 refactor recovery entries. The controller keeps
 * the storage transition separate from the editor so a recovery read failure
 * cannot accidentally become a successful history transaction.
 */
export class RefactorRecoveryController {
  private readonly workspaceId: string;
  private readonly workspaceRoot: string;
  private readonly storage: Storage | undefined;
  private active = true;

  constructor(options: RefactorRecoveryControllerOptions) {
    this.workspaceId = options.workspaceId;
    this.workspaceRoot = normalizeFsPath(options.workspaceRoot);
    this.storage = options.storage;
  }

  /** Re-arm the owner after a StrictMode effect replay or workspace mount. */
  activate(): void {
    this.active = true;
  }

  /** Stop pending recovery work when the owning workspace is unmounted. */
  dispose(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  listPending(): RefactorRecoveryJournalRecord[] {
    return listPendingRefactorRecoveryJournals(this.workspaceRoot, this.storage);
  }

  persist(entry: RefactorRecoveryJournalEntry): { ok: true } | { ok: false; reason: string } {
    if (!this.active) {
      return { ok: false, reason: "Refactor recovery workspace owner is closed" };
    }
    if (entry.workspaceId !== this.workspaceId || normalizeFsPath(entry.workspaceRoot) !== this.workspaceRoot) {
      return { ok: false, reason: "Refactor recovery journal belongs to another workspace" };
    }
    const result = recordRefactorRecoveryJournal(entry, this.storage);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  discard(entry: RefactorRecoveryJournalRecord): void {
    // The explicit user discard action is the only path allowed to remove a
    // legacy v1 entry; v1 is never replayed automatically.
    clearRefactorRecoveryJournal(entry.recoveryId, this.storage);
  }

  async recover(
    entry: RefactorRecoveryJournalRecord,
    handlers: RefactorRecoveryReplayHandlers,
  ): Promise<RefactorRecoveryReplayResult> {
    if (!this.active) {
      return this.pending([], [], "Refactor recovery workspace owner is closed");
    }
    if (entry.schemaVersion !== 2) {
      return replayRefactorRecoveryJournal(entry, handlers);
    }
    const pathError = this.validatePaths(entry);
    if (pathError) {
      return this.pending([], [pathError], pathError);
    }

    const applying: RefactorRecoveryJournalEntry = {
      ...entry,
      status: "applying",
      updatedAt: Date.now(),
    };
    const prepared = this.persist(applying);
    if (!prepared.ok) {
      return this.pending([], [], `Cannot start refactor recovery: ${prepared.reason}`);
    }

    const result = await replayRefactorRecoveryJournal(applying, {
      ...handlers,
      readText: async (path, document) => {
        if (!this.active) throw new Error("Refactor recovery workspace owner is closed");
        return handlers.readText(path, document);
      },
      applyText: async (path, text, document, expectedDocumentRevision) => {
        if (!this.active) throw new Error("Refactor recovery workspace owner is closed");
        return handlers.applyText(path, text, document, expectedDocumentRevision);
      },
      onDocumentApplied: async (path, document) => {
        await handlers.onDocumentApplied?.(path, document);
        if (!this.active) throw new Error("Refactor recovery workspace owner is closed");
        const documentIndex = applying.documents.indexOf(document);
        if (documentIndex < 0) {
          throw new Error(`Recovery settled an unknown document: ${path}`);
        }
        applying.status = "applying";
        applying.appliedOperationIndex = Math.max(
          applying.appliedOperationIndex,
          documentIndex,
        );
        const progress = this.persist(applying);
        if (!progress.ok) {
          throw new Error(`Recovery progress could not be persisted: ${progress.reason}`);
        }
      },
    });
    if (result.status === "rolled-back") {
      const settled: RefactorRecoveryJournalEntry = {
        ...applying,
        status: "rolled-back",
        appliedOperationIndex: Math.max(-1, applying.operationCount - 1),
        updatedAt: Date.now(),
      };
      const persisted = this.persist(settled);
      if (!persisted.ok) {
        return this.pending(
          result.restoredUris,
          [],
          `Recovery bytes were restored, but the settled journal could not be persisted: ${persisted.reason}`,
        );
      }
      return result;
    }

    const pendingEntry: RefactorRecoveryJournalEntry = {
      ...applying,
      status: "recovery-required",
      updatedAt: Date.now(),
    };
    const persisted = this.persist(pendingEntry);
    const reason = persisted.ok
      ? result.reason
      : `${result.reason}; recovery journal update failed: ${persisted.reason}`;
    return this.pending(result.restoredUris, result.conflicts, reason);
  }

  private validatePaths(entry: RefactorRecoveryJournalEntry): string | null {
    if (entry.workspaceId !== this.workspaceId) {
      return "Refactor recovery journal workspace identity does not match the current workspace";
    }
    for (const document of entry.documents) {
      if (!document.canonicalPath) {
        return `Refactor recovery has no local path for ${document.uri}`;
      }
      const normalized = normalizeFsPath(document.canonicalPath);
      if (relativePathWithinRoot(this.workspaceRoot, normalized) === null) {
        return `Refactor recovery path is outside the workspace: ${document.canonicalPath}`;
      }
    }
    return null;
  }

  private pending(
    restoredUris: string[],
    conflicts: string[],
    reason: string,
  ): RefactorRecoveryReplayResult {
    return {
      status: "pending",
      restoredUris,
      preHashesRestored: false,
      conflicts,
      reason,
    };
  }
}
