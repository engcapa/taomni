import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import type { useWorkspaceCommandRouting } from "../hooks/useWorkspaceCommandRouting";
import type { useWorkspaceDocumentEditing } from "../hooks/useWorkspaceDocumentEditing";
import type { useWorkspaceEditingFeatures } from "../hooks/useWorkspaceEditingFeatures";
import { useWorkspaceExecutionRuntime } from "../hooks/useWorkspaceExecutionRuntime";
import type { useWorkspaceFileOpening } from "../hooks/useWorkspaceFileOpening";
import type { useWorkspaceIntelligenceRuntime } from "../hooks/useWorkspaceIntelligenceRuntime";
import type { useWorkspaceProjectRuntime } from "../hooks/useWorkspaceProjectRuntime";
import type { useWorkspaceSemanticFeatures } from "../hooks/useWorkspaceSemanticFeatures";
import type { useWorkspaceSession } from "../hooks/useWorkspaceSession";
import { useWorkspaceSurfaceComposition } from "../hooks/useWorkspaceSurfaceComposition";
import type { useWorkspaceSurfaceState } from "../hooks/useWorkspaceSurfaceState";
import { WorkspaceShellView } from "./WorkspaceShellView";


export interface CreateWorkspaceShellPropsContext {
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  insight: ReturnType<typeof useWorkspaceIntelligenceRuntime>;
  semantics: ReturnType<typeof useWorkspaceSemanticFeatures>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  session: ReturnType<typeof useWorkspaceSession>;
  commands: ReturnType<typeof useWorkspaceCommandRouting>;
  editorFeatures: ReturnType<typeof useWorkspaceEditingFeatures>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  executionRuntime: ReturnType<typeof useWorkspaceExecutionRuntime>;
  surfaces: ReturnType<typeof useWorkspaceSurfaceComposition>;
  visible: boolean;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
}

export function createWorkspaceShellProps(context: CreateWorkspaceShellPropsContext) {
  const {
    executionRuntime,
    surfaces,
    visible,
    onOpenGitManager,
    editing,
    insight,
    semantics,
    project,
    surfaceState,
    session,
    commands,
    editorFeatures,
    files,
  } = context;

  const { localHistoryTarget } = editing.localHistory;
  const { aiRewriteState } = editing.editorAi;
  const { inlineRename } = insight.refactoring;
  const { refactorRecoveryReview } = semantics.refactorRecovery;
  const { breakpointPopup } = executionRuntime.breakpoints;
  const { gutterMenu } = executionRuntime.breakpoints;
  const shellProps: import('react').ComponentProps<typeof WorkspaceShellView> = {
    workspaceGenerationPopupsProps: {
      newJavaClassDialogState: semantics.javaCreation.newJavaClassDialogState,
      setNewJavaClassDialogState: semantics.javaCreation.setNewJavaClassDialogState,
      createJavaClassFromPlan: semantics.javaCreation.createJavaClassFromPlan,
      setFileTemplateSettingsOpen: semantics.javaCreation.setFileTemplateSettingsOpen,
      fileTemplateSettingsOpen: semantics.javaCreation.fileTemplateSettingsOpen,
      autoImportSettingsOpen: semantics.javaCreation.autoImportSettingsOpen,
      setAutoImportSettingsOpen: semantics.javaCreation.setAutoImportSettingsOpen,
      autoImportCandidatePrompt: semantics.javaCreation.autoImportCandidatePrompt,
      workspaceUndoConfirmOpen: project.editState.workspaceUndoConfirmOpen,
      workspaceEditHistoryState: project.editState.workspaceEditHistoryState,
      undoConfirmTriggerRef: project.editState.undoConfirmTriggerRef,
      closeWorkspaceUndoConfirmation: project.editState.closeWorkspaceUndoConfirmation,
      setWorkspaceUndoConfirmOpen: project.editState.setWorkspaceUndoConfirmOpen,
      undoWorkspaceEdit: project.editState.undoWorkspaceEdit,
      refactoring: insight.refactoring,
    },
    workspaceDebugPopupsProps: {
      dapGuideOpen: surfaceState.dapGuideOpen,
      setDapGuideOpen: surfaceState.setDapGuideOpen,
      breakpointPopup,
      debug: executionRuntime.debug,
      breakpoints: executionRuntime.breakpoints,
      gutterMenu,
      openDebugFrame: executionRuntime.openDebugFrame,
    },
    workspaceEditingPopupsProps: {
      uiActions: project.uiActions,
      editorCommands: session.editorCommands,
      clipboard: session.clipboard,
      codeGeneration: semantics.codeGeneration,
      activeLanguageId: editing.documentLanguage.activeLanguageId,
      setStatusMessage: session.setStatusMessage,
      keymapCheatSheetOpen: surfaceState.keymapCheatSheetOpen,
      actionsController: commands.actionsController,
      setKeymapCheatSheetOpen: surfaceState.setKeymapCheatSheetOpen,
      codeInsightNotice: surfaceState.codeInsightNotice,
      setCodeInsightNotice: surfaceState.setCodeInsightNotice,
      statusBridge: semantics.statusBridge,
      activeLspState: editing.documentLanguage.activeLspState,
      goToLineRequest: surfaceState.goToLineRequest,
      setGoToLineRequest: surfaceState.setGoToLineRequest,
      keymap: commands.keymap,
      codeStyle: project.codeStyle,
      activeFile: editing.documentLanguage.activeFile,
    },
    workspaceRefactoringPopupsProps: {
      debugLaunch: executionRuntime.debugLaunch,
      inlineRename,
      refactoring: insight.refactoring,
      refactoringPreviewModal: semantics.codeActions.refactoringPreviewModal,
      setRefactoringPreviewModal: semantics.codeActions.setRefactoringPreviewModal,
      refactorRecoveryReview,
      roots: project.projectTree.roots,
      refactorRecovery: semantics.refactorRecovery,
      activeCompareSession: surfaceState.activeCompareSession,
      setActiveCompareSession: surfaceState.setActiveCompareSession,
      comparisons: editorFeatures.comparisons,
    },
    workspaceConfigurationPopupsProps: {
      appearance: project.appearance,
      setStatusMessage: session.setStatusMessage,
      clipboard: session.clipboard,
      uiActions: project.uiActions,
      tabPolicyOwner: session.tabPolicyOwner,
      openOrder: session.workspaceUi.openOrder,
      openFiles: session.workspaceUi.openFiles,
      workspaceInstanceId: session.workspaceInstanceId,
      activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
      applyTabPolicy: surfaces.applyTabPolicy,
      intelligence: project.intelligence,
      buildRunToolsOpen: project.buildTools.buildRunToolsOpen,
      buildRunTools: project.buildTools.buildRunTools,
      setBuildRunTools: project.buildTools.setBuildRunTools,
      setBuildRunToolsOpen: project.buildTools.setBuildRunToolsOpen,
    },
    workspaceDocumentPopupsProps: {
      visible,
      externalFileConflicts: surfaceState.externalFileConflicts,
      fileLifecycle: editing.fileLifecycle,
      recoveryState: project.recoveryState,
      recoveryActions: files.recoveryActions,
      fileEncodingDialogOpen: surfaceState.fileEncodingDialogOpen,
      activeFile: editing.documentLanguage.activeFile,
      encodingOwner: semantics.encodingOwner,
      setFileEncodingDialogOpen: surfaceState.setFileEncodingDialogOpen,
      localHistoryTarget,
      openFiles: session.workspaceUi.openFiles,
      localHistory: editing.localHistory,
      editorAi: editing.editorAi,
      aiRewriteState,
      preferences: session.preferences,
      applySelectionReplacement: editing.applySelectionReplacement,
      setStatusMessage: session.setStatusMessage,
    },
    workspaceNavigationPopupsProps: {
      keyboard: commands.keyboard,
      searchEverywhereOpen: session.workspaceUi.searchEverywhereOpen,
      searchEverywhereMode: session.workspaceUi.searchEverywhereMode,
      navigation: files.navigation,
      actionsController: commands.actionsController,
      seSymbolsAvailable: semantics.searchNavigation.seSymbolsAvailable,
      semanticIndex: session.semanticIndex,
      fetchWorkspaceSymbols: semantics.searchNavigation.fetchWorkspaceSymbols,
      uiActions: project.uiActions,
      openWorkspaceSymbol: semantics.searchNavigation.openWorkspaceSymbol,
      runSearchEverywhereCommand: commands.runSearchEverywhereCommand,
      keymap: commands.keymap,
      toolWindowRouting: project.toolWindowRouting,
      recentFilesOpen: session.workspaceUi.recentFilesOpen,
      recentEntries: session.workspaceUi.recentEntries,
      recentAdvanceNonce: session.workspaceUi.recentAdvanceNonce,
      toolWindowActions: editorFeatures.toolWindowActions,
      workspaceInstanceId: session.workspaceInstanceId,
      workspaceLocationControllerRef: project.workspaceLocationControllerRef,
      navigationHistoryFacade: files.navigationHistoryFacade,
      openFiles: session.workspaceUi.openFiles,
      openFile: files.openFile,
      librarySources: semantics.librarySources,
      roots: project.projectTree.roots,
      structureOpen: session.workspaceUi.structureOpen,
      activeFile: editing.documentLanguage.activeFile,
      structureSymbols: session.workspaceUi.structureSymbols,
      structureLoading: session.workspaceUi.structureLoading,
      structureUnavailable: session.workspaceUi.structureUnavailable,
      structureSyntaxOnly: surfaceState.structureSyntaxOnly,
      structure: editorFeatures.structure,
      quickDocOpen: session.workspaceUi.quickDocOpen,
      quickDocContent: session.workspaceUi.quickDocContent,
      documentation: semantics.documentation,
      referenceSessions: session.referenceSessions,
      locationPeek: session.workspaceUi.locationPeek,
      treeInteractions: files.treeInteractions,
      visible,
      structuralSearch: semantics.searchNavigation.structuralSearch,
      usages: project.usages,
      usagesActions: insight.usagesActions,
      setStatusMessage: session.setStatusMessage,
      lspClientEvents: session.lspClientEvents,
    },
    workspaceToolbarProps: {
      title: semantics.title,
      roots: project.projectTree.roots,
      looseFiles: project.projectTree.looseFiles,
      dirtyCount: insight.dirtyCount,
      visible,
      workspaceWidgetHost: commands.workspaceWidgetHost,
      projectFactsRoot: project.projectFactsRoot,
      projectFacts: project.projectFacts,
      projectDescriptorDiscovery: project.projectDescriptorDiscovery,
      refreshProjectFacts: project.refreshProjectFacts,
      gitRootsLoading: project.gitSnapshotOwner.gitRootsLoading,
      onOpenGitManager,
      gitRoots: project.gitSnapshotOwner.gitRoots,
      executeWorkspaceCommand: commands.executeWorkspaceCommand,
      projectBuildBusy: executionRuntime.projectBuildBusy,
      buildActiveProject: executionRuntime.runActions.buildActiveProject,
      activeRunConfiguration: executionRuntime.execution.activeRunConfiguration,
      javaRunBusy: executionRuntime.javaRunBusy,
      activeFileRunnable: executionRuntime.activeFileRunnable,
      runActiveTarget: executionRuntime.runActions.runActiveTarget,
      activeRunConfigurations: executionRuntime.execution.activeRunConfigurations,
      activeFile: editing.documentLanguage.activeFile,
      absolutePathForOpenFile: editing.absolutePathForOpenFile,
      workspaceInstanceId: session.workspaceInstanceId,
      debugRuntimeAvailable: executionRuntime.debugRuntimeAvailable,
      activeDebugConfiguration: executionRuntime.execution.activeDebugConfiguration,
      activeFileDebuggable: executionRuntime.activeFileDebuggable,
      debugSessionActive: executionRuntime.breakpoints.debugSessionActive,
      startDebugActiveTarget: executionRuntime.debugLaunch.startDebugActiveTarget,
      toolbarMoreOpen: surfaceState.toolbarMoreOpen,
      setToolbarMoreOpen: surfaceState.setToolbarMoreOpen,
      navCan: files.navigation.navCan,
      currentEditorFontSize: project.appearance.currentEditorFontSize,
      stepCodeViewFontSize: project.appearance.stepCodeViewFontSize,
      setCodeViewFontSize: project.appearance.setCodeViewFontSize,
      activeFileSoftWrap: project.appearance.activeFileSoftWrap,
      toggleSoftWrap: project.appearance.toggleSoftWrap,
      columnSelectionMode: project.appearance.columnSelectionMode,
      toggleColumnSelectionMode: project.appearance.toggleColumnSelectionMode,
      splitOrientation: session.workspaceUi.splitOrientation,
      splitEditor: editing.splits.splitEditor,
      syncSplitScroll: project.telemetry.syncSplitScroll,
      setSyncSplitScroll: project.telemetry.setSyncSplitScroll,
      setStatusMessage: session.setStatusMessage,
      closeSplit: editing.splits.closeSplit,
      activeInlayHintsEnabled: editing.documentLanguage.activeInlayHintsEnabled,
      activeLanguageId: editing.documentLanguage.activeLanguageId,
      activeCapabilities: editing.documentLanguage.activeCapabilities,
      toggleInlayHintsForActiveLanguage: editorFeatures.languagePreferences.toggleInlayHintsForActiveLanguage,
      intelligencePreferences: project.intelligence.intelligencePreferences,
      activeGitRoot: semantics.activeGitRoot,
      toggleInlineBlame: editorFeatures.languagePreferences.toggleInlineBlame,
      rightPaneOpen: project.toolWindowRouting.rightPaneOpen,
      rightPaneTab: session.workspaceUi.rightPaneTab,
      openTabPolicySettings: session.tabPolicyOwner.openTabPolicySettings,
    },
    workspaceOperationObservationsProps: {
      announcements: editing.announcements,
      activeFile: editing.documentLanguage.activeFile,
      uiActions: project.uiActions,
      clipboard: session.clipboard,
    },
    clipboard: session.clipboard,
    rootRef: surfaceState.rootRef,
    observationBridge: session.observationBridge,
    tabPolicyOwner: session.tabPolicyOwner,
    openFiles: session.workspaceUi.openFiles,
    activeKey: session.workspaceUi.activeKey,
    recoveryState: project.recoveryState,
    closedTabsStack: surfaceState.closedTabsStack,
    visible: visible,
    workspaceInstanceId: session.workspaceInstanceId,
    toolWindowRouting: project.toolWindowRouting,
    mainRailMergeActive: session.mainRailMergeActive,
    mainRailHost: session.mainRailHost,
    leftStripeTop: surfaces.leftStripeTop,
    stripeItemsAt: surfaces.stripeItemsAt,
    moreToolWindowsButton: surfaces.moreToolWindowsButton,
    stripeCallbacks: surfaces.stripeCallbacks,
    lastProjectPanelSizeRef: session.lastProjectPanelSizeRef,
    setShellChromeState: session.storeActions.setShellChromeState,
    projectPanelRef: session.projectPanelRef,
    initialProjectPanelSize: session.initialProjectPanelSize,
    toolWindowActions: editorFeatures.toolWindowActions,
    renderToolWindowSideArea: surfaces.renderToolWindowSideArea,
    languagePanelOpen: session.workspaceUi.languagePanelOpen,
    workspaceUi: session.workspaceUi,
    editorLayout: surfaces.editorLayout,
    renderEditorGroup: surfaces.renderEditorGroup,
    sideContents: surfaces.sideContents,
    editorCommands: session.editorCommands,
    renderToolWindowPane: surfaces.renderToolWindowPane,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    dockContents: surfaces.dockContents,
    rightStripeTop: surfaces.rightStripeTop,
    // Platform shell bridge: the workspace sidebar can open a file and refresh
    // the project tree without reaching into editor internals.
    openFile: files.openFile,
    refreshProjectTree: () => {
      const treeData = project.projectTree.treeData;
      treeData.reset();
      project.projectTree.roots.forEach((root) => { void treeData.loadDir(root.id, ""); });
      session.workspaceUi.expandedDirKeys.forEach((key) => {
        const separator = key.indexOf(":");
        if (separator <= 0) return;
        const rootId = key.slice(0, separator);
        const path = key.slice(separator + 1);
        if (path) void treeData.loadDir(rootId, path);
      });
    },
  };
  return { shellProps };
}
