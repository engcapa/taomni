import { type SaveObservationState } from "../saveObservationContract";
import { useWorkspaceRecoveryState } from "./useWorkspaceRecoveryState";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";


export interface UseWorkspaceAnnouncementsContext {
  activeKey: string | null;
  recoveryState: ReturnType<typeof useWorkspaceRecoveryState>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
}

export function useWorkspaceAnnouncements(context: UseWorkspaceAnnouncementsContext) {
  const { activeKey, recoveryState, activeFile, uiActions } = context;
  const latestSaveObservation = activeKey ? recoveryState.saveObservations[activeKey] ?? null : null;
  const activeSaveObservationState: SaveObservationState = (() => {
    if (activeFile?.saving) return "saving";
    if (
      activeFile
      && latestSaveObservation
      && latestSaveObservation.bufferRevision !== (activeFile.documentRevision ?? 0)
    ) {
      return activeFile.dirty ? "dirty" : "clean";
    }
    if (
      activeFile
      && latestSaveObservation
      && latestSaveObservation.bufferRevision === (activeFile.documentRevision ?? 0)
      && latestSaveObservation.state !== "saved"
      && latestSaveObservation.state !== "clean"
    ) {
      return latestSaveObservation.state;
    }
    if (activeFile?.dirty) return "dirty";
    return latestSaveObservation?.state ?? "clean";
  })();
  const activeSaveReceipt = latestSaveObservation?.latestReceipt ?? null;
  const activeSaveObservationLabel = activeFile?.title
    ?? latestSaveObservation?.filePath.split(/[\\/]/).pop()
    ?? "active file";
  const activeSaveAnnouncement = (() => {
    switch (activeSaveObservationState) {
      case "dirty": return `Unsaved changes in ${activeSaveObservationLabel}`;
      case "saving": return `Saving ${activeSaveObservationLabel}`;
      case "saved": return `Saved ${activeSaveObservationLabel}`;
      case "stale": return `Saved previous snapshot of ${activeSaveObservationLabel}; current changes remain unsaved`;
      case "conflict": return `Save conflict for ${activeSaveObservationLabel}`;
      case "error": return `Save failed for ${activeSaveObservationLabel}`;
      case "recovery": return `Save recovery required for ${activeSaveObservationLabel}`;
      default: return `${activeSaveObservationLabel} has no unsaved changes`;
    }
  })();
  // ED-CLIP-004: the announcement names the outcome AND the system effect
  // separately, because ownership and external effect are independent axes
  // (ED-CLIP-002): a stale generation after a completed OS write still performed
  // that write, and saying otherwise would be the collapse the spec forbids.
  const clipboardAnnouncement = (() => {
    const record = uiActions.latestClipboardObservation;
    if (!record) return "";
    const action = record.operation === "cut"
      ? "Cut"
      : record.operation === "copy"
        ? "Copy"
        : "Paste";
    const effect = record.systemEffect === "performed"
      ? "system clipboard effect performed"
      : record.systemEffect === "not-performed"
        ? "no system clipboard effect"
        : "system clipboard effect unknown";
    switch (record.outcome) {
      case "success":
        return `${action} completed; ${effect}`;
      case "denied":
        return `${action} denied by the system clipboard; ${effect}`
          + (record.usedWorkspaceFallback ? "; pasted from the workspace clipboard slot instead" : "");
      case "stale-generation":
        return `${action} ownership changed during the operation; ${effect}`
          + (record.usedWorkspaceFallback ? "; pasted from the workspace clipboard slot instead" : "");
      default:
        return `${action} could not reach the system clipboard; ${effect}`
          + (record.usedWorkspaceFallback ? "; pasted from the workspace clipboard slot instead" : "");
    }
  })();
  return {
    activeSaveObservationState,
    latestSaveObservation,
    activeSaveReceipt,
    activeSaveAnnouncement,
    clipboardAnnouncement,
  };
}
