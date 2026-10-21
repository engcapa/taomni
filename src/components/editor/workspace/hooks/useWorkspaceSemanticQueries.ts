import { useCallback, useEffect, useRef } from "react";
import { type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createBeginSemanticQuery } from "../controller/semanticQueries";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { WorkspaceSemanticQueryHost } from "../workspaceSemanticQueryHost";


export interface UseWorkspaceSemanticQueriesContext {
  publishWorkspaceObservation: (update: (bridge: WorkspaceObservationBridge) => void) => void;
  workspaceInstanceId: string;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspSessionGeneration: () => number;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  projectFactsRoot: string;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
}

export function useWorkspaceSemanticQueries(context: UseWorkspaceSemanticQueriesContext) {
  const { publishWorkspaceObservation, workspaceInstanceId, openFilesRef, lspSessionGeneration, rootsRef, projectFactsRoot, lspDescriptorForFile } = context;

  const semanticQueryHostRef = useRef(new WorkspaceSemanticQueryHost({
    onRequest: ({ kind }) => {
      publishWorkspaceObservation((bridge) => bridge.observeProviderRequest(kind));
    },
    onCancel: ({ kind }) => {
      publishWorkspaceObservation((bridge) => bridge.observeProviderCancel(kind));
    },
  }));
  const workspaceInstanceIdRef = useRef(workspaceInstanceId);
  workspaceInstanceIdRef.current = workspaceInstanceId;
  const semanticQuerySequenceRef = useRef(0);
  const semanticQueryLatestRequestRef = useRef<Record<string, string>>({});

  const beginSemanticQuery = useCallback(createBeginSemanticQuery({
    openFilesRef,
    lspSessionGeneration,
    workspaceInstanceId,
    semanticQuerySequenceRef,
    semanticQueryLatestRequestRef,
    rootsRef,
    projectFactsRoot,
    lspDescriptorForFile,
    workspaceInstanceIdRef,
  }), [lspDescriptorForFile, lspSessionGeneration, projectFactsRoot, workspaceInstanceId]);

  useEffect(() => {
    const queryHost = semanticQueryHostRef.current;
    return () => queryHost.cancelWorkspace(workspaceInstanceId);
  }, [workspaceInstanceId]);
  return { workspaceInstanceIdRef, semanticQueryHostRef, beginSemanticQuery };
}
