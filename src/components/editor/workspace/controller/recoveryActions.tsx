import { type LspWorkspaceEdit, type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { refactorJournalPostImageMatches, refactorJournalPreImageMatches, updateRefactorRecoveryJournalV2, type RefactorKind, type RefactorPlanV3, type RefactorRecoveryJournalEntryV2, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { executeRefactorRecovery, type RefactorRecoveryPreconditionSummary } from "../refactorRecoveryController";
import { buildWorkspacePathSnapshotEdit, type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { type ReplaceFilePreimage } from "../replaceInFilesModel";
import { fsPathComparisonKey } from "../codeWorkspaceModel";



export interface RunRecoveryRestoreContext {
  workspaceInstanceIdRef: import("react").RefObject<string>;
  refactorRecoveryBusyRef: import("react").RefObject<Set<string>>;
  setRefactorRecoveryReview: import("react").Dispatch<import("react").SetStateAction<{ entry: RefactorRecoveryJournalEntryV2; ownerInstanceId: string; preconditions: RefactorRecoveryPreconditionSummary | null; loading: boolean; error: string | null; busy: boolean; } | null>>;
  readWorkspaceEditPathSnapshot: (absolutePath: string) => Promise<WorkspaceEditPathSnapshot | null>;
  replayWorkspaceEncodingRef: import("react").RefObject<Map<string, { encoding: string; bom: boolean; eol?: "lf" | "crlf" | "cr"; }> | null>;
  replayWorkspaceRestoreRef: import("react").RefObject<boolean>;
  applyLspWorkspaceEditNow: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
  restoreEchoSuppressorRef: import("react").RefObject<import("../refactorRecoveryController").RestoreEchoSuppressor>;
  applyLspResourceOperation: (operation: Exclude<LspWorkspaceEditOperation, { kind: "text"; }>) => Promise<void>;
  refreshTree: () => void;
  setStatusMessage: (message: string) => void;
  closeRefactorRecoveryReview: (recoveryId: string) => void;
  classifyRecoveryEntry: (entry: RefactorRecoveryJournalEntryV2) => Promise<RefactorRecoveryPreconditionSummary>;
}


export function createRunRecoveryRestore(controllerContext: RunRecoveryRestoreContext) {
  return async (
    targetEntry: RefactorRecoveryJournalEntryV2,
    targetPreconditions: RefactorRecoveryPreconditionSummary,
    ownerInstanceId: string,
  ): Promise<void> => {
    const released = () => controllerContext.workspaceInstanceIdRef.current !== ownerInstanceId;
    const recoveryId = targetEntry.recoveryId;
    if (controllerContext.refactorRecoveryBusyRef.current.has(recoveryId)) return;
    controllerContext.refactorRecoveryBusyRef.current.add(recoveryId);
    controllerContext.setRefactorRecoveryReview((current) => (
      current && current.entry.recoveryId === recoveryId ? { ...current, busy: true, error: null } : current
    ));
    try {
      const documentList = targetEntry.documents.map((doc) => doc.canonicalPath ?? doc.uri);
      const moveList = (targetEntry.resourceMoves ?? [])
        .filter((move) => move.oldPath && move.newPath)
        .map((move) => `${move.oldPath} → ${move.newPath} (moved back on restore)`);
      const resourceList = [...documentList, ...moveList].join("\n");
      const restore = await confirmAppDialog({
        title: "Restore pre-refactor content",
        message: `Restore ${targetEntry.documents.length} file(s) to their pre-refactor content`
          + `${moveList.length > 0 ? ` and move ${moveList.length} relocated file(s) back` : ""}?\n${resourceList}`,
        confirmLabel: "Restore files",
      });
      if (released()) return;
      if (!restore) {
        controllerContext.setRefactorRecoveryReview((current) => (
          current && current.entry.recoveryId === recoveryId ? { ...current, busy: false } : current
        ));
        return;
      }
      const execution = await executeRefactorRecovery(targetEntry, targetPreconditions, {
      restoreText: async (doc) => {        const targetPath = doc.canonicalPath || doc.uri;
        const current = await controllerContext.readWorkspaceEditPathSnapshot(targetPath);
        if (!current || !current.exists || current.text === null) {
          throw new Error(`Cannot restore ${targetPath}: current content unreadable`);
        }
        // Re-verify immediately before writing: content changed between the
        // classification and this write is never overwritten.
        if (refactorJournalPreImageMatches(doc, current.text)) return; // already restored; read-back confirms
        if (!refactorJournalPostImageMatches(doc, current.text)) {
          throw new Error(`${targetPath}: content changed during recovery; file left untouched`);
        }
        controllerContext.replayWorkspaceEncodingRef.current = new Map([
          [fsPathComparisonKey(targetPath), {
            encoding: doc.encoding,
            bom: doc.bom,
            eol: doc.eol ?? undefined,
          }],
        ]);
        try {
          // ED-AUDIT-008: recovery restores are journal-owned history too.
          controllerContext.replayWorkspaceRestoreRef.current = true;
          try {
            await controllerContext.applyLspWorkspaceEditNow(
              buildWorkspacePathSnapshotEdit(
                [current],
                [{
                  path: targetPath,
                  exists: true,
                  text: doc.preText,
                  encoding: doc.encoding,
                  bom: doc.bom,
                  eol: doc.eol ?? undefined,
                }],
              ),
              { recordHistory: false },
            );
            // ED-AUDIT-014: the watcher will echo this own-write back for
            // closed files; mark it so the echo does not clobber the
            // restore-complete status set after all writes settle.
            controllerContext.restoreEchoSuppressorRef.current.markRestored(fsPathComparisonKey(targetPath));
          } finally {
            controllerContext.replayWorkspaceRestoreRef.current = false;
          }
        } finally {
          controllerContext.replayWorkspaceEncodingRef.current = null;
        }
      },
      readBack: async (doc) => {
        const snapshot = await controllerContext.readWorkspaceEditPathSnapshot(doc.canonicalPath || doc.uri);
        return snapshot && snapshot.text !== null ? { text: snapshot.text } : null;
      },
      // ED-FOLLOW-001: reverse one journalled file move (new path back to
      // the old path) through the same resource-operation path the forward
      // move used, so locks, buffer remapping, and tree refresh all apply.
      reverseResourceMove: async (move) => {
        if (!move.oldPath || !move.newPath) {
          throw new Error("Journalled move has no resolvable path pair");
        }
        await controllerContext.applyLspResourceOperation({
          kind: "rename",
          oldUri: move.newUri,
          oldPath: move.newPath,
          newUri: move.oldUri,
          newPath: move.oldPath,
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        });
        controllerContext.refreshTree();
        // The reversal's own watcher echo must not clobber the
        // restore-complete status (same rationale as the 014 suppressor).
        controllerContext.restoreEchoSuppressorRef.current.markRestored(fsPathComparisonKey(move.oldPath));
        controllerContext.restoreEchoSuppressorRef.current.markRestored(fsPathComparisonKey(move.newPath));
      },
      pathExists: async (path) => {
        const snapshot = await controllerContext.readWorkspaceEditPathSnapshot(path);
        if (snapshot === null) throw new Error(`Cannot stat ${path}: not a regular file`);
        return snapshot.exists;
      },
      readMoveText: async (path) => {
        const snapshot = await controllerContext.readWorkspaceEditPathSnapshot(path);
        return snapshot && snapshot.text !== null ? { text: snapshot.text } : null;
      },
    });
    if (released()) {
      controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
      return;
    }
    if (execution.state === "rolled-back") {
      updateRefactorRecoveryJournalV2(targetEntry.recoveryId, (current) => ({
        ...current,
        status: "rolled-back",
        verification: {
          mismatchedUris: Object.freeze([]),
          checkedAt: Date.now(),
          reversedMoves: Object.freeze([...execution.reversedMoves]),
          restoredUris: Object.freeze([...execution.restoredUris]),
        },
      }));
      controllerContext.setStatusMessage(
        `Refactor recovery complete: restored ${execution.restoredUris.length}, `
          + `already restored ${execution.skippedUris.length}`
          + `${execution.reversedMoves.length > 0 ? `, moved back ${execution.reversedMoves.length}` : ""}`
          + `${execution.contentUnverifiedMoves.length > 0 ? ` (${execution.contentUnverifiedMoves.length} move(s) without a content proof)` : ""}.`,
      );
      controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
      controllerContext.closeRefactorRecoveryReview(recoveryId);
      return;
    }
    const problems = [
      ...execution.conflicts.map((conflict) => `${conflict.canonicalPath ?? conflict.uri}: third-party content (not overwritten)`),
      ...execution.failures.map((failure) => `${failure.canonicalPath ?? failure.uri}: ${failure.reason}`),
      ...execution.moveConflicts.map((conflict) => `${conflict.newUri}: ${conflict.reason}`),
      ...execution.moveFailures.map((failure) => `${failure.newUri}: ${failure.reason}`),
    ];
    // ED-REPAIR-004: partial recovery failure retains facts, accurate reasons, and progress in persistent journal
    updateRefactorRecoveryJournalV2(targetEntry.recoveryId, (current) => ({
      ...current,
      status: "recovery-required",
      verification: {
        ...current.verification,
        mismatchedUris: Object.freeze(problems.map((p) => p.split(":")[0]?.trim() || p)),
        checkedAt: Date.now(),
        reversedMoves: Object.freeze([...(current.verification?.reversedMoves ?? []), ...execution.reversedMoves]),
        lastRecoveryError: problems.join("; "),
        restoredUris: Object.freeze([...(current.verification?.restoredUris ?? []), ...execution.restoredUris]),
      },
    }));
    // Keep the review open with a visible error so the user can retry,
    // keep pending, or abandon this record. Refresh preconditions so the
    // dialog reflects the post-attempt states.
    try {
      const refreshed = await controllerContext.classifyRecoveryEntry(targetEntry);
      if (!released()) {
        controllerContext.setRefactorRecoveryReview((current) => (
          current && current.entry.recoveryId === recoveryId
            ? {
              ...current,
              preconditions: refreshed,
              loading: false,
              busy: false,
              error: `Restore incomplete: restored ${execution.restoredUris.length} of ${targetEntry.documents.length} file(s). ${problems.join("; ")}`,
            }
            : current
        ));
      }
    } catch (error) {
      if (!released()) {
        controllerContext.setRefactorRecoveryReview((current) => (
          current && current.entry.recoveryId === recoveryId
            ? {
              ...current,
              busy: false,
              error: `Restore incomplete: restored ${execution.restoredUris.length} of ${targetEntry.documents.length} file(s). ${problems.join("; ")}`,
            }
            : current
        ));
      }
    } finally {
      controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
    }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controllerContext.setRefactorRecoveryReview((current) => (
        current && current.entry.recoveryId === targetEntry.recoveryId
          ? { ...current, busy: false, error: `Restore failed: ${message}` }
          : current
      ));
      controllerContext.refactorRecoveryBusyRef.current.delete(targetEntry.recoveryId);
    }
  };
}
