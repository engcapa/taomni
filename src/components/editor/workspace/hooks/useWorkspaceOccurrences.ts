import { useCallback } from "react";
import { type LspDocumentDescriptor, type LspLocation } from "../../../../lib/editor/lsp";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createHighlightUsagesInFile } from "../controller/semanticQueries";
import { formatOccurrenceStatus, stepOccurrence } from "../occurrenceHighlightModel";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";


export interface UseWorkspaceOccurrencesContext {
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  activeEditorGroupId: string;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspDocumentEpochRef: import("react").RefObject<Record<string, number>>;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeLspDocumentIsSynced: boolean;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  isCurrentLspDocumentRequest: (file: OpenFileState, epoch: number) => boolean;
  setStatusMessage: (message: string) => void;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
}

export function useWorkspaceOccurrences(context: UseWorkspaceOccurrencesContext) {
  const {
    telemetry,
    activeEditorGroupId,
    activeFile,
    lspDescriptorForFile,
    lspDocumentEpochRef,
    activeCapabilities,
    activeLspDocumentIsSynced,
    openFilesRef,
    isCurrentLspDocumentRequest,
    setStatusMessage,
    revealEditorLocation,
  } = context;

  const activateNavigationBar = useCallback(() => {
    telemetry.setNavigationBarActiveByGroup((prev) => ({
      ...prev,
      [activeEditorGroupId]: true,
    }));
  }, [activeEditorGroupId]);

  const highlightUsagesInFile = useCallback(createHighlightUsagesInFile({
    activeFile,
    occurrenceRequestGenerationRef: telemetry.occurrenceRequestGenerationRef,
    autoHighlightRequestGenerationRef: telemetry.autoHighlightRequestGenerationRef,
    cursorPositionsRef: telemetry.cursorPositionsRef,
    activeEditorGroupId,
    lspDescriptorForFile,
    lspDocumentEpochRef,
    activeCapabilities,
    activeLspDocumentIsSynced,
    occurrenceActiveFileKeyRef: telemetry.occurrenceActiveFileKeyRef,
    occurrenceActiveGroupIdRef: telemetry.occurrenceActiveGroupIdRef,
    openFilesRef,
    isCurrentLspDocumentRequest,
    setStatusMessage,
    setOccurrenceSession: telemetry.setOccurrenceSession,
    occurrenceSessionRef: telemetry.occurrenceSessionRef,
    setHighlightsByGroupNow: telemetry.setHighlightsByGroupNow,
  }), [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    setStatusMessage,
  ]);

  const navigateOccurrence = useCallback((direction: "next" | "previous") => {
    const session = telemetry.occurrenceSessionRef.current;
    if (!session || !activeFile || session.fileKey !== activeFile.key) {
      setStatusMessage("No active occurrence highlight session");
      return;
    }
    const { session: nextSession, current } = stepOccurrence(session, direction);
    telemetry.setOccurrenceSession(nextSession);
    telemetry.occurrenceSessionRef.current = nextSession;
    if (current) {
      revealEditorLocation(activeFile.key, current.range);
    }
    setStatusMessage(formatOccurrenceStatus(nextSession));
  }, [activeFile, revealEditorLocation, setStatusMessage]);

  const clearHighlightUsages = useCallback(() => {
    const session = telemetry.occurrenceSessionRef.current;
    telemetry.autoHighlightRequestGenerationRef.current += 1;
    telemetry.occurrenceRequestGenerationRef.current += 1;
    if (!session) return false;
    telemetry.setOccurrenceSession(null);
    telemetry.occurrenceSessionRef.current = null;
    telemetry.setHighlightsByGroupNow((current) => ({
      ...current,
      [activeEditorGroupId]: [],
    }));
    setStatusMessage("Occurrence highlights cleared");
    return true;
  }, [activeEditorGroupId, setStatusMessage]);
  return { activateNavigationBar, highlightUsagesInFile, navigateOccurrence, clearHighlightUsages };
}
