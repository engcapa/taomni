import type { HierarchyPanel } from "../panels/HierarchyPanel";
import { useState, useCallback, useRef, type ComponentProps } from "react";
import { type LspDocumentDescriptor, type LspPosition } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { createOpenHierarchy } from "../controller/navigationActions";
import { type HierarchyRootState } from "../hierarchyQueryModel";
import { WorkspaceSemanticQueryHost } from "../workspaceSemanticQueryHost";


export interface UseWorkspaceHierarchyContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  activeEditorGroupId: string;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspSessionGeneration: () => number;
  workspaceInstanceId: string;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  semanticQueryHostRef: import("react").RefObject<WorkspaceSemanticQueryHost>;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
}

export function useWorkspaceHierarchy(context: UseWorkspaceHierarchyContext) {
  const {
    activeFile,
    lspDescriptorForFile,
    setStatusMessage,
    lspFilesRef,
    cursorPositionsRef,
    activeEditorGroupId,
    editorSelectionRef,
    openFilesRef,
    lspSessionGeneration,
    workspaceInstanceId,
    workspaceInstanceIdRef,
    semanticQueryHostRef,
    projectAnalysisSnapshot,
    updateLspStatusForFile,
    setBottomDockTab,
    setBottomDockOpen,
  } = context;

  const [callHierarchyRoot, setCallHierarchyRoot] = useState<HierarchyRootState | null>(null);
  const hierarchyRequestSequenceRef = useRef(0);
  // §8.20.5 W4: per-mode provenance for stale detection (provider restart /
  // project fingerprint move) surfaced as a Rerun banner in HierarchyPanel.
  const hierarchyProvenanceRef = useRef<Partial<Record<"call" | "type", {
    generation: number;
    projectFingerprint: string;
  }>>>({});
  const [hierarchyProvenanceRevision, setHierarchyProvenanceRevision] = useState(0);
  const [typeHierarchyRoot, setTypeHierarchyRoot] = useState<HierarchyRootState | null>(null);


  const openHierarchy = useCallback(createOpenHierarchy({
    activeFile,
    lspDescriptorForFile,
    setStatusMessage,
    lspFilesRef,
    cursorPositionsRef,
    activeEditorGroupId,
    editorSelectionRef,
    openFilesRef,
    lspSessionGeneration,
    hierarchyRequestSequenceRef,
    workspaceInstanceId,
    workspaceInstanceIdRef,
    semanticQueryHostRef,
    projectAnalysisSnapshot,
    updateLspStatusForFile,
    hierarchyProvenanceRef,
    setHierarchyProvenanceRevision,
    setCallHierarchyRoot,
    setBottomDockTab,
    setTypeHierarchyRoot,
    setBottomDockOpen,
  }), [
    activeEditorGroupId,
    activeFile,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    lspDescriptorForFile,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceInstanceId,
  ]);
  const hierarchyPanelProps = (mode: "call" | "type"): Omit<ComponentProps<typeof HierarchyPanel>, "active" | "onOpenLocation"> => {
    const root = mode === "call" ? callHierarchyRoot : typeHierarchyRoot;
    const provenance = hierarchyProvenanceRef.current[mode];
    void hierarchyProvenanceRevision;
    let staleReason: string | null = null;
    if (provenance && root) {
      if (provenance.generation !== lspSessionGeneration()) {
        staleReason = "Provider restarted since this hierarchy was prepared";
      } else {
        const current = projectAnalysisSnapshot?.projectFingerprint ?? "";
        if (current && provenance.projectFingerprint !== current) {
          staleReason = "Project model changed since this hierarchy was prepared";
        }
      }
    }
    return {
      mode,
      root,
      staleReason,
      onRerunStale: () => void openHierarchy(mode),
      queryHost: semanticQueryHostRef.current,
      liveLspGeneration: lspSessionGeneration,
      liveDocumentRevision: () => openFilesRef.current[root?.fileKey ?? ""]?.documentRevision ?? -1,
      onStatus: (status) => {
        if (activeFile) updateLspStatusForFile(activeFile, status);
      },
    };
  };
  return { openHierarchy, hierarchyPanelProps };
}
