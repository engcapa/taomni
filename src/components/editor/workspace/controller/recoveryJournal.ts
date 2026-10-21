import { workspaceListDir, workspaceReadFile, workspaceReadLooseFile } from "../../../../lib/editor/workspace";
import { getRefactorRecoveryJournalV2, updateRefactorRecoveryJournalV2, isPendingRefactorRecoveryEntry, dismissRefactorRecoveryEntry, type RefactorRecoveryJournalEntryV2 } from "../refactorPlan";
import { type RefactorRecoveryPreconditionSummary } from "../refactorRecoveryController";
import { type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, fsPathEquals, normalizeFsPath, parentPath, relativePathWithinRoot } from "../codeWorkspaceModel";



export interface ReadWorkspaceEditPathSnapshotContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
}


export function createReadWorkspaceEditPathSnapshot(controllerContext: ReadWorkspaceEditPathSnapshotContext): (absolutePath: string) => Promise<WorkspaceEditPathSnapshot | null> {
  return async (
    absolutePath: string,
  ): Promise<WorkspaceEditPathSnapshot | null> => {
    const normalizedPath = normalizeFsPath(absolutePath);
    const open = Object.values(controllerContext.openFilesRef.current).find((file) => {
      const path = controllerContext.absolutePathForOpenFile(file);
      return path != null && fsPathEquals(path, normalizedPath);
    });
    if (open && !open.loading) return {
      path: normalizedPath,
      exists: true,
      text: open.text,
      encoding: open.encoding ?? "UTF-8",
      bom: open.bom ?? false,
      eol: open.eol ? (open.eol.toLowerCase() as "lf" | "crlf" | "cr") : undefined,
    };
    for (const root of controllerContext.rootsRef.current) {
      const relative = relativePathWithinRoot(root.path, normalizedPath);
      if (relative === null) continue;
      if (!relative) return null;
      try {
        const listing = await workspaceListDir(root.path, parentPath(relative));
        if (listing.state !== "ready") return null;
        const entry = listing.entries.find((candidate) => candidate.path === relative);
        if (!entry) return { path: normalizedPath, exists: false, text: null };
        // Restoring a directory, symlink, or special node as a regular file
        // would be data loss. Those transactions remain deliberately ineligible.
        if (entry.fileType !== "file") return null;
        const file = await workspaceReadFile(root.path, relative);
        const eol = file.text.includes("\r\n") ? ("crlf" as const) : file.text.includes("\r") && !file.text.includes("\n") ? ("cr" as const) : ("lf" as const);
        return {
          path: normalizedPath,
          exists: true,
          text: file.text,
          encoding: file.encoding ?? "UTF-8",
          bom: file.bom ?? false,
          eol,
        };
      } catch {
        return null;
      }
    }
    try {
      const file = await workspaceReadLooseFile(normalizedPath);
      const eol = file.text.includes("\r\n") ? ("crlf" as const) : file.text.includes("\r") && !file.text.includes("\n") ? ("cr" as const) : ("lf" as const);
      return {
        path: normalizedPath,
        exists: true,
        text: file.text,
        encoding: file.encoding ?? "UTF-8",
        bom: file.bom ?? false,
        eol,
      };
    } catch {
      return { path: normalizedPath, exists: false, text: null };
    }
  };
}



export interface RunRecoveryDismissContext {
  workspaceInstanceIdRef: import("react").RefObject<string>;
  refactorRecoveryBusyRef: import("react").RefObject<Set<string>>;
  setRefactorRecoveryReview: import("react").Dispatch<import("react").SetStateAction<{ entry: RefactorRecoveryJournalEntryV2; ownerInstanceId: string; preconditions: RefactorRecoveryPreconditionSummary | null; loading: boolean; error: string | null; busy: boolean; } | null>>;
  setStatusMessage: (message: string) => void;
  closeRefactorRecoveryReview: (recoveryId: string) => void;
}


export function createRunRecoveryDismiss(controllerContext: RunRecoveryDismissContext): (targetEntry: RefactorRecoveryJournalEntryV2, ownerInstanceId: string) => Promise<void> {
  return async (
    targetEntry: RefactorRecoveryJournalEntryV2,
    ownerInstanceId: string,
  ): Promise<void> => {
    const released = () => controllerContext.workspaceInstanceIdRef.current !== ownerInstanceId;
    const recoveryId = targetEntry.recoveryId;
    if (released()) return;
    if (controllerContext.refactorRecoveryBusyRef.current.has(recoveryId)) return;
    controllerContext.refactorRecoveryBusyRef.current.add(recoveryId);
    controllerContext.setRefactorRecoveryReview((current) => (
      current && current.entry.recoveryId === recoveryId ? { ...current, busy: true, error: null } : current
    ));
    try {
      // Re-read the latest record synchronously before comparing: no await
      // between the freshness check and the dismiss write inside the helper.
      const latest = getRefactorRecoveryJournalV2(recoveryId);
      if (!latest) {
        throw new Error("recovery entry is missing; refresh and try again");
      }
      if (latest.workspaceRoot !== targetEntry.workspaceRoot || latest.transactionId !== targetEntry.transactionId) {
        throw new Error("recovery entry changed to a different transaction; refresh and confirm again");
      }
      if (!isPendingRefactorRecoveryEntry(latest)) {
        // Already resolved elsewhere: close quietly without file effects.
        controllerContext.setStatusMessage("Refactor recovery entry is no longer pending.");
        controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
        controllerContext.closeRefactorRecoveryReview(recoveryId);
        return;
      }
      const result = dismissRefactorRecoveryEntry(recoveryId, targetEntry.updatedAt);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      if (released()) return;
      const affectedCount = targetEntry.documents.length + (targetEntry.resourceMoves ?? []).length;
      controllerContext.setStatusMessage(
        `Abandoned refactor recovery for ${affectedCount} file(s); files left exactly as they are now.`,
      );
      controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
      controllerContext.closeRefactorRecoveryReview(recoveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!released()) {
        controllerContext.setRefactorRecoveryReview((current) => (
          current && current.entry.recoveryId === recoveryId
            ? { ...current, busy: false, error: `Could not abandon recovery: ${message}` }
            : current
        ));
      }
      controllerContext.refactorRecoveryBusyRef.current.delete(recoveryId);
    }
  };
}



export interface PromptRefactorRecoveryEntryContext {
  workspaceInstanceIdRef: import("react").RefObject<string>;
  refactorRecoveryBusyRef: import("react").RefObject<Set<string>>;
  refactorRecoveryResolveRef: import("react").RefObject<Map<string, () => void>>;
  setRefactorRecoveryReview: import("react").Dispatch<import("react").SetStateAction<{ entry: RefactorRecoveryJournalEntryV2; ownerInstanceId: string; preconditions: RefactorRecoveryPreconditionSummary | null; loading: boolean; error: string | null; busy: boolean; } | null>>;
  classifyRecoveryEntry: (entry: RefactorRecoveryJournalEntryV2) => Promise<RefactorRecoveryPreconditionSummary>;
  closeRefactorRecoveryReview: (recoveryId: string) => void;
  setStatusMessage: (message: string) => void;
}


export function createPromptRefactorRecoveryEntry(controllerContext: PromptRefactorRecoveryEntryContext): (entry: RefactorRecoveryJournalEntryV2, ownerInstanceId: string) => Promise<void> {
  return async (
    entry: RefactorRecoveryJournalEntryV2,
    ownerInstanceId: string,
  ): Promise<void> => {
    const released = () => controllerContext.workspaceInstanceIdRef.current !== ownerInstanceId;
    if (released()) return;
    // RC-02: dismissed/committed entries are never pending; skip without UI.
    const latestAtOpen = getRefactorRecoveryJournalV2(entry.recoveryId) ?? entry;
    if (!isPendingRefactorRecoveryEntry(latestAtOpen)) return;
    if (controllerContext.refactorRecoveryBusyRef.current.has(entry.recoveryId)) return;
    // Bridge the dialog's user action back to the sequential discover loop:
    // resolve only when the review closes (keep/restore-success/dismiss).
    // Restore/dismiss failures keep the dialog open and do not resolve.
    await new Promise<void>((resolve) => {
      controllerContext.refactorRecoveryResolveRef.current.set(entry.recoveryId, resolve);
      controllerContext.setRefactorRecoveryReview({
        entry: latestAtOpen,
        ownerInstanceId,
        preconditions: null,
        loading: true,
        error: null,
        busy: false,
      });
      void (async () => {
        try {
          const preconditions = await controllerContext.classifyRecoveryEntry(latestAtOpen);
          if (released()) {
            controllerContext.closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          if (preconditions.overall === "already-restored") {
            updateRefactorRecoveryJournalV2(entry.recoveryId, (currentEntry) => ({
              ...currentEntry,
              status: "rolled-back",
              verification: { mismatchedUris: Object.freeze([]), checkedAt: Date.now() },
            }));
            controllerContext.setStatusMessage("Refactor recovery: every affected file already matches its pre-refactor content; entry closed.");
            controllerContext.closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          // Functional update with creation fallback: the loading state set
          // above may not have rendered yet when a fast classify resolves
          // (state updater would see null and drop this update). Either way
          // the dialog ends loaded with preconditions.
          controllerContext.setRefactorRecoveryReview((currentState) => {
            if (currentState && currentState.entry.recoveryId === entry.recoveryId) {
              return { ...currentState, preconditions, loading: false };
            }
            if (!currentState) {
              return {
                entry: latestAtOpen,
                ownerInstanceId,
                preconditions,
                loading: false,
                error: null,
                busy: false,
              };
            }
            return currentState;
          });
        } catch (error) {
          if (released()) {
            controllerContext.closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          const message = `Could not verify the pending entry: ${error instanceof Error ? error.message : String(error)}`;
          controllerContext.setRefactorRecoveryReview((currentState) => {
            if (currentState && currentState.entry.recoveryId === entry.recoveryId) {
              return { ...currentState, loading: false, error: message };
            }
            if (!currentState) {
              return {
                entry: latestAtOpen,
                ownerInstanceId,
                preconditions: null,
                loading: false,
                error: message,
                busy: false,
              };
            }
            return currentState;
          });
        }
      })();
    });
  };
}
