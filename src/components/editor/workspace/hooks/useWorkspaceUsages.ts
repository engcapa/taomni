import { useCallback } from "react";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { type LspDocumentDescriptor,type LspPosition } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createRunFindReferences } from "../controller/navigationActions";
import { type UsagesScopeSelection } from "../usageQuerySession";
import { WorkspaceSemanticQueryHost } from "../workspaceSemanticQueryHost";
import type { WorkspaceUsagesState } from "./useWorkspaceUsagesState";


export interface UseWorkspaceUsagesContext {
  usages: WorkspaceUsagesState;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  beginSemanticQuery: (kind: import("../workspaceSemanticQueryHost").SemanticQueryKind, file: OpenFileState, descriptor: LspDocumentDescriptor, position: LspPosition) => { identity: import("../workspaceSemanticQueryHost").SemanticQueryIdentity; cancelKey: string; requestSeq: number; guards: import("../workspaceSemanticQueryHost").SemanticQueryLiveGuards; isCurrent: (candidate?: import("../workspaceSemanticQueryHost").SemanticQueryIdentity) => boolean; lspOptions: (signal: AbortSignal) => { signal: AbortSignal; cancelKey: string; requestSeq: number; }; };
  workspaceInstanceId: string;
  lspSessionGeneration: () => number;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
}

export function useWorkspaceUsages(context: UseWorkspaceUsagesContext) {
  const {
    setBottomDockOpen,
    setBottomDockTab,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    beginSemanticQuery,
    workspaceInstanceId,
    lspSessionGeneration,
    rootsRef,
    semanticQueryHostRef,
    updateLspStatusForFile,
    projectAnalysisSnapshot,
    setStatusMessage,
    openFilesRef,
  } = context;
  const { referencesRequestSequenceRef, setReferencesResult, usageSessionRef, referencesRerunRef, setUsagesRecentsRevision, referencesPinnedRef, setUsagesScopeDialog, findReferencesRef, setUsagesScopeSelection, usagesScopeDialog, usagesScopeSelection } = context.usages;

  const runFindReferences = useCallback(
    createRunFindReferences({
      referencesRequestSequenceRef,
      setBottomDockOpen,
      setBottomDockTab,
      setReferencesResult,
      usageSessionRef,
      semanticIndex,
      ensureWorkspaceSemanticDocumentsSynced,
      lspDescriptorForFile,
      beginSemanticQuery,
      workspaceInstanceId,
      lspSessionGeneration,
      rootsRef,
      semanticQueryHostRef,
      updateLspStatusForFile,
      referencesRerunRef,
      projectAnalysisSnapshot,
      setUsagesRecentsRevision,
      setStatusMessage,
    }),
    [
      beginSemanticQuery,
      ensureWorkspaceSemanticDocumentsSynced,
      lspDescriptorForFile,
      lspSessionGeneration,
      projectAnalysisSnapshot?.projectFingerprint,
      rootsRef,
      semanticIndex.beginBuild,
      semanticIndex.abandonBuild,
      semanticIndex.current,
      semanticIndex.failBuild,
      semanticIndex.finishQuery,
      setStatusMessage,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );

  // §8.20.5: manual Find Usages opens the scope dialog first; the recorded
  // selection then drives the request (rerun reuses it without asking).
  const findReferences = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      if (referencesPinnedRef.current) {
        const replacePinned = await confirmAppDialog({
          title: "Replace Pinned Usages",
          message: "The references result is pinned. Replace it with a new Find Usages session?",
          confirmLabel: "Replace",
        });
        if (!replacePinned) {
          setStatusMessage("Kept the pinned usages result; new request cancelled");
          return;
        }
      }
      setUsagesScopeDialog({ open: true, file, position });
    },
    [setStatusMessage],
  );
  findReferencesRef.current = findReferences;

  const confirmUsagesScope = useCallback((selection: UsagesScopeSelection) => {
    setUsagesScopeSelection(selection);
    const pending = usagesScopeDialog;
    setUsagesScopeDialog(null);
    if (pending) void runFindReferences(pending.file, pending.position, selection);
  }, [runFindReferences, usagesScopeDialog]);

  // §8.19.7 rerun: replay against the recorded origin uri+position marker so
  // the same symbol identity is re-queried even after the caret moved — with
  // the LAST scope selection, no dialog (refresh semantics).
  const rerunFindReferences = useCallback(() => {
    const marker = referencesRerunRef.current;
    if (!marker) return;
    const live = openFilesRef.current[marker.fileKey];
    if (!live) {
      setStatusMessage("The usages session's origin buffer is closed; reopen it to rerun");
      return;
    }
    void runFindReferences(live, marker.position, usagesScopeSelection);
  }, [findReferences, runFindReferences, setStatusMessage, usagesScopeSelection]);
  return { findReferences, rerunFindReferences, confirmUsagesScope };
}
