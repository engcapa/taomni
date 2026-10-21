import { useCallback, useMemo } from "react";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createShowEditorContextMenu } from "../controller/editorMenus";
import { createGetLspHover } from "../controller/semanticQueries";
import { useProjectDiagnostics } from "../controller/useProjectDiagnostics";
import { type ProblemFileGroup } from "../panels/ProblemsPanel";
import { useSemanticNavigation } from "./useSemanticNavigation";
import { useSymbolRefactoring } from "./useSymbolRefactoring";
import { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceCommandRouting } from "./useWorkspaceCommandRouting";
import { useWorkspaceCompletion } from "./useWorkspaceCompletion";
import { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import { useWorkspaceEditingFeatures } from "./useWorkspaceEditingFeatures";
import { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import { useWorkspaceParameterInfo } from "./useWorkspaceParameterInfo";
import { useWorkspaceProblemPresentation } from "./useWorkspaceProblemPresentation";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceSemanticFeatures } from "./useWorkspaceSemanticFeatures";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";
import { useWorkspaceUsages } from "./useWorkspaceUsages";


export interface UseWorkspaceIntelligenceRuntimeContext {
  session: ReturnType<typeof useWorkspaceSession>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
  semantics: ReturnType<typeof useWorkspaceSemanticFeatures>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  editorFeatures: ReturnType<typeof useWorkspaceEditingFeatures>;
  commands: ReturnType<typeof useWorkspaceCommandRouting>;
}

export function useWorkspaceIntelligenceRuntime(context: UseWorkspaceIntelligenceRuntimeContext) {
  const { session, project, editing, ports, semantics, files, surfaceState, editorFeatures, commands } = context;
  const completion = useWorkspaceCompletion({
    openFilesRef: session.bufferState.openFilesRef,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    projectFactsRoot: project.projectFactsRoot,
    workspaceInstanceId: session.workspaceInstanceId,
    lspSessionGeneration: project.lsp.sessionGeneration,
    setStatusMessage: session.setStatusMessage,
    projectDescriptorDiscovery: project.projectDescriptorDiscovery,
    projectFacts: project.projectFacts,
    lspFilesRef: session.bufferState.lspFilesRef,
    ensureLspDocumentSynced: editing.documents.ensureLspDocumentSynced,
    updateLspStatusForFile: project.lsp.updateStatus,
  });
  const parameterInfo = useWorkspaceParameterInfo({
    openFilesRef: session.bufferState.openFilesRef,
    lspFilesRef: session.bufferState.lspFilesRef,
    ensureLspDocumentSynced: editing.documents.ensureLspDocumentSynced,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    workspaceInstanceId: session.workspaceInstanceId,
    lspSessionGeneration: project.lsp.sessionGeneration,
    updateLspStatusForFile: project.lsp.updateStatus,
    activeFile: editing.documentLanguage.activeFile,
    parameterInfoSession: session.referenceSessions.parameterInfoSession,
  });

  const getLspHover = useCallback(
    createGetLspHover({
      debugRef: ports.debugRef,
      absolutePathForOpenFile: editing.absolutePathForOpenFile,
      lspDescriptorForFile: project.lsp.descriptorForFile,
      lspSessionGeneration: project.lsp.sessionGeneration,
      referenceInfoController: session.referenceSessions.referenceInfoController,
      workspaceInstanceId: session.workspaceInstanceId,
      lspFilesRef: session.bufferState.lspFilesRef,
      openFilesRef: session.bufferState.openFilesRef,
      updateLspStatusForFile: project.lsp.updateStatus,
      setLspFiles: project.buffers.setLspFiles,
    }),
    [
      editing.absolutePathForOpenFile,
      project.lsp.descriptorForFile,
      project.lsp.sessionGeneration,
      session.referenceSessions.referenceInfoController,
      project.lsp.updateStatus,
      session.workspaceInstanceId,
    ],
  );
  ports.getLspHoverRef.current = getLspHover;
  const semanticNavigation = useSemanticNavigation({
    setStatusMessage: session.setStatusMessage,
    setLocationPeek: project.uiActions.setLocationPeek,
    openLspLocation: semantics.librarySources.openLspLocation,
    recordNavigationLocation: files.navigation.recordNavigationLocation,
    openFilesRef: session.bufferState.openFilesRef,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    lspFilesRef: session.bufferState.lspFilesRef,
    ensureLspDocumentSynced: editing.documents.ensureLspDocumentSynced,
    beginSemanticQuery: project.semanticQueries.beginSemanticQuery,
    semanticQueryHostRef: project.semanticQueries.semanticQueryHostRef,
    updateLspStatusForFile: project.lsp.updateStatus,
    goToDefinitionRef: ports.goToDefinitionRef,
    peekDefinitionRef: ports.peekDefinitionRef,
    goToDeclarationRef: ports.goToDeclarationRef,
    goToTypeDefinitionRef: ports.goToTypeDefinitionRef,
    goToImplementationRef: ports.goToImplementationRef,
  });
  const refactoring = useSymbolRefactoring({
    rootRef: surfaceState.rootRef,
    activeEditorGroupIdRef: surfaceState.activeEditorGroupIdRef,
    openFilesRef: session.bufferState.openFilesRef,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    lspFilesRef: session.bufferState.lspFilesRef,
    activeKey: session.workspaceUi.activeKey,
    semanticIndex: session.semanticIndex,
    setStatusMessage: session.setStatusMessage,
    ensureWorkspaceSemanticDocumentsSynced: editing.documents.ensureWorkspaceSemanticDocumentsSynced,
    updateLspStatusForFile: project.lsp.updateStatus,
    lspSessionGeneration: project.lsp.sessionGeneration,
    projectAnalysisSnapshot: project.projectAnalysis.snapshot,
    rootsRef: project.projectTree.rootsRef,
    buildPlanOpenFiles: editing.editPlanning.buildPlanOpenFiles,
    applyLspWorkspaceEdit: semantics.editTransactions.applyLspWorkspaceEdit,
    activeFile: editing.documentLanguage.activeFile,
    editorSelectionRef: session.editorSelectionRef,
    renameSymbolRef: ports.renameSymbolRef,
    workspaceInstanceId: session.workspaceInstanceId,
    revealNavLocation: files.revealNavLocation,
    intentionRequestAbortRef: semantics.codeActions.intentionRequestAbortRef,
    requestCodeActions: semantics.codeActions.requestCodeActions,
    editorPaneRef: surfaceState.editorPaneRef,
    showCodeActionsMenu: editorFeatures.intentions.showCodeActionsMenu,
    intentionSessionRef: semantics.codeActions.intentionSessionRef,
    runCodeAction: semantics.codeActions.runCodeAction,
    runExtractMethodRef: ports.runExtractMethodRef,
    referencesRequestSequenceRef: project.usages.referencesRequestSequenceRef,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setReferencesResult: project.usages.setReferencesResult,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    safeDeleteSymbolRef: ports.safeDeleteSymbolRef,
  });
  const usagesActions = useWorkspaceUsages({
    usages: project.usages,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    semanticIndex: session.semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced: editing.documents.ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    beginSemanticQuery: project.semanticQueries.beginSemanticQuery,
    workspaceInstanceId: session.workspaceInstanceId,
    lspSessionGeneration: project.lsp.sessionGeneration,
    rootsRef: project.projectTree.rootsRef,
    semanticQueryHostRef: project.semanticQueries.semanticQueryHostRef,
    updateLspStatusForFile: project.lsp.updateStatus,
    projectAnalysisSnapshot: project.projectAnalysis.snapshot,
    setStatusMessage: session.setStatusMessage,
    openFilesRef: session.bufferState.openFilesRef,
  });

  const showEditorContextMenu = useCallback(createShowEditorContextMenu({
    editorSelectionRef: session.editorSelectionRef,
    lspFilesRef: session.bufferState.lspFilesRef,
    activeEditorGroupIdRef: surfaceState.activeEditorGroupIdRef,
    actionsController: commands.actionsController,
    executeEditorCommandFor: session.editorCommands.executeEditorCommandFor,
    debugRef: ports.debugRef,
    breadcrumbSymbolsRef: project.telemetry.breadcrumbSymbolsRef,
    openEditorContextMenuAt: files.treeInteractions.openEditorContextMenuAt,
    t: session.t,
    editorAiPreferencesRef: session.preferences.editorAiPreferencesRef,
  }), [
    editing.absolutePathForOpenFile,
    commands.actionsController,
    session.editorCommands.editorCommandStateFor,
    session.editorCommands.executeEditorCommandFor,
    files.treeInteractions.openEditorContextMenuAt,
    session.setStatusMessage,
    session.t,
  ]);

  const deferredActiveFile = session.workspaceUi.activeKey ? semantics.deferredOpenFiles[session.workspaceUi.activeKey] ?? editing.documentLanguage.activeFile : null;
  const dirtyCount = useMemo(
    () => Object.values(session.workspaceUi.openFiles).filter((file) => file.dirty).length,
    [session.workspaceUi.openFiles],
  );
  const dirtyFiles = useMemo(
    () => session.workspaceUi.openOrder.map((key) => session.workspaceUi.openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [session.workspaceUi.openFiles, session.workspaceUi.openOrder],
  );
  const problemFiles = useMemo<ProblemFileGroup[]>(
    () => session.workspaceUi.openOrder.flatMap((key) => {
      const file = semantics.deferredOpenFiles[key];
      const diagnostics = session.workspaceUi.lspFiles[key]?.diagnostics ?? [];
      return file && diagnostics.length > 0
        ? [{ key, title: file.title, subtitle: file.subtitle, path: project.inspections.inspectionPathForFileKey(key), diagnostics }]
        : [];
    }),
    [semantics.deferredOpenFiles, project.inspections.inspectionPathForFileKey, session.workspaceUi.lspFiles, session.workspaceUi.openOrder],
  );
  const projectDiagnostics = useProjectDiagnostics({
    rootsRef: project.projectTree.rootsRef,
    openFilesRef: session.bufferState.openFilesRef,
    looseFilesRef: project.projectTree.looseFilesRef,
    workspaceInstanceId: session.workspaceInstanceId,
    mountedRef: session.mountedRef,
    findRoot: project.projectTree.findRoot,
    inspectionPathForFileKey: project.inspections.inspectionPathForFileKey,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    lspDescriptorForPath: project.lsp.descriptorForPath,
    setStatusMessage: session.setStatusMessage,
  });

  const problemsScopeFiles = projectDiagnostics.problemsScope === "project" ? projectDiagnostics.projectProblemFiles : problemFiles;
  const analysisFiles = problemsScopeFiles;
  const problems = useWorkspaceProblemPresentation({
    problemsScopeFiles,
    lspFilesRef: session.bufferState.lspFilesRef,
    lspSessionGeneration: project.lsp.sessionGeneration,
    projectAnalysisSnapshot: project.projectAnalysis.snapshot,
    openFilesRef: session.bufferState.openFilesRef,
    suppressedInSourceKeys: semantics.codeActions.suppressedInSourceKeys,
    inspectionPathForFileKey: project.inspections.inspectionPathForFileKey,
    persistInspectionProfile: project.inspections.persistInspectionProfile,
    setStatusMessage: session.setStatusMessage,
    inspectionTransform: project.inspections.inspectionTransform,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
    openFile: files.openFile,
    problemPathToRef: projectDiagnostics.problemPathToRef,
    openLspLocation: semantics.librarySources.openLspLocation,
  });
  return {
    refactoring,
    semanticNavigation,
    projectDiagnostics,
    deferredActiveFile,
    dirtyFiles,
    parameterInfo,
    getLspHover,
    usagesActions,
    completion,
    showEditorContextMenu,
    problems,
    problemsScopeFiles,
    analysisFiles,
    dirtyCount,
  };
}
