import { useMemo } from "react";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { useT } from "../../../../lib/i18n";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createWorkspaceCommands } from "../controller/commandCatalog";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { type RunPanelHandle } from "../panels/RunPanel";
import { type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { useStructuralSearchSession } from "../useStructuralSearchSession";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceNavigation } from "../useWorkspaceNavigation";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type ClosedTabEntry } from "../workspaceTabPolicy";
import { useCodeGeneration } from "./useCodeGeneration";
import { useEditorAiActions } from "./useEditorAiActions";
import { useIntentionActions } from "./useIntentionActions";
import { useRefactorRecovery } from "./useRefactorRecovery";
import { useReferenceDocumentation } from "./useReferenceDocumentation";
import { useSemanticNavigation } from "./useSemanticNavigation";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";
import { useWorkspaceBookmarkActions } from "./useWorkspaceBookmarkActions";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceClipboard } from "./useWorkspaceClipboard";
import { useWorkspaceCodeStyle } from "./useWorkspaceCodeStyle";
import { useWorkspaceComparisons } from "./useWorkspaceComparisons";
import { useWorkspaceCoverage } from "./useWorkspaceCoverage";
import { useWorkspaceDocumentLanguage } from "./useWorkspaceDocumentLanguage";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";
import { useWorkspaceFileLifecycle } from "./useWorkspaceFileLifecycle";
import { useWorkspaceHierarchy } from "./useWorkspaceHierarchy";
import { useWorkspaceIntelligencePreferences } from "./useWorkspaceIntelligencePreferences";
import { useWorkspaceJavaCreation } from "./useWorkspaceJavaCreation";
import { useWorkspaceKeyboard } from "./useWorkspaceKeyboard";
import { useWorkspaceKeymap } from "./useWorkspaceKeymap";
import { useWorkspaceLanguagePreferences } from "./useWorkspaceLanguagePreferences";
import { useWorkspaceOccurrences } from "./useWorkspaceOccurrences";
import { useWorkspaceReaderMode } from "./useWorkspaceReaderMode";
import { useWorkspaceSave } from "./useWorkspaceSave";
import { useWorkspaceSplits } from "./useWorkspaceSplits";
import { useWorkspaceStructure } from "./useWorkspaceStructure";
import { useWorkspaceStyleActions } from "./useWorkspaceStyleActions";
import { useWorkspaceTabPolicy } from "./useWorkspaceTabPolicy";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";
import { useWorkspaceToolWindows } from "./useWorkspaceToolWindows";
import { useWorkspaceTreeInteractions } from "./useWorkspaceTreeInteractions";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";
import { useWorkspaceTreeOpening } from "./useWorkspaceTreeOpening";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";
import { useWorkspaceUsagesState } from "./useWorkspaceUsagesState";


export interface UseWorkspaceCommandCatalogContext {
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  codeGeneration: ReturnType<typeof useCodeGeneration>;
  closedTabsStack: readonly ClosedTabEntry[];
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  setClosedTabsStack: import("react").Dispatch<import("react").SetStateAction<readonly ClosedTabEntry[]>>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  setStatusMessage: (message: string) => void;
  keymap: ReturnType<typeof useWorkspaceKeymap>;
  codeStyle: ReturnType<typeof useWorkspaceCodeStyle>;
  javaCreation: ReturnType<typeof useWorkspaceJavaCreation>;
  styleActions: ReturnType<typeof useWorkspaceStyleActions>;
  navigation: ReturnType<typeof useWorkspaceNavigation>;
  seSymbolsAvailable: boolean;
  documentLanguage: ReturnType<typeof useWorkspaceDocumentLanguage>;
  navigateDiagnostic: (direction: 1 | -1) => void;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  peekDefinitionRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  intelligence: ReturnType<typeof useWorkspaceIntelligencePreferences>;
  appearance: ReturnType<typeof useWorkspaceAppearance>;
  tabPolicyOwner: ReturnType<typeof useWorkspaceTabPolicy>;
  copyReferenceAtCursor: () => Promise<void>;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
  openFindInFiles: (focusTarget?: "query" | "replace") => void;
  structuralSearch: ReturnType<typeof useStructuralSearchSession>;
  structure: ReturnType<typeof useWorkspaceStructure>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  editState: ReturnType<typeof useWorkspaceEditState>;
  languagePreferences: ReturnType<typeof useWorkspaceLanguagePreferences>;
  documentation: ReturnType<typeof useReferenceDocumentation>;
  intentions: ReturnType<typeof useIntentionActions>;
  goToTypeDefinitionRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  goToImplementationRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  renameSymbolRef: import("react").RefObject<() => Promise<void>>;
  safeDeleteSymbolRef: import("react").RefObject<() => Promise<void>>;
  runExtractMethodRef: import("react").RefObject<() => Promise<void>>;
  t: ReturnType<typeof useT>;
  editorAi: ReturnType<typeof useEditorAiActions>;
  preferences: ReturnType<typeof useWorkspacePreferences>;
  toolWindowActions: ReturnType<typeof useWorkspaceToolWindows>;
  hierarchy: ReturnType<typeof useWorkspaceHierarchy>;
  goToDeclarationRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<boolean>>;
  semanticNavigation: ReturnType<typeof useSemanticNavigation>;
  usages: ReturnType<typeof useWorkspaceUsagesState>;
  bookmarkActions: ReturnType<typeof useWorkspaceBookmarkActions>;
  occurrences: ReturnType<typeof useWorkspaceOccurrences>;
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  comparisons: ReturnType<typeof useWorkspaceComparisons>;
  readerMode: ReturnType<typeof useWorkspaceReaderMode>;
  activeGitRoot: import("../../../../lib/editor/workspace").WorkspaceGitRoot | null;
  workspaceInstanceId: string;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
  terminalDockRef: import("react").RefObject<TerminalDockHandle | null>;
  runActiveJavaFileRef: import("react").RefObject<() => void>;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  buildActiveProjectRef: import("react").RefObject<(rebuild?: boolean) => void>;
  recompileActiveFileRef: import("react").RefObject<() => void>;
  toggleActiveBreakpointRef: import("react").RefObject<(line: number) => void>;
  viewBreakpointsAtCaretRef: import("react").RefObject<(line: number) => void>;
  toggleTemporaryBreakpointRef: import("react").RefObject<(line: number) => void>;
  toggleActiveBreakpointEnabledRef: import("react").RefObject<(line: number) => void>;
  debugRef: import("react").RefObject<import("../useCodeDebugSession").CodeDebugSession | null>;
  openEvaluateDialogRef: import("react").RefObject<(expression?: string) => void>;
  showDebugExecutionPointRef: import("react").RefObject<() => void>;
  runPanelRef: import("react").RefObject<RunPanelHandle | null>;
  refactorRecovery: ReturnType<typeof useRefactorRecovery>;
  keyboard: ReturnType<typeof useWorkspaceKeyboard>;
  saves: ReturnType<typeof useWorkspaceSave>;
  fileLifecycle: ReturnType<typeof useWorkspaceFileLifecycle>;
  treeInteractions: ReturnType<typeof useWorkspaceTreeInteractions>;
  fileActions: ReturnType<typeof useWorkspaceFileActions>;
  gitSnapshotOwner: ReturnType<typeof useWorkspaceGitSnapshots>;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  openGitManager: () => void;
  splits: ReturnType<typeof useWorkspaceSplits>;
  treeOpening: ReturnType<typeof useWorkspaceTreeOpening>;
  findInDirectory: (path: string) => void;
  setKeymapCheatSheetOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  coverage: ReturnType<typeof useWorkspaceCoverage>;
  setDapGuideOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}

export function useWorkspaceCommandCatalog(context: UseWorkspaceCommandCatalogContext) {
  const {
    editorCommands,
    uiActions,
    codeGeneration,
    closedTabsStack,
    workspaceUi,
    setClosedTabsStack,
    openFile,
    bufferState,
    setStatusMessage,
    codeStyle,
    javaCreation,
    styleActions,
    navigation,
    seSymbolsAvailable,
    documentLanguage,
    navigateDiagnostic,
    editorSelectionRef,
    peekDefinitionRef,
    showCodeInsightNotice,
    intelligence,
    appearance,
    tabPolicyOwner,
    copyReferenceAtCursor,
    clipboard,
    openFindInFiles,
    structuralSearch,
    structure,
    absolutePathForOpenFile,
    editState,
    languagePreferences,
    documentation,
    intentions,
    goToTypeDefinitionRef,
    goToImplementationRef,
    renameSymbolRef,
    safeDeleteSymbolRef,
    runExtractMethodRef,
    t,
    editorAi,
    preferences,
    toolWindowActions,
    hierarchy,
    goToDeclarationRef,
    usages,
    bookmarkActions,
    occurrences,
    telemetry,
    comparisons,
    readerMode,
    activeGitRoot,
    workspaceInstanceId,
    toolWindowRouting,
    terminalDockRef,
    runActiveJavaFileRef,
    projectTree,
    buildActiveProjectRef,
    recompileActiveFileRef,
    toggleActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    toggleTemporaryBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    debugRef,
    openEvaluateDialogRef,
    showDebugExecutionPointRef,
    runPanelRef,
    refactorRecovery,
    saves,
    fileLifecycle,
    treeInteractions,
    fileActions,
    gitSnapshotOwner,
    onOpenGitManager,
    openGitManager,
    splits,
    treeOpening,
    findInDirectory,
    setKeymapCheatSheetOpen,
    coverage,
    setDapGuideOpen,
  } = context;

  const workspaceCommands = useMemo<WorkspaceCommand[]>(createWorkspaceCommands({
    executeEditorCommand: editorCommands.executeEditorCommand,
    setSurroundWithDialogOpen: uiActions.setSurroundWithDialogOpen,
    requestGenerateCandidates: codeGeneration.requestGenerateCandidates,
    closedTabsStack,
    workspaceUi,
    activeEditorGroupId: workspaceUi.activeEditorGroupId,
    setClosedTabsStack,
    openFile,
    openFilesRef: bufferState.openFilesRef,
    setStatusMessage,
    get setKeymapSettingsOpen() { return context.keymap.setKeymapSettingsOpen; },
    setCodeStyleSettingsOpen: codeStyle.setCodeStyleSettingsOpen,
    setFileTemplateSettingsOpen: javaCreation.setFileTemplateSettingsOpen,
    setAutoImportSettingsOpen: javaCreation.setAutoImportSettingsOpen,
    executeAutoImportOnTheFly: styleActions.executeAutoImportOnTheFly,
    executePasteWithAutoImport: styleActions.executePasteWithAutoImport,
    openSearchEverywhere: navigation.openSearchEverywhere,
    seSymbolsAvailable,
    recentFilesOpen: workspaceUi.recentFilesOpen,
    openRecentFiles: navigation.openRecentFiles,
    recentChangedOnly: navigation.recentChangedOnly,
    setRecentLocationsChangedOnly: uiActions.setRecentLocationsChangedOnly,
    setRecentLocationsOpen: uiActions.setRecentLocationsOpen,
    navigateLastEditLocation: navigation.navigateLastEditLocation,
    activeFile: documentLanguage.activeFile,
    navigateDiagnostic,
    editorSelectionRef,
    peekDefinitionRef,
    lspFilesRef: bufferState.lspFilesRef,
    showCodeInsightNotice,
    setParameterInfoRequestNonce: intelligence.setParameterInfoRequestNonce,
    setEditorAppearanceSettingsOpen: appearance.setEditorAppearanceSettingsOpen,
    openTabPolicySettings: tabPolicyOwner.openTabPolicySettings,
    editorCommandStateFor: editorCommands.editorCommandStateFor,
    copyReferenceAtCursor,
    clipboardHandle: clipboard.clipboardHandle,
    setClipboardHistoryEntries: uiActions.setClipboardHistoryEntries,
    setClipboardHistoryOpen: uiActions.setClipboardHistoryOpen,
    setIntelligenceSettingsOpen: intelligence.setIntelligenceSettingsOpen,
    optimizeImports: styleActions.optimizeImports,
    runRearrangeExecute: styleActions.runRearrangeExecute,
    runCleanupExecute: styleActions.runCleanupExecute,
    navCan: navigation.navCan,
    navigateHistory: navigation.navigateHistory,
    openFindInFiles,
    structuralSearch,
    openStructurePopup: structure.openStructurePopup,
    absolutePathForOpenFile,
    activeLanguageId: documentLanguage.activeLanguageId,
    workspaceResourceOperationLocked: editState.workspaceResourceOperationLocked,
    activeCapabilities: documentLanguage.activeCapabilities,
    formatActiveFile: styleActions.formatActiveFile,
    intelligencePreferences: intelligence.intelligencePreferences,
    setFormatOnSave: languagePreferences.setFormatOnSave,
    openQuickDocumentation: documentation.openQuickDocumentation,
    runTypeInfo: documentation.runTypeInfo,
    externalDocTargetFromProvider: documentation.externalDocTargetFromProvider,
    runExternalDocumentation: documentation.runExternalDocumentation,
    runExpressionStaticData: documentation.runExpressionStaticData,
    openCodeActionsAtCursor: intentions.openCodeActionsAtCursor,
    resolveEditorTarget: editorCommands.resolveEditorTarget,
    goToTypeDefinitionRef,
    goToImplementationRef,
    renameSymbolRef,
    safeDeleteSymbolRef,
    openRefactorActions: intentions.openRefactorActions,
    runExtractMethodRef,
    t,
    runEditorAiActionAtCursor: editorAi.runEditorAiActionAtCursor,
    editorAiPreferences: preferences.editorAiPreferences,
    cycleAiAnswerLanguage: preferences.cycleAiAnswerLanguage,
    setAiAnswerLanguage: preferences.setAiAnswerLanguage,
    languagePanelOpen: workspaceUi.languagePanelOpen,
    handleActivateToolWindow: toolWindowActions.handleActivateToolWindow,
    handleReturnToEditor: editorCommands.handleReturnToEditor,
    handleRestoreToolWindowLayout: toolWindowActions.handleRestoreToolWindowLayout,
    jumpToLastToolWindow: toolWindowActions.jumpToLastToolWindow,
    hideActiveToolWindow: toolWindowActions.hideActiveToolWindow,
    toggleAllToolWindows: toolWindowActions.toggleAllToolWindows,
    openHierarchy: hierarchy.openHierarchy,
    goToDeclarationRef,
    get goToDefinition() { return context.semanticNavigation.goToDefinition; },
    activeKey: workspaceUi.activeKey,
    findReferencesRef: usages.findReferencesRef,
    usageSessionRef: usages.usageSessionRef,
    setLocationPeek: uiActions.setLocationPeek,
    toggleTodosPane: bookmarkActions.toggleTodosPane,
    toggleBookmarkAtCursor: bookmarkActions.toggleBookmarkAtCursor,
    chooseMnemonicBookmarkAtCursor: bookmarkActions.chooseMnemonicBookmarkAtCursor,
    openTodosPane: bookmarkActions.openTodosPane,
    bookmarks: preferences.bookmarks,
    jumpToMnemonicBookmark: bookmarkActions.jumpToMnemonicBookmark,
    activateNavigationBar: occurrences.activateNavigationBar,
    highlightUsagesInFile: occurrences.highlightUsagesInFile,
    occurrenceSessionRef: telemetry.occurrenceSessionRef,
    navigateOccurrence: occurrences.navigateOccurrence,
    clearHighlightUsages: occurrences.clearHighlightUsages,
    compareWithClipboard: comparisons.compareWithClipboard,
    compareWithFile: comparisons.compareWithFile,
    compareWithLocalHistory: comparisons.compareWithLocalHistory,
    activeRenderedDocLanguageId: documentLanguage.activeRenderedDocLanguageId,
    toggleRenderedDocComments: readerMode.toggleRenderedDocComments,
    toggleInlayHints: languagePreferences.toggleInlayHints,
    activeInlayHintsEnabled: documentLanguage.activeInlayHintsEnabled,
    toggleInlayHintsForActiveLanguage: languagePreferences.toggleInlayHintsForActiveLanguage,
    activeGitRoot,
    toggleInlineBlame: languagePreferences.toggleInlineBlame,
    activeFileSoftWrap: appearance.activeFileSoftWrap,
    toggleSoftWrap: appearance.toggleSoftWrap,
    columnSelectionMode: appearance.columnSelectionMode,
    toggleColumnSelectionMode: appearance.toggleColumnSelectionMode,
    workspaceInstanceId,
    setBottomDockOpen: toolWindowRouting.setBottomDockOpen,
    setBottomDockTab: toolWindowRouting.setBottomDockTab,
    terminalDockRef,
    runActiveJavaFileRef,
    roots: projectTree.roots,
    buildActiveProjectRef,
    recompileActiveFileRef,
    cursorPositionsRef: telemetry.cursorPositionsRef,
    toggleActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    toggleTemporaryBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    debugRef,
    openEvaluateDialogRef,
    showDebugExecutionPointRef,
    runPanelRef,
    workspaceEditHistoryState: editState.workspaceEditHistoryState,
    searchEverywhereOpen: workspaceUi.searchEverywhereOpen,
    requestWorkspaceUndoConfirmation: editState.requestWorkspaceUndoConfirmation,
    redoWorkspaceEdit: editState.redoWorkspaceEdit,
    promptRefactorRecoveryEntry: refactorRecovery.promptRefactorRecoveryEntry,
    get activeKeyRef() { return context.keyboard.activeKeyRef; },
    saveFile: saves.saveFile,
    closeFile: fileLifecycle.closeFile,
    revealEditorTabInTree: treeInteractions.revealEditorTabInTree,
    reloadFile: saves.reloadFile,
    refreshTree: fileActions.refreshTree,
    gitRootsLoading: gitSnapshotOwner.gitRootsLoading,
    onOpenGitManager,
    gitRoots: gitSnapshotOwner.gitRoots,
    openGitManager,
    splitOrientation: workspaceUi.splitOrientation,
    setSyncSplitScroll: telemetry.setSyncSplitScroll,
    splitEditor: splits.splitEditor,
    goToAdjacentSplit: splits.goToAdjacentSplit,
    moveActiveTabToAdjacentSplit: splits.moveActiveTabToAdjacentSplit,
    equalizeActiveSplitRatios: splits.equalizeActiveSplitRatios,
    stretchActiveSplit: splits.stretchActiveSplit,
    unsplitAllWindows: splits.unsplitAllWindows,
    openLooseFile: fileActions.openLooseFile,
    addRoot: fileActions.addRoot,
    treeContextMenuSessionRef: treeInteractions.treeContextMenuSessionRef,
    selected: workspaceUi.treeSelection,
    requestTreeOpen: treeOpening.requestTreeOpen,
    selectedRootDirectory: fileActions.selectedRootDirectory,
    createFile: fileActions.createFile,
    createDir: fileActions.createDir,
    openNewJavaClassDialog: javaCreation.openNewJavaClassDialog,
    renameSelected: fileActions.renameSelected,
    deleteSelected: fileActions.deleteSelected,
    ignoreWorkspacePath: fileActions.ignoreWorkspacePath,
    findInDirectory,
    copyTreePath: fileActions.copyTreePath,
    setKeymapCheatSheetOpen,
    coverageReport: coverage.coverageReport,
    scanWorkspaceCoverage: coverage.scanWorkspaceCoverage,
    setDapGuideOpen,
  }), [
    documentLanguage.activeCapabilities,
    editorCommands.activeEditorCommandState,
    workspaceUi.activeEditorGroupId,
    documentLanguage.activeFile,
    activeGitRoot,
    workspaceUi.activeKey,
    documentLanguage.activeInlayHintsEnabled,
    documentLanguage.activeLanguageId,
    documentLanguage.activeRenderedDocLanguageId,
    fileActions.addRoot,
    preferences.bookmarks,
    fileLifecycle.closeFile,
    comparisons.compareWithClipboard,
    comparisons.compareWithFile,
    comparisons.compareWithLocalHistory,
    bookmarkActions.chooseMnemonicBookmarkAtCursor,
    closedTabsStack,
    appearance.columnSelectionMode,
    fileActions.copyTreePath,
    fileActions.createDir,
    fileActions.createFile,
    fileActions.deleteSelected,
    editorCommands.editorCommandStateFor,
    splits.equalizeActiveSplitRatios,
    editorCommands.executeActiveEditorCommand,
    editorCommands.executeEditorCommand,
    findInDirectory,
    styleActions.formatActiveFile,
    gitSnapshotOwner.gitRoots.length,
    gitSnapshotOwner.gitRootsLoading,
    splits.goToAdjacentSplit,
    fileActions.ignoreWorkspacePath,
    intelligence.intelligencePreferences.formatOnSave,
    intelligence.intelligencePreferences.inlayHintsEnabled,
    intelligence.intelligencePreferences.inlineBlameEnabled,
    appearance.activeFileSoftWrap,
    workspaceUi.languagePanelOpen,
    splits.moveActiveTabToAdjacentSplit,
    navigation.navCan.back,
    navigation.navCan.forward,
    navigateDiagnostic,
    navigation.navigateHistory,
    onOpenGitManager,
    intentions.openCodeActionsAtCursor,
    openFile,
    openFindInFiles,
    openGitManager,
    hierarchy.openHierarchy,
    fileActions.openLooseFile,
    documentation.openQuickDocumentation,
    intentions.openRefactorActions,
    navigation.openRecentFiles,
    navigation.openSearchEverywhere,
    structure.openStructurePopup,
    styleActions.optimizeImports,
    workspaceUi.recentFilesOpen,
    fileActions.refreshTree,
    saves.reloadFile,
    codeGeneration.requestGenerateCandidates,
    editState.requestWorkspaceUndoConfirmation,
    workspaceUi.searchEverywhereOpen,
    treeInteractions.revealEditorTabInTree,
    readerMode.revealRenderedDocSource,
    readerMode.readerModeByFile,
    fileActions.renameSelected,
    editorCommands.resolveEditorTarget,
    projectTree.roots.length,
    editorAi.runEditorAiActionAtCursor,
    styleActions.runRearrangeExecute,
    saves.saveFile,
    coverage.scanWorkspaceCoverage,
    seSymbolsAvailable,
    workspaceUi.treeSelection,
    fileActions.selectedRootDirectory,
    toolWindowRouting.setBottomDockOpen,
    toolWindowRouting.setBottomDockTab,
    languagePreferences.setFormatOnSave,
    setClosedTabsStack,
    setStatusMessage,
    workspaceUi.splitOrientation,
    splits.stretchActiveSplit,
    editState.workspaceResourceOperationLocked,
    t,
    bookmarkActions.toggleBookmarkAtCursor,
    appearance.toggleColumnSelectionMode,
    languagePreferences.toggleInlayHints,
    languagePreferences.toggleInlayHintsForActiveLanguage,
    languagePreferences.toggleInlineBlame,
    readerMode.toggleRenderedDocComments,
    toolWindowActions.toggleOutlinePane,
    toolWindowActions.toggleProjectTree,
    appearance.toggleSoftWrap,
    bookmarkActions.toggleTodosPane,
    bookmarkActions.jumpToMnemonicBookmark,
    toolWindowActions.jumpToLastToolWindow,
    toolWindowActions.hideActiveToolWindow,
    toolWindowActions.toggleAllToolWindows,
    editState.undoWorkspaceEdit,
    editState.redoWorkspaceEdit,
    splits.unsplitAllWindows,
    editState.workspaceEditHistoryState,
    workspaceUi.layoutTreeV2,
    coverage.coverageReport,
    telemetry.occurrenceSession,
  ]);
  return { workspaceCommands };
}
