import { Fragment, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle, type PanelImperativeHandle } from "react-resizable-panels";
import { AlertTriangle, Activity, Braces, GitBranch, GitCommitHorizontal, ListTree, GitFork, Network, ListTodo, BookOpen, TerminalSquare, Play, Hammer, FlaskConical, Bug, Search, ShieldCheck, FolderTree } from "lucide-react";
import { workspaceReadFile, workspaceReadLooseFile, workspaceJavaRunTarget, type ExecutionRunConfiguration, type ExecutionBuildTarget, type WorkspaceToolConfig } from "../../lib/editor/workspace";
import type { WorkspaceSearchMatch } from "../../lib/editor/workspaceSearch";
import { lspCodeActionResolve, lspCompletion, lspCompletionResolve, lspDocumentSymbols, lspDefinition, lspImplementation, lspJavaModules, lspResolveWorkspaceEdit, lspDownloadSources, lspStartWorkspaceWatcher, lspStopWorkspaceWatcher, lspSelectionRanges, lspTypeDefinition, lspWorkspaceSymbolResolve, type LspCodeAction, type LspCompletionResolveResult, type LspCompletionResult, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentSymbol, type LspDocumentHighlight, type LspInlayHint, type LspSemanticToken, type LspLocation, type LspPosition, type LspRange, type LspWorkspaceEdit, type LspWorkspaceApplyEditRequest, type LspWorkspaceEditOperation } from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadCodeViewProfile } from "../../lib/codeViewProfile";
import { registerShellKeyClaim } from "../../lib/shellKeyClaims";
import { useAppStore } from "../../stores/appStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { createEditorGroup, selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type CodeWorkspaceEditorGroupState, type EditorGroupId, type EditorSplitOrientation, type RightPaneTabId } from "../../stores/codeWorkspaceStore";
import { useCodeWorkspaceStatusStore, type WorkspaceEol } from "../../stores/codeWorkspaceStatusStore";
import { type EffectiveCodeStyle, type ExplicitIndentationOverride, resolveEffectiveCodeStyle } from "./workspace/codeStyleModel";
import type { ResolvedCodeStyle } from "./workspace/editorConfigResolver";
import { createWorkspaceStyleController, type WorkspaceStyleController } from "./workspace/workspaceStyleController";
import type { CompletionAcceptanceDiagnostic, CompletionInvocationRequest, CompletionRequestIdentity, CompletionRequestToken } from "./workspace/lspCompletion";
import { resolveCompletionScopeFacts, sameCompletionScopeFacts, type CompletionScopeFactsState } from "./workspace/completionScopeAdapter";
import { SaveTransactionRegistry } from "./workspace/saveCommit";
import { type SaveObservationRecord, type SaveObservationState } from "./workspace/saveObservationContract";
import { listDiskEffectLedgerEntries, resolveDiskEffectLedgerEntry, type WorkspaceDiskEffectLedgerEntryV4 } from "./workspace/workspaceRecovery";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3, type ClosedTabEntry, type WorkspaceTabPolicyV3 } from "./workspace/workspaceTabPolicy";
import { attachWorkspaceMouseDispatcher } from "./workspace/workspaceMouseDispatcher";
import { createWorkspaceLocationController, isPathContainedInRoot, NavigationHistoryFacade, workspacePathComparisonKey, type BackForwardHistoryBridge, type WorkspaceLocationController } from "./workspace/navigationHistoryModel";
import { WorkspaceSemanticQueryHost } from "./workspace/workspaceSemanticQueryHost";
import { createSingleLeafLayout, getAllLeafNodes, navigateLeafOrder, panelLayoutToRatios, cloneLayoutTree, type LayoutNode } from "./workspace/recursiveLayoutTree";
import { historyList, historyRead, type LocalHistoryEntry } from "../../lib/localHistory";
import { defaultWorkspaceLayoutSnapshot, layoutSnapshotHasOpenFiles, readWorkspaceLayoutSnapshot, uniqueOrderedKeys, writeWorkspaceLayoutSnapshot, type PersistedEditorViewState, type WorkspaceViewStates } from "./workspace/workspaceLayoutPersistence";
import { LocalHistoryDialog } from "./workspace/LocalHistoryDialog";
import { CodeStyleSettingsDialog } from "./workspace/CodeStyleSettingsDialog";
import { WorkspaceTabPolicySettingsDialog } from "./workspace/WorkspaceTabPolicySettingsDialog";
import { NewJavaClassDialog } from "./workspace/NewJavaClassDialog";
import { FileTemplateSettingsDialog } from "./workspace/FileTemplateSettingsDialog";
import { AutoImportSettingsDialog } from "./workspace/AutoImportSettingsDialog";
import { AutoImportCandidateDialog } from "./workspace/AutoImportCandidateDialog";
import { loadAutoImportPreferences } from "../../lib/autoImportPreferences";
import { type AutoImportCandidate } from "./workspace/autoImportModel";
import { BUILT_IN_SCHEME_ID, activeSchemeForLanguage, readCodeStyleSchemeStore, schemeStyleFields, writeCodeStyleSchemeStore, type CodeStyleSchemeStoreState } from "./workspace/workspaceCodeStyleSchemes";
import { EditorSelectionAiToolbar } from "./workspace/EditorSelectionAiToolbar";
import { buildEditorAiPrompt, type EditorAiAction } from "./workspace/editorAiPrompts";
import { EditorAiRewriteDialog } from "./workspace/EditorAiRewriteDialog";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { readText, writeText } from "../../lib/clipboard";
import { useContextMenu, type ContextMenuCloseReason } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import { type EditorCommandId, type EditorCommandOptions, type EditorCommandPort, type EditorCommandPortRegistration, type EditorCommandState, type EditorCommandTarget, type EditorSelectionRange } from "./workspace/CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "./workspace/workspaceDocumentTransactionOwner";
import { SurroundWithDialog } from "./workspace/SurroundWithDialog";
import { GenerateCodeDialog } from "./workspace/GenerateCodeDialog";
import { applyGenerateSelection, type GenerateCandidate } from "./workspace/generateCodeWorkflow";
import { filterGenerateCodeActions } from "./workspace/workspaceSemanticEditing";
import { ClipboardHistoryPopup } from "./workspace/ClipboardHistoryPopup";
import { acquireClipboardStore, createDefaultClipboardPermissionAdapter, type EditorClipboardSession, WorkspaceClipboardSessionContext } from "./workspace/workspaceClipboardSession";
import type { ClipboardObservationRecord } from "./workspace/clipboardObservationContract";
import { WorkspaceObservationBridge } from "./workspace/workspaceObservationBridge";
import { WorkspaceObservationBoundary } from "./workspace/WorkspaceObservationBoundary";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { isTauriRuntime } from "../../lib/runtime";
import { useMountedRef } from "../../hooks/useMountedRef";
import { inlayHintsEnabledForLanguage, readWorkspaceIntelligencePreferences, writeWorkspaceIntelligencePreferences, type WorkspaceIntelligencePreferences } from "./workspace/intelligencePreferences";
import { WorkspaceLspSessionManager } from "./workspace/workspaceLspSessionManager";
import { isLargeFileContent } from "./workspace/largeFile";
import { workspaceEditApplyResponse } from "./workspace/workspaceEditApply";
import { formatWorkspaceEditPreview, workspaceEditOperations, type WorkspaceEditPreview } from "./workspace/workspaceEditPreview";
import { RefactoringPreviewDialog } from "./workspace/RefactoringPreviewDialog";
import { InlineRenamePopup } from "./workspace/InlineRenamePopup";
import { inlineRenameNameError } from "./workspace/inlineRename";
import { writeRefactorOptionsMode } from "./workspace/refactorOptions";
import { javaMainRunLines, type RunGutterTarget } from "./workspace/runGutter";
import { RefactorRecoveryReviewDialog } from "./workspace/RefactorRecoveryReviewDialog";
import { listRefactorRecoveryJournalsV2, isPendingRefactorRecoveryEntry, type RefactorPlanV3, type RefactorRecoveryJournalEntryV2 } from "./workspace/refactorPlan";
import { classifyRefactorRecoveryPreconditions, createRestoreEchoSuppressor, type RefactorRecoveryPreconditionSummary } from "./workspace/refactorRecoveryController";
import { KeymapCheatSheetDialog } from "./workspace/KeymapCheatSheetDialog";
import { KeymapSettingsDialog } from "./workspace/KeymapSettingsDialog";
import { KeymapMigrationNotice } from "./workspace/KeymapMigrationNotice";
import { GoToLineDialog } from "./workspace/GoToLineDialog";
import { languageServiceReadiness } from "./workspace/languageServiceReadiness";
import { javaSyntaxOutline } from "./workspace/javaSyntaxOutline";
import { WorkspaceGitManager } from "../git/WorkspaceGitManager";
import { CodeInsightNotice, caretAnchor, type CodeInsightNoticeState } from "./workspace/CodeInsightNotice";
import type { GoToLineRequest } from "./workspace/CodeMirrorHost";
import { BUILTIN_KEYMAP_PRESETS, consumeKeymapDefaultsMigrationNotice, dismissKeymapDefaultsMigrationNotice, isBuiltinKeymapScheme, readKeymapSchemes, writeKeymapSchemes, type KeymapSchemeV3 } from "./workspace/workspaceKeymapScheme";
import { TabSwitcher } from "./workspace/TabSwitcher";
import { DapAdapterGuideDialog } from "./workspace/DapAdapterGuideDialog";
import { buildWorkspacePathSnapshotEdit, WorkspaceEditHistory, type WorkspaceEditPathSnapshot } from "./workspace/workspaceEditHistory";
import { evidencePresentationLine } from "./workspace/capabilityEvidence";
import { toProviderDiagnosticsV3 } from "./workspace/inspectionProviderAdapter";
import { IntentionSession } from "./workspace/intentionSession";
import { CanonicalCodeActionService, extractAffectedResourcesFromWorkspaceEdit, type CodeActionTransactionSnapshot } from "./workspace/codeActionProviderAdapter";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "./workspace/workspaceResourceRecoveryCoordinator";
import { BottomDock, type BottomDockTab } from "./workspace/panels/BottomDock";
import { ToolWindowRail, type ToolWindowRailItem } from "./workspace/panels/ToolWindowRail";
import { useLatestHandlers } from "./workspace/useLatestHandlers";
import { useToolWindowLayout } from "./workspace/useToolWindowLayout";
import { ToolWindowPortal, useToolWindowNodes } from "./workspace/panels/ToolWindowHost";
import { workspaceNavigationSegments } from "./workspace/workspaceNavigationBar";
import { ReferencesPanel, type ReferencesResultState } from "./workspace/panels/ReferencesPanel";
import { ProblemsPanel, type ProblemFileGroup } from "./workspace/panels/ProblemsPanel";
import { FindInFilesPanel } from "./workspace/panels/FindInFilesPanel";
import { StructuralSearchPanel } from "./workspace/panels/StructuralSearchPanel";
import { StructuralSearchDialog } from "./workspace/StructuralSearchDialog";
import { useStructuralSearchSession } from "./workspace/useStructuralSearchSession";
import type { StructuralMatch } from "../../lib/editor/structuralSearch";
import { DocumentationPane } from "./workspace/panels/DocumentationPane";
import { HierarchyPanel } from "./workspace/panels/HierarchyPanel";
import { type HierarchyRootState } from "./workspace/hierarchyQueryModel";
import { TodosBookmarksPanel } from "./workspace/panels/TodosBookmarksPanel";
import { CoveragePanel } from "./workspace/panels/CoveragePanel";
import { parseCoverageReport, type WorkspaceCoverageReport } from "./workspace/coverageModel";
import { findBookmarkByMnemonic, isValidMnemonic, mergeWorkspaceBookmarkSnapshot, normalizeMnemonic, readWorkspaceBookmarks, renameWorkspaceBookmarkGroup, setMnemonicBookmark, toggleWorkspaceBookmark, writeWorkspaceBookmarks, type WorkspaceBookmark } from "./workspace/todoBookmarks";
import { formatOccurrenceStatus, stepOccurrence, type OccurrenceHighlightSession } from "./workspace/occurrenceHighlightModel";
import { readHighlightingLevel, writeHighlightingLevel, type HighlightingLevel } from "./workspace/highlightingLevelModel";
import { classifyCompareReadError, createFileCompareSession, createUnavailableCompareSession, type CompareSelection, type CompareTarget, type EditorCompareSession } from "./workspace/editorCompareModel";
import { EditorCompareDialog } from "./workspace/EditorCompareDialog";
import { isDiagnosticScopeCurrent, type DiagnosticScope } from "./workspace/diagnosticScopeModel";
import { isDocCommentRenderingSupported, readReaderModePreference, writeReaderModePreference } from "./workspace/renderedDocCommentsModel";
import { useDeferredOpenFileTodos } from "./workspace/useDeferredOpenFileTodos";
import { type QuickDocContent } from "./workspace/referenceDocumentation";
import { extractProviderDocLinks, openExternalDocumentation, validateExternalDocUrl } from "./workspace/referenceDocumentation";
import { LEGACY_CONTEXT_INFO_REASON, ReferenceInfoController, type ReferenceHistorySnapshot } from "./workspace/referenceInfoController";
import { ParameterInfoSession, type ParameterDisplayState, type ParameterInvalidateReason, type ReferenceSessionContext } from "./workspace/referenceInfoSession";
import { useWorkspaceProjectAnalysis } from "./workspace/useWorkspaceProjectAnalysis";
import { useProjectFacts } from "../../hooks/useProjectFacts";
import { useProjectDescriptorDiscovery } from "../../hooks/useProjectDescriptorDiscovery";
import { useProjectFactsStore } from "../../stores/projectFactsStore";
import { DEFAULT_SCOPE_SELECTION, UsageQuerySession, type UsagesScopeSelection } from "./workspace/usageQuerySession";
import { UsagesScopeDialog } from "./workspace/UsagesScopeDialog";
import { type LocationPeekState } from "./workspace/LocationPeek";
import { type GoToSymbolItem, type SearchEverywhereMode } from "./workspace/SearchEverywhere";
import { type RecentFileEntry } from "./workspace/RecentFilesPopup";
import { WorkspacePopupsHost } from "./workspace/WorkspacePopupsHost";
import { UndoWorkspaceEditConfirmDialog } from "./workspace/UndoWorkspaceEditConfirmDialog";
import { WorkspaceBuildRunToolsDialog } from "./workspace/WorkspaceBuildRunToolsDialog";
import { WorkspaceIntelligenceSettingsDialog } from "./workspace/WorkspaceIntelligenceSettingsDialog";
import { WorkspaceEditorAppearanceSettingsDialog } from "./workspace/WorkspaceEditorAppearanceSettingsDialog";
import { DEFAULT_EDITOR_APPEARANCE_PROFILE, matchesSoftWrapPath, normalizeEditorAppearanceProfile, readEditorAppearanceProfileWithDiagnostics, writeEditorAppearanceProfile, type EditorAppearanceProfile } from "./workspace/editorAppearanceProfile";
import { applyRunConfigurationOverride, applyRunOverrideToDebugConfiguration, applyRunOverrideToJavaLaunch, javaRunTargetToExecutionRunConfiguration, materializeRunConfigurations, parseDotEnv, readRunConfigurationOverrides, resolveEnvironmentFilePath, writeActiveRunConfigurationSelection } from "./workspace/runConfigurationPersistence";
import { executeTaskPlan, resolveBuildTargetPlan } from "./workspace/executionPlan";
import { FileTreePane } from "./workspace/FileTreePane";
import { ProjectTree } from "./workspace/ProjectTree";
import { navigateProjectTree } from "./workspace/projectTreeNavigation";
import { OutlinePane } from "./workspace/OutlinePane";
import { useWorkspaceActionsController } from "./workspace/useWorkspaceActionsController";
import { type WorkspaceCommand, type WorkspaceCommandContext } from "./workspace/workspaceCommands";
import type { ShellShortcutClaim } from "./workspace/shellShortcutRouter";
import type { WorkspaceFocus } from "./workspace/workspaceActionRegistry";
import { codePointOffsetToUtf16Offset, collectReplacePreimages, replaceMatchAbsolutePath, type ReplaceFilePreimage, type ReplacePrepareOptions } from "./workspace/replaceInFilesModel";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../types";
import { type LibraryBufferInfo, type LspFileState, type MarkdownViewMode, type OpenFileState, type TreeSelection, type TreeViewMode, type WorkspaceBuildRunTools, readWorkspaceBuildRunTools, writeWorkspaceBuildRunTools, workspaceToolConfig, CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE, CODE_WORKSPACE_MAX_TREE_FONT_SIZE, CODE_WORKSPACE_MIN_TREE_FONT_SIZE, absoluteWorkspacePath, basename, clampCodeWorkspaceFontSize, clampCodeWorkspaceTreeFontSize, errorMessage, fileKey, gitRootForWorkspacePath, initialFileRef, initialLooseFiles, initialRoots, isExternalHref, isLspFeatureReady, shouldLiveSyncLsp, shouldProbeLsp, makeLibraryFile, fsPathComparisonKey, fsPathEquals, normalizeEditorText, normalizeFsPath, parentPath, readCodeWorkspaceTreeFontSize, relativePathWithinRoot, resolveLooseMarkdownLink, resolveRootMarkdownLink, rootDirKey, workspaceTitle, writeCodeWorkspaceTreeFontSize, writeCodeWorkspaceTreeViewMode } from "./workspace/codeWorkspaceModel";
import { useWorkspaceTreeData } from "./workspace/useWorkspaceTreeData";
import { useWorkspaceLspSession } from "./workspace/useWorkspaceLspSession";
import { useWorkspaceGitSnapshots } from "./workspace/useWorkspaceGitSnapshots";
import { useWorkspaceNavigation } from "./workspace/useWorkspaceNavigation";
import { useWorkspaceFileActions } from "./workspace/useWorkspaceFileActions";
import { symbolChainAtPosition, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "./workspace/Breadcrumbs";
import { useT } from "../../lib/i18n";
import { TerminalDockPanel, type TerminalDockHandle } from "./workspace/panels/TerminalDockPanel";
import { RunPanel, type RunPanelHandle, type WorkspaceTaskItem } from "./workspace/panels/RunPanel";
import { BuildPanel } from "./workspace/panels/BuildPanel";
import { AnalysisPanel } from "./workspace/panels/AnalysisPanel";
import { TestsPanel } from "./workspace/panels/TestsPanel";
import { DebugPanel } from "./workspace/panels/DebugPanel";
import { JavaMainClassPicker } from "./workspace/JavaMainClassPicker";
import { useCodeDebugSession } from "./workspace/useCodeDebugSession";
import { type JavaMainClassOption } from "../../lib/editor/dap";
import { type DebugBreakpoint, type DebugStackFrame } from "./workspace/dapDebugModel";
import { BreakpointPopup, GutterBreakpointMenu } from "./workspace/panels/debug/BreakpointPopup";
import { BreakpointsDialog } from "./workspace/panels/debug/BreakpointsDialog";
import { EvaluateExpressionDialog } from "./workspace/panels/debug/EvaluateExpressionDialog";
import type { EditorRevealTarget } from "./workspace/EditorGroup";
import { LspMessageRequestDialog } from "./workspace/LspMessageRequestDialog";
import { useWorkspaceLspClientEvents } from "./workspace/useWorkspaceLspClientEvents";
import { addDiagnosticToInspectionBaseline, addInspectionSuppression, applyInspectionProfile, clearInspectionBaseline, importInspectionBaseline, readInspectionProfile, removeInspectionBaselineEntry, removeInspectionSuppression, diagnosticInspectionId, replaceInspectionBaseline, serializeInspectionBaseline, updateInspectionRule, writeInspectionProfile, type InspectionProfile, type InspectionRule, type InspectionSuppressionScope } from "./workspace/inspectionProfile";
import { ExternalFileConflictDialog } from "./workspace/ExternalFileConflictDialog";
import { WorkspaceRecoveryDialog } from "./workspace/WorkspaceRecoveryDialog";
import { FileEncodingDialog } from "./workspace/FileEncodingDialog";
import { readWorkspaceRecoveryEntries, reconcileWorkspaceRecoveryEntries, removeWorkspaceRecoveryEntry, writeWorkspaceRecoveryEntries, type WorkspaceRecoveryEntry } from "./workspace/workspaceRecovery";
import { changedWorkspaceSemanticBufferPaths, workspaceSemanticIndexTokenRevisionCurrent, type WorkspaceSemanticIndexBuildToken } from "./workspace/workspaceSemanticIndex";
import { useWorkspaceSemanticIndex } from "./workspace/useWorkspaceSemanticIndex";
import { createRestoreTimingRecorder, executeBoundedAsyncQueue, planWorkspaceRestore } from "./workspace/workspaceRestoreModel";
import { TextInputDialog } from "../sidebar/ConfirmDialog";
import { createOpenFile } from "./workspace/controller/fileActions";
import { createOpenHierarchy, createOpenLspLocation, createOpenQuickDocumentation, createNavigateDiagnostic, createRunFindReferences } from "./workspace/controller/navigationActions";
import { createApplyLspResourceOperationUnlocked } from "./workspace/controller/resourceActions";
import { createApplyLspWorkspaceEditNow } from "./workspace/controller/workspaceEditActions";
import { createRunRecoveryRestore } from "./workspace/controller/recoveryActions";
import { createRequestCodeActions, createRunCodeAction, createShowCodeActionsMenu } from "./workspace/controller/codeActionActions";
import { createExecuteAutoImportOnTheFly, createExecutePasteWithAutoImport, createRunRearrangeExecute, createRunCleanupExecute } from "./workspace/controller/styleActions";
import { createWorkspaceCommands } from "./workspace/controller/commandCatalog";
import { createBuildActiveProject, createStartDebugActiveFile, createStartDebugActiveTarget } from "./workspace/controller/runActions";
import { type CodeWorkspaceTabProps, type PendingExternalFileConflict, type PendingExternalFileEvent, WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES, type TabPolicyLifecycleReceiptView, type ResourceCleanupRecoveryView, TREE_DETAILS_STORAGE_KEY, type PendingClosedFile, extractContextSnippet, LSP_CHANGE_SYNC_DELAY_MS, LSP_FEATURE_SYNC_WAIT_MS, type WorkspaceEditTabSnapshot, compareSelectionFromEditorSelection, compareTargetForOpenFile, compareDescriptorForOpenFile, EMPTY_DISPLAY_DIAGNOSTICS, breadcrumbSegmentsForFile, LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS, type CodeWorkspaceGitManagerPayload, encodingSupportsBom, type LspLocationOpenOptions, semanticLocationsFromResult, RECENT_FILES_TOOL_WINDOWS } from "./workspace/controller/model";
import { type TreeOpenIntent, type WorkspaceEditApplyOptions } from "./workspace/controller/mutationTypes";
import { WorkspaceToolbar } from "./workspace/views/WorkspaceToolbar";
import { createRenderEditorGroup } from "./workspace/views/editorGroupView";
import { createBeginSemanticQuery, createFetchWorkspaceSymbols, createCopyReferenceAtCursor, createHighlightUsagesInFile, createParameterInfoProvider, createGetLspHover, createGoToDeclaration } from "./workspace/controller/semanticQueries";
import { createPersistWorkspaceLayoutNow } from "./workspace/controller/layoutPersistence";
import { createLoadBreadcrumbPathChildren, createBreadcrumbPathActions, createShowTreeContextMenu, createCreateJavaClassFromPlan } from "./workspace/controller/treeActions";
import { createMutateOpenBuffer, createQueueEditorTextUpdate, createReloadActiveFileWithEncoding } from "./workspace/controller/bufferMutations";
import { createReadWorkspaceEditPathSnapshot, createRunRecoveryDismiss, createPromptRefactorRecoveryEntry } from "./workspace/controller/recoveryJournal";
import { createBuildEditorAiContext, createShowEditorContextMenu } from "./workspace/controller/editorMenus";
import { createCompareWithClipboard, createCompareWithFile, createApplyCompareSession } from "./workspace/controller/compareActions";
import { createPrepareJavaLaunch } from "./workspace/controller/projectLaunch";
import { useProjectDiagnostics } from "./workspace/controller/useProjectDiagnostics";
import { useWorkspacePreferences } from "./workspace/controller/useWorkspacePreferences";
import { useEditorSemanticDecorations } from "./workspace/controller/useEditorSemanticDecorations";
import { useWorkspaceTests } from "./workspace/hooks/useWorkspaceTests";
import { useExecutionTargets } from "./workspace/hooks/useExecutionTargets";
import { createReplaceMatches } from "./workspace/controller/replaceMatches";
import { useBreakpointControls } from "./workspace/hooks/useBreakpointControls";
import { useWorkspaceSave } from "./workspace/hooks/useWorkspaceSave";
import { useSymbolRefactoring } from "./workspace/hooks/useSymbolRefactoring";
import { useWorkspaceKeyboard } from "./workspace/hooks/useWorkspaceKeyboard";
import { useWorkspaceFileLifecycle } from "./workspace/hooks/useWorkspaceFileLifecycle";
import { useWorkspaceGitDecorations } from "./workspace/hooks/useWorkspaceGitDecorations";
import { useWorkspaceToolWindows } from "./workspace/hooks/useWorkspaceToolWindows";
import { createApplyTabPolicy } from "./workspace/controller/applyTabPolicy";
import { createToolWindowChrome } from "./workspace/views/toolWindowChrome";























export function CodeWorkspaceTab({
  tabId,
  workspace,
  visible = true,
  onOpenGitManager,
  onSyncGitManager,
  onCommandsChange,
}: CodeWorkspaceTabProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);
  // ED-PARITY-027 B: while the main sidebar is collapsed to its rail, the
  // active workspace renders its left tool window bar into that rail.
  const mainRailHost = useMainRailHostStore((s) => s.host);
  const mainRailMergeActive = useAppStore((s) => s.mergeToolWindowRail && s.sidebarCollapsed);
  const setWorkspaceStatusSegments = useCodeWorkspaceStatusStore((s) => s.setStatus);
  const setWorkspaceStatusActions = useCodeWorkspaceStatusStore((s) => s.setActions);
  const clearWorkspaceStatus = useCodeWorkspaceStatusStore((s) => s.clearForTab);
  const sendPromptToTabChat = useChatStore((s) => s.sendPromptToTabChat);
  const t = useT();
  const workspaceInstanceId = useMemo(
    () => workspace.workspaceInstanceId ?? workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId, workspace.workspaceInstanceId],
  );
  const observationBridge = useMemo(
    () => new WorkspaceObservationBridge(workspaceInstanceId, import.meta.env.PROD),
    [workspaceInstanceId],
  );
  const observationBridgeRef = useRef(observationBridge);
  observationBridgeRef.current = observationBridge;
  const publishWorkspaceObservation = useCallback((
    update: (bridge: WorkspaceObservationBridge) => void,
  ) => {
    update(observationBridgeRef.current);
  }, []);
  const semanticIndex = useWorkspaceSemanticIndex(workspaceInstanceId);
  const referenceInfoController = useMemo(
    () => new ReferenceInfoController(workspaceInstanceId),
    [workspaceInstanceId],
  );
  // §8.20.2 W1: the ONLY Parameter Info request sequence lives in this
  // session; the editor host is a pure display adapter.
  const parameterInfoSession = useMemo(
    () => new ParameterInfoSession(referenceInfoController),
    [referenceInfoController],
  );
  const [parameterPopup, setParameterPopup] = useState<ParameterDisplayState>({ phase: "hidden" });
  const [referenceHistory, setReferenceHistory] = useState<ReferenceHistorySnapshot>(
    () => referenceInfoController.historySnapshot(),
  );
  useEffect(() => {
    referenceInfoController.activate();
    setReferenceHistory(referenceInfoController.historySnapshot());
    return () => referenceInfoController.dispose();
  }, [referenceInfoController]);
  useEffect(() => {
    const unsubscribe = parameterInfoSession.subscribe(setParameterPopup);
    return () => {
      unsubscribe();
      parameterInfoSession.dispose();
    };
  }, [parameterInfoSession]);
  const {
    messageRequest: lspMessageRequest,
    progresses: lspProgresses,
    resolveMessageRequest: resolveLspMessageRequest,
    cancelProgress: cancelLspProgress,
  } = useWorkspaceLspClientEvents({
    workspaceId: workspaceInstanceId,
    visible,
    onStatus: setStatusMessage,
  });
  const activeSemanticProviders = useMemo(
    () => lspProgresses.map((progress) => `${progress.serverLabel}:${progress.rootUri}`),
    [lspProgresses],
  );
  useEffect(() => {
    semanticIndex.setActiveProviders(activeSemanticProviders);
  }, [activeSemanticProviders, semanticIndex.setActiveProviders]);
  const { replaceBookmarks, bookmarksRef, restoreBookmarksForFileKey, editorAiPreferences, bookmarks, cycleAiAnswerLanguage, setAiAnswerLanguage, editorAiPreferencesRef } = useWorkspacePreferences({
    workspaceInstanceId,
  });
  // §8.19.6 per-workspace tab policy: restored from the layout snapshot
  // (migrated/repaired on read) and consumed by open-time limit enforcement.
  // Editing UI is deferred — restored values already govern eviction.
  const [tabPolicy, setTabPolicy] = useState<WorkspaceTabPolicyV3>(() => ({ ...DEFAULT_WORKSPACE_TAB_POLICY_V3 }));
  const tabPolicyRef = useRef(tabPolicy);
  tabPolicyRef.current = tabPolicy;
  const tabPolicyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [tabPolicyRevision, setTabPolicyRevision] = useState(0);
  // §8.26.3 AA2: Monotonic layout revision and base revision for tab policy transactions (§ED-TABS-001)
  const layoutRevision = useCodeWorkspaceStore(
    (state) => state.byInstanceId[workspaceInstanceId]?.layoutRevision ?? 0,
  );
  const [baseLayoutRevision, setBaseLayoutRevision] = useState(0);

  const openTabPolicySettings = useCallback(() => {
    const trigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    // ED-PARITY-010: an opener inside the transient ⋮ menu disappears with it;
    // return focus to the ⋮ anchor instead.
    tabPolicyTriggerRef.current = trigger?.closest('[data-testid="code-workspace-toolbar-more-menu"]')
      ? document.querySelector<HTMLButtonElement>('[data-testid="code-workspace-toolbar-more"]')
      : trigger;
    setBaseLayoutRevision(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).layoutRevision);
    setTabPolicySettingsOpen(true);
  }, [workspaceInstanceId]);

  const closeTabPolicySettings = useCallback(() => {
    setTabPolicySettingsOpen(false);
    requestAnimationFrame(() => tabPolicyTriggerRef.current?.focus());
  }, []);

  // §8.26.2 AA1: Root workspace clipboard session handle with permission adapter (§8.27.2 BB1 / ED-CLIP-002)
  const clipboardHandle = useMemo(() => acquireClipboardStore(workspaceInstanceId), [workspaceInstanceId]);
  const clipboardSnapshot = useSyncExternalStore(
    clipboardHandle.subscribe,
    clipboardHandle.getSnapshot,
    clipboardHandle.getSnapshot,
  );
  useEffect(() => {
    const observeClipboard = (snapshot: typeof clipboardSnapshot) => {
      publishWorkspaceObservation((bridge) => {
        bridge.observeClipboardSession(snapshot.payloadRevision, snapshot.consumerCount);
      });
    };
    const unsubscribe = clipboardHandle.subscribe(observeClipboard);
    observeClipboard(clipboardHandle.getSnapshot());
    return unsubscribe;
  }, [clipboardHandle, publishWorkspaceObservation]);
  useEffect(() => {
    const detachAdapter = clipboardHandle.attachPermissionAdapter(createDefaultClipboardPermissionAdapter());
    return () => {
      detachAdapter();
      clipboardHandle.release();
    };
  }, [clipboardHandle]);
  // §8.19.9 R8-D1: code style schemes — production store with persistence;
  // the active scheme layers into effective-style resolution BELOW EditorConfig.
  const [codeStyleSchemes, setCodeStyleSchemes] = useState<CodeStyleSchemeStoreState>(
    () => readCodeStyleSchemeStore(),
  );
  const codeStyleSchemesRef = useRef(codeStyleSchemes);
  codeStyleSchemesRef.current = codeStyleSchemes;
  const changeCodeStyleSchemes = useCallback((next: CodeStyleSchemeStoreState) => {
    setCodeStyleSchemes(next);
    writeCodeStyleSchemeStore(next);
  }, []);
  const [codeStyleSettingsOpen, setCodeStyleSettingsOpen] = useState(false);
  const [searchFocusTarget, setSearchFocusTarget] = useState<"query" | "replace">("query");
  const [workspaceUndoConfirmOpen, setWorkspaceUndoConfirmOpen] = useState(false);
  const undoConfirmTriggerRef = useRef<HTMLElement | null>(null);
  const searchEverywhereTriggerRef = useRef<HTMLElement | null>(null);
  const ensureWorkspaceUi = useCodeWorkspaceStore((s) => s.ensureInstance);
  const disposeWorkspaceUi = useCodeWorkspaceStore((s) => s.disposeInstance);
  const patchWorkspaceUi = useCodeWorkspaceStore((s) => s.patchInstance);
  const setStoreActiveKey = useCodeWorkspaceStore((s) => s.setActiveKey);
  const setStoreOpenOrder = useCodeWorkspaceStore((s) => s.setOpenOrder);
  const updateStoreOpenFiles = useCodeWorkspaceStore((s) => s.updateOpenFiles);
  const updateStoreLspFiles = useCodeWorkspaceStore((s) => s.updateLspFiles);
  const replaceStoreFileState = useCodeWorkspaceStore((s) => s.replaceFileState);
  const updateStoreExpandedRootIds = useCodeWorkspaceStore((s) => s.updateExpandedRootIds);
  const updateStoreExpandedDirKeys = useCodeWorkspaceStore((s) => s.updateExpandedDirKeys);
  const updateStoreEditorGroup = useCodeWorkspaceStore((s) => s.updateEditorGroup);
  const setStoreActiveEditorGroup = useCodeWorkspaceStore((s) => s.setActiveEditorGroup);
  const splitLayoutLeaf = useCodeWorkspaceStore((s) => s.splitLayoutLeaf);
  const closeLayoutLeaf = useCodeWorkspaceStore((s) => s.closeLayoutLeaf);
  const moveLayoutTabStore = useCodeWorkspaceStore((s) => s.moveLayoutTab);
  const equalizeLayoutRatiosStore = useCodeWorkspaceStore((s) => s.equalizeLayoutRatios);
  const stretchLayoutLeafStore = useCodeWorkspaceStore((s) => s.stretchLayoutLeaf);
  const unsplitAllLayoutStore = useCodeWorkspaceStore((s) => s.unsplitAllLayout);
  const setLayoutTreeV2Store = useCodeWorkspaceStore((s) => s.setLayoutTreeV2);
  const closeLayoutTabInLeaf = useCodeWorkspaceStore((s) => s.closeLayoutTabInLeaf);
  const setLeafActiveTab = useCodeWorkspaceStore((s) => s.setLeafActiveTab);
  const setLayoutNodeRatios = useCodeWorkspaceStore((s) => s.setLayoutNodeRatios);
  const seedTreeExpandIfEmpty = useCodeWorkspaceStore((s) => s.seedTreeExpandIfEmpty);
  const setShellChromeState = useCodeWorkspaceStore((s) => s.setShellChromeState);
  const setBottomDockHeightForTool = useCodeWorkspaceStore((s) => s.setBottomDockHeightForTool);
  const restoreDefaultToolWindowLayout = useCodeWorkspaceStore((s) => s.restoreDefaultToolWindowLayout);
  // The effect below initializes a missing instance after commit. Keeping the
  // render path read-only avoids notifying external-store subscribers during
  // render when a workspace is mounted for the first time.
  const workspaceUi = useCodeWorkspaceStore((s) => selectCodeWorkspaceUi(s, workspaceInstanceId));
  const projectPanelRef = useRef<PanelImperativeHandle>(null);
  // Panel `defaultSize` is a mount-time input for react-resizable-panels:
  // re-passing a value that changes while the pointer is down makes the library
  // re-register the panel, tear the group down and drop the live drag session,
  // which freezes the splitter after the first pixel of movement. Resolve the
  // persisted width exactly once and keep it constant for the mount.
  const initialProjectPanelWidthRef = useRef<number | null>(null);
  if (initialProjectPanelWidthRef.current === null) {
    // A live instance already carries the session's width; a fresh mount must
    // fall back to the persisted snapshot because `workspaceUi` still holds the
    // 452px store default until the hydration effect below runs.
    const storedWidth = useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId]
      ?.shellChromeState?.projectWidthPx
      ?? readWorkspaceLayoutSnapshot(workspaceInstanceId)?.shellChromeState?.projectWidthPx;
    initialProjectPanelWidthRef.current =
      typeof storedWidth === "number" && Number.isFinite(storedWidth) && storedWidth > 40
        ? Math.round(storedWidth)
        : 452;
  }
  const initialProjectPanelSize = `${initialProjectPanelWidthRef.current}px`;
  const lastProjectPanelSizeRef = useRef(initialProjectPanelWidthRef.current);

  useEffect(() => {
    ensureWorkspaceUi(workspaceInstanceId);
    replaceBookmarks(readWorkspaceBookmarks(workspaceInstanceId));
  }, [ensureWorkspaceUi, replaceBookmarks, workspaceInstanceId]);

  // Restore chrome/layout once per instance, then seed expand keys only when empty.
  const layoutHydratedRef = useRef<string | null>(null);
  const layoutRestoredOpenFilesRef = useRef(false);
  // ED-IMPROVE-007: in-memory per-leaf/file view snapshots; hydrated from the
  // layout snapshot before the first editor mounts so a reopen/restart applies
  // the right leaf's caret, selection, scroll and folds.
  const [hydratedViewStates] = useState<WorkspaceViewStates>(() => (
    readWorkspaceLayoutSnapshot(workspaceInstanceId)?.viewStates ?? {}
  ));
  const viewStatesRef = useRef<WorkspaceViewStates>(hydratedViewStates);
  const [viewStateRevision, setViewStateRevision] = useState(0);
  useEffect(() => {
    if (layoutHydratedRef.current === workspaceInstanceId) return;
    layoutHydratedRef.current = workspaceInstanceId;
    layoutRestoredOpenFilesRef.current = false;
    viewStatesRef.current = {};
    const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
    if (snapshot) {
      viewStatesRef.current = snapshot.viewStates ?? {};
      if (snapshot.layoutRecovered) {
        setStatusMessage("Recovered invalid workspace layout into a single editor leaf");
      }
      if (snapshot.shellChromeState?.projectWidthPx) {
        lastProjectPanelSizeRef.current = snapshot.shellChromeState.projectWidthPx;
      }
      setTabPolicy(snapshot.tabPolicy ?? { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 });
      patchWorkspaceUi(workspaceInstanceId, {
        bottomDockOpen: snapshot.bottomDockOpen,
        bottomDockTab: snapshot.bottomDockTab,
        rightPaneOpen: snapshot.rightPaneOpen,
        rightPaneTab: snapshot.rightPaneTab,
        languagePanelOpen: snapshot.languagePanelOpen,
        splitOrientation: snapshot.splitOrientation,
        activeEditorGroupId: snapshot.activeEditorGroupId,
        expandedRootIds: snapshot.expandedRootIds,
        expandedDirKeys: snapshot.expandedDirKeys,
        layoutTreeV2: snapshot.layoutTreeV2,
        shellChromeState: snapshot.shellChromeState,
        editorGroups: Object.fromEntries(
          Object.entries(snapshot.editorGroups).map(([id, g]) => [
            id,
            {
              id,
              openOrder: g.openOrder,
              activeKey: g.activeKey,
              previewKey: g.previewKey,
              pinnedKeys: g.pinnedKeys,
            },
          ]),
        ),
        openOrder: uniqueOrderedKeys(snapshot.editorGroups),
        activeKey: snapshot.editorGroups[snapshot.activeEditorGroupId]?.activeKey
          ?? snapshot.editorGroups.primary?.activeKey
          ?? snapshot.editorGroups.secondary?.activeKey
          ?? null,
      });
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshot);
      layoutRestoredOpenFilesRef.current = layoutSnapshotHasOpenFiles(snapshot);
      return;
    }
    const seedRoots = initialRoots(workspace);
    // §8.16.4 N6.6: fresh mounts materialize a single-leaf v2 tree
    // immediately so the recursive renderer is the only production layout
    // path from first paint; the primary/secondary fallback never renders.
    // The dormant "secondary" group stays present-but-empty: empty legacy
    // slots carry no layout truth (see validateTreeGroupConsistency).
    const uiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    patchWorkspaceUi(workspaceInstanceId, {
      layoutTreeV2: createSingleLeafLayout(
        "primary",
        uiNow.editorGroups.primary?.openOrder ?? [],
        uiNow.editorGroups.primary?.activeKey ?? null,
      ),
      editorGroups: {
        primary: uiNow.editorGroups.primary ?? createEditorGroup("primary"),
        secondary: createEditorGroup("secondary"),
      },
      activeEditorGroupId: "primary",
    });
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, defaultWorkspaceLayoutSnapshot());
      if (seedRoots.length === 0) return;
    seedTreeExpandIfEmpty(
      workspaceInstanceId,
      seedRoots.map((root) => root.id),
      seedRoots.map((root) => rootDirKey(root.id, "")),
    );
  }, [patchWorkspaceUi, seedTreeExpandIfEmpty, workspace, workspaceInstanceId]);

  const {
    languagePanelOpen,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen: rightPaneOpenStored,
    rightPaneTab,
    searchEverywhereOpen,
    searchEverywhereMode,
    recentFilesOpen,
    recentAdvanceNonce,
    recentEntries,
    structureOpen,
    structureLoading,
    structureUnavailable,
    structureSymbols,
    quickDocOpen,
    quickDocContent,
    pinnedDoc,
    pinnedDocLocked,
    locationPeek,
    searchFocusNonce,
    searchIncludePreset,
    searchQueryPreset,
    openOrder,
    activeKey,
    editorGroups,
    activeEditorGroupId,
    splitOrientation,
    markdownModes,
    treeFilter,
    treeViewMode,
    expandedRootIds,
    expandedDirKeys,
    treeSelection: selected,
    openFiles,
    lspFiles,
  } = workspaceUi;

  const expandedRoots = useMemo(() => new Set(expandedRootIds), [expandedRootIds]);
  const expandedDirs = useMemo(() => new Set(expandedDirKeys), [expandedDirKeys]);
  // Refs declared early so store-backed setters can dual-write latest maps synchronously.
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
  const lspFilesRef = useRef(lspFiles);
  const editorCommandPortsRef = useRef(new Map<EditorGroupId, {
    fileKey: string;
    token: object;
    port: EditorCommandPort;
  }>());
  const treeInteractionEpochRef = useRef(0);
  const treeOpenRequestIdRef = useRef(0);
  const pendingTreeOpenIntentRef = useRef<TreeOpenIntent | null>(null);
  const tryGrantTreeFocusRef = useRef<(intent: TreeOpenIntent, canonicalKey: string) => boolean>(() => false);

  const [editorCommandContextRevision, setEditorCommandContextRevision] = useState(0);
  /** Selection-derived action-context flags last published (see onSelectionChange). */
  const editorCommandSignatureRef = useRef<string | null>(null);
  const registerEditorCommandPort = useCallback((
    groupId: EditorGroupId,
    registration: EditorCommandPortRegistration,
  ) => {
    const current = editorCommandPortsRef.current.get(groupId);
    if (registration.port) {
      editorCommandPortsRef.current.set(groupId, {
        fileKey: registration.fileKey,
        token: registration.token,
        port: registration.port,
      });
      setEditorCommandContextRevision((revision) => revision + 1);
      if (pendingTreeOpenIntentRef.current) {
        const intent = pendingTreeOpenIntentRef.current;
        if (intent.groupId === groupId) {
          const expectedKey = intent.canonicalFileKey ?? intent.requestedFileKey;
          if (expectedKey === registration.fileKey) {
            tryGrantTreeFocusRef.current(intent, registration.fileKey);
          }
        }
      }
      return;
    }
    if (
      current?.fileKey !== registration.fileKey
      || current.token !== registration.token
    ) {
      return;
    }
    editorCommandPortsRef.current.delete(groupId);
    setEditorCommandContextRevision((revision) => revision + 1);
  }, []);
  const activeEditorCommandOwner = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = ui.activeEditorGroupId;
    const fileKey = ui.editorGroups[groupId]?.activeKey ?? null;
    const owner = editorCommandPortsRef.current.get(groupId) ?? null;
    return owner && fileKey === owner.fileKey ? owner : null;
  }, [workspaceInstanceId]);
  /**
   * Owner lookup pinned to an explicit recursive leaf. Context menus freeze
   * `{groupId, fileKey}` at open time; this guard keeps a later active-group
   * change from redirecting their execution to a different editor.
   */
  const editorCommandOwnerFor = useCallback((groupId: string, fileKey: string) => {
    const owner = editorCommandPortsRef.current.get(groupId as EditorGroupId) ?? null;
    return owner && owner.fileKey === fileKey ? owner : null;
  }, []);
  const activeEditorCommandState = useCallback((): EditorCommandState | null => {
    return activeEditorCommandOwner()?.port.state() ?? null;
  }, [activeEditorCommandOwner]);
  const executeActiveEditorCommand = useCallback((commandId: EditorCommandId, options?: EditorCommandOptions) => {
    return activeEditorCommandOwner()?.port.execute(commandId, options) ?? false;
  }, [activeEditorCommandOwner]);
  const executeEditorCommandFor = useCallback((
    target: EditorCommandTarget | undefined,
    commandId: EditorCommandId,
    options?: EditorCommandOptions,
  ) => {
    if (target) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)
        ?.port.execute(commandId, options) ?? false;
    }
    return executeActiveEditorCommand(commandId, options);
  }, [editorCommandOwnerFor, executeActiveEditorCommand]);
  const executeEditorCommand = useCallback((commandId: EditorCommandId, context?: WorkspaceCommandContext) => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return executeEditorCommandFor(target, commandId);
    }
    return executeActiveEditorCommand(commandId);
  }, [executeActiveEditorCommand, executeEditorCommandFor]);
  /**
   * Availability state for a command invocation. A context-menu payload pins
   * the owning leaf; without one (keyboard, palette) the active leaf answers.
   */
  const editorCommandStateFor = useCallback((context?: WorkspaceCommandContext): EditorCommandState | null => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)?.port.state() ?? null;
    }
    return activeEditorCommandState();
  }, [activeEditorCommandState, editorCommandOwnerFor]);
  const handleReturnToEditor = useCallback(() => {
    const owner = activeEditorCommandOwner();
    if (owner?.port?.focus) {
      owner.port.focus({ preventScroll: true });
      return;
    }
    const cmContent = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    cmContent?.focus({ preventScroll: true });
  }, [activeEditorCommandOwner]);
  /**
   * Resolve a provider-action invocation target. Context-menu payloads carry
   * the clicked file and position; keyboard/palette invocations fall back to
   * the active file at the current selection.
   */
  const resolveEditorTarget = useCallback((context?: WorkspaceCommandContext): {
    file: OpenFileState | null;
    position: LspPosition | undefined;
  } => {
    const payload = context?.payload as {
      groupId?: unknown;
      fileKey?: unknown;
      position?: LspPosition;
    } | undefined;
    if (typeof payload === "object" && payload !== null && typeof payload.fileKey === "string") {
      const file = openFilesRef.current[payload.fileKey] ?? null;
      return { file, position: payload.position };
    }
    // activeKeyRef is declared later in the component (keyboard switcher owns
    // it), so read through the store for the fallback active file.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const file = openFilesRef.current[ui.activeKey ?? ""] ?? null;
    return { file, position: editorSelectionRef.current.end };
  }, [workspaceInstanceId]);
  /**
   * False after unmount so async callbacks skip setState. MUST come from
   * `useMountedRef`: the inline `useEffect(() => () => { ref.current = false })`
   * spelling stays false forever under StrictMode's dev double-invoke, which
   * silently aborted the Java debug launch right after main-class resolution.
   */
  const mountedRef = useMountedRef();
  const [workspaceResourceOperationLocked, setWorkspaceResourceOperationLocked] = useState(false);
  // ED-IMPROVE-001: live mirror so an awaited rearrange/cleanup run observes a
  // read-only toggle that happens after the callback closure was created.
  const workspaceResourceOperationLockedRef = useRef(workspaceResourceOperationLocked);
  workspaceResourceOperationLockedRef.current = workspaceResourceOperationLocked;
  // ED-IMPROVE-001: monotonic per-workflow request tokens. A newer invocation
  // (double entry) supersedes the in-flight one, which then fails typed stale
  // before any mutation.
  const rearrangeRequestTokenRef = useRef(0);
  const cleanupRequestTokenRef = useRef(0);
  const workspaceEditQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWorkspaceEditsRef = useRef(0);
  const pendingWorkspaceHistoryClaimRef = useRef(false);
  const providerCommandSemanticGuardRef = useRef<{
    generation: number;
    revision: number;
    requireReady: boolean;
  } | null>(null);
  const providerCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fileActionResourceOperationRef = useRef<((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => Promise<void>) | null>(null);
  const pendingEditorTextByFileRef = useRef(new Map<string, OpenFileState>());
  const pendingEditorCaretByFileRef = useRef(new Map<string, {
    position: LspPosition;
    offset?: number;
  }>());
  const flushPendingEditLocationsRef = useRef<() => void>(() => {});
  const pendingEditorTextTimerRef = useRef<number | null>(null);
  /** Debounced didChange timers keyed by open-file key (live buffer path). */
  const liveLspSyncTimersRef = useRef<Record<string, number>>({});
  const [externalFileConflicts, setExternalFileConflicts] = useState<PendingExternalFileConflict[]>([]);
  const pendingExternalFileEventsRef = useRef(new Map<string, PendingExternalFileEvent>());
  const [workspaceRecoveryEntries, setWorkspaceRecoveryEntries] = useState<WorkspaceRecoveryEntry[]>([]);
  const [workspaceRecoveryOpen, setWorkspaceRecoveryOpen] = useState(false);
  /** §8.19.1 disk-effect ledger view state; bumped whenever rows are recorded/resolved. */
  const [diskEffectLedgerRevision, setDiskEffectLedgerRevision] = useState(0);
  const bumpDiskEffectLedger = useCallback(() => {
    setDiskEffectLedgerRevision((revision) => revision + 1);
  }, []);
  const diskEffectLedgerEntries = useMemo(
    () => listDiskEffectLedgerEntries(workspaceInstanceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision drives refresh; rows only change through recorded/resolved events or workspace switches
    [workspaceInstanceId, diskEffectLedgerRevision],
  );
  const [fileEncodingDialogOpen, setFileEncodingDialogOpen] = useState(false);
  const [saveObservations, setSaveObservations] = useState<Record<string, SaveObservationRecord>>({});
  const pendingEncodingDialogFileKeyRef = useRef<string | null>(null);
  const pendingWorkspaceRecoveryKeysRef = useRef(new Set<string>());
  useEffect(() => {
    setSaveObservations({});
  }, [workspaceInstanceId]);
  const invalidateSemanticAfterLspRestart = useCallback(() => {
    semanticIndex.invalidate("language-server-restarted");
  }, [semanticIndex.invalidate]);

  const setBottomDockOpenRaw = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { bottomDockOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setBottomDockTabRaw = useCallback((tab: string) => {
    patchWorkspaceUi(workspaceInstanceId, { bottomDockTab: tab as BottomDockTabId });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLanguagePanelOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).languagePanelOpen;
    patchWorkspaceUi(workspaceInstanceId, {
      languagePanelOpen: typeof open === "function" ? open(prev) : open,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  // ED-PARITY-024: IDEA tool window placement. Project and the bottom-left
  // dock keep their persisted flags; moved windows (and Structure/Docs) live
  // in the layout controller. Legacy "open the dock on tab X" call sites are
  // routed to X's current anchor below.
  const toolWindowLayout = useToolWindowLayout(
    workspaceInstanceId,
    WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES,
    {
      projectOpen: languagePanelOpen,
      setProjectOpen: (open) => setLanguagePanelOpen(open),
      bottomDockOpen,
      bottomDockTab,
      setBottomDockOpen: setBottomDockOpenRaw,
      setBottomDockTab: setBottomDockTabRaw,
    },
    rightPaneOpenStored ? [rightPaneTab === "documentation" ? "documentation" : "structure"] : [],
  );
  const toolWindowLayoutRef = useRef(toolWindowLayout);
  toolWindowLayoutRef.current = toolWindowLayout;
  const toolWindowNodes = useToolWindowNodes();
  const leftToolAreaOpen = toolWindowLayout.sideOpen("left");
  const rightToolAreaOpen = toolWindowLayout.sideOpen("right");
  /** A routed tab request suppresses the dock open that accompanies it. */
  const routedDockRequestRef = useRef<{ tab: string; dockWasOpen: boolean } | null>(null);
  const pendingDockOpenRef = useRef<{ tab: string; dockWasOpen: boolean } | null>(null);
  const setBottomDockOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const next = typeof open === "function" ? open(ui.bottomDockOpen) : open;
    if (next && routedDockRequestRef.current) return;
    if (next && !ui.bottomDockOpen) {
      // The tab request of the same call site may follow; remember that the
      // dock was closed so a routed tab can undo this open.
      const request = { tab: "", dockWasOpen: false };
      pendingDockOpenRef.current = request;
      queueMicrotask(() => {
        if (pendingDockOpenRef.current === request) pendingDockOpenRef.current = null;
      });
    }
    setBottomDockOpenRaw(next);
  }, [setBottomDockOpenRaw, workspaceInstanceId]);
  const setBottomDockTab = useCallback((tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const next = typeof tab === "function" ? tab(ui.bottomDockTab) : tab;
    const layout = toolWindowLayoutRef.current;
    if (layout.anchorOf(next) !== "bottom-left") {
      // A dock open issued just before this request (same call site) is undone.
      if (pendingDockOpenRef.current) {
        pendingDockOpenRef.current = null;
        setBottomDockOpenRaw(false);
      }
      const request = { tab: next, dockWasOpen: ui.bottomDockOpen };
      routedDockRequestRef.current = request;
      queueMicrotask(() => {
        if (routedDockRequestRef.current === request) routedDockRequestRef.current = null;
      });
      layout.show(next);
      return;
    }
    setBottomDockTabRaw(next);
  }, [setBottomDockOpenRaw, setBottomDockTabRaw, workspaceInstanceId]);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const lastRightPanelSizeRef = useRef(20);
  /** Legacy right-pane API (Outline / Documentation) mapped onto tool windows. */
  const rightPaneTabRef = useRef<RightPaneTabId>(rightPaneTab);
  const setRightPaneOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const layout = toolWindowLayoutRef.current;
    const tool = rightPaneTabRef.current === "documentation" ? "documentation" : "structure";
    const next = typeof open === "function" ? open(layout.isVisible(tool)) : open;
    if (next) layout.show(tool);
    else layout.hide(tool);
    patchWorkspaceUi(workspaceInstanceId, { rightPaneOpen: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRightPaneTab = useCallback((tab: RightPaneTabId) => {
    const layout = toolWindowLayoutRef.current;
    const previous = rightPaneTabRef.current === "documentation" ? "documentation" : "structure";
    const nextTool = tab === "documentation" ? "documentation" : "structure";
    rightPaneTabRef.current = tab;
    if (previous !== nextTool && layout.isVisible(previous)) layout.show(nextTool);
    patchWorkspaceUi(workspaceInstanceId, { rightPaneTab: tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  // Readers of the legacy flag see whether the right-pane tool is visible.
  const rightPaneOpen = toolWindowLayout.isVisible(rightPaneTab === "documentation" ? "documentation" : "structure");
  void rightPaneOpenStored;
  const setSearchEverywhereOpen = useCallback((open: boolean) => {
    if (open && !selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchEverywhereOpen) {
      searchEverywhereTriggerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchEverywhereMode = useCallback((mode: SearchEverywhereMode) => {
    patchWorkspaceUi(workspaceInstanceId, { searchEverywhereMode: mode });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentFilesOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { recentFilesOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRecentEntries = useCallback((entries: RecentFileEntry[]) => {
    patchWorkspaceUi(workspaceInstanceId, { recentEntries: entries });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureLoading = useCallback((loading: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { structureLoading: loading });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const [recentLocationsOpen, setRecentLocationsOpen] = useState(false);
  // §8.19.8 Surround With dialog state (one entry, all kinds).
  const [surroundWithDialogOpen, setSurroundWithDialogOpen] = useState(false);
  // §8.19.8 Generate Code workflow state: provider candidates + phase.
  const [generateCode, setGenerateCode] = useState<{
    open: boolean;
    phase: "loading" | "ready" | "empty" | "running" | "error";
    candidates: GenerateCandidate[];
    error: string | null;
  }>({ open: false, phase: "loading", candidates: [], error: null });
  // §8.19.5 Paste-from-History popup state (session-only ring snapshot).
  const [clipboardHistoryOpen, setClipboardHistoryOpen] = useState(false);
  // ED-CLIP-004: last settled guarded clipboard result, projected as metadata
  // only. This is the observation seam a packaged runtime asserts against; the
  // prose status line cannot prove which typed enum member production chose.
  const [latestClipboardObservation, setLatestClipboardObservation] =
    useState<ClipboardObservationRecord | null>(null);
  const [clipboardHistoryEntries, setClipboardHistoryEntries] = useState<EditorClipboardSession[]>([]);
  const generateCodeContextRef = useRef<{
    file: OpenFileState;
    range: LspRange;
    semanticToken: WorkspaceSemanticIndexBuildToken | null;
    actions: LspCodeAction[];
  } | null>(null);
  const [recentLocationsChangedOnly, setRecentLocationsChangedOnly] = useState(false);
  const setStructureUnavailable = useCallback((reason: string | null) => {
    patchWorkspaceUi(workspaceInstanceId, { structureUnavailable: reason });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setStructureSymbols = useCallback((symbols: LspDocumentSymbol[]) => {
    patchWorkspaceUi(workspaceInstanceId, { structureSymbols: symbols });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocOpen = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setQuickDocContent = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { quickDocContent: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDoc = useCallback((content: QuickDocContent | null) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDoc: content });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setPinnedDocLocked = useCallback((locked: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { pinnedDocLocked: locked });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLocationPeek = useCallback((peek: LocationPeekState | null) => {
    patchWorkspaceUi(workspaceInstanceId, { locationPeek: peek });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchFocusNonce = useCallback((updater: number | ((prev: number) => number)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchFocusNonce;
    patchWorkspaceUi(workspaceInstanceId, {
      searchFocusNonce: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchIncludePreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchIncludePreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchIncludePreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setSearchQueryPreset = useCallback((
    updater: { value: string; nonce: number } | ((prev: { value: string; nonce: number }) => { value: string; nonce: number }),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).searchQueryPreset;
    patchWorkspaceUi(workspaceInstanceId, {
      searchQueryPreset: typeof updater === "function" ? updater(prev) : updater,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setOpenOrder = useCallback((order: string[] | ((prev: string[]) => string[])) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openOrder;
    setStoreOpenOrder(workspaceInstanceId, typeof order === "function" ? order(prev) : order);
  }, [setStoreOpenOrder, workspaceInstanceId]);
  const setActiveKey = useCallback((key: string | null | ((prev: string | null) => string | null)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).activeKey;
    setStoreActiveKey(workspaceInstanceId, typeof key === "function" ? key(prev) : key);
  }, [setStoreActiveKey, workspaceInstanceId]);
  const updateEditorGroup = useCallback((
    groupId: EditorGroupId,
    updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState),
  ) => {
    updateStoreEditorGroup(workspaceInstanceId, groupId, updater);
  }, [updateStoreEditorGroup, workspaceInstanceId]);
  const activateEditorGroup = useCallback((groupId: EditorGroupId) => {
    setStoreActiveEditorGroup(workspaceInstanceId, groupId);
  }, [setStoreActiveEditorGroup, workspaceInstanceId]);
  const setMarkdownModes = useCallback((
    updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).markdownModes;
    const next = typeof updater === "function" ? updater(prev) : updater;
    patchWorkspaceUi(workspaceInstanceId, { markdownModes: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setTreeFilter = useCallback((value: string) => {
    patchWorkspaceUi(workspaceInstanceId, { treeFilter: value });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setSelected = useCallback((selection: TreeSelection | null) => {
    patchWorkspaceUi(workspaceInstanceId, { treeSelection: selection });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  const setExpandedRoots = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedRootIds);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedRootIds(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedRootIds, workspaceInstanceId]);

  const setExpandedDirs = useCallback((
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const prev = new Set(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).expandedDirKeys);
    const next = typeof updater === "function" ? updater(prev) : updater;
    updateStoreExpandedDirKeys(workspaceInstanceId, [...next]);
  }, [updateStoreExpandedDirKeys, workspaceInstanceId]);

  const flushPendingEditorText = useCallback(() => {
    if (pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(pendingEditorTextTimerRef.current);
      pendingEditorTextTimerRef.current = null;
    }
    const pending = pendingEditorTextByFileRef.current;
    if (pending.size === 0) return;
    flushPendingEditLocationsRef.current();
    const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    let next = current;
    for (const [key, file] of pending) {
      // A close/reload may have removed the buffer while its input callback
      // was queued. Do not resurrect it.
      if (!(key in current) || current[key] === file) continue;
      if (next === current) next = { ...current };
      next[key] = file;
    }
    pending.clear();
    if (next === current) return;
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
    semanticIndex.publishCurrent();
  }, [semanticIndex.publishCurrent, updateStoreOpenFiles, workspaceInstanceId]);
  const setOpenFiles = useCallback((
    updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>),
  ) => {
    // External operations (save, reload, rename, close, WorkspaceEdit) need
    // a coherent current buffer, so they flush any in-progress typing first.
    flushPendingEditorText();
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).openFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    const changedPaths = changedWorkspaceSemanticBufferPaths(prev, next);
    if (changedPaths.length > 0) {
      semanticIndex.invalidate("document-edited", changedPaths);
    }
    openFilesRef.current = next;
    updateStoreOpenFiles(workspaceInstanceId, next);
  }, [
    flushPendingEditorText,
    semanticIndex.invalidate,
    updateStoreOpenFiles,
    workspaceInstanceId,
  ]);

  /** Pending store teardown, so a StrictMode remount can cancel it (below). */
  const disposeTimerRef = useRef<{ timer: number; instanceId: string } | null>(null);
  useEffect(() => {
    // A remount of the SAME workspace cancels a teardown scheduled by the
    // previous cleanup. React StrictMode runs mount → cleanup → mount in
    // development, and disposing the store instance is NOT idempotent: it
    // deletes openOrder / activeKey / editorGroups outright. Running it
    // mid-mount dropped the writes the first pass had already made, so the
    // restored initial file sat in `openFiles` but in no editor group — the tab
    // rendered with no editor at all (and with no active file the Java Debug
    // button stays disabled). Deferring the teardown by a macrotask lets the
    // remount cancel it; a real unmount has no remount to cancel, so the
    // instance is still released a tick later.
    //
    // Only a matching instance id may cancel: a tab can be rebound to a
    // different workspace without unmounting, and cancelling there would leak
    // the previous instance's entry forever.
    const pending = disposeTimerRef.current;
    if (pending != null && pending.instanceId === workspaceInstanceId) {
      window.clearTimeout(pending.timer);
      disposeTimerRef.current = null;
    }
    return () => {
      // Capture this workspace's flush callback in the effect closure. A tab can
      // be rebound to a different workspace without unmounting, and a ref read
      // during cleanup would then point at the new instance.
      const instanceId = workspaceInstanceId;
      flushPendingEditorText();
      // Persist the final live buffer synchronously on teardown; the debounced
      // effect may not have fired yet when the app is closed or the renderer
      // is being replaced.
      reconcileWorkspaceRecoveryEntries(
        instanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      for (const timer of Object.values(liveLspSyncTimersRef.current)) {
        window.clearTimeout(timer);
      }
      liveLspSyncTimersRef.current = {};
      const timer = window.setTimeout(() => {
        if (disposeTimerRef.current?.timer === timer) disposeTimerRef.current = null;
        disposeWorkspaceUi(instanceId);
      }, 0);
      disposeTimerRef.current = { timer, instanceId };
    };
  }, [disposeWorkspaceUi, flushPendingEditorText, workspaceInstanceId]);

  const setLspFiles = useCallback((
    updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>),
  ) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).lspFiles;
    const next = typeof updater === "function" ? updater(prev) : updater;
    lspFilesRef.current = next;
    updateStoreLspFiles(workspaceInstanceId, next);
  }, [updateStoreLspFiles, workspaceInstanceId]);

  const replaceWorkspaceFileState = useCallback((
    nextOpenFiles: Record<string, OpenFileState>,
    nextLspFiles: Record<string, LspFileState>,
    keyChanges: Record<string, string | null>,
  ) => {
    openFilesRef.current = nextOpenFiles;
    lspFilesRef.current = nextLspFiles;
    replaceStoreFileState(workspaceInstanceId, {
      openFiles: nextOpenFiles,
      lspFiles: nextLspFiles,
      keyChanges,
    });
  }, [replaceStoreFileState, workspaceInstanceId]);

  const initialEditorAppearance = readEditorAppearanceProfileWithDiagnostics(
    workspaceInstanceId,
    loadCodeViewProfile(),
  );
  const [editorAppearanceProfile, setEditorAppearanceProfileState] = useState<EditorAppearanceProfile>(
    () => {
      if (initialEditorAppearance.source === "migrated") {
        return writeEditorAppearanceProfile(workspaceInstanceId, initialEditorAppearance.profile);
      }
      return initialEditorAppearance.profile;
    },
  );
  const [activeEditorFontSizes, setActiveEditorFontSizes] = useState<Record<EditorGroupId, number>>({});
  const [editorAppearanceSettingsOpen, setEditorAppearanceSettingsOpen] = useState(false);
  const [tabPolicySettingsOpen, setTabPolicySettingsOpen] = useState(false);
  const [tabPolicyReceipt, setTabPolicyReceipt] = useState<TabPolicyLifecycleReceiptView | null>(null);
  const [columnSelectionMode, setColumnSelectionMode] = useState(false);
  const [treeFontSize, setTreeFontSizeState] = useState(() => readCodeWorkspaceTreeFontSize());
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const projectFactsRoot = roots[0]?.path ?? "";
  const projectFacts = useProjectFacts(projectFactsRoot, {
    autoFetch: visible,
  });
  const projectDescriptorDiscovery = useProjectDescriptorDiscovery(projectFactsRoot, {
    autoRefresh: visible,
  });
  const refreshProjectFacts = useCallback(() => {
    void Promise.allSettled([
      projectFacts.refresh(),
      projectDescriptorDiscovery.refresh(),
    ]);
  }, [projectDescriptorDiscovery.refresh, projectFacts.refresh]);
  const [looseFiles, setLooseFiles] = useState<CodeWorkspaceLooseFileInfo[]>(() => initialLooseFiles(workspace));
  const {
    directories,
    compactChains,
    flatFiles,
    loadDir,
    loadFlatFiles,
    reset: resetTreeData,
    removeRoot: removeTreeDataRoot,
  } = useWorkspaceTreeData({
    roots,
    expandedRootIds: expandedRoots,
    treeViewMode,
    treeFilter,
    onError: setStatusMessage,
  });
  const {
    gitRoots,
    gitRootsLoading,
    gitSnapshots,
    notifyWorkspacePathGitChanged,
  } = useWorkspaceGitSnapshots({
    roots,
    onError: setStatusMessage,
    visible,
  });
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  // Editor keys whose library sources are being fetched (drives the button spinner).
  const [downloadingSourcesKeys, setDownloadingSourcesKeys] = useState<string[]>([]);
  const [activeSelectionStats, setActiveSelectionStats] = useState({ chars: 0, lineBreaks: 0 });
  const [cursorPositions, setCursorPositionsNow] = useState<Record<EditorGroupId, LspPosition>>({
    primary: { line: 0, character: 0 },
    secondary: { line: 0, character: 0 },
  });
  /** Latest caret per group for callbacks that must not change identity per caret move. */
  const cursorPositionsRef = useRef(cursorPositions);
  // The selection callback owns this ref synchronously. Never copy deferred
  // React state back into it: an older transition can commit between a caret
  // move and Ctrl+F8/Ctrl+Shift+F8, putting the action on the previous line.
  const [viewportRanges, setViewportRangesNow] = useState<Record<EditorGroupId, LspRange | null>>({
    primary: null,
    secondary: null,
  });
  const [syncSplitScroll, setSyncSplitScroll] = useState(false);
  const syncScrollOriginGroupIdRef = useRef<EditorGroupId | null>(null);
  const [highlightsByGroup, setHighlightsByGroupNow] = useState<Record<EditorGroupId, LspDocumentHighlight[]>>({
    primary: [],
    secondary: [],
  });
  const [inlayHintsByGroup, setInlayHintsByGroupNow] = useState<Record<EditorGroupId, LspInlayHint[]>>({
    primary: [],
    secondary: [],
  });
  const [semanticTokensByGroup, setSemanticTokensByGroupNow] = useState<Record<EditorGroupId, LspSemanticToken[]>>({
    primary: [],
    secondary: [],
  });
  const [inspectionProfile, setInspectionProfile] = useState<InspectionProfile>(
    () => readInspectionProfile(workspaceInstanceId),
  );
  useEffect(() => {
    setInspectionProfile(readInspectionProfile(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const persistInspectionProfile = useCallback((
    update: (current: InspectionProfile) => InspectionProfile,
  ) => {
    setInspectionProfile((current) => {
      return writeInspectionProfile(workspaceInstanceId, update(current));
    });
  }, [workspaceInstanceId]);
  const updateInspectionProfileRule = useCallback((id: string, patch: Partial<InspectionRule>) => {
    persistInspectionProfile((current) => updateInspectionRule(current, id, patch));
  }, [persistInspectionProfile]);
  const [intelligencePreferences, setIntelligencePreferencesState] = useState<WorkspaceIntelligencePreferences>(
    () => readWorkspaceIntelligencePreferences(workspaceInstanceId),
  );
  useEffect(() => {
    setIntelligencePreferencesState(readWorkspaceIntelligencePreferences(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const [parameterInfoRequestNonce, setParameterInfoRequestNonce] = useState(0);
  // 迁移时保留用户现值: persisted auto-popup/delay values flow straight into
  // the session; defaults never overwrite them.
  useEffect(() => {
    parameterInfoSession.setPreferences(intelligencePreferences.parameterInfo);
  }, [intelligencePreferences.parameterInfo, parameterInfoSession]);
  const workspaceLspSessionManagerRef = useRef<WorkspaceLspSessionManager | null>(null);
  if (!workspaceLspSessionManagerRef.current) {
    workspaceLspSessionManagerRef.current = new WorkspaceLspSessionManager(intelligencePreferences.completion);
  }
  useEffect(() => {
    workspaceLspSessionManagerRef.current?.setCompletionPreferences(intelligencePreferences.completion);
  }, [intelligencePreferences.completion]);
  const [intelligenceSettingsOpen, setIntelligenceSettingsOpen] = useState(false);
  const [breadcrumbSymbolsByGroup, setBreadcrumbSymbolsByGroupNow] = useState<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  // Caret, viewport and provider results arrive between keystrokes and
  // re-render the whole workspace shell. Render them as transitions so React
  // yields to typing (WebKitGTK input stalled behind these renders).
  const setCursorPositions = useCallback((update: Parameters<typeof setCursorPositionsNow>[0]) => {
    startTransition(() => setCursorPositionsNow(update));
  }, []);
  const setViewportRanges = useCallback((update: Parameters<typeof setViewportRangesNow>[0]) => {
    startTransition(() => setViewportRangesNow(update));
  }, []);
  const setHighlightsByGroup = useCallback((update: Parameters<typeof setHighlightsByGroupNow>[0]) => {
    startTransition(() => setHighlightsByGroupNow(update));
  }, []);
  const setInlayHintsByGroup = useCallback((update: Parameters<typeof setInlayHintsByGroupNow>[0]) => {
    startTransition(() => setInlayHintsByGroupNow(update));
  }, []);
  const setSemanticTokensByGroup = useCallback((update: Parameters<typeof setSemanticTokensByGroupNow>[0]) => {
    startTransition(() => setSemanticTokensByGroupNow(update));
  }, []);
  const setBreadcrumbSymbolsByGroup = useCallback((update: Parameters<typeof setBreadcrumbSymbolsByGroupNow>[0]) => {
    startTransition(() => setBreadcrumbSymbolsByGroupNow(update));
  }, []);
  const [navigationBarActiveByGroup, setNavigationBarActiveByGroup] = useState<Record<EditorGroupId, boolean>>({
    primary: false,
    secondary: false,
  });
  const [occurrenceSession, setOccurrenceSession] = useState<OccurrenceHighlightSession | null>(null);
  const occurrenceSessionRef = useRef<OccurrenceHighlightSession | null>(occurrenceSession);
  occurrenceSessionRef.current = occurrenceSession;
  const occurrenceActiveFileKeyRef = useRef<string | null>(activeKey);
  occurrenceActiveFileKeyRef.current = activeKey;
  const occurrenceActiveGroupIdRef = useRef<EditorGroupId>(activeEditorGroupId);
  occurrenceActiveGroupIdRef.current = activeEditorGroupId;
  const autoHighlightRequestGenerationRef = useRef(0);
  const occurrenceRequestGenerationRef = useRef(0);
  const [dismissedBannerKeys, setDismissedBannerKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedBannerKeys(new Set());
  }, [workspaceInstanceId]);
  const [fileHighlightingLevels, setFileHighlightingLevels] = useState<Record<string, HighlightingLevel>>({});

  const getFileHighlightingLevel = useCallback((fileKey: string): HighlightingLevel => {
    return fileHighlightingLevels[fileKey] ?? readHighlightingLevel(workspaceInstanceId, fileKey);
  }, [fileHighlightingLevels, workspaceInstanceId]);

  const setFileHighlightingLevel = useCallback((fileKey: string, level: HighlightingLevel) => {
    writeHighlightingLevel(workspaceInstanceId, fileKey, level);
    setFileHighlightingLevels((prev) => ({ ...prev, [fileKey]: level }));
  }, [workspaceInstanceId]);
  const [activeCompareSession, setActiveCompareSession] = useState<EditorCompareSession | null>(null);
  const [readerModeByFile, setReaderModeByFile] = useState<Record<string, boolean>>({});
  const [referencesResult, setReferencesResult] = useState<ReferencesResultState>({
    loading: false,
    origin: null,
    locations: [],
    error: null,
  });
  const referencesRequestSequenceRef = useRef(0);
  // §8.20.5 W4: ONE immutable usages session backs the tool window, the
  // lightweight Show Usages popup and the recent-query stack.
  const usageSessionRef = useRef<UsageQuerySession | null>(null);
  if (!usageSessionRef.current) usageSessionRef.current = new UsageQuerySession();
  useEffect(() => () => usageSessionRef.current?.dispose(), []);
  const [usagesScopeSelection, setUsagesScopeSelection] = useState<UsagesScopeSelection>({ ...DEFAULT_SCOPE_SELECTION });
  const [usagesScopeDialog, setUsagesScopeDialog] = useState<{
    open: boolean;
    file: OpenFileState;
    position: LspPosition;
  } | null>(null);
  const [usagesRecentsRevision, setUsagesRecentsRevision] = useState(0);
  // §8.19.7: pin ownership + rerun origin marker live above the panel so a
  // new Find Usages asks before replacing a pinned session and rerun targets
  // the recorded symbol identity instead of the current caret.
  const referencesPinnedRef = useRef(false);
  const [referencesPinned, setReferencesPinned] = useState(false);
  referencesPinnedRef.current = referencesPinned;
  const referencesRerunRef = useRef<{
    fileKey: string;
    uri: string;
    position: LspPosition;
    symbolName: string;
  } | null>(null);
  const findReferencesRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<void>>(async () => {});
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
  const setIntelligencePreferences = useCallback((
    update: WorkspaceIntelligencePreferences
      | ((current: WorkspaceIntelligencePreferences) => WorkspaceIntelligencePreferences),
  ) => {
    setIntelligencePreferencesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return writeWorkspaceIntelligencePreferences(workspaceInstanceId, next);
    });
  }, [workspaceInstanceId]);
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);
  // Library sources opened from the language server (JDK / dependency classes),
  // keyed by editor key so a closed tab can be re-fetched from history.
  const libraryBuffersRef = useRef<Record<string, LibraryBufferInfo>>({});
  const editorAppearanceProfileRef = useRef(editorAppearanceProfile);
  const treeFontSizeRef = useRef(treeFontSize);
  // Incremented for each active-buffer revision.  Async LSP responses capture
  // this value so an older response can never repaint a newer buffer.
  const lspDocumentEpochRef = useRef<Record<string, number>>({});
  const revealNonceRef = useRef(0);
  const editorSelectionRef = useRef<EditorSelectionRange>({
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    empty: true,
    text: "",
    rect: null,
  });
  const [editorAiSelection, setEditorAiSelection] = useState<EditorSelectionRange | null>(null);
  const [aiRewriteState, setAiRewriteState] = useState<{
    key: string;
    path: string;
    original: string;
    proposal: string;
    instruction: string;
    range: EditorSelectionRange;
  } | null>(null);
  // Read by the dialog's Restage action, which re-asks with the edited instruction.
  const aiRewriteStateRef = useRef(aiRewriteState);
  aiRewriteStateRef.current = aiRewriteState;
  const workspaceCommandRunnerRef = useRef<(commandId: string, context?: WorkspaceCommandContext) => boolean>(() => false);
  // CodeMirror owns character-level history. This separate stack groups a
  // multi-file WorkspaceEdit into one IDEA-style transaction.
  const workspaceEditHistoryRef = useRef<WorkspaceEditHistory | null>(null);
  if (workspaceEditHistoryRef.current === null) {
    workspaceEditHistoryRef.current = new WorkspaceEditHistory();
  }
  const [workspaceEditHistoryRevision, setWorkspaceEditHistoryRevision] = useState(0);
  const workspaceEditHistory = workspaceEditHistoryRef.current;
  const workspaceEditHistorySequenceRef = useRef(0);
  const replayWorkspacePathSnapshotsRef = useRef<(
    snapshots: readonly WorkspaceEditPathSnapshot[],
  ) => Promise<void>>(async () => {
    throw new Error("Workspace resource history is not ready");
  });
  const replayWorkspaceEncodingRef = useRef<Map<string, { encoding: string; bom: boolean; eol?: "lf" | "crlf" | "cr" }> | null>(null);
  // ED-AUDIT-014: comparison keys of closed-file paths just written by a
  // refactor restore, so the file-watcher echo of our own write does not
  // overwrite the "Refactor recovery complete" status with a misleading
  // "File changed on disk" note. Only the status message is suppressed.
  const restoreEchoSuppressorRef = useRef(createRestoreEchoSuppressor());
  // ED-AUDIT-008: set while a workspace-history restore replays through the
  // workspace-edit funnel. Open-buffer writes made inside that window are
  // recorded as "history-replay" mutations so the editor hosts treat the
  // resulting store snapshot as a journal-owned restore (origin "undo") and
  // never mirror it as a second undoable document entry.
  const replayWorkspaceRestoreRef = useRef(false);
  const goToDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const peekDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToDeclarationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => {});
  const safeDeleteSymbolRef = useRef<() => Promise<void>>(async () => {});
  const runExtractMethodRef = useRef<() => Promise<void>>(async () => {});
  // Hover enriches the AI prompt with type information. The LSP hover callback
  // is declared further down, so read it through a ref.
  const getLspHoverRef = useRef<(
    file: OpenFileState,
    position: LspPosition,
  ) => Promise<QuickDocContent | null>>(async () => null);
  const breadcrumbSymbolsRef = useRef<Record<EditorGroupId, LspDocumentSymbol[]>>({
    primary: [],
    secondary: [],
  });
  const activeEditorGroupIdRef = useRef<EditorGroupId>("primary");
  const documentTransactionOwnerRef = useRef(new WorkspaceDocumentTransactionOwner({
    onTransaction: ({ fileKey, revision }) => {
      publishWorkspaceObservation((bridge) => bridge.observeDocumentRevision(fileKey, revision));
    },
    onHistoryReceipt: ({ fileKey, revision }) => {
      publishWorkspaceObservation((bridge) => bridge.observeHistoryReceipt(`${fileKey}:${revision}`));
    },
    onViewLeaseChanged: ({ delta }) => {
      publishWorkspaceObservation((bridge) => bridge.observeLeaseDelta(delta));
    },
  }));
  const initialOpenedKeyRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLElement | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  /** ED-PARITY-020 DEC-020-01: caret popup for empty/unavailable code insight. */
  const [codeInsightNotice, setCodeInsightNotice] = useState<CodeInsightNoticeState | null>(null);
  const codeInsightNoticeSeqRef = useRef(0);
  /** ED-PARITY-014 DEC-014-04: File Structure shows a syntax-only outline. */
  const [structureSyntaxOnly, setStructureSyntaxOnly] = useState(false);
  /** ED-PARITY-018: the Git tool window mounts on first open, then stays. */
  const [gitToolWindowMounted, setGitToolWindowMounted] = useState(false);
  const showCodeInsightNotice = useCallback((message: string, action: "configure" | null = null) => {
    codeInsightNoticeSeqRef.current += 1;
    setCodeInsightNotice({
      id: codeInsightNoticeSeqRef.current,
      message,
      action,
      anchor: caretAnchor(editorPaneRef.current),
    });
  }, []);
  const inactiveEditorPaneRef = useRef<HTMLElement | null>(null);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
  const runPanelRef = useRef<RunPanelHandle | null>(null);
  const runActiveJavaFileRef = useRef<() => void>(() => {});
  const buildActiveProjectRef = useRef<(rebuild?: boolean) => void>(() => {});
  const recompileActiveFileRef = useRef<() => void>(() => {});
  const toggleActiveBreakpointRef = useRef<(line: number) => void>(() => {});
  const editActiveBreakpointRef = useRef<(line: number) => void>(() => {});
  /** IDEA Ctrl+Shift+F8: popup on a caret breakpoint, else the Breakpoints dialog. */
  const viewBreakpointsAtCaretRef = useRef<(line: number) => void>(() => {});
  const openEvaluateDialogRef = useRef<(expression?: string) => void>(() => {});
  const showDebugExecutionPointRef = useRef<() => void>(() => {});
  const addActiveBreakpointRef = useRef<(line: number, options: Partial<DebugBreakpoint>) => void>(() => {});
  const toggleActiveBreakpointEnabledRef = useRef<(line: number) => void>(() => {});
  const toggleTemporaryBreakpointRef = useRef<(line: number) => void>(() => {});
  const debugRef = useRef<ReturnType<typeof useCodeDebugSession> | null>(null);
  const lastTrackedBufferTextRef = useRef<Record<string, string>>({});
  const restoreRunRef = useRef<{
    workspaceInstanceId: string;
    cancelled: boolean;
    cancelPending: boolean;
  } | null>(null);

  useEffect(() => {
    const run = restoreRunRef.current;
    // React StrictMode immediately re-runs effects after cleanup. Re-arm the
    // current restore before the deferred cancellation callback can fire so
    // the in-flight native read is shared by both effect passes.
    if (run?.workspaceInstanceId === workspaceInstanceId) run.cancelPending = false;
    return () => {
      const cleanupRun = restoreRunRef.current;
      if (cleanupRun?.workspaceInstanceId !== workspaceInstanceId) return;
      cleanupRun.cancelPending = true;
      queueMicrotask(() => {
        if (restoreRunRef.current !== cleanupRun || !cleanupRun.cancelPending) return;
        cleanupRun.cancelled = true;
        restoreRunRef.current = null;
      });
    };
  }, [workspaceInstanceId]);

  useEffect(() => {
    workspaceEditHistory.clear();
    setWorkspaceEditHistoryRevision((revision) => revision + 1);
  }, [workspaceEditHistory, workspaceInstanceId]);

  // Per-workspace Maven/Gradle executable overrides (project wrapper still wins;
  // this is the "configured" tier between wrapper and PATH). Persisted per
  // workspace instance and threaded into every task/dependency detector.
  const [buildRunTools, setBuildRunTools] = useState<WorkspaceBuildRunTools>(
    () => readWorkspaceBuildRunTools(workspaceInstanceId),
  );
  const [buildRunToolsOpen, setBuildRunToolsOpen] = useState(false);
  useEffect(() => {
    setBuildRunTools(readWorkspaceBuildRunTools(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const toolConfig = useMemo<WorkspaceToolConfig | undefined>(
    () => workspaceToolConfig(buildRunTools),
    [buildRunTools],
  );
  const toolConfigRef = useRef(toolConfig);
  toolConfigRef.current = toolConfig;

  const [indentationOverrides, setIndentationOverrides] = useState<Record<string, ExplicitIndentationOverride | null>>({});
  const indentationOverridesRef = useRef(indentationOverrides);
  indentationOverridesRef.current = indentationOverrides;

  const resolvedCodeStylesRef = useRef<Record<string, ResolvedCodeStyle>>({});
  const saveTransactionRegistryRef = useRef<SaveTransactionRegistry>(new SaveTransactionRegistry());
  const resourceRecoveryCoordinatorRef = useRef<WorkspaceResourceRecoveryCoordinator>(
    new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId),
  );
  const resourceRecoveryHandlersRef = useRef(new Map<string, ResourceCleanupHandlers>());
  const [resourceCleanupRecoveries, setResourceCleanupRecoveries] = useState<readonly ResourceCleanupRecoveryView[]>([]);
  const workspaceStyleControllerRef = useRef<WorkspaceStyleController>(
    createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: {
        readFile: async () => null,
      },
    }),
  );

  // Unmount drops every live transaction owner so in-flight writers discard
  // their writeback/watcher/LSP side effects instead of resurrecting state.
  useEffect(() => {
    resourceRecoveryCoordinatorRef.current = new WorkspaceResourceRecoveryCoordinator(workspaceInstanceId);
    resourceRecoveryHandlersRef.current.clear();
    setResourceCleanupRecoveries([]);
    setTabPolicyReceipt(null);
    const registry = saveTransactionRegistryRef.current;
    return () => {
      registry.discardWorkspace(workspaceInstanceId);
      resourceRecoveryCoordinatorRef.current.dispose();
    };
  }, [workspaceInstanceId]);

  const rootsFingerprint = roots.map((r) => `${r.id}:${r.path}`).join("|");

  useEffect(() => {
    const provider = {
      readFile: async (absolutePath: string) => {
        const normalized = normalizeFsPath(absolutePath);
        for (const root of rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, normalized);
          if (rel !== null) {
            try {
              const res = await workspaceReadFile(root.path, rel);
              return res.text;
            } catch {
              return null;
            }
          }
        }
        try {
          const res = await workspaceReadLooseFile(normalized);
          return res.text;
        } catch {
          return null;
        }
      },
    };
    workspaceStyleControllerRef.current = createWorkspaceStyleController({
      workspaceId: workspaceInstanceId,
      roots: rootsRef.current,
      fileProvider: provider,
    });

    return () => {
      workspaceStyleControllerRef.current.clearCache();
    };
  }, [rootsFingerprint, workspaceInstanceId]);

  const workspaceLocationControllerRef = useRef<WorkspaceLocationController>(
    createWorkspaceLocationController(workspaceInstanceId),
  );

  useEffect(() => {
    workspaceLocationControllerRef.current = createWorkspaceLocationController(workspaceInstanceId);
    return () => {
      workspaceLocationControllerRef.current.dispose();
    };
  }, [workspaceInstanceId]);

  const getEffectiveCodeStyleForFile = useCallback((file: { key: string; languagePath: string; text: string } | null): EffectiveCodeStyle | undefined => {
    if (!file) return undefined;
    const asyncResolved = resolvedCodeStylesRef.current[file.key];
    if (asyncResolved) return asyncResolved;
    const explicitOverride = indentationOverridesRef.current[file.key];
    // §8.19.9 R8-D1: the active scheme for the file's extension-keyed
    // language participates below EditorConfig.
    const languageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const activeScheme = activeSchemeForLanguage(codeStyleSchemesRef.current, languageKey || null);
    return resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride,
      activeSchemeFields: schemeStyleFields(activeScheme),
    });
  }, []);

  /** Run a workspace task in the integrated terminal (shared by Run + Build panels). */
  const runWorkspaceTask = useCallback(
    (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
      terminalDockRef.current?.runCommand(
        task.command,
        task.cwd,
        `Run: ${task.label}`,
        onExit,
        task.environment,
        task.execution,
      );
      setBottomDockTab("terminal");
      setBottomDockOpen(true);
    },
    [setBottomDockOpen, setBottomDockTab],
  );
  const {
    descriptorForFile: lspDescriptorForFile,
    descriptorForPath: lspDescriptorForPath,
    isDocumentSynced: isLspDocumentSynced,
    documentVersion: lspDocumentVersion,
    sessionGeneration: lspSessionGeneration,
    serverStatuses: lspServerStatuses,
    syncDocument: syncLspDocument,
    waitForSyncQueue: waitForLspDocumentSyncQueue,
    saveDocument: saveLspDocument,
    closeDocument: closeLspDocument,
    closeDocumentAndWait: closeLspDocumentAndWait,
    updateStatus: updateLspStatusForFile,
    restartServers: restartLspServers,
  } = useWorkspaceLspSession({
    workspaceInstanceId,
    roots,
    openFilesRef,
    updateLspFiles: setLspFiles,
    onError: setStatusMessage,
    onRestart: invalidateSemanticAfterLspRestart,
    visible,
  });

  const observeResourceCleanupOutcome = useCallback((
    outcome: ResourceCleanupOutcome,
    handlers: ResourceCleanupHandlers,
  ) => {
    if (outcome.status === "retained") return;
    if (outcome.status === "committed") {
      if (outcome.recoveryId) {
        resourceRecoveryHandlersRef.current.delete(outcome.recoveryId);
        setResourceCleanupRecoveries((current) => current.filter(
          (recovery) => recovery.recoveryId !== outcome.recoveryId,
        ));
      }
      return;
    }

    resourceRecoveryHandlersRef.current.set(outcome.recoveryId, handlers);
    setResourceCleanupRecoveries((current) => {
      const previous = current.find((recovery) => recovery.recoveryId === outcome.recoveryId);
      const next: ResourceCleanupRecoveryView = {
        recoveryId: outcome.recoveryId,
        fileKey: outcome.fileKey,
        nextStage: outcome.nextStage,
        error: outcome.failedStages[0]?.error ?? outcome.message,
        completedStageCount: outcome.completedStages.length,
        attemptCount: (previous?.attemptCount ?? 0) + 1,
      };
      return [...current.filter((recovery) => recovery.recoveryId !== outcome.recoveryId), next];
    });
  }, []);

  const replayResourceCleanup = useCallback(async (recoveryId: string) => {
    const handlers = resourceRecoveryHandlersRef.current.get(recoveryId);
    if (!handlers) {
      setStatusMessage(`Cleanup recovery ${recoveryId} is no longer available`);
      return;
    }
    const outcome = await resourceRecoveryCoordinatorRef.current.replayRecoveryById(recoveryId, handlers);
    if (!outcome) {
      setStatusMessage(`Cleanup recovery ${recoveryId} was not found`);
      return;
    }
    observeResourceCleanupOutcome(outcome, handlers);
    setStatusMessage(outcome.status === "committed"
      ? `Completed resource cleanup recovery ${recoveryId}`
      : outcome.status === "committed-with-recovery"
        ? outcome.message
        : `Resource ${outcome.fileKey} is still retained by an editor view`);
  }, [observeResourceCleanupOutcome, setStatusMessage]);
  // §8.20.3 W2: provider-owned Project Analysis snapshot (phase/progress/
  // modules/classpath fingerprint). The generation resync rides the statuses
  // identity — a restart refreshes them, which re-probes on the new session.
  const [projectAnalysisGeneration, setProjectAnalysisGeneration] = useState(0);
  useEffect(() => {
    setProjectAnalysisGeneration(lspSessionGeneration());
  }, [lspServerStatuses, lspSessionGeneration]);
  const projectAnalysisRoots = useMemo(
    () => roots.map((root) => root.path),
    [roots],
  );
  const projectAnalysisDescriptorForRoot = useCallback(
    (root: string) => lspDescriptorForPath(root, root),
    [lspDescriptorForPath],
  );
  const javaServerStatus = useMemo(
    () => lspServerStatuses.find((server) => server.presetId === "java") ?? null,
    [lspServerStatuses],
  );
  const {
    snapshot: projectAnalysisSnapshot,
    probing: projectAnalysisProbing,
    refresh: refreshProjectAnalysis,
  } = useWorkspaceProjectAnalysis({
    workspaceInstanceId,
    roots: projectAnalysisRoots,
    provider: {
      configured: !!(javaServerStatus?.available || javaServerStatus?.active),
      active: !!javaServerStatus?.active,
      opening: false,
      lastError: javaServerStatus?.error ?? null,
    },
    progresses: lspProgresses,
    sessionGeneration: projectAnalysisGeneration,
    descriptorForRoot: projectAnalysisDescriptorForRoot,
  });
  const treePaneStyle = useMemo(() => ({
    "--taomni-code-tree-font-size": `${treeFontSize}px`,
    "--taomni-code-tree-small-font-size": `${Math.max(10, treeFontSize - 1)}px`,
    "--taomni-code-tree-row-height": `${Math.max(24, treeFontSize + 15)}px`,
  }) as CSSProperties, [treeFontSize]);
  const editorPaneStyle = useMemo(() => ({
    "--taomni-code-editor-ui-font-size": `${editorAppearanceProfile.fontSizePx}px`,
    "--taomni-code-editor-ui-small-font-size": `${Math.max(10, editorAppearanceProfile.fontSizePx - 2)}px`,
    "--taomni-code-editor-tab-height": `${Math.max(28, editorAppearanceProfile.fontSizePx + 15)}px`,
  }) as CSSProperties, [editorAppearanceProfile.fontSizePx]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  const semanticRootsFingerprint = useMemo(
    () => roots.map((root) => `${root.id}:${fsPathComparisonKey(root.path)}`).sort().join("\u0000"),
    [roots],
  );
  const previousSemanticRootsFingerprintRef = useRef(semanticRootsFingerprint);
  useEffect(() => {
    if (previousSemanticRootsFingerprintRef.current === semanticRootsFingerprint) return;
    previousSemanticRootsFingerprintRef.current = semanticRootsFingerprint;
    semanticIndex.invalidate("roots-changed", roots.map((root) => root.path));
  }, [roots, semanticIndex.invalidate, semanticRootsFingerprint]);

  useEffect(() => {
    setExternalFileConflicts([]);
  }, [workspaceInstanceId]);

  // ED-IMPROVE-001: switching the workspace supersedes any in-flight
  // rearrange/cleanup identity even before readLive observes the switch.
  useEffect(() => {
    rearrangeRequestTokenRef.current += 1;
    cleanupRequestTokenRef.current += 1;
  }, [workspaceInstanceId]);

  const persistWorkspaceLayoutNowRef = useRef<((targetInstanceId?: string) => void) | null>(null);

  // ED-IMPROVE-007: view snapshots stay in memory and persist with the next
  // debounced layout write. A late report from a replaced view/workspace is
  // dropped instead of resurrecting an old leaf's caret.
  // ED-REPAIR-009: ensure unmount tail captures update viewStatesRef even
  // when the component is in unmount phase, flushing to disk immediately.
  const handleViewStateChange = useCallback((
    groupId: EditorGroupId,
    fileKey: string,
    state: PersistedEditorViewState,
  ) => {
    if (workspaceInstanceIdRef.current !== workspaceInstanceId) return;
    const current = viewStatesRef.current;
    const leaf = current[groupId];
    if (leaf?.[fileKey] === state) return;
    viewStatesRef.current = {
      ...current,
      [groupId]: { ...(leaf ?? {}), [fileKey]: state },
    };
    if (mountedRef.current) {
      setViewStateRevision((revision) => revision + 1);
    } else {
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceId);
    }
  }, [workspaceInstanceId, mountedRef]);

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

  useEffect(() => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    pendingWorkspaceRecoveryKeysRef.current = new Set(entries.map((entry) => entry.key));
    setWorkspaceRecoveryEntries(entries);
    // §8.19.1: unresolved disk-effect rows also open the recovery center so a
    // previous session's committed-discarded/unknown writes are surfaced.
    setWorkspaceRecoveryOpen(
      entries.length > 0 || listDiskEffectLedgerEntries(workspaceInstanceId).length > 0,
    );
  }, [workspaceInstanceId]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const watchPaths = [
      ...roots.map((root) => root.path),
      ...looseFiles.map((file) => file.path),
    ];
    let disposed = false;
    void lspStartWorkspaceWatcher(workspaceInstanceId, watchPaths).catch((error) => {
      if (!disposed) {
        setStatusMessage(`File watcher unavailable: ${errorMessage(error)}`);
      }
    });
    return () => {
      disposed = true;
      void lspStopWorkspaceWatcher(workspaceInstanceId).catch(() => undefined);
    };
  }, [looseFiles, roots, setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  // Keep a bounded copy of unsaved buffers so a renderer/process crash can be
  // repaired on the next workspace open. Debouncing avoids a storage write for
  // every keystroke while retaining the latest edit within a short window.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const entries = reconcileWorkspaceRecoveryEntries(
        workspaceInstanceId,
        openFilesRef.current,
        pendingWorkspaceRecoveryKeysRef.current,
      );
      setWorkspaceRecoveryEntries(entries);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [openFiles, workspaceInstanceId]);

  useEffect(() => {
    // Store-backed openFiles can lag the live editor buffer while typing is
    // batched. Never clobber pending keystrokes with a stale store snapshot —
    // that used to drop mid-edit text right as completion asked for a sync.
    if (pendingEditorTextByFileRef.current.size === 0) {
      openFilesRef.current = openFiles;
      return;
    }
    const merged = { ...openFiles };
    for (const [key, file] of pendingEditorTextByFileRef.current) {
      if (key in merged) merged[key] = file;
    }
    openFilesRef.current = merged;
  }, [openFiles]);

  useEffect(() => {
    openOrderRef.current = openOrder;
  }, [openOrder]);

  useEffect(() => {
    lspFilesRef.current = lspFiles;
  }, [lspFiles]);

  // Mirrored for the AI prompt builders, which run from callbacks declared
  // before these values are in scope.
  useEffect(() => {
    breadcrumbSymbolsRef.current = breadcrumbSymbolsByGroup;
  }, [breadcrumbSymbolsByGroup]);

  useEffect(() => {
    activeEditorGroupIdRef.current = activeEditorGroupId;
  }, [activeEditorGroupId]);

  useEffect(() => {
    editorAppearanceProfileRef.current = editorAppearanceProfile;
    clipboardHandle.setHistoryEnabled(editorAppearanceProfile.clipboard.historyEnabled);
    clipboardHandle.setHistoryLimits(
      editorAppearanceProfile.clipboard.historyMaxItems,
      editorAppearanceProfile.clipboard.historyMaxTotalBytes,
    );
  }, [editorAppearanceProfile, clipboardHandle]);

  useEffect(() => {
    const result = readEditorAppearanceProfileWithDiagnostics(
      workspaceInstanceId,
      loadCodeViewProfile(),
    );
    const next = result.source === "migrated"
      ? writeEditorAppearanceProfile(workspaceInstanceId, result.profile)
      : result.profile;
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    setActiveEditorFontSizes({});
    if (result.diagnostic?.kind === "corrupt") {
      setStatusMessage(result.diagnostic.message);
    }
  }, [setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    treeFontSizeRef.current = treeFontSize;
  }, [treeFontSize]);

  const updateEditorAppearanceProfile = useCallback((
    updater: EditorAppearanceProfile
      | ((current: EditorAppearanceProfile) => EditorAppearanceProfile),
    statusMessage?: (profile: EditorAppearanceProfile) => string,
  ) => {
    const current = editorAppearanceProfileRef.current;
    const next = normalizeEditorAppearanceProfile(
      typeof updater === "function" ? updater(current) : updater,
    );
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    writeEditorAppearanceProfile(workspaceInstanceId, next);
    if (next.zoomScope === "all-editors") setActiveEditorFontSizes({});
    if (statusMessage) setStatusMessage(statusMessage(next));
  }, [setStatusMessage, workspaceInstanceId]);

  const effectiveEditorFontSize = useCallback((groupId: EditorGroupId) => (
    editorAppearanceProfileRef.current.zoomScope === "active-editor"
      ? activeEditorFontSizes[groupId] ?? editorAppearanceProfileRef.current.fontSizePx
      : editorAppearanceProfileRef.current.fontSizePx
  ), [activeEditorFontSizes]);

  const setCodeViewFontSize = useCallback((size: number) => {
    const nextSize = clampCodeWorkspaceFontSize(size);
    if (editorAppearanceProfileRef.current.zoomScope === "active-editor") {
      setActiveEditorFontSizes((current) => ({
        ...current,
        [activeEditorGroupIdRef.current]: nextSize,
      }));
      setStatusMessage(`Active editor zoom ${nextSize}px`);
      return;
    }
    updateEditorAppearanceProfile(
      (current) => ({ ...current, fontSizePx: nextSize }),
      (next) => `Code workspace zoom ${next.fontSizePx}px`,
    );
  }, [setStatusMessage, updateEditorAppearanceProfile]);

  const currentEditorFontSize = effectiveEditorFontSize(activeEditorGroupId);
  const activeAppearancePath = activeKey
    ? openFilesRef.current[activeKey]?.languagePath
    : undefined;
  const activeFileSoftWrap = !!activeAppearancePath && matchesSoftWrapPath(
    activeAppearancePath,
    editorAppearanceProfile.softWrap.patterns,
  );

  const toggleSoftWrap = useCallback(() => {
    const path = activeKey ? openFilesRef.current[activeKey]?.languagePath : undefined;
    if (!path) return;
    updateEditorAppearanceProfile((current) => {
      const enabled = matchesSoftWrapPath(path, current.softWrap.patterns);
      return {
        ...current,
        softWrap: {
          ...current.softWrap,
          patterns: enabled
            ? current.softWrap.patterns.filter((pattern) => !matchesSoftWrapPath(path, [pattern]))
            : [...current.softWrap.patterns, path],
        },
      };
    }, (next) => (
      matchesSoftWrapPath(path, next.softWrap.patterns)
        ? `Soft wrap enabled for ${path}`
        : `Soft wrap disabled for ${path}`
    ));
  }, [activeKey, updateEditorAppearanceProfile]);

  const toggleColumnSelectionMode = useCallback(() => {
    setColumnSelectionMode((current) => {
      const next = !current;
      setStatusMessage(`Column selection mode ${next ? "enabled" : "disabled"}`);
      return next;
    });
  }, [setStatusMessage]);

  const stepCodeViewFontSize = useCallback((delta: number) => {
    setCodeViewFontSize(effectiveEditorFontSize(activeEditorGroupIdRef.current) + delta);
  }, [effectiveEditorFontSize, setCodeViewFontSize]);

  const setTreeFontSize = useCallback(
    (size: number) => {
      const next = clampCodeWorkspaceTreeFontSize(size);
      treeFontSizeRef.current = next;
      setTreeFontSizeState(next);
      writeCodeWorkspaceTreeFontSize(next);
      setStatusMessage(`File tree zoom ${next}px`);
    },
    [setStatusMessage],
  );

  const stepTreeFontSize = useCallback(
    (delta: number) => {
      setTreeFontSize(treeFontSizeRef.current + delta);
    },
    [setTreeFontSize],
  );

  const setTreeViewMode = useCallback((mode: TreeViewMode) => {
    patchWorkspaceUi(workspaceInstanceId, { treeViewMode: mode });
    writeCodeWorkspaceTreeViewMode(mode);
    setStatusMessage(`File tree view: ${mode}`);
  }, [patchWorkspaceUi, setStatusMessage, workspaceInstanceId]);

  // IDEA Project view Appearance › Details (file time and size); a per-viewer
  // preference, so browser storage is enough and failures fall back to off.
  const [treeShowDetails, setTreeShowDetailsState] = useState(() => {
    try { return localStorage.getItem(TREE_DETAILS_STORAGE_KEY) === "true"; }
    catch { return false; }
  });
  const setTreeShowDetails = useCallback((value: boolean) => {
    setTreeShowDetailsState(value);
    try { localStorage.setItem(TREE_DETAILS_STORAGE_KEY, value ? "true" : "false"); }
    catch { /* storage unavailable: keep the in-memory choice */ }
  }, []);

  const zoomTargetForNode = useCallback((target: EventTarget | null): "tree" | "editor" => {
    const node = target instanceof Node ? target : null;
    if (node && treePaneRef.current?.contains(node)) return "tree";
    return "editor";
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (targetElement?.closest('[data-testid="code-workspace-todos-panel"]')) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      // Ctrl+0 is also the IDEA mnemonic-bookmark jump. A live [0] bookmark
      // owns the key; only an unclaimed stroke remains the zoom reset.
      if (reset && findBookmarkByMnemonic(bookmarksRef.current, "0")) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (increase) {
          stepTreeFontSize(1);
        } else if (decrease) {
          stepTreeFontSize(-1);
        } else {
          setTreeFontSize(CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE);
        }
      } else if (increase) {
        stepCodeViewFontSize(1);
      } else if (decrease) {
        stepCodeViewFontSize(-1);
      } else {
        setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setCodeViewFontSize, setTreeFontSize, stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (event.deltaY < 0) {
          stepTreeFontSize(1);
        } else if (event.deltaY > 0) {
          stepTreeFontSize(-1);
        }
      } else if (event.deltaY < 0) {
        stepCodeViewFontSize(1);
      } else if (event.deltaY > 0) {
        stepCodeViewFontSize(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [stepCodeViewFontSize, stepTreeFontSize, visible, zoomTargetForNode]);

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);

  // §8.18.5: openFile enforces the tab limit through the closer defined
  // later in the component; the ref bridges the declaration order.
  const closeFileRef = useRef<
    ((key: string, groupId?: EditorGroupId, options?: { discard?: boolean }) => Promise<void>) | null
  >(null);
  const pendingClosedFilesRef = useRef(new Map<string, PendingClosedFile>());

  const openFile = useCallback(
    createOpenFile({
    flushPendingEditorText,
    pendingClosedFilesRef,
    workspaceInstanceId,
    updateEditorGroup,
    tabPolicyRef,
    activateEditorGroup,
    openFilesRef,
    get mruFileKeysRef() { return mruFileKeysRef; },
    closeFileRef,
    setStatusMessage,
    syncLspDocument,
    libraryBuffersRef,
    setOpenFiles,
    lspDescriptorForPath,
    rootsRef,
    looseFilesRef,
    findRoot,
    restoreBookmarksForFileKey,
  }),
    [
      activateEditorGroup,
      findRoot,
      flushPendingEditorText,
      lspDescriptorForPath,
      restoreBookmarksForFileKey,
      setStatusMessage,
      syncLspDocument,
      updateEditorGroup,
      workspaceInstanceId,
    ],
  );

  const tryGrantTreeFocus = useCallback((intent: TreeOpenIntent, canonicalKey: string): boolean => {
    if (pendingTreeOpenIntentRef.current?.requestId !== intent.requestId) {
      return false;
    }
    if (treeInteractionEpochRef.current !== intent.interactionEpoch) {
      pendingTreeOpenIntentRef.current = null;
      return false;
    }
    const store = useCodeWorkspaceStore.getState();
    const currentUi = selectCodeWorkspaceUi(store, workspaceInstanceId);
    if (currentUi.activeEditorGroupId !== intent.groupId) {
      return false;
    }
    if (currentUi.editorGroups[intent.groupId]?.activeKey !== canonicalKey) {
      return false;
    }
    const active = document.activeElement;
    if (active && active instanceof HTMLElement) {
      if (active.matches("input, textarea, select, [contenteditable='true']") && !active.closest(".cm-editor")) {
        pendingTreeOpenIntentRef.current = null;
        return false;
      }
    }
    const owner = editorCommandPortsRef.current.get(intent.groupId);
    if (owner && owner.fileKey === canonicalKey && owner.port.focus) {
      const focused = owner.port.focus({ preventScroll: true });
      if (focused) {
        pendingTreeOpenIntentRef.current = null;
        return true;
      }
    }
    return false;
  }, [workspaceInstanceId]);

  useEffect(() => {
    tryGrantTreeFocusRef.current = tryGrantTreeFocus;
  }, [tryGrantTreeFocus]);

  const requestTreeOpen = useCallback(async (
    ref: CodeWorkspaceFileRef,
    options: {
      targetGroupId?: EditorGroupId;
      split?: boolean;
      preview?: boolean;
    } = {},
  ) => {
    flushPendingEditorText();
    treeInteractionEpochRef.current += 1;
    const epoch = treeInteractionEpochRef.current;
    const requestId = ++treeOpenRequestIdRef.current;

    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    let targetGroupId = options.targetGroupId ?? currentUi.activeEditorGroupId;

    if (options.split) {
      splitLayoutLeaf(workspaceInstanceId, currentUi.activeEditorGroupId, "vertical");
      const nextUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      targetGroupId = nextUi.activeEditorGroupId !== currentUi.activeEditorGroupId
        ? nextUi.activeEditorGroupId
        : currentUi.activeEditorGroupId;
    }

    const reqKey = fileKey(ref);
    const intent: TreeOpenIntent = {
      workspaceInstanceId,
      groupId: targetGroupId,
      requestedFileKey: reqKey,
      interactionEpoch: epoch,
      requestId,
    };
    pendingTreeOpenIntentRef.current = intent;

    const result = await openFile(ref, {
      groupId: targetGroupId,
      preview: options.preview ?? false,
      isCurrent: () => pendingTreeOpenIntentRef.current?.requestId === requestId,
    });

    if (pendingTreeOpenIntentRef.current?.requestId !== requestId) {
      return;
    }
    if (!result || result.error) {
      pendingTreeOpenIntentRef.current = null;
      return;
    }

    intent.canonicalFileKey = result.canonicalFileKey;
    tryGrantTreeFocus(intent, result.canonicalFileKey);
  }, [flushPendingEditorText, openFile, splitLayoutLeaf, tryGrantTreeFocus, workspaceInstanceId]);

  const removeRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    pendingWorkspaceRecoveryKeysRef.current.delete(entry.key);
    const next = removeWorkspaceRecoveryEntry(workspaceInstanceId, entry.key);
    setWorkspaceRecoveryEntries(next);
    if (next.length === 0) setWorkspaceRecoveryOpen(false);
  }, [workspaceInstanceId]);

  const discardWorkspaceRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    removeRecoveryEntry(entry);
    setStatusMessage(`Discarded recovery snapshot for ${entry.path}`);
  }, [removeRecoveryEntry, setStatusMessage]);

  const discardAllWorkspaceRecoveryEntries = useCallback(() => {
    pendingWorkspaceRecoveryKeysRef.current.clear();
    writeWorkspaceRecoveryEntries(workspaceInstanceId, []);
    setWorkspaceRecoveryEntries([]);
    setWorkspaceRecoveryOpen(false);
    setStatusMessage("Discarded workspace recovery snapshots");
  }, [setStatusMessage, workspaceInstanceId]);

  const recoverWorkspaceEntry = useCallback(async (entry: WorkspaceRecoveryEntry): Promise<boolean> => {
    try {
      await openFile(entry.ref, { preview: false });
      const latest = openFilesRef.current[entry.key]
        ?? Object.values(openFilesRef.current).find((candidate) => (
          candidate.ref.kind === entry.ref.kind
          && candidate.ref.path === entry.ref.path
          && (candidate.ref.kind === "root"
            ? entry.ref.kind === "root" && candidate.ref.rootId === entry.ref.rootId
            : entry.ref.kind === "loose" && candidate.ref.id === entry.ref.id)
        ));
      if (!latest || latest.loading || latest.error) {
        throw new Error(latest?.error ?? `Cannot open ${entry.path}`);
      }
      const recovered = normalizeEditorText(entry.text).text;
      const next: OpenFileState = {
        ...latest,
        text: recovered,
        eol: entry.eol,
        encoding: entry.encoding ?? latest.encoding ?? "UTF-8",
        bom: entry.bom ?? latest.bom ?? false,
        dirty: recovered !== latest.savedText,
        error: null,
      };
      setOpenFiles((current) => ({ ...current, [latest.key]: next }));
      if (latest.text !== next.text && lspFilesRef.current[latest.key]?.status?.active) {
        void syncLspDocument(next, "change");
      }
      removeRecoveryEntry(entry);
      setStatusMessage(`Recovered unsaved changes for ${latest.subtitle}`);
      return true;
    } catch (error) {
      setStatusMessage(`Cannot recover ${entry.path}: ${errorMessage(error)}`);
      return false;
    }
  }, [openFile, removeRecoveryEntry, setOpenFiles, setStatusMessage, syncLspDocument]);

  const recoverAllWorkspaceEntries = useCallback(async () => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    let recovered = 0;
    for (const entry of entries) {
      if (await recoverWorkspaceEntry(entry)) recovered += 1;
    }
    const remaining = readWorkspaceRecoveryEntries(workspaceInstanceId);
    setWorkspaceRecoveryEntries(remaining);
    setWorkspaceRecoveryOpen(remaining.length > 0);
    if (recovered > 1) setStatusMessage(`Recovered ${recovered} unsaved files`);
  }, [recoverWorkspaceEntry, setStatusMessage, workspaceInstanceId]);

  /** §8.19.1: Acknowledge clears only the explicitly selected ledger row. */
  const acknowledgeDiskEffectLedgerEntry = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    resolveDiskEffectLedgerEntry(entry.workspaceId, entry.transactionId, entry.path);
    bumpDiskEffectLedger();
    setStatusMessage(`Acknowledged disk result for ${entry.path}`);
  }, [bumpDiskEffectLedger, setStatusMessage]);

  /** §8.19.1: Reopen loads the file as it exists on disk right now. */
  const reopenDiskEffectLedgerFile = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    // fileIdentity is `root:<rootId>:<path>` / `loose:<id>:<path>`; fall back
    // to a root scan when only the absolute path is known.
    const identity = entry.fileIdentity;
    let ref: CodeWorkspaceFileRef | null = null;
    if (identity.startsWith("root:")) {
      const [, rootId, ...rest] = identity.split(":");
      if (rootId && rest.length > 0) ref = { kind: "root", rootId, path: rest.join(":") };
    } else if (identity.startsWith("loose:")) {
      const [, id, ...rest] = identity.split(":");
      if (id && rest.length > 0) ref = { kind: "loose", id, path: rest.join(":") };
    }
    if (!ref) {
      const matchingRoot = roots.find(
        (root) => entry.path.startsWith(root.path + "/") || entry.path === root.path,
      );
      if (matchingRoot) {
        ref = {
          kind: "root",
          rootId: matchingRoot.id,
          path: entry.path.slice(matchingRoot.path.length).replace(/^\/+/, ""),
        };
      }
    }
    if (!ref) {
      setStatusMessage(`Cannot reopen ${entry.path}: it is outside the workspace roots`);
      return;
    }
    void openFile(ref, { preview: true });
    setStatusMessage(`Opened ${entry.path} from disk; compare it with your editor state before acknowledging`);
  }, [openFile, roots, setStatusMessage]);

  const revealNavLocation = useCallback((key: string, position: { line: number; character: number }) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: position.line,
      character: position.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  const {
    navCan,
    goToFileItems,
    goToFileLoading,
    goToFileTruncated,
    openSearchEverywhere,
    openGoToFileItem,
    navigateHistory,
    recordNavigationLocation,
    suppressNextHistoryRecord,
    noteCaretPosition,
    reconcileFileReferences: reconcileNavigationFileReferences,
    removeNavigationLocations,
    openRecentFiles,
    recentChangedOnly,
    recordEditLocation,
    navigateLastEditLocation,
    pickRecentFile,
  } = useWorkspaceNavigation({
    workspaceInstanceId,
    activeKey,
    roots,
    flatFiles,
    visible,
    rootsRef,
    looseFilesRef,
    openFilesRef,
    loadFlatFiles,
    openFile,
    revealLocation: revealNavLocation,
    setSearchEverywhereMode,
    setSearchEverywhereOpen,
    setRecentEntries,
    setRecentFilesOpen,
  });

  // Recent Locations is metadata, not part of the live editing contract. Build
  // its line/context snapshot once per settled input burst so a caret near the
  // end of a large source file does not rescan the entire prefix on every key.
  flushPendingEditLocationsRef.current = () => {
    for (const [key, file] of pendingEditorTextByFileRef.current) {
      const caret = pendingEditorCaretByFileRef.current.get(key);
      if (!caret) continue;
      const activeFilePath = file.path ?? file.title;
      const { position, offset } = caret;
      const { lineText, contextSnippet } = extractContextSnippet(file.text, position.line, offset);
      const isInsideAnyRoot = rootsRef.current.some((root) => (
        isPathContainedInRoot(activeFilePath, root.path)
      ));
      workspaceLocationControllerRef.current.recordUserEdit({
        fileKey: file.key,
        filePath: activeFilePath,
        title: file.title,
        line: position.line,
        character: position.character,
        lineText,
        contextSnippet,
        sourceOwnership: file.library ? "library" : isInsideAnyRoot ? "workspace" : "external",
      });
      recordEditLocation(file.ref, position);
    }
    pendingEditorCaretByFileRef.current.clear();
  };

  const openFindInFiles = useCallback((focusTarget: "query" | "replace" = "query") => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchFocusTarget(focusTarget);
    setSearchFocusNonce((nonce) => nonce + 1);
  }, []);

  const findInDirectory = useCallback((path: string) => {
    setBottomDockOpen(true);
    setBottomDockTab("search");
    setSearchIncludePreset((current) => ({
      value: path ? `${path}/**` : "",
      nonce: current.nonce + 1,
    }));
  }, []);

  const openTerminalAt = useCallback((rootId: string, path: string, pathIsFile = false) => {
    const root = findRoot(rootId);
    if (!root) return;
    const relativeDirectory = pathIsFile ? parentPath(path) : path;
    const cwd = absoluteWorkspacePath(root, relativeDirectory);
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, relativeDirectory ? basename(relativeDirectory) : root.name);
  }, [findRoot]);

  // §8.16.5 N2.6: single facade for Recent Locations + Back/Forward so
  // rename/delete/remove operations keep both histories in sync.
  const navigationPathForRef = useCallback((ref: CodeWorkspaceFileRef): string | null => {
    if (ref.kind === "loose") return ref.path;
    const root = rootsRef.current.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    return `${root.path}/${ref.path}`;
  }, []);

  const navigationHistoryFacade = useMemo(() => {
    const controller = workspaceLocationControllerRef.current;
    const remapRef = (ref: CodeWorkspaceFileRef, fromPath: string, toPath: string): CodeWorkspaceFileRef | null => {
      const refPath = navigationPathForRef(ref);
      if (refPath == null) return ref;
      const fromKey = workspacePathComparisonKey(fromPath);
      if (workspacePathComparisonKey(refPath) !== fromKey) return ref;
      if (ref.kind === "loose") return { ...ref, path: toPath };
      const nextRel = toPath.split("/").slice(-ref.path.split("/").length).join("/");
      return { ...ref, path: nextRel };
    };
    const bridge: BackForwardHistoryBridge = {
      removeLocation: (identity) => {
        removeNavigationLocations((loc) => {
          const locPath = navigationPathForRef(loc.ref);
          return (identity.fileKey !== null && fileKey(loc.ref) === identity.fileKey)
            || (locPath !== null
              && workspacePathComparisonKey(locPath) === workspacePathComparisonKey(identity.canonicalPath));
        });
      },
      relocateFile: (fromPath, toPath) => {
        reconcileNavigationFileReferences((ref) => remapRef(ref, fromPath, toPath));
      },
      removeDirectorySubtree: (dirPath) => {
        removeNavigationLocations((loc) => {
          const locPath = navigationPathForRef(loc.ref);
          return locPath !== null && isPathContainedInRoot(locPath, dirPath);
        });
      },
    };
    return new NavigationHistoryFacade(controller, undefined, bridge);
  }, [
    navigationPathForRef,
    reconcileNavigationFileReferences,
    removeNavigationLocations,
  ]);

  useEffect(() => {
    if (layoutRestoredOpenFilesRef.current) {
      const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
      if (!snapshot) {
        layoutRestoredOpenFilesRef.current = false;
      } else {
        const keys = uniqueOrderedKeys(snapshot.editorGroups);
        if (keys.length === 0) {
          layoutRestoredOpenFilesRef.current = false;
        } else {
          // StrictMode cleans up the first effect pass before running the
          // second one. A run that survived deferred cleanup is reused so
          // the second pass does not issue duplicate native reads.
          if (
            initialOpenedKeyRef.current === `restored:${workspaceInstanceId}`
            && restoreRunRef.current
          ) return;
          initialOpenedKeyRef.current = `restored:${workspaceInstanceId}`;
          const plan = planWorkspaceRestore(snapshot, looseFiles);
          const restoreRun = { workspaceInstanceId, cancelled: false, cancelPending: false };
          restoreRunRef.current = restoreRun;
          const isCurrent = () => restoreRunRef.current === restoreRun && !restoreRun.cancelled;
          // ED-AUDIT-013: app-clock restore milestones for the performance
          // contract (request -> active ready -> all ready). activeReady
          // marks the active-open drain; the case proves editability with a
          // real keystroke right after, and the completion line below lands
          // in the run console artifact for aggregation. Durations derive
          // from these marks, never from runner step timings.
          const restoreTimings = createRestoreTimingRecorder(
            plan.activeTargets.length,
            plan.backgroundTargets.length,
          );
          restoreTimings.markRequested();

          // Restore active group selection
          if (plan.activeGroupId) {
            activateEditorGroup(plan.activeGroupId);
          }

          // Restore active tabs before starting background work. Both phases
          // use the same bounded queue so multiple split leaves cannot add
          // unbounded active reads on top of the background pool.
          void executeBoundedAsyncQueue(
            plan.activeTargets,
            (target) => openFile(target.ref, {
              groupId: target.groupId,
              preview: target.preview,
              activate: true,
              restoring: true,
              isCurrent,
            }),
            3,
          ).then((activeOutcomes) => {
            restoreTimings.markActiveReady();
            if (!isCurrent()) restoreTimings.markCancelled();
            if (plan.backgroundTargets.length === 0) {
              restoreTimings.markAllReady();
              console.log(`[restore-timings] ${JSON.stringify({
                workspaceInstanceId,
                ...restoreTimings.toJSON(),
                activeSettled: activeOutcomes.length,
                backgroundSettled: 0,
              })}`);
              return [];
            }
            return executeBoundedAsyncQueue(
              plan.backgroundTargets,
              (target) => openFile(target.ref, {
                groupId: target.groupId,
                preview: target.preview,
                activate: false,
                restoring: true,
                isCurrent,
              }),
              3,
            ).then((backgroundOutcomes) => {
              restoreTimings.markAllReady();
              if (!isCurrent()) restoreTimings.markCancelled();
              console.log(`[restore-timings] ${JSON.stringify({
                workspaceInstanceId,
                ...restoreTimings.toJSON(),
                activeSettled: activeOutcomes.length,
                backgroundSettled: backgroundOutcomes.length,
              })}`);
              return backgroundOutcomes;
            });
          }).finally(() => {
            layoutRestoredOpenFilesRef.current = false;
          });
          return;
        }
      }
    }
    const ref = initialFileRef(workspace, roots, looseFiles);
    if (!ref) return;
    const key = fileKey(ref);
    if (initialOpenedKeyRef.current === key) return;
    initialOpenedKeyRef.current = key;
    void openFile(ref);
  }, [looseFiles, openFile, roots, workspace, workspaceInstanceId]);

  const persistWorkspaceLayoutNow = useCallback(createPersistWorkspaceLayoutNow({
    workspaceInstanceId,
    layoutRestoredOpenFilesRef,
    editorGroups,
    libraryBuffersRef,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    languagePanelOpen,
    splitOrientation,
    activeEditorGroupId,
    expandedRootIds,
    expandedDirKeys,
    workspaceUi,
    tabPolicyRef,
    viewStatesRef,
    openFilesRef,
    setStatusMessage,
  }), [
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
    workspaceUi.layoutTreeV2,
    workspaceUi.shellChromeState,
  ]);

  persistWorkspaceLayoutNowRef.current = persistWorkspaceLayoutNow;

  useEffect(() => {
    if (!workspaceInstanceId) return;
    const timer = window.setTimeout(() => {
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceId);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
    workspaceUi.layoutTreeV2,
    workspaceUi.shellChromeState,
    tabPolicyRevision,
    viewStateRevision,
  ]);

  // ED-REPAIR-009: Flush layout snapshot on workspace unmount / window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceIdRef.current);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceId);
    };
  }, [workspaceInstanceId]);

  const applyFileActionResourceOperation = useCallback((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    const apply = fileActionResourceOperationRef.current;
    if (!apply) {
      return Promise.reject(new Error("Workspace resource operations are not ready"));
    }
    return apply(operation);
  }, []);

  const {
    selectedRootDirectory,
    copyTreePath,
    addRoot,
    addLooseFilePath,
    openLooseFile,
    refreshTree,
    toggleRoot,
    toggleDir,
    createFile,
    createDir,
    renameSelected,
    deleteSelected,
    revealInExplorer,
    stageTreeClipboard,
    canPasteTreeClipboard,
    pasteTreeClipboard,
    ignoreWorkspacePath,
  } = useWorkspaceFileActions({
    workspaceId: workspaceInstanceId,
    locationController: workspaceLocationControllerRef.current,
    roots,
    gitRoots,
    selected,
    activeKey,
    openFiles,
    directories,
    expandedRoots,
    expandedDirs,
    treeViewMode,
    rootsRef,
    looseFilesRef,
    openFilesRef,
    openOrderRef,
    setRoots,
    setLooseFiles,
    setSelected,
    setExpandedRoots,
    setExpandedDirs,
    setOpenFiles,
    setOpenOrder,
    setActiveKey,
    loadDir,
    loadFlatFiles,
    resetTreeData,
    removeTreeDataRoot,
    openFile,
    applyResourceOperation: applyFileActionResourceOperation,
    notifyWorkspacePathGitChanged,
    onStatus: setStatusMessage,
  });

  const treeContextMenuSessionRef = useRef<{
    workspaceInstanceId: string;
    selection: TreeSelection | null;
    consumed: boolean;
  } | null>(null);

  const handleTreeContextMenuClose = useCallback((reason?: ContextMenuCloseReason) => {
    const session = treeContextMenuSessionRef.current;
    treeContextMenuSessionRef.current = null;
    if (!session || session.consumed) {
      return;
    }
    if (reason !== "escape") return;
    // ED-TREEOPEN-001 / DEC-TOF-04: Esc gives focus back to the tree row the
    // menu acted on. The menu owns focus while it is mounted; a WebView that
    // resets focus to the document body when that focused node leaves the DOM
    // (WebView2 does, WebKitGTK keeps the new owner) would drop the restore
    // that ran before the unmount commit. Claim the row again after the commit
    // and after the next paint; each retry runs only while no other surface
    // owns focus, so a popup opened by the close keeps it.
    const claimTreeFocus = (own: boolean) => {
      const pane = treePaneRef.current;
      if (!pane) return;
      const active = document.activeElement;
      const menuOwnsFocus = active instanceof HTMLElement
        && !!active.closest("[data-taomni-context-menu]");
      const focusLost = !(active instanceof HTMLElement)
        || active === document.body
        || active === document.documentElement
        || !active.isConnected;
      // The closing menu hands the row back unconditionally; the retries only
      // fill a focus vacuum so they never steal from another surface.
      if (!own && !menuOwnsFocus && !focusLost) return;
      const target = pane.querySelector<HTMLElement>("[role='treeitem'][data-selected='true']")
        ?? pane.querySelector<HTMLElement>("[data-testid='code-workspace-tree']");
      target?.focus({ preventScroll: true });
    };
    claimTreeFocus(true);
    if (typeof queueMicrotask === "function") queueMicrotask(() => claimTreeFocus(false));
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => claimTreeFocus(false));
  }, []);

  const {
    show: openTreeContextMenu,
    showAt: openTreeContextMenuAt,
    render: treeContextMenu,
  } = useContextMenu({ onClose: handleTreeContextMenuClose });
  const {
    showAt: openEditorContextMenuAt,
    render: editorContextMenu,
  } = useContextMenu();

  const copyEditorTabPath = useCallback(async (key: string, absolute: boolean) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.ref.kind === "root") {
      await copyTreePath(file.ref.rootId, file.ref.path, absolute);
      return;
    }
    const text = absolute ? normalizeFsPath(file.ref.path) : basename(file.ref.path);
    try {
      await writeText(text);
      setStatusMessage(`Copied ${text}`);
    } catch (err) {
      setStatusMessage(errorMessage(err));
    }
  }, [copyTreePath, setStatusMessage]);

  const revealEditorTabInTree = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    setLanguagePanelOpen(true);
    setSelected({ kind: "file", ref: file.ref });
    if (file.ref.kind !== "root") return;
    const rootId = file.ref.rootId;
    setExpandedRoots((current) => new Set(current).add(rootId));
    const directories = file.ref.path.split("/").filter(Boolean).slice(0, -1);
    setExpandedDirs((current) => {
      const next = new Set(current);
      let path = "";
      for (const directory of directories) {
        path = path ? `${path}/${directory}` : directory;
        next.add(rootDirKey(rootId, path));
        void loadDir(rootId, path);
      }
      return next;
    });
    treePaneRef.current?.focus();
  }, [loadDir, setLanguagePanelOpen]);

  /**
   * IDEA Project view "Expand All": every root plus every directory listed so
   * far; their unloaded sub-directories load now, so repeated use goes deeper
   * without walking a whole large project at once.
   */
  const expandAllProjectTree = useCallback(() => {
    const keys = new Set<string>();
    const pending: Array<{ rootId: string; path: string }> = [];
    for (const [key, state] of Object.entries(directories)) {
      if (!state.loaded) continue;
      const rootId = key.slice(0, key.indexOf(":"));
      for (const entry of state.entries) {
        if (entry.fileType !== "dir") continue;
        const childKey = rootDirKey(rootId, entry.path);
        keys.add(childKey);
        if (!directories[childKey]?.loaded) pending.push({ rootId, path: entry.path });
      }
    }
    setExpandedRoots(new Set(roots.map((root) => root.id)));
    setExpandedDirs((current) => new Set([...current, ...keys]));
    for (const root of roots) {
      if (!directories[rootDirKey(root.id, "")]?.loaded) void loadDir(root.id, "");
    }
    for (const target of pending.slice(0, 200)) void loadDir(target.rootId, target.path);
  }, [directories, loadDir, roots, setExpandedDirs, setExpandedRoots]);

  /** IDEA Project view "Collapse All": back to the roots' top level. */
  const collapseAllProjectTree = useCallback(() => {
    setExpandedDirs(new Set());
  }, [setExpandedDirs]);

  const revealEditorTabInExplorer = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no file on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      void revealInExplorer(file.ref.rootId, file.ref.path);
      return;
    }
    const absolute = normalizeFsPath(file.ref.path);
    void invoke("sftp_open_path", { path: absolute })
      .then(() => setStatusMessage(`Opened ${absolute}`))
      .catch((err) => setStatusMessage(errorMessage(err)));
  }, [revealInExplorer, setStatusMessage]);

  /**
   * IDEA-style breadcrumb: list children of a directory/root segment, or siblings
   * when the file segment is clicked. Marks the trail's next segment as active.
   */
  const loadBreadcrumbPathChildren = useCallback(createLoadBreadcrumbPathChildren({
    rootsRef,
    loadDir,
  }), [loadDir]);

  const navigateBreadcrumbPathChild = useCallback((
    child: BreadcrumbPathChild,
    file: OpenFileState,
  ) => {
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      if (child.kind === "directory") {
        setSelected({ kind: "dir", rootId, path: child.path });
        setExpandedRoots((current) => new Set(current).add(rootId));
        setExpandedDirs((current) => {
          const next = new Set(current);
          let acc = "";
          for (const part of child.path.split("/").filter(Boolean)) {
            acc = acc ? `${acc}/${part}` : part;
            next.add(rootDirKey(rootId, acc));
          }
          return next;
        });
        void loadDir(rootId, child.path);
        treePaneRef.current?.focus();
        return;
      }
      void openFile({ kind: "root", rootId, path: child.path });
      return;
    }
    // Loose file sibling/parent navigation: open absolute path as a loose file.
    if (child.kind === "file") {
      void addLooseFilePath(child.path);
      return;
    }
    setStatusMessage(`Folder: ${child.path}`);
  }, [addLooseFilePath, loadDir, openFile, setStatusMessage]);

  const breadcrumbPathActions = useCallback(createBreadcrumbPathActions({
    setSelected,
    treePaneRef,
    setExpandedRoots,
    setExpandedDirs,
    loadDir,
    revealEditorTabInTree,
    copyTreePath,
    revealInExplorer,
    setStatusMessage,
  }), [copyTreePath, loadDir, revealEditorTabInTree, revealInExplorer, setStatusMessage]);

  const openEditorTabInTerminal = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    if (file.library) {
      setStatusMessage(`${file.title} is a library source with no directory on disk`);
      return;
    }
    if (file.ref.kind === "root") {
      openTerminalAt(file.ref.rootId, file.ref.path, true);
      return;
    }
    const cwd = parentPath(normalizeFsPath(file.ref.path));
    setBottomDockTab("terminal");
    setBottomDockOpen(true);
    terminalDockRef.current?.openAt(cwd, basename(cwd));
  }, [openTerminalAt, setStatusMessage]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const pane = treePaneRef.current;
    const target = event.target;
    if (!pane || !(target instanceof HTMLElement) || event.nativeEvent.isComposing) return;
    // WKWebView can report function keys as Unidentified while preserving the
    // physical code. Use that code for tree actions such as F2 and Delete.
    const key = event.key === "Unidentified" ? event.nativeEvent.code : event.key;
    const tree = pane.querySelector<HTMLElement>("[data-testid='code-workspace-tree']");
    if (!tree || (target !== pane && !tree.contains(target))) return;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      navigateProjectTree(tree, key, { onSelect: setSelected, onToggleRoot: toggleRoot, onToggleDir: toggleDir })) {
      event.preventDefault();
      treeInteractionEpochRef.current += 1;
      pendingTreeOpenIntentRef.current = null;
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (selected?.kind === "file") {
        void requestTreeOpen(selected.ref, { split: event.ctrlKey || event.metaKey });
      } else if (selected?.kind === "root") toggleRoot(selected.rootId);
      else if (selected?.kind === "dir") toggleDir(selected.rootId, selected.path);
      return;
    }
    if ((event.nativeEvent as KeyboardEvent).isComposing) return;
    if (key === "Escape") {
      event.preventDefault();
      handleReturnToEditor();
      return;
    }
    if (key === "F2") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.rename", { focus: "tree", payload: { selection: selected ?? undefined } });
    } else if (key === "Delete") {
      event.preventDefault();
      workspaceCommandRunnerRef.current("workspace.tree.delete", { focus: "tree", payload: { selection: selected ?? undefined } });
    }
  }, [handleReturnToEditor, requestTreeOpen, selected, setSelected, toggleDir, toggleRoot]);

  const showTreeContextMenu = useCallback(
    createShowTreeContextMenu({
    setSelected,
    treeContextMenuSessionRef,
    workspaceInstanceId,
    workspaceCommandRunnerRef,
    stageTreeClipboard,
    canPasteTreeClipboard,
    pasteTreeClipboard,
    openTreeContextMenu,
    setStatusMessage,
    revealInExplorer,
    openTerminalAt,
  }),
    [
      canPasteTreeClipboard,
      openTerminalAt,
      openTreeContextMenu,
      pasteTreeClipboard,
      revealInExplorer,
      stageTreeClipboard,
      workspaceInstanceId,
    ],
  );

  const mutateOpenBuffer = useCallback(createMutateOpenBuffer({
    openFilesRef,
    pendingEditorTextByFileRef,
    pendingEditorCaretByFileRef,
    setOpenFiles,
  }), [setOpenFiles]);

  const updateFileText = useCallback((key: string, text: string) => {
    mutateOpenBuffer(key, { text, error: null }, "programmatic");
  }, [mutateOpenBuffer]);

  const scheduleLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    const latestNow = openFilesRef.current[key];
    // Typing only drives didChange for an *already active* session. Missing
    // LSP / failed jdtls never schedules idle open probes from keystrokes.
    if (!latestNow || !shouldLiveSyncLsp(latestNow.languagePath, lspFilesRef.current[key])) {
      return;
    }
    liveLspSyncTimersRef.current[key] = window.setTimeout(() => {
      delete liveLspSyncTimersRef.current[key];
      const latest = openFilesRef.current[key];
      if (!latest || latest.loading) return;
      const lspState = lspFilesRef.current[key];
      if (!shouldLiveSyncLsp(latest.languagePath, lspState)) return;
      if (lspState?.status?.active && isLspDocumentSynced(key, latest.text)) return;
      // Active → change; still-opening → open (coalesced as pending change once active).
      const mode: "open" | "change" = lspState?.status?.active ? "change" : "open";
      void syncLspDocument(latest, mode);
    }, LSP_CHANGE_SYNC_DELAY_MS);
  }, [isLspDocumentSynced, syncLspDocument]);

  const cancelLiveLspSync = useCallback((key: string) => {
    const existing = liveLspSyncTimersRef.current[key];
    if (!existing) return;
    window.clearTimeout(existing);
    delete liveLspSyncTimersRef.current[key];
  }, []);

  /**
   * Bring the language server up to the live editor buffer before a latency-
   * sensitive feature (completion / signature). Bypasses the typing debounce
   * and waits for the in-flight sync queue to drain for this file.
   */
  const ensureLspDocumentSynced = useCallback(async (
    fileKey: string,
    requireSynchronized = false,
  ): Promise<OpenFileState | null> => {
    cancelLiveLspSync(fileKey);
    const kick = () => {
      const latest = openFilesRef.current[fileKey];
      if (!latest || latest.loading) return null;
      const state = lspFilesRef.current[fileKey];
      // Features require an active session; do not open-from-completion on plain text.
      if (!isLspFeatureReady(state)) return null;
      if (isLspDocumentSynced(fileKey, latest.text)) return latest;
      void syncLspDocument(latest, "change");
      return null;
    };
    const ready = kick();
    if (ready) return ready;
    // No active server: do not wait on every completion keystroke.
    if (!isLspFeatureReady(lspFilesRef.current[fileKey])) return null;
    if (requireSynchronized) {
      // A completion for the final trigger character has no later keystroke
      // to retry it. Keep it pending until didChange settles instead of
      // dropping it when the best-effort feature wait expires. Callers still
      // reject changed document/session identities before delivering results.
      await waitForLspDocumentSyncQueue(fileKey);
    } else {
      await Promise.race([
        waitForLspDocumentSyncQueue(fileKey),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, LSP_FEATURE_SYNC_WAIT_MS);
        }),
      ]);
    }
    const finalReady = kick();
    if (finalReady) return finalReady;
    // Best effort: if the server is active but still catching up, still return
    // the live buffer so the feature request can race (CM will re-query on the
    // next keystroke via isIncomplete / abort-on-doc-change).
    const latest = openFilesRef.current[fileKey];
    if (
      latest
      && isLspFeatureReady(lspFilesRef.current[fileKey])
      && (!requireSynchronized || isLspDocumentSynced(fileKey, latest.text))
    ) return latest;
    return null;
  }, [cancelLiveLspSync, isLspDocumentSynced, syncLspDocument, waitForLspDocumentSyncQueue]);

  /**
   * Semantic mutations are stricter than completion/signature help: every
   * active provider buffer must be acknowledged before the query is sent.
   * If the user edits during the barrier, the original action is abandoned.
   */
  const ensureWorkspaceSemanticDocumentsSynced = useCallback(async (
    requiredFileKey: string,
    expectedRevision: number,
  ): Promise<OpenFileState | null> => {
    const candidates = Object.values(openFilesRef.current).filter((candidate) => (
      !candidate.library
      && shouldLiveSyncLsp(candidate.languagePath, lspFilesRef.current[candidate.key])
    ));
    if (!candidates.some((candidate) => candidate.key === requiredFileKey)) return null;
    const synchronized = await Promise.all(candidates.map(async (candidate) => {
      const latest = await ensureLspDocumentSynced(candidate.key, true);
      const current = openFilesRef.current[candidate.key];
      return !!latest
        && !!current
        && latest.text === current.text
        && isLspDocumentSynced(candidate.key, current.text);
    }));
    if (!synchronized.every(Boolean)) return null;
    if (semanticIndex.current().revision !== expectedRevision) return null;
    const required = openFilesRef.current[requiredFileKey];
    return required && isLspDocumentSynced(requiredFileKey, required.text) ? required : null;
  }, [ensureLspDocumentSynced, isLspDocumentSynced, semanticIndex.current]);

  const queueEditorTextUpdate = useCallback(createQueueEditorTextUpdate({
    openFilesRef,
    workspaceInstanceId,
    updateEditorGroup,
    workspaceEditHistory,
    setWorkspaceEditHistoryRevision,
    mutateOpenBuffer,
    pendingEditorCaretByFileRef,
    editorSelectionRef,
    semanticIndex,
    scheduleLiveLspSync,
    pendingEditorTextTimerRef,
    flushPendingEditorText,
  }), [
    flushPendingEditorText,
    scheduleLiveLspSync,
    semanticIndex.invalidateSilently,
    updateEditorGroup,
    workspaceEditHistory,
    workspaceInstanceId,
  ]);

  const absolutePathForOpenFile = useCallback((file: OpenFileState): string | null => {
    // Library sources live inside a JAR / the language server, not on disk.
    if (file.library) return null;
    if (file.ref.kind === "loose") return normalizeFsPath(file.ref.path);
    const root = findRoot(file.ref.rootId);
    if (!root) return null;
    return absoluteWorkspacePath(root, file.ref.path);
  }, [findRoot]);
  /**
   * ED-FOLLOW-003: path-keyed open-buffer view for buildRefactorPlan.
   * The live openFiles map is keyed by file key (`root:<id>:<path>`), which
   * matchOpenFile can never resolve — passing it straight through silently
   * disabled every open-buffer plan guard (dirty edits, revision skew). The
   * view re-keys by absolute path and file URI so the guards see the
   * buffers. Deliberately narrow: only staleness/dirty signals ride it
   * (documentRevision, LSP revision, dirty, library). Buffer text and disk
   * hashes stay out so the plan's hash machinery keeps its current
   * snapshot-driven semantics (notably the EOL-tolerant journal path).
   *
   * Revision is reported only while the server has NOT acknowledged the
   * latest buffer text (isLspDocumentSynced false). documentRevision bumps
   * per edit while the sync version bumps per flushed didChange, so a
   * coalesced burst always skews the counters even though the server holds
   * the latest text — reporting the raw version would false-positive every
   * rename after any typing burst. Omitting it when synced makes the plan
   * guard mean exactly "the server has not seen the latest bytes".
   */
  const buildPlanOpenFiles = useCallback((): Record<string, {
    documentRevision?: number;
    revision?: number;
    canonicalPath?: string;
    dirty?: boolean;
    library?: unknown;
  }> => {
    const view: Record<string, {
      documentRevision?: number;
      revision?: number;
      canonicalPath?: string;
      dirty?: boolean;
      library?: unknown;
    }> = {};
    for (const file of Object.values(openFilesRef.current)) {
      if (file.loading) continue;
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath) continue;
      const normalized = normalizeFsPath(absolutePath);
      const entry: {
        documentRevision?: number;
        revision?: number;
        canonicalPath?: string;
        dirty?: boolean;
        library?: unknown;
      } = {
        documentRevision: file.documentRevision,
        canonicalPath: normalized,
        dirty: file.dirty === true,
      };
      if (!isLspDocumentSynced(file.key, file.text)) {
        const syncedRevision = lspDocumentVersion(file.key);
        if (syncedRevision !== null && syncedRevision !== undefined) {
          entry.revision = syncedRevision;
        }
      }
      if (file.library != null) {
        entry.library = file.library;
      }
      view[normalized] = entry;
      view[`file://${normalized}`] = entry;
    }
    return view;
  }, [absolutePathForOpenFile, isLspDocumentSynced, lspDocumentVersion]);
  const inspectionPathForFileKey = useCallback((fileKeyValue: string): string => {
    const open = openFilesRef.current[fileKeyValue];
    const ref = open?.ref;
    if (ref?.kind === "root") {
      return `root:${ref.rootId}:${normalizeFsPath(ref.path).replace(/^\/+/, "")}`;
    }
    if (ref) return `loose:${normalizeFsPath(ref.path)}`;
    for (const root of rootsRef.current) {
      const relative = relativePathWithinRoot(root.path, fileKeyValue);
      if (relative !== null) return `root:${root.id}:${normalizeFsPath(relative).replace(/^\/+/, "")}`;
    }
    return normalizeFsPath(fileKeyValue);
  }, []);
  const suppressInspection = useCallback((
    fileKeyValue: string,
    diagnostic: LspDiagnostic,
    scope: InspectionSuppressionScope,
  ) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addInspectionSuppression(current, diagnostic, path, scope));
    setStatusMessage(`Hidden locally (${scope}): ${diagnostic.source ?? "inspection"}:${diagnostic.code ?? "*"}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const addInspectionBaseline = useCallback((fileKeyValue: string, diagnostic: LspDiagnostic) => {
    const path = inspectionPathForFileKey(fileKeyValue);
    persistInspectionProfile((current) => addDiagnosticToInspectionBaseline(current, diagnostic, path));
    setStatusMessage("Added diagnostic to inspection baseline");
  }, [inspectionPathForFileKey, persistInspectionProfile, setStatusMessage]);
  const clearInspectionBaselineEntries = useCallback(() => {
    persistInspectionProfile(clearInspectionBaseline);
    setStatusMessage("Inspection baseline cleared");
  }, [persistInspectionProfile, setStatusMessage]);
  const removeInspectionBaseline = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionBaselineEntry(current, key));
  }, [persistInspectionProfile]);
  const removeInspectionSuppressionEntry = useCallback((key: string) => {
    persistInspectionProfile((current) => removeInspectionSuppression(current, key));
  }, [persistInspectionProfile]);
  const exportInspectionBaseline = useCallback(async () => {
    const text = serializeInspectionBaseline(inspectionProfile);
    await writeText(text);
    setStatusMessage("Inspection baseline copied to clipboard");
  }, [inspectionProfile, setStatusMessage]);
  const importInspectionBaselineFromClipboard = useCallback(async () => {
    try {
      const text = await readText();
      // Validate before entering the state updater. An invalid clipboard
      // payload must report an import error without throwing during render.
      const imported = importInspectionBaseline(inspectionProfile, text);
      persistInspectionProfile((current) => ({
        ...current,
        baseline: imported.baseline,
      }));
      setStatusMessage("Inspection baseline imported");
    } catch (error) {
      setStatusMessage(errorMessage(error));
    }
  }, [inspectionProfile, persistInspectionProfile, setStatusMessage]);

  const readWorkspaceEditPathSnapshot = useCallback(createReadWorkspaceEditPathSnapshot({
    openFilesRef,
    absolutePathForOpenFile,
    rootsRef,
  }), [absolutePathForOpenFile]);

  const captureWorkspaceEditPathSnapshots = useCallback(async (
    edit: LspWorkspaceEdit,
  ): Promise<WorkspaceEditPathSnapshot[] | null> => {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (path: string | null) => {
      if (!path) return false;
      const normalized = normalizeFsPath(path);
      const comparisonKey = fsPathComparisonKey(normalized);
      if (!seen.has(comparisonKey)) {
        seen.add(comparisonKey);
        paths.push(normalized);
      }
      return true;
    };
    for (const operation of workspaceEditOperations(edit)) {
      if (operation.kind === "text") {
        if (!add(operation.document.path)) return null;
      } else if (operation.kind === "rename") {
        if (!add(operation.oldPath) || !add(operation.newPath)) return null;
      } else if (!add(operation.path)) {
        return null;
      }
    }
    const snapshots = await Promise.all(paths.map(readWorkspaceEditPathSnapshot));
    return snapshots.every((snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null)
      ? snapshots
      : null;
  }, [readWorkspaceEditPathSnapshot]);

  const captureCodeActionTransactionSnapshot = useCallback(async (
    edit: LspWorkspaceEdit,
  ): Promise<CodeActionTransactionSnapshot | null> => {
    const pathSnapshots = await captureWorkspaceEditPathSnapshots(edit);
    if (!pathSnapshots) return null;
    const byPath = new Map(pathSnapshots.map((snapshot) => [
      fsPathComparisonKey(snapshot.path),
      snapshot,
    ]));
    const resources = [];
    for (const resource of extractAffectedResourcesFromWorkspaceEdit(edit)) {
      if (!resource.path) return null;
      const path = normalizeFsPath(resource.path);
      const snapshot = byPath.get(fsPathComparisonKey(path));
      if (!snapshot) return null;
      resources.push({
        uri: resource.uri || path,
        path,
        exists: snapshot.exists,
        text: snapshot.text,
        encoding: snapshot.encoding,
        bom: snapshot.bom,
        eol: snapshot.eol,
      });
    }
    return { resources };
  }, [captureWorkspaceEditPathSnapshots]);

  const restoreCodeActionTransactionSnapshot = useCallback(async (
    snapshot: CodeActionTransactionSnapshot,
  ) => {
    const byPath = new Map<string, WorkspaceEditPathSnapshot>();
    for (const resource of snapshot.resources) {
      const path = normalizeFsPath(resource.path);
      byPath.set(fsPathComparisonKey(path), {
        path,
        exists: resource.exists,
        text: resource.text,
        encoding: resource.encoding,
        bom: resource.bom,
        eol: resource.eol,
      });
    }
    await replayWorkspacePathSnapshotsRef.current([...byPath.values()]);
  }, []);

  const absolutePathForBookmark = useCallback((bookmark: WorkspaceBookmark): string | null => {
    const open = openFilesRef.current[bookmark.fileKey];
    if (open) return absolutePathForOpenFile(open);
    for (const root of rootsRef.current) {
      const prefix = `root:${root.id}:`;
      if (bookmark.fileKey.startsWith(prefix)) {
        return absoluteWorkspacePath(root, bookmark.fileKey.slice(prefix.length));
      }
    }
    return null;
  }, [absolutePathForOpenFile]);

  const captureWorkspaceEditBookmarkSnapshot = useCallback((paths: readonly string[]): WorkspaceBookmark[] => {
    const affectedPaths = new Set(paths.map((path) => fsPathComparisonKey(path)));
    return bookmarksRef.current.filter((bookmark) => {
      const path = absolutePathForBookmark(bookmark);
      return path !== null && affectedPaths.has(fsPathComparisonKey(path));
    });
  }, [absolutePathForBookmark]);

  const restoreWorkspaceBookmarkSnapshot = useCallback((
    snapshot: readonly WorkspaceBookmark[],
    affectedIds: readonly string[],
  ) => {
    if (affectedIds.length === 0) return;
    const next = mergeWorkspaceBookmarkSnapshot(bookmarksRef.current, snapshot, affectedIds);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);

  const captureWorkspaceEditTabSnapshot = useCallback((
    paths: readonly string[],
  ): WorkspaceEditTabSnapshot => {
    const pathSet = new Set(paths.map(fsPathComparisonKey));
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    // §8.16.4 N6.6: snapshot every leaf at any depth, not just the legacy
    // primary/secondary pair; the full tree (with ratios) is captured so a
    // failed WorkspaceEdit restores the entire layout.
    const groupIds: EditorGroupId[] = getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    const files = Object.values(openFilesRef.current).flatMap((file) => {
      const absolutePath = absolutePathForOpenFile(file);
      if (!absolutePath || !pathSet.has(fsPathComparisonKey(absolutePath))) return [];
      const groups = groupIds.flatMap((id) => {
        const group = ui.editorGroups[id];
        if (!group || !group.openOrder.includes(file.key)) return [];
        return [{
          id,
          active: group.activeKey === file.key,
          preview: group.previewKey === file.key,
          pinned: group.pinnedKeys.includes(file.key),
        }];
      });
      return groups.length > 0 ? [{ path: normalizeFsPath(absolutePath), ref: file.ref, groups }] : [];
    });
    return {
      activeGroupId: ui.activeEditorGroupId,
      splitOrientation: ui.splitOrientation,
      layoutTreeV2: cloneLayoutTree(ui.layoutTreeV2),
      files,
    };
  }, [absolutePathForOpenFile, workspaceInstanceId]);

  const restoreWorkspaceEditTabs = useCallback(async (snapshot: WorkspaceEditTabSnapshot) => {
    // §8.16.4 N6.6: restore the entire recursive tree (structure + ratios)
    // before reopening tabs so a failed WorkspaceEdit recovers every leaf,
    // not just the two legacy groups.
    setLayoutTreeV2Store(workspaceInstanceId, cloneLayoutTree(snapshot.layoutTreeV2));
    for (const file of snapshot.files) {
      for (const group of file.groups) {
        await openFile(file.ref, { preview: group.preview, groupId: group.id });
        const key = fileKey(file.ref);
        updateEditorGroup(group.id, (current) => ({
          ...current,
          activeKey: group.active ? key : current.activeKey,
          previewKey: group.preview ? key : current.previewKey === key ? null : current.previewKey,
          pinnedKeys: group.pinned
            ? [...new Set([...current.pinnedKeys, key])]
            : current.pinnedKeys.filter((candidate) => candidate !== key),
        }));
      }
    }
    activateEditorGroup(snapshot.activeGroupId);
  }, [activateEditorGroup, openFile, updateEditorGroup, workspaceInstanceId]);

  /**
   * Persist an open buffer with an explicit text payload.
   * Used by WorkspaceEdit for open-clean files (§5.2.9): apply then save.
   * Unlike `saveFile`, this does not require the buffer to already be dirty.
   */
  const [localHistoryTarget, setLocalHistoryTarget] = useState<{ key: string; path: string } | null>(null);

  const compareLocalHistorySnapshot = useCallback((
    key: string,
    entry: LocalHistoryEntry,
    snapshotText: string,
    options?: {
      file?: OpenFileState;
      selection?: CompareSelection;
      target?: CompareTarget;
    },
  ) => {
    const file = options?.file ?? openFilesRef.current[key];
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    if (!path) {
      setStatusMessage(`${file.title} has no local filesystem path`);
      return;
    }
    const selection = options?.selection ?? compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = options?.target ?? compareTargetForOpenFile(file, selection);
    const result = createFileCompareSession(
      {
        title: `${file.title} @ ${entry.reason} #${entry.id}`,
        path: entry.path,
        text: snapshotText,
        encoding: file.encoding ?? "UTF-8",
        eol: file.eol,
        bom: file.bom ?? false,
        sizeBytes: entry.byteLen,
        source: "local-history",
        readOnly: true,
      },
      compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle),
      target,
    );
    if (!result.session) {
      const unavailable = classifyCompareReadError(result.error ?? "Local history snapshot is unavailable");
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${file.title} with Local History`,
        unavailableTitle: "Local History snapshot",
        reason: unavailable.reason,
        message: unavailable.message,
        right: compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle),
        target,
      }));
      return;
    }
    setActiveCompareSession(result.session);
  }, [absolutePathForOpenFile, setStatusMessage]);

  const openLocalHistoryForKey = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const absolute = absolutePathForOpenFile(file);
    if (!absolute) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        : "Cannot resolve path for local history");
      return;
    }
    setLocalHistoryTarget({ key, path: absolute });
  }, [absolutePathForOpenFile, setStatusMessage]);

  const restoreLocalHistoryText = useCallback((key: string, text: string) => {
    updateFileText(key, text);
    setStatusMessage("Restored local history snapshot into the editor buffer");
  }, [setStatusMessage, updateFileText]);

  const applySelectionReplacement = useCallback((key: string, range: EditorSelectionRange, nextText: string) => {
    const file = openFilesRef.current[key];
    if (!file) return;
    const lines = file.text.split("\n");
    const offsetAt = (position: { line: number; character: number }) => {
      let offset = 0;
      for (let line = 0; line < Math.min(position.line, lines.length); line += 1) {
        offset += (lines[line]?.length ?? 0) + 1;
      }
      const lineText = lines[Math.min(position.line, Math.max(0, lines.length - 1))] ?? "";
      return offset + Math.min(Math.max(0, position.character), lineText.length);
    };
    const from = offsetAt(range.start);
    const to = offsetAt(range.end);
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const replaced = `${file.text.slice(0, start)}${nextText}${file.text.slice(end)}`;
    updateFileText(key, replaced);
  }, [updateFileText]);

  /**
   * Gather everything the AI prompt builder needs for a selection: language,
   * enclosing scope, imports, neighbouring lines, diagnostics, and LSP type
   * info. A bare selection is often only a fragment (an `impl` header, a
   * signature), so the surrounding facts are what make the answer accurate.
   */
  const buildEditorAiContext = useCallback(createBuildEditorAiContext({
    lspFilesRef,
    breadcrumbSymbolsRef,
    activeEditorGroupIdRef,
    getLspHoverRef,
  }), []);

  /** Default rewrite/fix instruction shown in the proposal dialog. */
  const defaultAiInstruction = useCallback((action: EditorAiAction): string | undefined => (
    action === "fix"
      ? "Fix issues in the selected code"
      : action === "rewrite"
        ? "Rewrite the selected code"
        : undefined
  ), []);

  const aiSentStatusKey = useCallback((action: EditorAiAction): string => (
    action === "explain"
      ? "codeWorkspaceAi.sentExplain"
      : action === "syntax"
        ? "codeWorkspaceAi.sentSyntax"
        : action === "fix"
          ? "codeWorkspaceAi.sentFix"
          : "codeWorkspaceAi.sentRewrite"
  ), []);

  /**
   * Shared tail for every AI selection action: build the prompt, send it, and —
   * for the code-producing actions — open the proposal dialog so the answer can
   * be diffed against the selection before it is applied.
   */
  const dispatchEditorAiAction = useCallback(async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
  ) => {
    const instruction = defaultAiInstruction(action);
    const context = await buildEditorAiContext(action, file, selection, text, instruction);
    const prompt = buildEditorAiPrompt(context, editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);

    if (action === "fix" || action === "rewrite") {
      setAiRewriteState({
        key: file.key,
        path: file.subtitle || file.path,
        original: text,
        proposal: text,
        instruction: instruction ?? "",
        range: selection,
      });
    }

    setEditorAiSelection(null);
    setStatusMessage(t(aiSentStatusKey(action)));
  }, [
    aiSentStatusKey,
    buildEditorAiContext,
    defaultAiInstruction,
    editorAiPreferences.answerLanguage,
    sendPromptToTabChat,
    setStatusMessage,
    t,
  ]);

  /** Selection-toolbar entry point: the user has already highlighted the code. */
  const handleEditorAiAction = useCallback(async (action: EditorAiAction, text: string) => {
    const selection = editorSelectionRef.current;
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file || selection.empty || !text.trim()) return;
    await dispatchEditorAiAction(action, file, selection, text);
  }, [activeKey, dispatchEditorAiAction]);

  /**
   * Command-palette / context-menu entry point, where there may be no selection.
   * Falls back to the enclosing symbol at the caret, then to the current line, so
   * "put the caret on it and ask" works without selecting anything by hand.
   */
  const runEditorAiActionAtCursor = useCallback(async (action: EditorAiAction) => {
    const file = activeKey ? openFilesRef.current[activeKey] ?? null : null;
    if (!file) return;
    const selection = editorSelectionRef.current;
    if (!selection.empty && selection.text.trim().length >= 2) {
      await dispatchEditorAiAction(action, file, selection, selection.text);
      return;
    }

    const lines = file.text.split("\n");
    const chain = symbolChainAtPosition(
      breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current] ?? [],
      selection.start,
    );
    const enclosing = chain[chain.length - 1]?.range;
    const startLine = enclosing ? enclosing.start.line : selection.start.line;
    const endLine = enclosing ? enclosing.end.line : selection.start.line;
    const text = lines.slice(startLine, endLine + 1).join("\n");
    if (text.trim().length < 2) {
      setStatusMessage(t("codeWorkspaceAi.noSelection"));
      return;
    }

    // Synthesize the range so the prompt reports the lines it actually sent.
    const synthetic: EditorSelectionRange = {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: (lines[endLine] ?? "").length },
      empty: false,
      text,
      rect: null,
    };
    await dispatchEditorAiAction(action, file, synthetic, text);
  }, [activeKey, dispatchEditorAiAction, setStatusMessage, t]);

  /** Re-ask with the instruction the user edited in the proposal dialog. */
  const regenerateAiRewrite = useCallback(async () => {
    const state = aiRewriteStateRef.current;
    if (!state) return;
    const file = openFilesRef.current[state.key] ?? null;
    if (!file) return;
    const instruction = state.instruction.trim() || defaultAiInstruction("rewrite");
    const context = await buildEditorAiContext(
      "rewrite",
      file,
      state.range,
      state.original,
      instruction,
    );
    const prompt = buildEditorAiPrompt(context, editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);
    setStatusMessage(t("codeWorkspaceAi.resentRewrite"));
  }, [buildEditorAiContext, buildEditorAiPrompt, defaultAiInstruction, editorAiPreferences.answerLanguage, sendPromptToTabChat, setStatusMessage, t]);
  const { formatFileText, saveOpenBufferText, commitClosedFilePreparedSave, saveFile, reloadFile } = useWorkspaceSave({
    openFilesRef,
    rootsRef,
    bumpDiskEffectLedger,
    saveTransactionRegistryRef,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    workspaceStyleControllerRef,
    notifyWorkspacePathGitChanged,
    semanticIndex,
    saveLspDocument,
    syncLspDocument,
    workspaceInstanceId,
    lspDescriptorForFile,
    lspFilesRef,
    indentationOverridesRef,
    codeStyleSchemesRef,
    resolvedCodeStylesRef,
    updateLspStatusForFile,
    findRoot,
    setStatusMessage,
    activeKey,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    intelligencePreferences,
    get canonicalCodeActionServiceRef() { return canonicalCodeActionServiceRef; },
    setSaveObservations,
    publishWorkspaceObservation,
    setOpenFiles,
  });
  const { closeFile, keepLocalExternalFileConflict, loadDiskExternalFileConflict, mergeExternalFileConflict, dismissExternalFileConflict } = useWorkspaceFileLifecycle({
    findRoot,
    openFilesRef,
    lastTrackedBufferTextRef,
    mutateOpenBuffer,
    lspFilesRef,
    syncLspDocument,
    absolutePathForOpenFile,
    setExternalFileConflicts,
    workspaceStyleControllerRef,
    semanticIndex,
    refreshTree,
    restoreEchoSuppressorRef,
    setStatusMessage,
    setOpenFiles,
    workspaceInstanceId,
    pendingExternalFileEventsRef,
    activeEditorGroupId,
    get mruFileKeysRef() { return mruFileKeysRef; },
    closeLayoutTabInLeaf,
    tabPolicyRef,
    resourceRecoveryCoordinatorRef,
    pendingClosedFilesRef,
    get setClosedTabsStack() { return setClosedTabsStack; },
    closeLspDocumentAndWait,
    saveTransactionRegistryRef,
    setMarkdownModes,
    setLspFiles,
    observeResourceCleanupOutcome,
    closeFileRef,
  });

  const promotePreviewTab = useCallback((groupId: EditorGroupId, key: string) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: group.previewKey === key ? null : group.previewKey,
    }));
  }, [updateEditorGroup]);

  const setTabPinned = useCallback((groupId: EditorGroupId, key: string, pinned: boolean) => {
    updateEditorGroup(groupId, (group) => ({
      ...group,
      previewKey: pinned && group.previewKey === key ? null : group.previewKey,
      pinnedKeys: pinned
        ? [...group.pinnedKeys.filter((entry) => entry !== key), key]
        : group.pinnedKeys.filter((entry) => entry !== key),
    }));
  }, [updateEditorGroup]);

  const closeGroupFiles = useCallback(async (groupId: EditorGroupId, keys: string[]) => {
    for (const key of keys) await closeFile(key, groupId);
  }, [closeFile]);

  const splitEditor = useCallback((
    orientation: EditorSplitOrientation,
    key = activeKey,
    sourceGroupId = activeEditorGroupId,
  ) => {
    if (!key || !openFilesRef.current[key]) return;
    splitLayoutLeaf(workspaceInstanceId, sourceGroupId, orientation, key);
  }, [activeEditorGroupId, activeKey, splitLayoutLeaf, workspaceInstanceId]);

  const closeSplit = useCallback(() => {
    closeLayoutLeaf(workspaceInstanceId, activeEditorGroupId);
  }, [activeEditorGroupId, closeLayoutLeaf, workspaceInstanceId]);

  // §8.19.6 R5-b: split management actions — navigation, tab moves between
  // splits, equalize/stretch proportions and unsplit-all. All layout truth
  // flows through the recursive-tree store reducers.
  const goToAdjacentSplit = useCallback((direction: 1 | -1): boolean => {
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, activeEditorGroupId, direction);
    if (!target || target.id === activeEditorGroupId) return false;
    setStoreActiveEditorGroup(workspaceInstanceId, target.id);
    setStatusMessage(`${direction === 1 ? "Next" : "Previous"} editor: ${target.id}`);
    return true;
  }, [activeEditorGroupId, setStoreActiveEditorGroup, setStatusMessage, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const moveActiveTabToAdjacentSplit = useCallback((direction: 1 | -1): boolean => {
    // Read through the store so a stale closure never moves the wrong tab.
    const liveUi = useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId];
    const sourceId = liveUi?.activeEditorGroupId ?? activeEditorGroupId;
    const key = sourceId ? (liveUi?.editorGroups[sourceId]?.activeKey ?? null) : null;
    if (!key) return false;
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, sourceId, direction);
    if (!target || target.id === sourceId) return false;
    moveLayoutTabStore(workspaceInstanceId, sourceId, target.id, key);
    setStatusMessage(`Moved ${openFilesRef.current[key]?.title ?? key} to the ${direction === 1 ? "next" : "previous"} split`);
    return true;
  }, [activeEditorGroupId, moveLayoutTabStore, openFilesRef, setStatusMessage, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const moveTabToAdjacentSplitFrom = useCallback((
    sourceLeafId: EditorGroupId,
    key: string,
    direction: 1 | -1,
  ): boolean => {
    const target = navigateLeafOrder(workspaceUi.layoutTreeV2, sourceLeafId, direction);
    if (!target || target.id === sourceLeafId) return false;
    moveLayoutTabStore(workspaceInstanceId, sourceLeafId, target.id, key);
    return true;
  }, [moveLayoutTabStore, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const equalizeActiveSplitRatios = useCallback((): boolean => {
    equalizeLayoutRatiosStore(workspaceInstanceId, activeEditorGroupId);
    setStatusMessage("Split proportions equalized");
    return true;
  }, [activeEditorGroupId, equalizeLayoutRatiosStore, setStatusMessage, workspaceInstanceId]);

  const stretchActiveSplit = useCallback((): boolean => {
    stretchLayoutLeafStore(workspaceInstanceId, activeEditorGroupId);
    return true;
  }, [activeEditorGroupId, stretchLayoutLeafStore, workspaceInstanceId]);

  const unsplitAllWindows = useCallback((): boolean => {
    if (getAllLeafNodes(useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId]?.layoutTreeV2
      ?? workspaceUi.layoutTreeV2).length <= 1) {
      setStatusMessage("No splits to close");
      return false;
    }
    unsplitAllLayoutStore(workspaceInstanceId);
    setStatusMessage("Closed all splits — tabs kept in one editor");
    return true;
  }, [setStatusMessage, unsplitAllLayoutStore, workspaceInstanceId, workspaceUi.layoutTreeV2]);

  const activeFile = activeKey ? openFiles[activeKey] ?? null : null;
  const latestSaveObservation = activeKey ? saveObservations[activeKey] ?? null : null;
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
    const record = latestClipboardObservation;
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
  // Large-file mode (M6-B): above the size/line threshold, skip the per-edit
  // semantic-tokens / inlay-hint / document-highlight storm and their decoration
  // rebuilds. Lezer highlighting and on-demand features stay available.
  const activeFileIsLarge = useMemo(
    () => (activeFile && !activeFile.loading ? isLargeFileContent(activeFile.text) : false),
    [activeFile],
  );
  // Metadata panels and AI workspace context do not need a new snapshot for
  // every character.  Let React publish that non-interactive work after the
  // input update has painted.
  const deferredOpenFiles = useDeferredValue(openFiles);
  const activeLspState = activeKey ? lspFiles[activeKey] ?? null : null;
  const activeCapabilities = activeLspState?.status?.capabilities ?? null;
  const inspectionTransform = useCallback(
    (diagnostic: LspDiagnostic, path?: string): LspDiagnostic | null => (
      applyInspectionProfile(diagnostic, inspectionProfile, { path })
    ),
    [inspectionProfile],
  );
  // The session layer already content-dedupes `lspFiles[key].diagnostics`, so the
  // source array identity is stable between real diagnostic changes. Mapping it
  // through the inspection profile on every render would throw that stability
  // away and defeat CodeMirrorHost's identity-based memo, forcing a full
  // diagnostics-compartment reconfigure per render. Cache per source array so
  // the mapped result keeps the same identity too.
  const displayDiagnosticsCache = useMemo(
    () => new WeakMap<readonly LspDiagnostic[], { path: string | undefined; result: LspDiagnostic[] }>(),
    [inspectionProfile],
  );
  const displayDiagnosticsFor = useCallback(
    (source: LspDiagnostic[] | null | undefined, path: string | undefined): LspDiagnostic[] => {
      if (!source || source.length === 0) return EMPTY_DISPLAY_DIAGNOSTICS;
      const cached = displayDiagnosticsCache.get(source);
      if (cached && cached.path === path) return cached.result;
      const mapped = source.flatMap((diagnostic) => {
        const display = inspectionTransform(diagnostic, path);
        return display ? [display] : [];
      });
      const result = mapped.length === 0 ? EMPTY_DISPLAY_DIAGNOSTICS : mapped;
      displayDiagnosticsCache.set(source, { path, result });
      return result;
    },
    [displayDiagnosticsCache, inspectionTransform],
  );
  const diagnosticScopeForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): DiagnosticScope => {
    const descriptor = lspDescriptorForFile(file);
    return {
      fileKey: file.key,
      revision: file.documentRevision ?? 0,
      providerId: state?.status?.presetId ?? null,
      providerGeneration: lspSessionGeneration(),
      uri: state?.status?.uri || descriptor?.documentUri || descriptor?.filePath || null,
    };
  }, [lspDescriptorForFile, lspSessionGeneration]);
  const currentDiagnosticsForFile = useCallback((
    file: OpenFileState,
    state: LspFileState | null | undefined,
  ): LspDiagnostic[] | null => {
    if (!state || !isDiagnosticScopeCurrent(state.diagnosticScope, diagnosticScopeForFile(file, state))) {
      return null;
    }
    return state.diagnostics;
  }, [diagnosticScopeForFile]);
  const activeLspDocumentIsSynced = Boolean(
    activeFile
    && !activeFile.loading
    && activeLspState?.status
    // Store-backed fields re-render after the didChange queue drains; the
    // session helper also covers the silent mid-burst path.
    && !activeLspState.syncing
    && (activeLspState.syncedText === activeFile.text
      || isLspDocumentSynced(activeFile.key, activeFile.text)),
  );

  // The backend is responsible for serializing didOpen/didChange calls, but
  // the view also needs a revision token so a slow feature response cannot
  // paint a document revision that has already been replaced locally.
  useEffect(() => {
    if (!activeFile) return;
    lspDocumentEpochRef.current[activeFile.key] =
      (lspDocumentEpochRef.current[activeFile.key] ?? 0) + 1;
  }, [activeFile?.key, activeFile?.text]);

  const isCurrentLspDocumentRequest = useCallback((file: OpenFileState, epoch: number) => {
    const latestFile = openFilesRef.current[file.key];
    return latestFile?.text === file.text
      && lspDocumentEpochRef.current[file.key] === epoch
      && isLspDocumentSynced(file.key, file.text);
  }, [isLspDocumentSynced]);

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
  const activeLanguageId = activeLspState?.status?.languageId ?? null;
  const activeRenderedDocLanguageId = activeLanguageId
    ?? activeFile?.languagePath.split(".").pop()?.toLowerCase()
    ?? null;
  const activeInlayHintsEnabled = inlayHintsEnabledForLanguage(
    intelligencePreferences,
    activeLanguageId,
  );
  const toggleInlayHints = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlayHintsEnabled: !current.inlayHintsEnabled,
    }));
  }, [setIntelligencePreferences]);
  const toggleInlayHintsForActiveLanguage = useCallback(() => {
    const languageId = activeLanguageId;
    setIntelligencePreferences((current) => {
      if (!languageId) return { ...current, inlayHintsEnabled: !current.inlayHintsEnabled };
      const currentlyEnabled = inlayHintsEnabledForLanguage(current, languageId);
      return {
        ...current,
        inlayHintsEnabled: true,
        inlayHintLanguages: {
          ...current.inlayHintLanguages,
          [languageId]: !currentlyEnabled,
        },
      };
    });
  }, [activeLanguageId, setIntelligencePreferences]);
  const toggleInlineBlame = useCallback(() => {
    setIntelligencePreferences((current) => ({
      ...current,
      inlineBlameEnabled: !current.inlineBlameEnabled,
    }));
  }, [setIntelligencePreferences]);
  const setFormatOnSave = useCallback((enabled: boolean) => {
    setCodeStyleSchemes((current) => {
      const active = activeSchemeForLanguage(current, activeLanguageId || null);
      if (!active || active.id === BUILT_IN_SCHEME_ID) {
        return current;
      }
      const updatedSchemes = current.schemes.map((scheme) => {
        if (scheme.id === active.id) {
          return {
            ...scheme,
            saveActions: {
              ...scheme.saveActions,
              format: enabled,
            },
          };
        }
        return scheme;
      });
      return { ...current, schemes: updatedSchemes };
    });
    setIntelligencePreferences((current) => ({
      ...current,
      formatOnSave: enabled,
    }));
    setStatusMessage(`Format on save ${enabled ? "enabled" : "disabled"} for this workspace`);
  }, [activeLanguageId, setCodeStyleSchemes, setIntelligencePreferences, setStatusMessage]);

  // Probe / re-open when the active buffer *identity* changes — not on every
  // text commit. Typing drives didChange through scheduleLiveLspSync only.
  // Depending on the whole activeFile object used to re-fire open/change IPC
  // after each EDITOR_TEXT_COMMIT_IDLE flush and made non-LSP files feel laggy.
  const activeFileKey = activeFile?.key ?? null;
  const activeFileLoading = activeFile?.loading ?? false;
  const activeFileLanguagePath = activeFile?.languagePath ?? null;
  // Library buffers are served by the origin project's session and never opened as
  // documents, so they must not start a server of their own.
  const activeFileIsLibrary = !!activeFile?.library;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || !activeFileLanguagePath) return;
    if (activeFileIsLibrary) return;
    const lspState = lspFilesRef.current[activeFileKey];
    if (!shouldProbeLsp(activeFileLanguagePath, lspState)) return;
    if (lspState?.status?.active) {
      // Active session: typing / store-text effects own didChange.
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = openFilesRef.current[activeFileKey];
      if (!latest || !shouldProbeLsp(latest.languagePath, lspFilesRef.current[activeFileKey])) return;
      void syncLspDocument(latest, "open");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeFileIsLibrary,
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    syncLspDocument,
    visible,
  ]);

  // Non-CodeMirror text updates (format, AI rewrite, store patches in tests)
  // still need didChange once the server is active. Gated so plain-text /
  // unavailable presets never schedule IPC from store flushes.
  const activeFileText = activeFile?.text;
  useEffect(() => {
    if (!visible || !activeFileKey || activeFileLoading || activeFileText == null) return;
    const lspState = lspFilesRef.current[activeFileKey];
    if (!shouldLiveSyncLsp(activeFileLanguagePath ?? "", lspState)) return;
    if (isLspDocumentSynced(activeFileKey, activeFileText)) return;
    scheduleLiveLspSync(activeFileKey);
  }, [
    activeFileKey,
    activeFileLanguagePath,
    activeFileLoading,
    activeFileText,
    isLspDocumentSynced,
    scheduleLiveLspSync,
    visible,
  ]);
  useEditorSemanticDecorations({
    activeEditorGroupId,
    activeFile,
    autoHighlightRequestGenerationRef,
    occurrenceActiveFileKeyRef,
    occurrenceActiveGroupIdRef,
    occurrenceSessionRef,
    openFilesRef,
    activeFileIsLarge,
    setHighlightsByGroup,
    cursorPositions,
    lspDescriptorForFile,
    activeCapabilities,
    activeLspDocumentIsSynced,
    lspDocumentEpochRef,
    isCurrentLspDocumentRequest,
    updateLspStatusForFile,
    occurrenceSession,
    setOccurrenceSession,
    activeInlayHintsEnabled,
    setInlayHintsByGroup,
    viewportRanges,
    setSemanticTokensByGroup,
  });

  const getLspSelectionRanges = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange,
  ): Promise<LspRange[] | null> => {
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities;
    if (!capabilities?.selectionRange) return null;
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return null;
    try {
      const result = await lspSelectionRanges(descriptor, selection.end);
      updateLspStatusForFile(file, result.status);
      return result.ranges.length > 0 ? result.ranges : null;
    } catch {
      return null;
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);
  const breadcrumbPathSegments = useMemo<BreadcrumbPathSegment[]>(() => {
    return activeFile ? breadcrumbSegmentsForFile(activeFile, roots) : [];
  }, [activeFile, roots]);

  const openFileTodos = useDeferredOpenFileTodos(openFiles);

  useEffect(() => {
    let cancelled = false;
    if (!activeFile || activeFile.loading || !activeCapabilities?.documentSymbol) {
      setBreadcrumbSymbolsByGroup((current) => (
        (current[activeEditorGroupId] ?? []).length === 0
          ? current
          : { ...current, [activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    if (!activeLspDocumentIsSynced) {
      setBreadcrumbSymbolsByGroup((current) => (
        (current[activeEditorGroupId] ?? []).length === 0
          ? current
          : { ...current, [activeEditorGroupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const descriptor = lspDescriptorForFile(activeFile);
    if (!descriptor) return () => { cancelled = true; };
    const epoch = lspDocumentEpochRef.current[activeFile.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(activeFile, epoch)) return;
      void lspDocumentSymbols(descriptor).then((result) => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          updateLspStatusForFile(activeFile, result.status);
          setBreadcrumbSymbolsByGroup((current) => ({
            ...current,
            [activeEditorGroupId]: result.symbols,
          }));
        }
      }).catch(() => {
        if (!cancelled && isCurrentLspDocumentRequest(activeFile, epoch)) {
          setBreadcrumbSymbolsByGroup((current) => (
            (current[activeEditorGroupId] ?? []).length === 0
              ? current
              : { ...current, [activeEditorGroupId]: [] }
          ));
        }
      });
    }, LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentSymbol,
    activeEditorGroupId,
    activeFile,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);
  const activeRootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : null;
  const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) ?? null : null;
  const activeGitRoot = activeRoot && activeFile?.ref.kind === "root"
    ? gitRootForWorkspacePath(activeRoot, activeFile.ref.path, gitRoots)
    : null;
  const title = workspaceTitle(workspace, roots, looseFiles);
  const gitManagerPayload = useMemo<CodeWorkspaceGitManagerPayload>(() => ({
    workspaceName: title,
    workspaceInstanceId,
    workspaceId: workspace.workspaceId,
    roots: gitRoots,
    // Empty roots still emit a payload so the linked Git manager can close
    // instead of snapshotting stale paths (issue #324 B1).
    activeRepoRoot: activeGitRoot?.repoRoot ?? gitRoots[0]?.repoRoot ?? null,
  }), [activeGitRoot, gitRoots, title, workspace.workspaceId, workspaceInstanceId]);

  const activeLspProgress = lspProgresses.length > 0
    ? lspProgresses[lspProgresses.length - 1]!
    : null;
  const activeLspProgressKey = activeLspProgress
    ? `${activeLspProgress.presetId}\u0000${activeLspProgress.rootUri}\u0000${typeof activeLspProgress.token}:${String(activeLspProgress.token)}`
    : null;

  const openGitManager = useCallback(() => {
    if (!onOpenGitManager || gitManagerPayload.roots.length === 0) return;
    onOpenGitManager(gitManagerPayload);
  }, [gitManagerPayload, onOpenGitManager]);

  const reloadActiveFileWithEncoding = useCallback(createReloadActiveFileWithEncoding({
    activeKey,
    openFilesRef,
    setOpenFiles,
    findRoot,
    mutateOpenBuffer,
    setFileEncodingDialogOpen,
    setStatusMessage,
  }), [activeKey, findRoot, mutateOpenBuffer, setStatusMessage]);

  const convertActiveFileEncoding = useCallback((encoding: string, bom: boolean) => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    const effectiveBom = encodingSupportsBom(encoding) && bom;
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        encoding,
        bom: effectiveBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: save as ${encoding}${effectiveBom ? " BOM" : ""}`);
  }, [activeKey, setStatusMessage]);

  const openFileEncodingDialog = useCallback(() => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file || file.library || file.loading) return;
    if (file.saving) {
      // Saving is an asynchronous transaction. Queue the user's intent so a
      // status-bar click that lands in the save/writeback window is honored
      // after the same active file reaches a settled state.
      pendingEncodingDialogFileKeyRef.current = activeKey;
      return;
    }
    setFileEncodingDialogOpen(true);
  }, [activeKey]);

  useEffect(() => {
    const pendingKey = pendingEncodingDialogFileKeyRef.current;
    if (!pendingKey) return;
    if (pendingKey !== activeKey) {
      pendingEncodingDialogFileKeyRef.current = null;
      return;
    }
    const file = openFilesRef.current[pendingKey];
    if (!file || file.library || file.loading || file.saving) return;
    pendingEncodingDialogFileKeyRef.current = null;
    setFileEncodingDialogOpen(true);
  }, [activeFile, activeKey]);

  const cycleActiveFileEol = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    const nextEol: WorkspaceEol = file.eol === "LF"
      ? "CRLF"
      : file.eol === "CRLF"
        ? "CR"
        : "LF";
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        eol: nextEol,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: line endings set to ${nextEol}; save to apply`);
  }, [activeKey, setOpenFiles, setStatusMessage]);

  const toggleActiveFileBom = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    if (!encodingSupportsBom(file.encoding ?? "UTF-8")) {
      setStatusMessage(`${file.subtitle}: BOM is only available for UTF-8 and UTF-16 encodings`);
      return;
    }
    const nextBom = !(file.bom ?? false);
    setOpenFiles((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? file),
        bom: nextBom,
        dirty: true,
        error: null,
      },
    }));
    setStatusMessage(`${file.subtitle}: ${file.encoding ?? "UTF-8"} ${nextBom ? "BOM enabled" : "BOM disabled"}; save to apply`);
  }, [activeKey, setOpenFiles, setStatusMessage]);

  const activeCodeStyle = useMemo(() => getEffectiveCodeStyleForFile(activeFile), [getEffectiveCodeStyleForFile, activeFile]);
  const activeIndentation = activeCodeStyle?.label ?? "Spaces: 2";

  const cycleActiveFileIndentation = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library) return;
    const currentStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: indentationOverridesRef.current[key],
    });
    let nextOverride: ExplicitIndentationOverride | null = null;
    if (currentStyle.insertSpaces && currentStyle.indentSize === 2) {
      nextOverride = { type: "spaces", size: 4 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 4) {
      nextOverride = { type: "spaces", size: 8 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 8) {
      nextOverride = { type: "tabs", size: 4 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 4) {
      nextOverride = { type: "tabs", size: 2 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 2) {
      nextOverride = null; // reset to auto/default
    } else {
      nextOverride = { type: "spaces", size: 2 };
    }
    setIndentationOverrides((curr) => ({ ...curr, [key]: nextOverride }));
    const nextStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: nextOverride,
    });
    setStatusMessage(`${file.subtitle}: code style set to ${nextStyle.label}`);
  }, [activeKey, setStatusMessage]);

  useEffect(() => {
    if (!visible) {
      clearWorkspaceStatus(tabId);
      return;
    }
    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const status = activeLspState?.status ?? null;
    const gitSnapshot = activeGitRoot ? gitSnapshots[activeGitRoot.repoRoot] : null;
    setWorkspaceStatusSegments({
      tabId,
      line: cursor.line + 1,
      column: cursor.character + 1,
      encoding: activeFile
        ? `${activeFile.encoding ?? "UTF-8"}${activeFile.bom ? " BOM" : ""}`
        : "UTF-8",
      eol: activeFile?.eol ?? "LF",
      indentation: activeIndentation,
      languageId: status?.languageId ?? activeLanguageId,
      lspActive: !!status?.active,
      lspLabel: status?.displayName ?? (status?.active ? "LSP" : null),
      lspError: !!activeLspState?.error || (!!status && !status.active && !!status.error),
      lspProgress: activeLspProgress
        ? {
            key: activeLspProgressKey ?? "lsp-progress",
            label: activeLspProgress.title ?? activeLspProgress.serverLabel,
            message: activeLspProgress.message,
            percentage: activeLspProgress.percentage,
            cancellable: activeLspProgress.cancellable,
          }
        : null,
      gitBranch: gitSnapshot?.currentBranch ?? null,
      gitAhead: gitSnapshot?.ahead ?? 0,
      gitBehind: gitSnapshot?.behind ?? 0,
      fontSize: currentEditorFontSize,
      largeFile: activeFileIsLarge,
      // ED-PARITY-010 DEC-010-06: IDEA status bar selection count, lock and
      // navigation bar (root › dirs › file › enclosing symbols).
      selectionChars: activeSelectionStats.chars,
      selectionLineBreaks: activeSelectionStats.lineBreaks,
      readOnly: !!activeFile?.library,
      navigation: activeFile ? workspaceNavigationSegments(
        activeFile.ref,
        roots,
        symbolChainAtPosition(breadcrumbSymbolsByGroup[activeEditorGroupId] ?? [], cursor),
      ) : [],
    });
  }, [
    activeSelectionStats,
    breadcrumbSymbolsByGroup,
    roots,
    activeEditorGroupId,
    activeFile?.bom,
    activeFile?.encoding,
    activeFile?.eol,
    activeFileIsLarge,
    activeGitRoot,
    activeIndentation,
    activeLanguageId,
    activeLspState,
    activeLspProgress,
    activeLspProgressKey,
    clearWorkspaceStatus,
    currentEditorFontSize,
    cursorPositions,
    gitSnapshots,
    setWorkspaceStatusSegments,
    tabId,
    visible,
  ]);

  const activeLspPresetIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeLspPresetIdRef.current = activeLspState?.status?.presetId ?? null;
  }, [activeLspState?.status?.presetId]);

  const openLanguageServersSettings = useCallback((presetId?: string | null) => {
    openSettingsSection("language-servers", { presetId: presetId ?? null });
  }, []);

  useEffect(() => {
    if (!visible) return;
    setWorkspaceStatusActions(tabId, {
      // Language server install / binary selection lives in Settings (global).
      openLanguagePanel: () => openLanguageServersSettings(activeLspPresetIdRef.current),
      openGitManager: gitManagerPayload.roots.length > 0 && onOpenGitManager ? openGitManager : undefined,
      cycleEol: activeFile && !activeFile.library ? cycleActiveFileEol : undefined,
      toggleBom: activeFile && !activeFile.library ? toggleActiveFileBom : undefined,
      chooseEncoding: activeFile && !activeFile.library ? openFileEncodingDialog : undefined,
      cycleIndentation: activeFile && !activeFile.library ? cycleActiveFileIndentation : undefined,
      cancelLspProgress: activeLspProgress?.cancellable
        ? () => cancelLspProgress(activeLspProgress)
        : undefined,
    });
  }, [
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    cycleActiveFileEol,
    cycleActiveFileIndentation,
    openFileEncodingDialog,
    toggleActiveFileBom,
    activeFile,
    openLanguageServersSettings,
    activeLspProgress,
    cancelLspProgress,
    setWorkspaceStatusActions,
    tabId,
    visible,
  ]);

  useEffect(() => {
    return () => clearWorkspaceStatus(tabId);
  }, [clearWorkspaceStatus, tabId]);
  const { gitLineChangesByFile, gitChangeByRootPath, gitHeadTextByFile, gitBlameByGroup } = useWorkspaceGitDecorations({
    roots,
    gitRoots,
    gitSnapshots,
    workspaceUi,
    editorGroups,
    openFiles,
    openFilesRef,
    intelligencePreferences,
    cursorPositions,
    workspaceInstanceId,
  });

  const openMarkdownHref = useCallback(
    (href: string) => {
      if (!activeFile || isExternalHref(href)) return false;
      const target = href.split("#", 1)[0].split("?", 1)[0];
      if (!target) return false;
      if (activeFile.ref.kind === "root") {
        const path = resolveRootMarkdownLink(activeFile.ref.path, target);
        void openFile({ kind: "root", rootId: activeFile.ref.rootId, path });
        return true;
      }
      const path = resolveLooseMarkdownLink(activeFile.ref.path, target);
      void addLooseFilePath(path);
      return true;
    },
    [activeFile, addLooseFilePath, openFile],
  );

  const revealEditorLocation = useCallback((key: string, range: LspLocation["range"]) => {
    revealNonceRef.current += 1;
    setRevealTarget({
      key,
      line: range.start.line,
      character: range.start.character,
      nonce: revealNonceRef.current,
    });
  }, []);

  /**
   * Open a language-server library source (JDK class, dependency JAR) as a
   * read-only buffer. Nothing is read from or written to disk, and the buffer is
   * not registered as a loose workspace file — it only exists while open (plus in
   * the library registry so history can reopen it).
   */
  const openLibraryBuffer = useCallback(async (
    info: LibraryBufferInfo,
    text: string,
    range: LspLocation["range"],
    options: LspLocationOpenOptions = {},
  ) => {
    if (options.isCurrent && !options.isCurrent()) return false;
    const file = makeLibraryFile(info, text);
    const ref = file.ref;
    const key = file.key;
    libraryBuffersRef.current[key] = info;
    suppressNextHistoryRecord();
    setOpenFiles((current) => ({ ...current, [key]: file }));
    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = options.groupId ?? currentUi.activeEditorGroupId;
    updateEditorGroup(groupId, (group) => {
      const alreadyOpen = group.openOrder.includes(key);
      let nextOrder = group.openOrder;
      let previewKey = group.previewKey;
      if (!alreadyOpen) {
        if (options.preview && previewKey && previewKey !== key && !group.pinnedKeys.includes(previewKey)) {
          nextOrder = nextOrder.filter((entry) => entry !== previewKey);
        }
        nextOrder = [...nextOrder, key];
      }
      if (options.preview) {
        previewKey = group.pinnedKeys.includes(key) ? null : key;
      } else if (previewKey === key) {
        previewKey = null;
      }
      return { ...group, openOrder: nextOrder, activeKey: key, previewKey };
    });
    if (groupId !== currentUi.activeEditorGroupId) activateEditorGroup(groupId);
    if (options.isCurrent && !options.isCurrent()) return false;
    revealEditorLocation(key, range);
    if (options.isCurrent && !options.isCurrent()) return false;
    const position = {
      line: range.start.line,
      character: range.start.character,
    };
    if (options.onRevealed) {
      options.onRevealed(ref, position);
    } else if (options.recordHistory !== false) {
      recordNavigationLocation(ref, position, { replaceSameFile: false });
    }
    setStatusMessage(`Opened ${file.subtitle} (read-only)`);
    return true;
  }, [
    activateEditorGroup,
    recordNavigationLocation,
    revealEditorLocation,
    setStatusMessage,
    suppressNextHistoryRecord,
    updateEditorGroup,
    workspaceInstanceId,
  ]);

  /**
   * IDEA-style on-demand "Download sources" for a decompiled library buffer:
   * ask jdtls to fetch the sources JAR, then swap the buffer's decompiled bytecode
   * for the attached source in place (keeping the same tab / caret).
   */
  const downloadLibrarySources = useCallback(async (key: string) => {
    const info = libraryBuffersRef.current[key];
    const file = openFilesRef.current[key];
    if (!info || !file?.library) return;
    if (downloadingSourcesKeys.includes(key)) return;
    setDownloadingSourcesKeys((current) => [...current, key]);
    setStatusMessage(`Downloading sources for ${info.title}…`);
    try {
      const descriptor = lspDescriptorForPath(info.originRootPath, info.originFilePath);
      const result = await lspDownloadSources(descriptor, info.uri);
      if (!openFilesRef.current[key]) return; // tab closed mid-download
      if (result.attached && !result.decompiled) {
        const nextInfo: LibraryBufferInfo = { ...info, decompiled: false };
        libraryBuffersRef.current[key] = nextInfo;
        // Preserve caret/scroll: only the text + decompiled flag change.
        setOpenFiles((current) => {
          const existing = current[key];
          if (!existing) return current;
          const rebuilt = makeLibraryFile(nextInfo, result.text);
          return { ...current, [key]: { ...rebuilt, key: existing.key } };
        });
        setStatusMessage(`Attached sources for ${info.title}`);
      } else {
        setStatusMessage(result.message ?? `No sources published for ${info.title}`);
      }
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      setDownloadingSourcesKeys((current) => current.filter((entry) => entry !== key));
    }
  }, [downloadingSourcesKeys, lspDescriptorForPath, setStatusMessage]);

  const openLspLocation = useCallback(
    createOpenLspLocation({
    rootsRef,
    suppressNextHistoryRecord,
    openFile,
    openFilesRef,
    revealEditorLocation,
    recordNavigationLocation,
    setLooseFiles,
    setStatusMessage,
    activeFile,
    lspDescriptorForFile,
    updateLspStatusForFile,
    openLibraryBuffer,
  }),
    [
      activeFile,
      lspDescriptorForFile,
      openFile,
      openLibraryBuffer,
      recordNavigationLocation,
      revealEditorLocation,
      setStatusMessage,
      suppressNextHistoryRecord,
      updateLspStatusForFile,
    ],
  );

  const fetchWorkspaceSymbols = useCallback(createFetchWorkspaceSymbols({
    activeFile,
    openFilesRef,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    updateLspStatusForFile,
  }), [
    activeFile,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    updateLspStatusForFile,
  ]);

  const openWorkspaceSymbol = useCallback(async (
    symbol: GoToSymbolItem,
    options?: { split: boolean },
  ) => {
    setSearchEverywhereOpen(false);
    let location: LspLocation;
    if (!symbol.resolved) {
      if (!symbol.resolveToken) {
        setStatusMessage(`Cannot open ${symbol.name}: the language server did not provide a source location`);
        return;
      }
      try {
        const resolved = await lspWorkspaceSymbolResolve(workspaceInstanceId, symbol.resolveToken);
        if (!resolved.resolved) {
          setStatusMessage(`Cannot open ${symbol.name}: workspace symbol resolution returned no source range`);
          return;
        }
        location = {
          uri: resolved.uri,
          path: resolved.path,
          range: resolved.selectionRange,
        };
      } catch (error) {
        setStatusMessage(`Cannot open ${symbol.name}: ${errorMessage(error)}`);
        return;
      }
    } else {
      location = {
        uri: symbol.uri,
        path: symbol.path,
        range: {
          start: { line: symbol.line, character: symbol.character },
          end: { line: symbol.line, character: symbol.character },
        },
      };
    }
    let groupId: EditorGroupId | undefined;
    if (options?.split) {
      const current = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      splitLayoutLeaf(workspaceInstanceId, current.activeEditorGroupId, "vertical");
      const next = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      if (next.activeEditorGroupId !== current.activeEditorGroupId) {
        groupId = next.activeEditorGroupId;
      }
    }
    await openLspLocation(location, { groupId, preview: !options?.split });
  }, [openLspLocation, setStatusMessage, splitLayoutLeaf, workspaceInstanceId]);

  const seSymbolsAvailable = !!(
    activeCapabilities?.workspaceSymbol
    || Object.values(lspFiles).some((state) => state.status?.capabilities?.workspaceSymbol)
  );

  const openSearchMatch = useCallback(
    (match: WorkspaceSearchMatch, options: { preview: boolean }) => {
      const absolute = replaceMatchAbsolutePath(match);
      const root = rootsRef.current.find((candidate) => candidate.id === match.rootId)
        ?? rootsRef.current.find((candidate) => relativePathWithinRoot(candidate.path, absolute) !== null);
      const path = root ? relativePathWithinRoot(root.path, absolute) : null;
      if (!root || path === null) {
        setStatusMessage(`Cannot open search result outside the workspace: ${absolute}`);
        return;
      }
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path };
      // Backend line numbers are 1-based; reveal targets follow LSP 0-based.
      // ED-IMPROVE-004: backend offsets are code points, reveal ranges are UTF-16.
      const line = Math.max(0, match.lineNumber - 1);
      revealNonceRef.current += 1;
      setRevealTarget({
        key: fileKey(ref),
        line,
        character: codePointOffsetToUtf16Offset(match.lineText, match.matchStart),
        nonce: revealNonceRef.current,
        focus: !options.preview,
      });
      void openFile(ref, { preview: options.preview });
    },
    [openFile, setStatusMessage],
  );

  // ED-PARITY-009: Structural Search session (dialog + result tool window).
  const structuralRoots = useMemo(
    () => roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
    [roots],
  );
  const structuralActiveFile = useMemo(
    () => (activeFile?.ref.kind === "root" ? { rootId: activeFile.ref.rootId, path: activeFile.ref.path } : null),
    [activeFile?.ref],
  );
  const showStructuralResults = useCallback(() => {
    setBottomDockOpen(true);
    setBottomDockTab("structural");
  }, []);
  const structuralSearch = useStructuralSearchSession({
    roots: structuralRoots,
    activeFile: structuralActiveFile,
    getBuffers: () => Object.values(openFilesRef.current).flatMap((file) => (
      file.ref.kind === "root" && !file.loading && !file.error && /\.java$/i.test(file.ref.path)
        && structuralRoots.some((root) => root.id === (file.ref.kind === "root" ? file.ref.rootId : null))
        ? [{ rootId: file.ref.rootId, path: file.ref.path, text: file.text }]
        : []
    )),
    onShowResults: showStructuralResults,
    onStatus: setStatusMessage,
  });
  const openStructuralMatch = useCallback((match: StructuralMatch, options: { preview: boolean }) => {
    const root = rootsRef.current.find((candidate) => candidate.id === match.rootId);
    if (!root) {
      setStatusMessage(`Cannot open structural result outside the workspace: ${match.path}`);
      return;
    }
    const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: match.path };
    revealNonceRef.current += 1;
    // Select the whole matched fragment, like IDEA's usage highlight.
    setRevealTarget({
      key: fileKey(ref),
      line: match.start.line,
      character: match.start.character,
      end: { line: match.end.line, character: match.end.character },
      nonce: revealNonceRef.current,
      focus: !options.preview,
    });
    void openFile(ref, { preview: options.preview });
  }, [openFile, setStatusMessage]);

  // ED-MAIN-005 / ED-REPAIR-005: read the frozen per-file preimage before the replace preview
  // can be confirmed. Validates frozen workspace instance, roots, and buffer states across
  // all async reads; aborts or fails cleanly if states change mid-read.
  const prepareReplacePreimages = useCallback(async (
    paths: readonly string[],
    options?: ReplacePrepareOptions,
  ): Promise<readonly ReplaceFilePreimage[]> => {
    return collectReplacePreimages({
      paths,
      options,
      initialWorkspaceInstanceId: workspaceInstanceId,
      getCurrentWorkspaceInstanceId: () => workspaceInstanceId,
      getCurrentRoots: () => rootsRef.current,
      getOpenFileState: (absolute) => {
        const open = Object.values(openFilesRef.current).find((file) => {
          const currentPath = absolutePathForOpenFile(file);
          return currentPath !== null && fsPathEquals(currentPath, absolute);
        });
        if (!open) return null;
        return {
          documentRevision: open.documentRevision ?? null,
          dirty: open.dirty ?? false,
          readOnly: !!open.library,
        };
      },
      readFile: (rootPath, relativePath) => workspaceReadFile(rootPath, relativePath),
      isLocked: () => workspaceResourceOperationLockedRef.current,
    });
  }, [absolutePathForOpenFile, workspaceInstanceId]);

  const structureFileRef = useRef<string | null>(null);

  const pinQuickDocumentation = useCallback((content: QuickDocContent) => {
    setPinnedDoc(content);
    setReferenceHistory(referenceInfoController.pushHistory(content));
    setPinnedDocLocked(true);
    setRightPaneTab("documentation");
    setRightPaneOpen(true);
    setQuickDocOpen(false);
  }, [
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
  ]);

  const openQuickDocumentation = useCallback(createOpenQuickDocumentation({
    activeFile,
    editorSelectionRef,
    lspDescriptorForFile,
    setStatusMessage,
    showCodeInsightNotice,
    lspSessionGeneration,
    referenceInfoController,
    workspaceInstanceId,
    lspFilesRef,
    openFilesRef,
    updateLspStatusForFile,
    setQuickDocContent,
    setReferenceHistory,
    pinnedDoc,
    pinnedDocLocked,
    setPinnedDoc,
    intelligencePreferences,
    setPinnedDocLocked,
    setRightPaneTab,
    setRightPaneOpen,
    setQuickDocOpen,
  }), [
    activeFile,
    intelligencePreferences.quickDoc.defaultTarget,
    lspDescriptorForFile,
    lspSessionGeneration,
    pinnedDoc,
    pinnedDocLocked,
    referenceInfoController,
    setPinnedDoc,
    setPinnedDocLocked,
    setQuickDocContent,
    setQuickDocOpen,
    setRightPaneOpen,
    setRightPaneTab,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Type Info: ready ONLY when a provider hands back typed
   * content (`source:"provider"`). No standard LSP channel exists today and
   * hover markdown must never be converted into a type, so the honest
   * production result is an explicit per-kind unavailable state.
   */
  const runTypeInfo = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    const serverLabel = lspFilesRef.current[file.key]?.status?.displayName ?? "this language server";
    if (!descriptor) {
      setStatusMessage(`Type Info is not provided by ${serverLabel}`);
      return;
    }
    const position = editorSelectionRef.current.start;
    const outcome = await referenceInfoController.requestTyped({
      kind: "type-info",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
      languageId: descriptor.languageId ?? "plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    }, async () => ({ state: "unavailable" as const, reason: "provider-no-type-info-channel" }));
    if (outcome.state === "ready" && outcome.payload.kind === "type-info") {
      setStatusMessage(`Type: ${outcome.payload.display}`);
    } else if (outcome.state === "unavailable") {
      setStatusMessage(outcome.reason === "legacy-context-info-not-expression-static-data"
        ? "Legacy context info is not Expression Static Data"
        : `Type Info is not provided by ${serverLabel}`);
    } else if (outcome.state === "failed") {
      setStatusMessage(outcome.message);
    }
  }, [
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 Expression Static Data: discoverable action; when jdtls/the
   * current provider exposes no static-data channel the result is an explicit
   * provider-unavailable — never local text guessing. Legacy V2 context-info
   * records migrate through migrateLegacyContextInfoRecord inside the
   * controller and surface under the same unavailable umbrella.
   */
  const runExpressionStaticData = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const descriptor = lspDescriptorForFile(file);
    const serverLabel = lspFilesRef.current[file.key]?.status?.displayName ?? "this language server";
    if (!descriptor) {
      setStatusMessage(`Expression Static Data is not provided by ${serverLabel}`);
      return;
    }
    const position = editorSelectionRef.current.start;
    const outcome = await referenceInfoController.requestTyped({
      kind: "expression-static-data",
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
      languageId: descriptor.languageId ?? "plaintext",
      position,
      documentRevision: file.documentRevision,
      providerGeneration: lspSessionGeneration(),
    }, async () => ({ state: "unavailable" as const, reason: "provider-no-static-data-channel" }));
    if (outcome.state === "ready" && outcome.payload.kind === "expression-static-data") {
      const summary = outcome.payload.facts.map((fact) => `${fact.label}: ${fact.value}`).join(" · ");
      setStatusMessage(summary);
    } else if (outcome.state === "unavailable") {
      setStatusMessage(outcome.reason === LEGACY_CONTEXT_INFO_REASON
        ? "Legacy context info records do not carry Expression Static Data"
        : `Expression Static Data is not provided by ${serverLabel}`);
    } else if (outcome.state === "failed") {
      setStatusMessage(outcome.message);
    }
  }, [
    activeFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  /**
   * §8.20.2 W1 External Documentation: enabled only from a real provider URL
   * found in the last READY quick-documentation payload (extracted, never
   * synthesized from the symbol name); https-only policy stays at the service
   * boundary inside the controller.
   */
  const externalDocTargetFromProvider = useCallback((): { url: string; title: string } | null => {
    const last = referenceInfoController.lastReady("quick-documentation");
    if (!last || last.payload.kind !== "quick-documentation") return null;
    const url = extractProviderDocLinks(last.payload.markdown)
      .find((candidate) => validateExternalDocUrl(candidate).kind === "allowed");
    if (!url) return null;
    return { url, title: quickDocContent?.title ?? last.identity.fileKey };
  }, [quickDocContent?.title, referenceInfoController]);

  const runExternalDocumentation = useCallback(async () => {
    const target = externalDocTargetFromProvider();
    const outcome = await referenceInfoController.requestTyped({
      kind: "external-documentation",
      workspaceId: workspaceInstanceId,
      fileKey: activeFile?.key ?? "",
      uri: "",
      languageId: "",
      position: editorSelectionRef.current.start,
      documentRevision: activeFile?.documentRevision ?? 0,
      providerGeneration: lspSessionGeneration(),
    }, async () => {
      if (!target) return { state: "unavailable" as const, reason: "no-provider-url" };
      return {
        state: "payload" as const,
        payload: { kind: "external-documentation" as const, url: target.url, title: target.title },
      };
    });
    if (outcome.state === "ready" && outcome.payload.kind === "external-documentation") {
      const decision = await openExternalDocumentation(outcome.payload.url);
      if (decision.kind !== "allowed") setStatusMessage("The documentation link could not be opened");
      return;
    }
    if (outcome.state === "failed") setStatusMessage(outcome.message);
  }, [
    activeFile?.documentRevision,
    activeFile?.key,
    externalDocTargetFromProvider,
    lspSessionGeneration,
    referenceInfoController,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const openReferenceSource = useCallback((content: QuickDocContent) => {
    if (!content.sourceLocation) {
      setStatusMessage("Documentation source unavailable");
      return;
    }
    void openLspLocation(content.sourceLocation);
  }, [openLspLocation, setStatusMessage]);

  const applyReferenceHistorySnapshot = useCallback((snapshot: ReferenceHistorySnapshot) => {
    setReferenceHistory(snapshot);
    if (!snapshot.content) return;
    if (quickDocOpen) setQuickDocContent(snapshot.content);
    if (pinnedDoc) setPinnedDoc(snapshot.content);
  }, [pinnedDoc, quickDocOpen, setPinnedDoc]);

  const referenceHistoryBack = useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goBack());
  }, [applyReferenceHistorySnapshot, referenceInfoController]);

  const referenceHistoryForward = useCallback(() => {
    applyReferenceHistorySnapshot(referenceInfoController.goForward());
  }, [applyReferenceHistorySnapshot, referenceInfoController]);

  const formatActiveFile = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) {
      setStatusMessage("No formattable file is open");
      return false;
    }
    const absPath = absolutePathForOpenFile(file) ?? file.languagePath;
    if (file.library || workspaceResourceOperationLockedRef.current) {
      setStatusMessage(`${absPath} is read-only and cannot be reformatted`);
      return false;
    }
    try {
      const outcome = await formatFileText(file, editorSelectionRef.current);
      if (outcome.state === "unavailable") {
        setStatusMessage(outcome.reason);
        return false;
      }
      if (outcome.state === "unchanged") {
        setStatusMessage(`${file.title} is already formatted`);
        return false;
      }
      updateFileText(file.key, outcome.text);
      setStatusMessage(`Formatted ${file.title}`);
      return true;
    } catch (error) {
      setStatusMessage(`Format failed: ${errorMessage(error)}`);
      return false;
    }
  }, [absolutePathForOpenFile, activeFile, formatFileText, setStatusMessage, updateFileText]);

  const applyLspResourceOperationUnlocked = useCallback(createApplyLspResourceOperationUnlocked({
    flushPendingEditorText,
    rootsRef,
    openFilesRef,
    saveTransactionRegistryRef,
    workspaceInstanceId,
    closeLspDocument,
    lspFilesRef,
    reconcileNavigationFileReferences,
    setExpandedDirs,
    setSelected,
    replaceWorkspaceFileState,
    setRevealTarget,
    bookmarksRef,
    looseFilesRef,
    replaceBookmarks,
    syncLspDocument,
    notifyWorkspacePathGitChanged,
  }), [
    closeLspDocument,
    flushPendingEditorText,
    notifyWorkspacePathGitChanged,
    replaceBookmarks,
    reconcileNavigationFileReferences,
    replaceWorkspaceFileState,
    setExpandedDirs,
    setSelected,
    syncLspDocument,
    workspaceInstanceId,
  ]);

  const applyLspResourceOperation = useCallback(async (
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text" }>,
  ) => {
    if (mountedRef.current) {
      flushSync(() => setWorkspaceResourceOperationLocked(true));
    }
    try {
      const result = await applyLspResourceOperationUnlocked(operation);
      const paths = operation.kind === "rename"
        ? [operation.oldPath, operation.newPath]
        : [operation.path];
      semanticIndex.invalidate(
        "resource-operation",
        paths.filter((path): path is string => !!path),
      );
      return result;
    } finally {
      if (mountedRef.current) {
        flushSync(() => setWorkspaceResourceOperationLocked(false));
      }
    }
  }, [applyLspResourceOperationUnlocked, mountedRef, semanticIndex.invalidate]);

  useEffect(() => {
    fileActionResourceOperationRef.current = applyLspResourceOperation;
    return () => {
      if (fileActionResourceOperationRef.current === applyLspResourceOperation) {
        fileActionResourceOperationRef.current = null;
      }
    };
  }, [applyLspResourceOperation]);

  const applyLspWorkspaceEditNow = useCallback(createApplyLspWorkspaceEditNow({
    captureWorkspaceEditPathSnapshots,
    captureWorkspaceEditBookmarkSnapshot,
    captureWorkspaceEditTabSnapshot,
    workspaceInstanceIdRef,
    workspaceInstanceId,
    rootsRef,
    openFilesRef,
    absolutePathForOpenFile,
    workspaceResourceOperationLockedRef,
    lspDocumentVersion,
    isLspDocumentSynced,
    replayWorkspaceRestoreRef,
    mutateOpenBuffer,
    updateFileText,
    saveOpenBufferText,
    replayWorkspaceEncodingRef,
    workspaceStyleControllerRef,
    commitClosedFilePreparedSave,
    readWorkspaceEditPathSnapshot,
    get setRefactoringPreviewModal() { return setRefactoringPreviewModal; },
    semanticIndex,
    applyLspResourceOperation,
    setStatusMessage,
    refreshTree,
    workspaceEditHistorySequenceRef,
    replayWorkspacePathSnapshotsRef,
    restoreWorkspaceBookmarkSnapshot,
    restoreWorkspaceEditTabs,
    workspaceEditHistory,
    setWorkspaceEditHistoryRevision,
  }), [
    absolutePathForOpenFile,
    applyLspResourceOperation,
    captureWorkspaceEditBookmarkSnapshot,
    captureWorkspaceEditPathSnapshots,
    captureWorkspaceEditTabSnapshot,
    commitClosedFilePreparedSave,
    formatWorkspaceEditPreview,
    isLspDocumentSynced,
    lspDocumentVersion,
    mutateOpenBuffer,
    readWorkspaceEditPathSnapshot,
    refreshTree,
    saveOpenBufferText,
    setStatusMessage,
    restoreWorkspaceEditTabs,
    restoreWorkspaceBookmarkSnapshot,
    semanticIndex.invalidate,
    semanticIndex.current,
    updateFileText,
    workspaceEditHistory,
    workspaceInstanceId,
  ]);

  replayWorkspacePathSnapshotsRef.current = async (snapshots) => {
    const currentSnapshots = await Promise.all(
      snapshots.map((snapshot) => readWorkspaceEditPathSnapshot(snapshot.path)),
    );
    if (!currentSnapshots.every(
      (snapshot): snapshot is WorkspaceEditPathSnapshot => snapshot !== null,
    )) {
      throw new Error("A workspace history path is not a regular file");
    }
    replayWorkspaceEncodingRef.current = new Map(
      snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => [
          fsPathComparisonKey(snapshot.path),
          {
            encoding: snapshot.encoding ?? "UTF-8",
            bom: snapshot.bom ?? false,
            eol: snapshot.eol,
          },
        ]),
    );
    try {
      // ED-AUDIT-008: open-buffer writes inside this replay are restores, not
      // fresh edits — the journal transaction owns their history.
      replayWorkspaceRestoreRef.current = true;
      try {
        const outcomes = await applyLspWorkspaceEditNow(
          buildWorkspacePathSnapshotEdit(currentSnapshots, snapshots),
          { recordHistory: false },
        );
        const response = workspaceEditApplyResponse(outcomes);
        if (!response.applied) {
          throw new Error(response.failureReason ?? "Workspace history replay failed");
        }
      } finally {
        replayWorkspaceRestoreRef.current = false;
      }
    } finally {
      replayWorkspaceEncodingRef.current = null;
    }
  };

  const applyLspWorkspaceEdit = useCallback((
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    pendingWorkspaceEditsRef.current += 1;
    const pending = workspaceEditQueueRef.current
      .then(() => applyLspWorkspaceEditNow(edit, options))
      .finally(() => { pendingWorkspaceEditsRef.current -= 1; });
    workspaceEditQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [applyLspWorkspaceEditNow]);

  // ED-AUDIT-014: pending refactor recovery entries are surfaced through the
  // review dialog when the workspace becomes ready. The runner is held in a
  // ref because it closes over callbacks defined above.
  const refactorRecoveryPromptRef = useRef<(
    (entry: RefactorRecoveryJournalEntryV2, ownerInstanceId: string) => Promise<void>
  ) | null>(null);
  const handledRefactorRecoveryIdsRef = useRef<Set<string>>(new Set());
  const handledRefactorRecoveryOwnerRef = useRef<string | null>(null);
  // RC-02: one-entry review dialog state (figure A). The dialog owns the
  // A→B abandon confirm inline (cancel-focused); restore's second confirm
  // reuses the global app dialog. Async work stays in this owner.
  const [refactorRecoveryReview, setRefactorRecoveryReview] = useState<{
    entry: RefactorRecoveryJournalEntryV2;
    ownerInstanceId: string;
    preconditions: RefactorRecoveryPreconditionSummary | null;
    loading: boolean;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const refactorRecoveryBusyRef = useRef<Set<string>>(new Set());
  const refactorRecoveryResolveRef = useRef<Map<string, () => void>>(new Map());
  const refactorRecoveryReviewRef = useRef<typeof refactorRecoveryReview | null>(null);
  refactorRecoveryReviewRef.current = refactorRecoveryReview;

  const closeRefactorRecoveryReview = useCallback((recoveryId: string) => {
    setRefactorRecoveryReview((current) => (
      current && current.entry.recoveryId === recoveryId ? null : current
    ));
    const resolve = refactorRecoveryResolveRef.current.get(recoveryId);
    if (resolve) {
      refactorRecoveryResolveRef.current.delete(recoveryId);
      resolve();
    }
  }, []);

  const classifyRecoveryEntry = useCallback(async (
    entry: RefactorRecoveryJournalEntryV2,
  ): Promise<RefactorRecoveryPreconditionSummary> => classifyRefactorRecoveryPreconditions(entry, async (path) => {
    const snapshot = await readWorkspaceEditPathSnapshot(path);
    return snapshot && snapshot.text !== null ? { text: snapshot.text } : null;
  }, {
    pathExists: async (path) => {
      const snapshot = await readWorkspaceEditPathSnapshot(path);
      return snapshot === null ? null : snapshot.exists;
    },
  }), [readWorkspaceEditPathSnapshot]);

  const runRecoveryRestore = useCallback(createRunRecoveryRestore({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    setRefactorRecoveryReview,
    readWorkspaceEditPathSnapshot,
    replayWorkspaceEncodingRef,
    replayWorkspaceRestoreRef,
    applyLspWorkspaceEditNow,
    restoreEchoSuppressorRef,
    applyLspResourceOperation,
    refreshTree,
    setStatusMessage,
    closeRefactorRecoveryReview,
    classifyRecoveryEntry,
  }), [applyLspResourceOperation, applyLspWorkspaceEditNow, classifyRecoveryEntry, closeRefactorRecoveryReview, readWorkspaceEditPathSnapshot, refreshTree, setStatusMessage]);

  const runRecoveryDismiss = useCallback(createRunRecoveryDismiss({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    setRefactorRecoveryReview,
    setStatusMessage,
    closeRefactorRecoveryReview,
  }), [closeRefactorRecoveryReview, setStatusMessage]);

  const keepRecoveryReview = useCallback((recoveryId: string) => {
    closeRefactorRecoveryReview(recoveryId);
  }, [closeRefactorRecoveryReview]);

  const promptRefactorRecoveryEntry = useCallback(createPromptRefactorRecoveryEntry({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    refactorRecoveryResolveRef,
    setRefactorRecoveryReview,
    classifyRecoveryEntry,
    closeRefactorRecoveryReview,
    setStatusMessage,
  }), [classifyRecoveryEntry, closeRefactorRecoveryReview, setStatusMessage]);
  refactorRecoveryPromptRef.current = promptRefactorRecoveryEntry;

  useEffect(() => {
    if (handledRefactorRecoveryOwnerRef.current !== workspaceInstanceId) {
      handledRefactorRecoveryOwnerRef.current = workspaceInstanceId;
      handledRefactorRecoveryIdsRef.current = new Set();
      // RC-02: workspace switch releases pending dialogs; stale async
      // results must never commit to the new instance.
      for (const resolve of refactorRecoveryResolveRef.current.values()) {
        try { resolve(); } catch { /* ignore */ }
      }
      refactorRecoveryResolveRef.current.clear();
      refactorRecoveryBusyRef.current.clear();
      setRefactorRecoveryReview(null);
    }
    let disposed = false;
    const discover = async () => {
      const rootPath = roots[0]?.path;
      const runner = refactorRecoveryPromptRef.current;
      if (!rootPath || !runner) return;
      const listing = listRefactorRecoveryJournalsV2(rootPath);
      const pending = listing.entries.filter(isPendingRefactorRecoveryEntry);
      for (const entry of pending) {
        if (disposed) return;
        if (workspaceInstanceIdRef.current !== workspaceInstanceId) return;
        if (handledRefactorRecoveryIdsRef.current.has(entry.recoveryId)) continue;
        handledRefactorRecoveryIdsRef.current.add(entry.recoveryId);
        await runner(entry, workspaceInstanceId);
      }
    };
    void discover();
    return () => {
      disposed = true;
    };
  }, [roots, workspaceInstanceId]);

  const workspaceEditHistoryState = useMemo(
    () => workspaceEditHistory.state(),
    [workspaceEditHistory, workspaceEditHistoryRevision],
  );

  const undoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.undo();
      if (result) {
        setStatusMessage(`Undid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot undo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  const requestWorkspaceUndoConfirmation = useCallback(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    undoConfirmTriggerRef.current = activeElement?.closest('[data-testid="code-workspace-search-everywhere"]')
      ? searchEverywhereTriggerRef.current
      : activeElement;
    setWorkspaceUndoConfirmOpen(true);
  }, []);

  const closeWorkspaceUndoConfirmation = useCallback(() => {
    setWorkspaceUndoConfirmOpen(false);
  }, []);

  const redoWorkspaceEdit = useCallback(async () => {
    try {
      const result = await workspaceEditHistory.redo();
      if (result) {
        setStatusMessage(`Redid ${result.entry.label} (${result.entry.affectedPaths.length} files)`);
      }
    } catch (error) {
      setStatusMessage(`Cannot redo workspace edit: ${errorMessage(error)}`);
    } finally {
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
  }, [setStatusMessage, workspaceEditHistory]);

  // ED-AUDIT-008: the workspace-edit journal and the per-document CodeMirror
  // ledger are two history owners over the same Ctrl+Z stroke. The newest
  // user-visible transaction wins: while the journal can serve the requested
  // direction the editor's shared undo/redo routes there; `undefined` hands
  // the stroke back to the document ledger (character-level history). A busy
  // journal blocks the stroke entirely so a document undo can never interleave
  // with a running multi-file restore.
  const claimWorkspaceHistory = useCallback((action: "undo" | "redo"): boolean | undefined => {
    if (pendingWorkspaceHistoryClaimRef.current) return false;
    if (pendingWorkspaceEditsRef.current > 0) {
      // Writes become visible before post-state verification registers their
      // history. Keep this stroke with the multi-file transaction; falling
      // through here would undo only the open document and strand disk edits.
      const sequence = workspaceEditHistorySequenceRef.current;
      pendingWorkspaceHistoryClaimRef.current = true;
      const pendingClaim = workspaceEditQueueRef.current.then(async () => {
        if (action === "undo" && workspaceEditHistorySequenceRef.current > sequence) {
          await undoWorkspaceEdit();
        }
      }).finally(() => { pendingWorkspaceHistoryClaimRef.current = false; });
      workspaceEditQueueRef.current = pendingClaim.then(() => undefined, () => undefined);
      return true;
    }
    const state = workspaceEditHistory.state();
    if (state.busy) return false;
    if (action === "undo" ? !state.canUndo : !state.canRedo) return undefined;
    if (action === "undo") void undoWorkspaceEdit();
    else void redoWorkspaceEdit();
    return true;
  }, [redoWorkspaceEdit, undoWorkspaceEdit, workspaceEditHistory]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<LspWorkspaceApplyEditRequest>("lsp://workspace-apply-edit", (event) => {
      const request = event.payload;
      if (request.workspaceId !== workspaceInstanceId) return;
      void (async () => {
        try {
          const semanticGuard = providerCommandSemanticGuardRef.current;
          const outcomes = await applyLspWorkspaceEdit(request.edit, {
            preview: true,
            label: request.label ?? "Language server changes",
            semanticGeneration: semanticGuard?.generation,
            semanticRevision: semanticGuard?.revision,
            semanticRequireReady: semanticGuard?.requireReady,
          });
          const response = workspaceEditApplyResponse(outcomes);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            response.applied,
            response.failureReason,
            response.failedChange,
          );
        } catch (error) {
          const message = errorMessage(error);
          setStatusMessage(message);
          await lspResolveWorkspaceEdit(
            request.requestId,
            workspaceInstanceId,
            false,
            message,
          ).catch(() => undefined);
        }
      })();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyLspWorkspaceEdit, setStatusMessage, workspaceInstanceId]);

  const [newJavaClassDialogState, setNewJavaClassDialogState] = useState<{
    open: boolean;
    targetDirectory: string;
    root: CodeWorkspaceRootInfo;
    dirRelPath: string;
    sourceRoots: readonly string[];
    existingFiles: readonly string[];
    projectFactsStatus: string;
    projectFactsGeneration: number;
    projectFactsFingerprint: string | null;
  } | null>(null);

  const [fileTemplateSettingsOpen, setFileTemplateSettingsOpen] = useState(false);
  const [autoImportSettingsOpen, setAutoImportSettingsOpen] = useState(false);
  const [autoImportCandidatePrompt, setAutoImportCandidatePrompt] = useState<{
    candidates: readonly AutoImportCandidate[];
    onSelect: (candidate: AutoImportCandidate) => void;
    onClose: () => void;
  } | null>(null);

  const openNewJavaClassDialog = useCallback((target?: { rootId: string; path: string }) => {
    const directory = target ?? selectedRootDirectory;
    if (!directory) {
      setStatusMessage("Add a folder before creating Java classes");
      return;
    }
    const root = findRoot(directory.rootId);
    if (!root) return;

    const targetDir = directory.path ? `${root.path}/${directory.path}` : root.path;
    const facts = useProjectFactsStore.getState().getWorkspaceFacts(root.path);
    const projectFactsStatus = facts?.status;
    const isFactsReady = facts?.status === "ready";
    const sourceRoots = isFactsReady && facts?.structure
      ? facts.structure.modules.flatMap((m) =>
          m.sourceSets
            .filter((s) => s.kind === "main" || s.kind === "test")
            .flatMap((s) => s.roots),
        )
      : [];

    const dirKey = `root:${root.id}:${directory.path}`;
    const dirEntries = directories[dirKey]?.entries ?? [];
    const existingFiles = dirEntries.map((f) => `${targetDir}/${f.name}`);

    setNewJavaClassDialogState({
      open: true,
      targetDirectory: targetDir,
      root,
      dirRelPath: directory.path,
      sourceRoots,
      existingFiles,
      projectFactsStatus,
      projectFactsGeneration: facts.generation,
      projectFactsFingerprint: facts.fingerprint,
    });
  }, [directories, findRoot, selectedRootDirectory, setStatusMessage]);

  const createJavaClassFromPlan = useCallback(createCreateJavaClassFromPlan({
    newJavaClassDialogState,
    applyLspWorkspaceEdit,
    setStatusMessage,
    loadDir,
    setSelected,
    openFile,
    notifyWorkspacePathGitChanged,
  }), [
    applyLspWorkspaceEdit,
    loadDir,
    newJavaClassDialogState,
    notifyWorkspacePathGitChanged,
    openFile,
    setSelected,
    setStatusMessage,
  ]);

  const requestCodeActions = useCallback(createRequestCodeActions({
    lspFilesRef,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    setStatusMessage,
    lspDescriptorForFile,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    updateLspStatusForFile,
    get canonicalCodeActionServiceRef() { return canonicalCodeActionServiceRef; },
  }), [
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    semanticIndex.beginBuild,
    semanticIndex.current,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  // §8.20.4 W3: ONE frozen Intention session per request, shared by Alt+Enter,
  // the gutter bulb, Problems quick fix and Search Actions. Candidates carry
  // stable ids; resolve state and disabled reasons live here, not in UI copies.
  const intentionSessionRef = useRef<IntentionSession | null>(null);
  const canonicalCodeActionServiceRef = useRef<CanonicalCodeActionService | null>(null);
  if (!canonicalCodeActionServiceRef.current) canonicalCodeActionServiceRef.current = new CanonicalCodeActionService();
  const intentionRequestAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // StrictMode replays setup after cleanup in tauri dev. A disposed session
    // cannot be reused: each setup owns a fresh session and cleans up exactly
    // that instance, including requests from a previous workspace binding.
    const session = new IntentionSession();
    intentionSessionRef.current = session;
    return () => {
      intentionRequestAbortRef.current?.abort();
      intentionRequestAbortRef.current = null;
      session.dispose();
      if (intentionSessionRef.current === session) intentionSessionRef.current = null;
    };
  }, [workspaceInstanceId]);
  // Diagnostics whose provider suppression edit applied successfully
  // ("Suppressed in source"); distinct from local hide (profile suppressions).
  const [suppressedInSourceKeys, setSuppressedInSourceKeys] = useState<Set<string>>(new Set());
  const markProviderSuppressionApplied = useCallback((action: LspCodeAction, file: OpenFileState) => {
    if (!/suppress/i.test(`${action.kind ?? ""} ${action.title}`)) return;
    const path = inspectionPathForFileKey(file.key);
    const diagnostics = lspFilesRef.current[file.key]?.diagnostics ?? [];
    setSuppressedInSourceKeys((current) => {
      const next = new Set(current);
      for (const diagnostic of diagnostics) {
        next.add(`${path}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`);
      }
      return next;
    });
    setStatusMessage("Suppressed in source by the language server");
  }, [inspectionPathForFileKey, setStatusMessage]);

  const runCodeAction = useCallback(createRunCodeAction({
    semanticIndex,
    lspDescriptorForFile,
    setStatusMessage,
    intentionSessionRef,
    lspFilesRef,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    updateLspStatusForFile,
    openFilesRef,
    canonicalCodeActionServiceRef,
    rootsRef,
    captureCodeActionTransactionSnapshot,
    restoreCodeActionTransactionSnapshot,
    applyLspWorkspaceEdit,
    get extractSessionRef() { return extractSessionRef; },
    providerCommandSemanticGuardRef,
    providerCommandQueueRef,
    workspaceEditHistory,
    setWorkspaceEditHistoryRevision,
    markProviderSuppressionApplied,
  }), [
    applyLspWorkspaceEdit,
    captureCodeActionTransactionSnapshot,
    lspCodeActionResolve,
    lspDescriptorForFile,
    markProviderSuppressionApplied,
    projectAnalysisSnapshot?.projectFingerprint,
    restoreCodeActionTransactionSnapshot,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
    workspaceEditHistory,
  ]);

  // §8.19.8 Generate Code: request provider source/generate CodeActions for
  // the caret, list exactly what came back, and apply the selection through
  // the existing runCodeAction pipeline (resolve → WorkspaceEdit/command with
  // semantic staleness guards). No local member templates exist anywhere.
  const requestGenerateCandidates = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading || file.library) {
      setStatusMessage("Generate requires an active workspace file");
      setGenerateCode((prev) => ({ ...prev, phase: "empty" }));
      return;
    }
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    setGenerateCode((prev) => ({ ...prev, open: true, phase: "loading", error: null }));
    const requested = await requestCodeActions(file, range, [], ["source"]);
    if (requested.requestFailure) {
      // Stale keeps its context-specific wording; every other failure kind
      // already surfaced its accurate message on the status line.
      generateCodeContextRef.current = null;
      setGenerateCode({
        open: true,
        phase: "error",
        candidates: [],
        error: requested.requestFailure.kind === "stale"
          ? "Generation actions became stale because the workspace changed; retry to request them again"
          : requested.requestFailure.message,
      });
      return;
    }
    const filtered = filterGenerateCodeActions(requested.actions);
    if (filtered.length === 0) {
      generateCodeContextRef.current = null;
      setGenerateCode({ open: true, phase: "empty", candidates: [], error: null });
      return;
    }
    generateCodeContextRef.current = {
      file,
      range,
      semanticToken: requested.semanticToken,
      actions: filtered.map((entry) => entry.item),
    };
    setGenerateCode({
      open: true,
      phase: "ready",
      candidates: filtered.map((entry, index) => ({
        id: String(index),
        title: entry.title,
        kind: entry.kind,
      })),
      error: null,
    });
  }, [activeFile, requestCodeActions, setStatusMessage]);

  const closeGenerateDialog = useCallback(() => {
    generateCodeContextRef.current = null;
    setGenerateCode((prev) => ({ ...prev, open: false }));
  }, []);

  const applyGenerateCandidates = useCallback(async (ids: readonly string[]) => {
    const context = generateCodeContextRef.current;
    if (!context) return;
    // Only ids that still map onto the captured provider actions.
    const selection: GenerateCandidate[] = ids.flatMap((id) => {
      const action = context.actions[Number(id)];
      return action ? [{ id, title: action.title, kind: action.kind ?? "" }] : [];
    });
    if (selection.length === 0) return;
    setGenerateCode((prev) => ({ ...prev, phase: "running", error: null }));
    const outcome = await applyGenerateSelection(selection, {
      actionFor: (candidate) => context.actions[Number(candidate.id)],
      isStale: () => !!context.semanticToken
        && !workspaceSemanticIndexTokenRevisionCurrent(semanticIndex.current(), context.semanticToken!),
      run: (action) => runCodeAction(action, context.file, context.semanticToken),
    });
    if (outcome.failedIndex != null) {
      // §8.19.8: resolve/apply failure keeps the dialog on Retry/Cancel and
      // never falls back to inserting a fixed template.
      setGenerateCode((prev) => ({
        ...prev,
        phase: "error",
        error: outcome.message ?? "Generation failed",
      }));
      return;
    }
    setStatusMessage(`Generated via ${outcome.applied} language-server action${outcome.applied === 1 ? "" : "s"}`);
    closeGenerateDialog();
  }, [closeGenerateDialog, runCodeAction, semanticIndex.current, setStatusMessage]);

  // §8.19.5 Copy Reference: workspace-relative `path:line` from real file
  // facts, plus a symbol candidate only when the provider names one via its
  // rename range. Qualified names are never synthesized — without a
  // provider channel they stay an explicit unavailable reason.
  const copyReferenceAtCursor = useCallback(createCopyReferenceAtCursor({
    activeFile,
    absolutePathForOpenFile,
    rootsRef,
    editorSelectionRef,
    setStatusMessage,
    openFilesRef,
    lspDescriptorForFile,
    editorPaneRef,
    openTreeContextMenuAt,
  }), [
    absolutePathForOpenFile,
    activeFile,
    lspDescriptorForFile,
    openTreeContextMenuAt,
    setStatusMessage,
  ]);

  const showCodeActionsMenu = useCallback(createShowCodeActionsMenu({
    intentionRequestAbortRef,
    requestCodeActions,
    showCodeInsightNotice,
    setStatusMessage,
    intentionSessionRef,
    get beginExtractSessionRef() { return beginExtractSessionRef; },
    get captureMethodSymbolsRef() { return captureMethodSymbolsRef; },
    runCodeAction,
    get continueExtractNamingRef() { return continueExtractNamingRef; },
    get finishExtractSessionRef() { return finishExtractSessionRef; },
    openTreeContextMenuAt,
  }), [
    openTreeContextMenuAt,
    requestCodeActions,
    runCodeAction,
    setStatusMessage,
  ]);

  const openRefactorActions = useCallback(async (only: string[], sectionLabel: string) => {
    const file = activeFile;
    if (!file || file.loading || file.library) return;
    const selection = editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      file,
      range,
      [],
      only,
      sectionLabel,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openCodeActionsAtCursor = useCallback(async (context?: WorkspaceCommandContext) => {
    const target = resolveEditorTarget(context);
    const file = target.file;
    if (!file || file.loading) return;
    const payload = context?.payload as {
      position?: LspPosition;
      selectionStart?: LspPosition;
      selectionEnd?: LspPosition;
      hasSelection?: boolean;
      diagnostics?: LspDiagnostic[];
      clientX?: number;
      clientY?: number;
    } | undefined;
    const selection = editorSelectionRef.current;
    const position = target.position ?? selection.start;
    const range: LspRange = payload
      ? {
          start: payload.hasSelection ? (payload.selectionStart ?? position) : position,
          end: payload.hasSelection ? (payload.selectionEnd ?? position) : position,
        }
      : {
          start: selection.start,
          end: selection.empty ? selection.start : selection.end,
        };
    const line = range.start.line;
    const diagnostics = payload?.diagnostics ?? (
      lspFilesRef.current[file.key]?.diagnostics ?? []
    ).filter((item) => item.range.start.line <= line && item.range.end.line >= line);
    // DEC-020-01: Alt+Enter with an unavailable service answers at the caret.
    const readiness = languageServiceReadiness(lspFilesRef.current[file.key] ?? null);
    if (readiness.kind !== "ready" && readiness.kind !== "idle") {
      showCodeInsightNotice(`Context actions unavailable: ${readiness.message}`, readiness.action === "configure" ? "configure" : null);
      return;
    }
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      payload?.clientX ?? (rect?.left ?? 0) + 80,
      payload?.clientY ?? (rect?.top ?? 0) + 80,
      file,
      range,
      diagnostics,
    );
  }, [resolveEditorTarget, showCodeActionsMenu]);

  const openCodeActionsForLine = useCallback(async (line: number) => {
    const file = activeFile;
    if (!file || file.loading) return;
    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? []).filter(
      (item) => item.range.start.line <= line && item.range.end.line >= line,
    );
    const range: LspRange = diagnostics[0]?.range ?? {
      start: { line, character: 0 },
      end: { line, character: 0 },
    };
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 48,
      (rect?.top ?? 0) + 48 + line * 16,
      file,
      range,
      diagnostics,
    );
  }, [activeFile, showCodeActionsMenu]);

  const openQuickFixForProblem = useCallback(async (fileKey: string, diagnostic: LspDiagnostic) => {
    const file = openFilesRef.current[fileKey];
    if (!file) return;
    const rect = editorPaneRef.current?.getBoundingClientRect();
    await showCodeActionsMenu(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 120,
      file,
      diagnostic.range,
      [diagnostic],
    );
  }, [showCodeActionsMenu]);

  const openStructurePopup = useCallback(async () => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file || file.loading) return;
    structureFileRef.current = file.key;
    setStructureSymbols([]);
    setStructureUnavailable(null);
    setStructureSyntaxOnly(false);
    setStructureLoading(true);
    setStructureOpen(true);
    // ED-PARITY-014 DEC-014-04: with no provider, Java files still get a
    // syntax-only outline from the bundled grammar, labelled as such.
    const syntaxFallback = (reason: string) => {
      const outline = /\.java$/i.test(file.title) ? javaSyntaxOutline(file.text) : [];
      if (outline.length > 0) {
        setStructureSymbols(outline);
        setStructureSyntaxOnly(true);
        setStructureUnavailable(null);
      } else {
        setStructureUnavailable(reason);
      }
    };
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      setStructureLoading(false);
      syntaxFallback("No language service for this file");
      return;
    }
    try {
      const result = await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(file, result.status);
      if (structureFileRef.current !== file.key) return;
      if (result.symbols.length === 0 && !result.status.active) {
        syntaxFallback(result.status.error ?? "Language server is not running for this file");
      } else {
        setStructureSymbols(result.symbols);
        setStructureUnavailable(null);
      }
    } catch (err) {
      if (structureFileRef.current === file.key) syntaxFallback(errorMessage(err));
    } finally {
      if (structureFileRef.current === file.key) setStructureLoading(false);
    }
  }, [activeKey, lspDescriptorForFile, updateLspStatusForFile]);

  const pickStructureSymbol = useCallback(
    (symbol: LspDocumentSymbol) => {
      setStructureOpen(false);
      const key = structureFileRef.current;
      if (key) revealEditorLocation(key, symbol.selectionRange);
    },
    [revealEditorLocation],
  );

  const pickOutlineSymbol = useCallback((symbol: LspDocumentSymbol) => {
    if (activeKey) revealEditorLocation(activeKey, symbol.selectionRange);
  }, [activeKey, revealEditorLocation]);

  const openFileByKey = useCallback(async (key: string): Promise<boolean> => {
    const existing = openFilesRef.current[key];
    if (existing) {
      if (existing.loading || existing.error) return false;
      updateEditorGroup(activeEditorGroupId, (group) => (
        group.openOrder.includes(key)
          ? { ...group, activeKey: key }
          : { ...group, openOrder: [...group.openOrder, key], activeKey: key, previewKey: group.previewKey === key ? null : group.previewKey }
      ));
      return true;
    }
    if (key.startsWith("root:")) {
      const rest = key.slice("root:".length);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const rootId = rest.slice(0, sep);
        const path = rest.slice(sep + 1);
        await openFile({ kind: "root", rootId, path });
        const opened = openFilesRef.current[key];
        return !!opened && !opened.loading && !opened.error;
      }
    }
    if (key.startsWith("loose:")) {
      const id = key.slice("loose:".length);
      const loose = looseFilesRef.current.find((item) => item.id === id);
      if (loose) {
        await openFile({ kind: "loose", id: loose.id, path: loose.path });
        const opened = openFilesRef.current[key];
        return !!opened && !opened.loading && !opened.error;
      }
    }
    return false;
  }, [activeEditorGroupId, openFile, updateEditorGroup]);

  const openTodoOrBookmark = useCallback(async (
    item: {
      fileKey: string;
      pathLabel?: string;
      line: number;
      character: number;
      state?: WorkspaceBookmark["state"];
    },
  ): Promise<boolean> => {
    if (item.state === "missing") {
      setStatusMessage(`Bookmark target is missing: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const origin = activeKey ? openFilesRef.current[activeKey] : null;
    if (origin) {
      recordNavigationLocation(origin.ref, editorSelectionRef.current.end);
    }
    if (item.fileKey !== activeKey) suppressNextHistoryRecord();
    if (!await openFileByKey(item.fileKey)) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const target = openFilesRef.current[item.fileKey];
    if (!target || target.loading || target.error) {
      setStatusMessage(`Cannot open bookmark target: ${item.pathLabel ?? item.fileKey}`);
      return false;
    }
    const position = { line: item.line, character: item.character };
    revealEditorLocation(item.fileKey, {
      start: position,
      end: position,
    });
    recordNavigationLocation(target.ref, position, { replaceSameFile: false });
    return true;
  }, [activeKey, openFileByKey, recordNavigationLocation, revealEditorLocation, setStatusMessage, suppressNextHistoryRecord]);
  const { handleActivateToolWindow, handleRestoreToolWindowLayout, jumpToLastToolWindow, hideActiveToolWindow, toggleAllToolWindows, toggleOutlinePane, toggleProjectTree, currentBottomDockHeight, handleBottomDockHeightChange, maxBottomDockHeight, handleProjectPanelResize, handleRightPanelResize } = useWorkspaceToolWindows({
    setLanguagePanelOpen,
    projectPanelRef,
    leftToolAreaOpen,
    lastProjectPanelSizeRef,
    toolWindowLayoutRef,
    rootRef,
    workspaceUi,
    bottomDockTab,
    setBottomDockHeightForTool,
    workspaceInstanceId,
    treePaneRef,
    rightPaneTabRef,
    handleReturnToEditor,
    restoreDefaultToolWindowLayout,
    setStatusMessage,
    bottomDockOpen,
    rightPaneOpen,
    rightPaneTab,
    setRightPaneTab,
    setRightPaneOpen,
    setBottomDockTab,
    setBottomDockOpen,
    rightPanelRef,
    rightToolAreaOpen,
    lastRightPanelSizeRef,
  });

  const openTodosPane = useCallback(() => {
    setBottomDockTab("todos");
    setBottomDockOpen(true);
  }, [setBottomDockOpen, setBottomDockTab]);

  const toggleTodosPane = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    if (ui.bottomDockOpen && ui.bottomDockTab === "todos") {
      setBottomDockOpen(false);
      return;
    }
    openTodosPane();
  }, [openTodosPane, setBottomDockOpen, workspaceInstanceId]);

  const toggleBookmarkAtCursor = useCallback(() => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file) {
      setStatusMessage("Open a file to toggle bookmarks");
      return;
    }
    const position = editorSelectionRef.current.end;
    const lineText = file.text.split("\n")[position.line] ?? "";
    const label = lineText.trim() || `${file.title}:${position.line + 1}`;
    const next = toggleWorkspaceBookmark(workspaceInstanceId, {
      fileKey: file.key,
      pathLabel: file.subtitle || file.path,
      line: position.line,
      character: position.character,
      label,
    }, bookmarks);
    replaceBookmarks(next);
    setStatusMessage(next.some((item) => item.fileKey === file.key && item.line === position.line)
      ? `Bookmarked line ${position.line + 1}`
      : `Removed bookmark on line ${position.line + 1}`);
    openTodosPane();
  }, [activeKey, bookmarks, openTodosPane, replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const removeBookmark = useCallback((id: string) => {
    const next = bookmarksRef.current.filter((item) => item.id !== id);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);

  const renameBookmarkGroup = useCallback((oldGroupName: string, newGroupName: string) => {
    const current = bookmarksRef.current;
    const next = renameWorkspaceBookmarkGroup(
      workspaceInstanceId,
      oldGroupName,
      newGroupName,
      current,
    );
    if (next === current) return;
    replaceBookmarks(next);
    setStatusMessage(`Renamed bookmark group to ${newGroupName.trim()}`);
  }, [replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const jumpToMnemonicBookmark = useCallback((mnemonic: string) => {
    const target = findBookmarkByMnemonic(bookmarks, mnemonic);
    if (!target) {
      setStatusMessage(`No bookmark with mnemonic '${mnemonic}' found`);
      return;
    }
    void openTodoOrBookmark(target).then((opened) => {
      if (opened) setStatusMessage(`Jumped to bookmark [${target.mnemonic}] on line ${target.line + 1}`);
    });
  }, [bookmarks, openTodoOrBookmark, setStatusMessage]);

  const setMnemonicBookmarkAtCursor = useCallback((mnemonic: string) => {
    const file = activeKey ? openFilesRef.current[activeKey] : null;
    if (!file) {
      setStatusMessage("Open a file to toggle mnemonic bookmarks");
      return;
    }
    const position = editorSelectionRef.current.end;
    const lineText = file.text.split("\n")[position.line] ?? "";
    const label = lineText.trim() || `${file.title}:${position.line + 1}`;
    const next = setMnemonicBookmark(
      workspaceInstanceId,
      {
        fileKey: file.key,
        pathLabel: file.subtitle || file.path,
        line: position.line,
        character: position.character,
        label,
        mnemonic,
      },
      bookmarks,
    );
    replaceBookmarks(next);
    const setOnLine = next.some(
      (item) => item.fileKey === file.key && item.line === position.line && item.mnemonic === mnemonic,
    );
    setStatusMessage(
      setOnLine
        ? `Set bookmark [${mnemonic}] on line ${position.line + 1}`
        : `Removed bookmark on line ${position.line + 1}`,
    );
    openTodosPane();
  }, [activeKey, bookmarks, openTodosPane, replaceBookmarks, setStatusMessage, workspaceInstanceId]);

  const chooseMnemonicBookmarkAtCursor = useCallback(async () => {
    const selected = await promptAppDialog({
      title: "Set Bookmark Mnemonic",
      label: "Mnemonic (0-9 or A-Z)",
      placeholder: "A",
      confirmLabel: "Set Bookmark",
    });
    if (selected === null) return;
    const trimmed = selected.trim();
    if (!isValidMnemonic(trimmed)) {
      setStatusMessage("Bookmark mnemonic must be exactly one letter or digit");
      return;
    }
    setMnemonicBookmarkAtCursor(normalizeMnemonic(trimmed));
  }, [setMnemonicBookmarkAtCursor, setStatusMessage]);

  const activateNavigationBar = useCallback(() => {
    setNavigationBarActiveByGroup((prev) => ({
      ...prev,
      [activeEditorGroupId]: true,
    }));
  }, [activeEditorGroupId]);

  const highlightUsagesInFile = useCallback(createHighlightUsagesInFile({
    activeFile,
    occurrenceRequestGenerationRef,
    autoHighlightRequestGenerationRef,
    cursorPositionsRef,
    activeEditorGroupId,
    lspDescriptorForFile,
    lspDocumentEpochRef,
    activeCapabilities,
    activeLspDocumentIsSynced,
    occurrenceActiveFileKeyRef,
    occurrenceActiveGroupIdRef,
    openFilesRef,
    isCurrentLspDocumentRequest,
    setStatusMessage,
    setOccurrenceSession,
    occurrenceSessionRef,
    setHighlightsByGroupNow,
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
    const session = occurrenceSessionRef.current;
    if (!session || !activeFile || session.fileKey !== activeFile.key) {
      setStatusMessage("No active occurrence highlight session");
      return;
    }
    const { session: nextSession, current } = stepOccurrence(session, direction);
    setOccurrenceSession(nextSession);
    occurrenceSessionRef.current = nextSession;
    if (current) {
      revealEditorLocation(activeFile.key, current.range);
    }
    setStatusMessage(formatOccurrenceStatus(nextSession));
  }, [activeFile, revealEditorLocation, setStatusMessage]);

  const clearHighlightUsages = useCallback(() => {
    const session = occurrenceSessionRef.current;
    autoHighlightRequestGenerationRef.current += 1;
    occurrenceRequestGenerationRef.current += 1;
    if (!session) return false;
    setOccurrenceSession(null);
    occurrenceSessionRef.current = null;
    setHighlightsByGroupNow((current) => ({
      ...current,
      [activeEditorGroupId]: [],
    }));
    setStatusMessage("Occurrence highlights cleared");
    return true;
  }, [activeEditorGroupId, setStatusMessage]);

  /** ED-PARITY-022 DEC-022-02: VCS popup Show Diff — HEAD (read-only) ↔ buffer. */
  const showGitHeadDiff = useCallback((key: string) => {
    const file = openFilesRef.current[key];
    const head = gitHeadTextByFile[key];
    if (!file || !head || typeof head.text !== "string") {
      setStatusMessage("Show Diff is unavailable: the HEAD revision of this file is not loaded");
      return;
    }
    const target = compareTargetForOpenFile(file, undefined);
    const result = createFileCompareSession(
      { title: `${file.title} (HEAD)`, text: head.text ?? "", source: "file", readOnly: true },
      compareDescriptorForOpenFile(file, "buffer", file.path, file.text, file.title),
      target,
    );
    if (!result.session) {
      setStatusMessage(result.error ?? "Show Diff is unavailable for this file");
      return;
    }
    setActiveCompareSession(result.session);
  }, [gitHeadTextByFile, setStatusMessage]);

  const compareWithClipboard = useCallback(createCompareWithClipboard({
    activeFile,
    editorSelectionRef,
    setActiveCompareSession,
  }), [activeFile]);

  const compareWithFile = useCallback(createCompareWithFile({
    activeFile,
    editorSelectionRef,
    absolutePathForOpenFile,
    setStatusMessage,
    rootsRef,
    setActiveCompareSession,
  }), [absolutePathForOpenFile, activeFile, setStatusMessage]);

  const compareWithLocalHistory = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    if (!path) {
      setStatusMessage(file.library
        ? `${file.title} is a library source with no local history`
        : "Cannot resolve path for local history");
      return;
    }
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const target = compareTargetForOpenFile(file, selection);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const rightDescriptor = compareDescriptorForOpenFile(file, "buffer", path, rightText, rightTitle);
    try {
      const entries = await historyList(path);
      const entry = entries[0];
      if (!entry) {
        setActiveCompareSession(createUnavailableCompareSession({
          source: "local-history",
          title: `Compare ${rightTitle} with Local History`,
          unavailableTitle: "Local History",
          reason: "no-history",
          message: `No local history snapshots exist for ${path}.`,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const snapshotText = await historyRead(entry.id);
      compareLocalHistorySnapshot(file.key, entry, snapshotText, { file, selection, target });
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "local-history",
        title: `Compare ${rightTitle} with Local History`,
        unavailableTitle: "Local History",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [absolutePathForOpenFile, activeFile, compareLocalHistorySnapshot, setStatusMessage]);

  const applyCompareSession = useCallback(createApplyCompareSession({
    workspaceResourceOperationLocked,
    flushPendingEditorText,
    openFilesRef,
    setStatusMessage,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    semanticIndex,
    workspaceEditHistory,
    workspaceInstanceId,
    syncLspDocument,
    setWorkspaceEditHistoryRevision,
    setActiveCompareSession,
  }), [
    absolutePathForOpenFile,
    flushPendingEditorText,
    mutateOpenBuffer,
    semanticIndex.invalidate,
    setStatusMessage,
    syncLspDocument,
    workspaceEditHistory,
    workspaceInstanceId,
    workspaceResourceOperationLocked,
  ]);

  const setRenderedDocMode = useCallback((fileKey: string, enabled: boolean) => {
    writeReaderModePreference(workspaceInstanceId, fileKey, enabled);
    setReaderModeByFile((prev) => {
      if (prev[fileKey] === enabled) return prev;
      return { ...prev, [fileKey]: enabled };
    });
  }, [workspaceInstanceId]);

  const toggleRenderedDocComments = useCallback(() => {
    const file = activeFile;
    if (!file) return;
    if (!isDocCommentRenderingSupported(activeRenderedDocLanguageId)) {
      setStatusMessage(`Rendered documentation comments not supported for ${activeRenderedDocLanguageId || "plain text"}`);
      return;
    }
    const current = readerModeByFile[file.key] ?? readReaderModePreference(workspaceInstanceId, file.key);
    const next = !current;
    setRenderedDocMode(file.key, next);
    setStatusMessage(next ? "Rendered documentation enabled (Reader Mode)" : "Rendered documentation disabled");
  }, [activeFile, activeRenderedDocLanguageId, readerModeByFile, setRenderedDocMode, setStatusMessage, workspaceInstanceId]);

  const revealRenderedDocSource = useCallback((fileKey: string) => {
    setRenderedDocMode(fileKey, false);
    if (fileKey === activeFile?.key) setStatusMessage("Rendered documentation disabled");
  }, [activeFile?.key, setRenderedDocMode, setStatusMessage]);

  const navigateDiagnostic = useCallback(createNavigateDiagnostic({
    activeFile,
    lspFilesRef,
    currentDiagnosticsForFile,
    setStatusMessage,
    diagnosticScopeForFile,
    displayDiagnosticsFor,
    inspectionPathForFileKey,
    cursorPositionsRef,
    activeEditorGroupId,
    openFile,
    openFilesRef,
    revealEditorLocation,
  }), [
    activeEditorGroupId,
    activeFile,
    currentDiagnosticsForFile,
    diagnosticScopeForFile,
    displayDiagnosticsFor,
    inspectionPathForFileKey,
    openFile,
    openFilesRef,
    revealEditorLocation,
    setStatusMessage,
  ]);

  const optimizeImports = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const wholeFileRange: LspRange = {
      start: { line: 0, character: 0 },
      end: { line: file.text.split("\n").length, character: 0 },
    };
    const requested = await requestCodeActions(
      file,
      wholeFileRange,
      [],
      ["source.organizeImports"],
    );
    if (requested.requestFailure) {
      // Stale keeps its context-specific wording; every other failure kind
      // already surfaced its accurate message on the status line.
      if (requested.requestFailure.kind === "stale") {
        setStatusMessage("Import optimization became stale because the workspace changed; request it again");
      }
      return;
    }
    if (!requested.actions.length) {
      setStatusMessage("No import optimization available from language server");
      return;
    }
    await runCodeAction(requested.actions[0], file, requested.semanticToken);
    setStatusMessage("Imports organized");
  }, [activeFile, requestCodeActions, runCodeAction, setStatusMessage]);

  /**
   * ED-IMPORT-001: Provider-backed on-the-fly auto-import.
   * Resolves unresolved symbol diagnostics against provider code actions,
   * enforces package priorities/exclusions, validates project facts generation (A3),
   * and auto-applies unambiguous imports or prompts for ambiguous candidates (A1).
   */
  const executeAutoImportOnTheFly = useCallback(createExecuteAutoImportOnTheFly({
    activeFile,
    lspFilesRef,
    projectFactsRoot,
    requestCodeActions,
    runCodeAction,
    setStatusMessage,
    setAutoImportCandidatePrompt,
  }), [activeFile, projectFactsRoot, requestCodeActions, runCodeAction, setStatusMessage]);

  /**
   * ED-IMPORT-001: Paste with auto-import resolution.
   * Scans pasted text for type tokens, resolves candidates via provider/classpath,
   * enforces independent paste preferences (A2), rejects stale generation (A3),
   * and executes paste + import statements in a single atomic transaction (A4).
   */
  const executePasteWithAutoImport = useCallback(createExecutePasteWithAutoImport({
    activeFile,
    clipboardHandle,
    executeActiveEditorCommand,
    lspFilesRef,
    projectFactsRoot,
    updateFileText,
    setStatusMessage,
    setAutoImportCandidatePrompt,
  }), [
    activeFile,
    clipboardHandle,
    executeActiveEditorCommand,
    projectFactsRoot,
    setStatusMessage,
    updateFileText,
  ]);

  // ED-IMPORT-001: Automatic on-the-fly auto-import trigger on diagnostics change
  useEffect(() => {
    if (!activeFile) return;
    const isJava = activeFile.languagePath.endsWith(".java") || lspFilesRef.current[activeFile.key]?.status?.languageId === "java";
    if (!isJava) return;
    const settings = loadAutoImportPreferences();
    if (!settings.addUnambiguousImportsOnTheFly) return;
    const diags = lspFiles[activeFile.key]?.diagnostics ?? [];
    const hasUnresolved = diags.some((d) =>
      /cannot find symbol|cannot be resolved to a type|unknown class|cannot resolve symbol/i.test(d.message)
    );
    if (!hasUnresolved) return;
    const timer = setTimeout(() => {
      void executeAutoImportOnTheFly(activeFile);
    }, 250);
    return () => clearTimeout(timer);
  }, [activeFile, executeAutoImportOnTheFly, lspFiles]);

  const [coverageReport, setCoverageReport] = useState<WorkspaceCoverageReport | null>(null);
  const [coverageOverlayEnabled, setCoverageOverlayEnabled] = useState(true);
  const [dapGuideOpen, setDapGuideOpen] = useState(false);
  const [keymapCheatSheetOpen, setKeymapCheatSheetOpen] = useState(false);

  const scanWorkspaceCoverage = useCallback(async () => {
    for (const root of rootsRef.current) {
      const candidates = [
        "coverage/lcov.info",
        "lcov.info",
        "target/site/jacoco/jacoco.xml",
        "target/site/jacoco-aggregate/jacoco.xml",
        "build/reports/jacoco/test/jacocoTestReport.xml",
        "coverage.xml",
      ];
      for (const rel of candidates) {
        try {
          const file = await workspaceReadFile(root.path, rel);
          if (file && file.text) {
            const report = parseCoverageReport(file.text);
            setCoverageReport(report);
            setStatusMessage(`Loaded test coverage (${rel}): ${report.totalPercentage}% covered`);
            return;
          }
        } catch {
          // Continue searching candidates
        }
      }
    }
    setStatusMessage("No coverage reports found (run tests with coverage enabled)");
  }, [setStatusMessage]);

  // §8.18.5 closed-tab reopen stack (session-only, max 50, never persisted).
  const [closedTabsStack, setClosedTabsStack] = useState<readonly ClosedTabEntry[]>([]);

  // ED-AUDIT-015: production execute owner for Rearrange Code. The action
  // entry below only checks that a file is open; every capability decision,
  // provider request, preview confirm, apply and postcondition check lives
  // here and in executeRearrangeTransaction, so a supported decision can
  // never again degrade to a bare status message plus `return true`.
  const runRearrangeExecute = useCallback(createRunRearrangeExecute({
    workspaceInstanceId,
    rearrangeRequestTokenRef,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    setStatusMessage,
    lspFilesRef,
    openFilesRef,
    workspaceInstanceIdRef,
    requestCodeActions,
    lspDocumentVersion,
    workspaceResourceOperationLockedRef,
    lspSessionGeneration,
    applyLspWorkspaceEdit,
    activeCapabilities,
    activeLspState,
  }), [
    absolutePathForOpenFile,
    activeCapabilities,
    activeLspState,
    applyLspWorkspaceEdit,
    lspDescriptorForFile,
    lspDocumentVersion,
    lspSessionGeneration,
    requestCodeActions,
    workspaceInstanceId,
  ]);

  // ED-AUDIT-016: production execute owner for Code Cleanup. The fake
  // success stub is gone: the file-scope default-profile branch performs a
  // real request or a real typed failure, mirroring the rearrange owner.
  const runCleanupExecute = useCallback(createRunCleanupExecute({
    workspaceInstanceId,
    cleanupRequestTokenRef,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    setStatusMessage,
    lspFilesRef,
    openFilesRef,
    workspaceInstanceIdRef,
    requestCodeActions,
    lspDocumentVersion,
    workspaceResourceOperationLockedRef,
    lspSessionGeneration,
    applyLspWorkspaceEdit,
    activeCapabilities,
    activeLspState,
  }), [
    absolutePathForOpenFile,
    activeCapabilities,
    activeLspState,
    applyLspWorkspaceEdit,
    lspDescriptorForFile,
    lspDocumentVersion,
    lspSessionGeneration,
    requestCodeActions,
    workspaceInstanceId,
  ]);

  const workspaceCommands = useMemo<WorkspaceCommand[]>(createWorkspaceCommands({
    executeEditorCommand,
    setSurroundWithDialogOpen,
    requestGenerateCandidates,
    closedTabsStack,
    workspaceUi,
    activeEditorGroupId,
    setClosedTabsStack,
    openFile,
    openFilesRef,
    setStatusMessage,
    get setKeymapSettingsOpen() { return setKeymapSettingsOpen; },
    setCodeStyleSettingsOpen,
    setFileTemplateSettingsOpen,
    setAutoImportSettingsOpen,
    executeAutoImportOnTheFly,
    executePasteWithAutoImport,
    openSearchEverywhere,
    seSymbolsAvailable,
    recentFilesOpen,
    openRecentFiles,
    recentChangedOnly,
    setRecentLocationsChangedOnly,
    setRecentLocationsOpen,
    navigateLastEditLocation,
    activeFile,
    navigateDiagnostic,
    editorSelectionRef,
    peekDefinitionRef,
    lspFilesRef,
    showCodeInsightNotice,
    setParameterInfoRequestNonce,
    setEditorAppearanceSettingsOpen,
    openTabPolicySettings,
    editorCommandStateFor,
    copyReferenceAtCursor,
    clipboardHandle,
    setClipboardHistoryEntries,
    setClipboardHistoryOpen,
    setIntelligenceSettingsOpen,
    optimizeImports,
    runRearrangeExecute,
    runCleanupExecute,
    navCan,
    navigateHistory,
    openFindInFiles,
    structuralSearch,
    openStructurePopup,
    absolutePathForOpenFile,
    activeLanguageId,
    workspaceResourceOperationLocked,
    activeCapabilities,
    formatActiveFile,
    intelligencePreferences,
    setFormatOnSave,
    openQuickDocumentation,
    runTypeInfo,
    externalDocTargetFromProvider,
    runExternalDocumentation,
    runExpressionStaticData,
    openCodeActionsAtCursor,
    resolveEditorTarget,
    goToTypeDefinitionRef,
    goToImplementationRef,
    renameSymbolRef,
    safeDeleteSymbolRef,
    openRefactorActions,
    runExtractMethodRef,
    t,
    runEditorAiActionAtCursor,
    editorAiPreferences,
    cycleAiAnswerLanguage,
    setAiAnswerLanguage,
    languagePanelOpen,
    handleActivateToolWindow,
    handleReturnToEditor,
    handleRestoreToolWindowLayout,
    jumpToLastToolWindow,
    hideActiveToolWindow,
    toggleAllToolWindows,
    openHierarchy,
    goToDeclarationRef,
    get goToDefinition() { return goToDefinition; },
    activeKey,
    findReferencesRef,
    usageSessionRef,
    setLocationPeek,
    toggleTodosPane,
    toggleBookmarkAtCursor,
    chooseMnemonicBookmarkAtCursor,
    openTodosPane,
    bookmarks,
    jumpToMnemonicBookmark,
    activateNavigationBar,
    highlightUsagesInFile,
    occurrenceSessionRef,
    navigateOccurrence,
    clearHighlightUsages,
    compareWithClipboard,
    compareWithFile,
    compareWithLocalHistory,
    activeRenderedDocLanguageId,
    toggleRenderedDocComments,
    toggleInlayHints,
    activeInlayHintsEnabled,
    toggleInlayHintsForActiveLanguage,
    activeGitRoot,
    toggleInlineBlame,
    activeFileSoftWrap,
    toggleSoftWrap,
    columnSelectionMode,
    toggleColumnSelectionMode,
    workspaceInstanceId,
    setBottomDockOpen,
    setBottomDockTab,
    terminalDockRef,
    runActiveJavaFileRef,
    roots,
    buildActiveProjectRef,
    recompileActiveFileRef,
    cursorPositionsRef,
    toggleActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    toggleTemporaryBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    debugRef,
    openEvaluateDialogRef,
    showDebugExecutionPointRef,
    runPanelRef,
    workspaceEditHistoryState,
    searchEverywhereOpen,
    requestWorkspaceUndoConfirmation,
    redoWorkspaceEdit,
    promptRefactorRecoveryEntry,
    get activeKeyRef() { return activeKeyRef; },
    saveFile,
    closeFile,
    revealEditorTabInTree,
    reloadFile,
    refreshTree,
    gitRootsLoading,
    onOpenGitManager,
    gitRoots,
    openGitManager,
    splitOrientation,
    setSyncSplitScroll,
    splitEditor,
    goToAdjacentSplit,
    moveActiveTabToAdjacentSplit,
    equalizeActiveSplitRatios,
    stretchActiveSplit,
    unsplitAllWindows,
    openLooseFile,
    addRoot,
    treeContextMenuSessionRef,
    selected,
    requestTreeOpen,
    selectedRootDirectory,
    createFile,
    createDir,
    openNewJavaClassDialog,
    renameSelected,
    deleteSelected,
    ignoreWorkspacePath,
    findInDirectory,
    copyTreePath,
    setKeymapCheatSheetOpen,
    coverageReport,
    scanWorkspaceCoverage,
    setDapGuideOpen,
  }), [
    activeCapabilities,
    activeEditorCommandState,
    activeEditorGroupId,
    activeFile,
    activeGitRoot,
    activeKey,
    activeInlayHintsEnabled,
    activeLanguageId,
    activeRenderedDocLanguageId,
    addRoot,
    bookmarks,
    closeFile,
    compareWithClipboard,
    compareWithFile,
    compareWithLocalHistory,
    chooseMnemonicBookmarkAtCursor,
    closedTabsStack,
    columnSelectionMode,
    copyTreePath,
    createDir,
    createFile,
    deleteSelected,
    editorCommandStateFor,
    equalizeActiveSplitRatios,
    executeActiveEditorCommand,
    executeEditorCommand,
    findInDirectory,
    formatActiveFile,
    gitRoots.length,
    gitRootsLoading,
    goToAdjacentSplit,
    ignoreWorkspacePath,
    intelligencePreferences.formatOnSave,
    intelligencePreferences.inlayHintsEnabled,
    intelligencePreferences.inlineBlameEnabled,
    activeFileSoftWrap,
    languagePanelOpen,
    moveActiveTabToAdjacentSplit,
    navCan.back,
    navCan.forward,
    navigateDiagnostic,
    navigateHistory,
    onOpenGitManager,
    openCodeActionsAtCursor,
    openFile,
    openFindInFiles,
    openGitManager,
    openHierarchy,
    openLooseFile,
    openQuickDocumentation,
    openRefactorActions,
    openRecentFiles,
    openSearchEverywhere,
    openStructurePopup,
    optimizeImports,
    recentFilesOpen,
    refreshTree,
    reloadFile,
    requestGenerateCandidates,
    requestWorkspaceUndoConfirmation,
    searchEverywhereOpen,
    revealEditorTabInTree,
    revealRenderedDocSource,
    readerModeByFile,
    renameSelected,
    resolveEditorTarget,
    roots.length,
    runEditorAiActionAtCursor,
    runRearrangeExecute,
    saveFile,
    scanWorkspaceCoverage,
    seSymbolsAvailable,
    selected,
    selectedRootDirectory,
    setBottomDockOpen,
    setBottomDockTab,
    setFormatOnSave,
    setClosedTabsStack,
    setStatusMessage,
    splitOrientation,
    stretchActiveSplit,
    workspaceResourceOperationLocked,
    t,
    toggleBookmarkAtCursor,
    toggleColumnSelectionMode,
    toggleInlayHints,
    toggleInlayHintsForActiveLanguage,
    toggleInlineBlame,
    toggleRenderedDocComments,
    toggleOutlinePane,
    toggleProjectTree,
    toggleSoftWrap,
    toggleTodosPane,
    jumpToMnemonicBookmark,
    jumpToLastToolWindow,
    hideActiveToolWindow,
    toggleAllToolWindows,
    undoWorkspaceEdit,
    redoWorkspaceEdit,
    unsplitAllWindows,
    workspaceEditHistoryState,
    workspaceUi.layoutTreeV2,
    coverageReport,
    occurrenceSession,
  ]);

  const commandFocusForTarget = useCallback((target: EventTarget | null): WorkspaceFocus => {
    const node = target instanceof Node ? target : null;
    if (!node) return "workspace";
    // Terminal dock marks itself with data-workspace-focus="terminal".
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest?.('[data-workspace-focus="terminal"]')) return "terminal";
    if (el?.closest?.('[data-workspace-focus="modal"]') || el?.closest?.('[role="dialog"]') || el?.closest?.('[data-testid$="-popup"]')) return "modal";
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".cm-editor")) return "modal";
    if (treePaneRef.current?.contains(node)) return "tree";
    if (editorPaneRef.current?.contains(node)) return "editor";
    return "workspace";
  }, []);

  const isSurfaceOwnedKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(
      '[data-testid="code-workspace-editor-search"], [data-testid="code-workspace-breadcrumbs"], [data-testid="code-workspace-highlighting-widget"], [data-testid="code-workspace-todos-panel"], [data-taomni-context-menu], [data-testid="code-workspace-search-everywhere"]'
      // ED-PARITY-004 S7/A3.5: the Keymap settings + Cheat Sheet surfaces own
      // their own keyboard state. Their filter/search inputs must receive
      // Ctrl+F as text instead of the workspace dispatcher opening the editor
      // find panel behind the dialog. The Keymap recorder keeps working
      // because it listens on window capture independently of this guard.
      + ', [data-testid="workspace-keymap-settings-dialog"], [data-testid="keymap-cheatsheet-dialog"], [data-testid="code-workspace-undo-confirm"]'
      // ED-PARITY-009: the Structural Search dialog owns Esc/Ctrl+Enter and text input.
      + ', [data-testid="structural-search-dialog"]'
      // ED-PARITY-017: the in-place naming session owns Esc/Enter/Shift+F6/Alt+Shift+O.
      + ', [data-testid="code-workspace-inline-rename"]'
      // Debugger popups/dialogs own their fields, Esc and Delete.
      + ', [data-testid="debug-breakpoint-popup"], [data-testid="debug-breakpoints-dialog"], [data-testid="debug-evaluate-dialog"]',
    ));
  }, []);

  const isNativeTextInputTarget = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && !element.closest(".cm-editor"),
    );
  }, []);

  const isEditorSurfaceKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(".cm-editor"));
  }, []);

  // Stable identity unless the active file actually changes, so the action
  // snapshot stays fresh on file switch without re-render feedback loops.
  const actionContextData = useMemo(() => {
    // Port state is intentionally sampled while constructing the immutable host
    // snapshot; registration and selection events bump the revision dependency.
    void editorCommandContextRevision;
    const editorState = activeEditorCommandState();
    return {
      activeFileKey: activeKey ?? undefined,
      activeFilePath: activeFile?.path,
      editorViewId: editorState ? activeEditorGroupId : undefined,
      hasActiveFile: !!editorState,
      hasSelection: editorState?.hasSelection ?? false,
      readOnly: editorState?.readOnly ?? false,
      editorComposing: editorState?.composing ?? false,
      editorCaretCount: editorState?.caretCount ?? 0,
      editorOccurrenceSessionActive: editorState?.occurrenceSessionActive ?? false,
      // The cheat sheet evaluates and runs actions in its modal context, so
      // editor-only actions show as unavailable there (ED-PARITY-005).
      ...(keymapCheatSheetOpen ? { modalOpen: true } : {}),
    };
  }, [
    activeEditorCommandState,
    activeEditorGroupId,
    activeFile?.path,
    activeKey,
    editorCommandContextRevision,
    keymapCheatSheetOpen,
  ]);

  const actionsController = useWorkspaceActionsController({
    workspaceId: workspaceInstanceId,
    commands: workspaceCommands,
    resolveFocus: commandFocusForTarget,
    getDefaultFocus: () => activeEditorCommandOwner() ? "editor" : "workspace",
    contextData: actionContextData,
    // §8.16.3 typed-result visibility: surfaced outcomes instead of silent no-ops.
    onCommandExecuted: (commandId, result) => {
      if (!result) return;
      if (result.kind === "failed") {
        setStatusMessage(`Action ${commandId} failed: ${result.message ?? "unknown error"}`);
      } else if (result.kind === "cancelled") {
        setStatusMessage(`Action ${commandId} cancelled`);
      } else if (result.kind === "no-op" && result.reason && result.reason !== "condition-not-met") {
        // §8.18.2 result sink: silent success stays quiet, but a blocked
        // no-op names its reason instead of disappearing.
        setStatusMessage(`Action ${commandId}: ${result.message ?? result.reason}`);
      }
    },
    // ED-PARITY-004 DEC-05: an ambiguous stroke used to be swallowed by all
    // three dispatchers. Name the contenders so the rejection is observable.
    onBindingConflict: (notice) => {
      setStatusMessage(
        `${notice.keybinding} is assigned to ${notice.actionIds.join(" and ")} — resolve it in Keymap Settings`,
      );
    },
  });

  const executeWorkspaceCommand = useCallback((
    commandId: string,
    context: WorkspaceCommandContext = { focus: "workspace" },
  ) => {
    return actionsController.executeCommand(commandId, context);
  }, [actionsController]);
  workspaceCommandRunnerRef.current = executeWorkspaceCommand;

  // §8.18.2 editable Keymap: per-app-profile scheme store; the active scheme
  // is applied to the live action host so every dispatcher/surface shares it.
  const keymapStore = useMemo(() => readKeymapSchemes(), []);
  const [keymapSchemes, setKeymapSchemes] = useState<KeymapSchemeV3[]>(keymapStore.schemes);
  const [activeKeymapSchemeId, setActiveKeymapSchemeId] = useState<string | null>(keymapStore.activeId);
  const [keymapSettingsOpen, setKeymapSettingsOpen] = useState(false);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  /** ED-PARITY-012 DEC-012-06: pending Go to Line:Column dialog. */
  const [goToLineRequest, setGoToLineRequest] = useState<GoToLineRequest | null>(null);
  useEffect(() => {
    if (bottomDockOpen && bottomDockTab === "git") setGitToolWindowMounted(true);
  }, [bottomDockOpen, bottomDockTab]);
  // The ⋮ menu closes on any outside press or Esc without swallowing that
  // press, so the next toolbar/editor click still reaches its target.
  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-testid="code-workspace-toolbar-more-menu"], [data-testid="code-workspace-toolbar-more"]')) return;
      setToolbarMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolbarMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [toolbarMoreOpen]);
  const workspaceWidgetHost = useCodeWorkspaceStatusStore((s) => s.widgetHost);
  const statusNavigationHost = useCodeWorkspaceStatusStore((s) => s.navigationHost);
  /** Action to record a shortcut for when the dialog opens (Assign Shortcut). */
  const [keymapAssignActionId, setKeymapAssignActionId] = useState<string | null>(null);
  const keymapCorruptDiagnostic = keymapStore.recoveredFromCorrupt
    ? "Stored keymap was corrupted; a backup was kept and defaults are active."
    : null;
  const activeKeymapScheme = useMemo(
    () => [...keymapSchemes, ...BUILTIN_KEYMAP_PRESETS].find((scheme) => scheme.id === activeKeymapSchemeId) ?? null,
    [keymapSchemes, activeKeymapSchemeId],
  );
  // ED-PARITY-013 DEC-013-06: one-time notice for profiles that used the
  // pre-IDEA defaults (F12 / Ctrl+Alt+S). Decided once at mount.
  const [keymapMigrationNoticeOpen, setKeymapMigrationNoticeOpen] = useState(
    () => consumeKeymapDefaultsMigrationNotice(),
  );

  // Stable handler identities let the memoized project tree skip the
  // per-caret-move workspace re-render.
  const projectTreeHandlers = useLatestHandlers({
    onToggleRoot: toggleRoot,
    onToggleDir: toggleDir,
    onSelect: setSelected,
    onOpenFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean }) => { void requestTreeOpen(ref, options); },
    onContextMenu: showTreeContextMenu,
    onAddFolder: () => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" }),
    onOpenLooseFile: () => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" }),
  });

  // ED-PARITY-010 DEC-010-01: IDEA tool window stripes. The bottom-dock tools
  // render their own buttons into `bottomRailHost` (same testids as before).
  const railShortcut = (actionId: string) => actionsController.host.effectiveKeybindingDisplay(actionId)[0];
  const leftToolRailItems: ToolWindowRailItem[] = [
    {
      id: "project",
      label: "Project",
      icon: <FolderTree className="h-3.5 w-3.5" />,
      active: languagePanelOpen,
      shortcut: railShortcut("workspace.toggleProjectTree"),
      onSelect: toggleProjectTree,
    },
    {
      id: "commit",
      label: "Commit",
      icon: <GitCommitHorizontal className="h-3.5 w-3.5" />,
      active: bottomDockOpen && bottomDockTab === "git",
      shortcut: railShortcut("workspace.commitToolWindow"),
      disabled: gitRoots.length === 0,
      disabledReason: "No Git repository in this workspace",
      onSelect: () => handleActivateToolWindow("git"),
    },
  ];
  // ED-PARITY-011 DEC-011-05: tab names of files with error diagnostics.
  const filesWithErrors = useMemo(() => new Set(
    Object.entries(lspFiles)
      .filter(([, state]) => state?.diagnostics?.some((diagnostic) => diagnostic.severity === 1))
      .map(([key]) => key),
  ), [lspFiles]);
  // ED-PARITY-010 DEC-010-03: IDEA empty-editor tips with the live bindings.
  const emptyEditorHints = [
    { label: "Search Everywhere", shortcut: "Double Shift" },
    { label: "Go to File", shortcut: railShortcut("workspace.goToFile") },
    { label: "Recent Files", shortcut: railShortcut("workspace.recentFiles") },
    { label: "Navigation Bar", shortcut: railShortcut("workspace.activateNavigationBar") },
    { label: "Drop files here to open them" },
  ];
  const rightToolRailItems: ToolWindowRailItem[] = [
    {
      id: "structure",
      label: "Structure",
      icon: <ListTree className="h-3.5 w-3.5" />,
      active: rightPaneOpen && rightPaneTab === "outline",
      shortcut: railShortcut("workspace.toggleDocumentationPane"),
      onSelect: toggleOutlinePane,
    },
    {
      id: "documentation",
      label: "Docs",
      icon: <BookOpen className="h-3.5 w-3.5" />,
      active: rightPaneOpen && rightPaneTab === "documentation",
      onSelect: () => {
        if (rightPaneOpen && rightPaneTab === "documentation") {
          setRightPaneOpen(false);
          return;
        }
        setRightPaneTab("documentation");
        setRightPaneOpen(true);
      },
    },
  ];

  useEffect(() => {
    writeKeymapSchemes(keymapSchemes, activeKeymapSchemeId);
  }, [keymapSchemes, activeKeymapSchemeId]);

  useEffect(() => {
    actionsController.host.setKeymapScheme(activeKeymapScheme);
  }, [actionsController.host, activeKeymapScheme]);

  // IDEA's macOS keymap binds Cmd+1..0 to tool windows; the app shell's Cmd+N
  // tab switch yields those strokes while focus is inside this workspace.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const host = actionsController.host;
    return registerShellKeyClaim(root, (event) => host.claimsSingleStroke(event));
  }, [actionsController.host, visible]);

  // §8.19.2: one workspace-root mouse dispatcher; unbound gestures (text
  // selection, editing) pass through untouched. Re-attach only when the
  // element or host instance changes.
  const mouseHostRef = useRef(actionsController.host);
  mouseHostRef.current = actionsController.host;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const attached = attachWorkspaceMouseDispatcher(mouseHostRef.current, root);
    return () => attached.dispose();
  }, [visible]);

  // ED-PARITY-004 DEC-03: the Keymap dialog's Apply is the only edge that
  // reaches this. `null` means the user deleted the active scheme and the app
  // is back on the built-in defaults.
  const applyKeymapScheme = useCallback((scheme: KeymapSchemeV3 | null) => {
    // Built-in presets ship with the app: only their id becomes active.
    if (scheme && !isBuiltinKeymapScheme(scheme.id)) {
      setKeymapSchemes((schemes) => {
        const exists = schemes.some((entry) => entry.id === scheme.id);
        return exists
          ? schemes.map((entry) => (entry.id === scheme.id ? scheme : entry))
          : [...schemes, scheme];
      });
    }
    setActiveKeymapSchemeId(scheme?.id ?? null);
  }, []);
  const { mruFileKeysRef, activeKeyRef, tabSwitcherOpen, switcherSnapshot, tabSwitcherIndex, setTabSwitcherIndex, commitTabSwitcher, setTabSwitcherOpen, setSwitcherSnapshot } = useWorkspaceKeyboard({
    activeKey,
    workspaceInstanceId,
    bottomDockOpen,
    bottomDockTab,
    workspaceUi,
    openFiles,
    editorGroups,
    setStatusMessage,
    closeFile,
    activeEditorGroupId,
    setBottomDockOpen,
    setBottomDockTab,
    openFilesRef,
    setStoreActiveEditorGroup,
    setLeafActiveTab,
    openFile,
    actionsController,
    visible,
    isSurfaceOwnedKeyEvent,
    isNativeTextInputTarget,
    isEditorSurfaceKeyEvent,
    onCommandsChange,
    activeEditorCommandOwner,
    activeEditorGroupIdRef,
  });

  const runSearchEverywhereCommand = useCallback((commandId: string) => {
    setSearchEverywhereOpen(false);
    // §8.17.3: run the SAME frozen evaluation the list rendered — a stale or
    // disabled entry must not re-evaluate itself into a fresh context.
    const entry = actionsController.snapshot.find((item) => item.id === commandId);
    if (!entry) return;
    void actionsController.host.executePrepared(entry.evaluation);
  }, [actionsController]);

  const commandRegistration = actionsController.commandRegistration;

  // W0 §8.20.1: while this instance is the active workspace tab and its
  // reopen stack is non-empty, claim Ctrl+Shift+T from the shell router so
  // the chord reopens the closed tab instead of creating a local terminal.
  // Empty stack (or inactive tab) = no claim = shell owns the chord.
  const shellShortcutClaims = useMemo((): readonly ShellShortcutClaim[] => (
    visible && closedTabsStack.length > 0
      ? [{
          ownerId: workspaceInstanceId,
          actionId: "workspace.reopenClosedTab",
          scope: "active-workspace",
          priority: 40,
          enabled: true,
          canExecute: true,
          disabledReason: null,
        }]
      : []
  ), [visible, closedTabsStack.length, workspaceInstanceId]);
  const commandRegistrationWithClaims = useMemo(
    () => (
      shellShortcutClaims.length > 0
        ? { ...commandRegistration, shellShortcutClaims }
        : commandRegistration
    ),
    [commandRegistration, shellShortcutClaims],
  );

  useLayoutEffect(() => {
    if (!onCommandsChange) return;
    onCommandsChange(tabId, commandRegistrationWithClaims);
  }, [commandRegistrationWithClaims, onCommandsChange, tabId]);

  useEffect(() => {
    if (!onCommandsChange) return;
    return () => onCommandsChange(tabId, null);
  }, [onCommandsChange, tabId]);

  // Track navigation location on tab activation / file switch (I3)
  useEffect(() => {
    if (!visible || !activeFile || activeFileLoading) return;
    const file = openFilesRef.current[activeFile.key] ?? activeFile;
    const text = file.text ?? "";
    const cursor = cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const lines = text.split("\n");
    const lineText = lines[cursor.line] ?? "";
    const startLine = Math.max(0, cursor.line - 1);
    const endLine = Math.min(lines.length, cursor.line + 2);
    const contextSnippet = lines.slice(startLine, endLine).join("\n");

    let sourceOwnership: "workspace" | "library" | "external" = "external";
    if (file.library) {
      sourceOwnership = "library";
    } else {
      const activeFilePath = file.path ?? file.title;
      const isInsideAnyRoot = rootsRef.current.some((root) => isPathContainedInRoot(activeFilePath, root.path));
      if (isInsideAnyRoot) {
        sourceOwnership = "workspace";
      }
    }

    workspaceLocationControllerRef.current.recordNavigation({
      fileKey: file.key,
      filePath: file.path ?? file.title,
      title: file.title,
      line: cursor.line,
      character: cursor.character,
      lineText,
      contextSnippet,
      reason: "tab-switch",
      sourceOwnership,
    });
  }, [activeEditorGroupId, activeFile?.key, activeFileLoading, visible]);

  // §8.16.2 completion identity: one live provider of workspace/file/session
  // identity for every completion request minted from this workspace tab.
  const completionIdentityForFile = useCallback(
    (file: OpenFileState): CompletionRequestIdentity | null => {
      const live = openFilesRef.current[file.key];
      if (!live) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      const absPath = absolutePathForOpenFile(live) ?? live.path ?? file.path;
      // ED-COMP-004: every request records its effective project scope from
      // the ready same-workspace snapshot; unready/stale/degraded/cross-root
      // facts resolve to an explicit scope-facts-missing state (document
      // fallback) instead of guessed module/project scope.
      const projectScope = resolveCompletionScopeFacts(projectFactsRoot, absPath, "module");
      return {
        workspaceId: workspaceInstanceId,
        fileKey: live.key,
        filePath: absPath,
        uri: descriptor.documentUri ?? descriptor.filePath,
        languageId: descriptor.languageId ?? live.languagePath,
        documentRevision: live.documentRevision ?? 0,
        lspSessionGeneration: lspSessionGeneration(),
        projectScope,
      };
    },
    [absolutePathForOpenFile, lspDescriptorForFile, lspSessionGeneration, projectFactsRoot, workspaceInstanceId],
  );

  const isCompletionTokenCurrent = useCallback(
    (token: CompletionRequestToken): boolean => {
      if (token.workspaceId !== workspaceInstanceId) return false;
      const live = openFilesRef.current[token.fileKey];
      if (!live) return false;
      const identity = completionIdentityForFile(live);
      return !!identity
        && identity.workspaceId === token.workspaceId
        && identity.fileKey === token.fileKey
        && identity.filePath === token.filePath
        && identity.uri === token.uri
        && identity.languageId === token.languageId
        && identity.documentRevision === token.documentRevision
        && identity.lspSessionGeneration === token.lspSessionGeneration
        && sameCompletionScopeFacts(identity.projectScope, token.projectScope);
    },
    [completionIdentityForFile, workspaceInstanceId],
  );

  const reportCompletionDiagnostic = useCallback((
    kind: CompletionAcceptanceDiagnostic,
    detail?: string,
  ) => {
    if (kind === "truncated") {
      setStatusMessage(`Completion list truncated${detail ? ` (${detail})` : ""}; keep typing to refine`);
    } else if (kind === "invalid-additional-edits") {
      setStatusMessage("Completion rejected invalid provider edits");
    } else if (kind === "identity-mismatch") {
      setStatusMessage("Completion discarded because the editor changed");
    } else {
      setStatusMessage(`Completion import unavailable${detail ? ` (${detail})` : ""}`);
    }
  }, [setStatusMessage]);

  // ED-COMP-004 A3: an explicitly invoked completion that falls back for
  // missing scope facts names its prerequisite once. Silent unless the
  // workspace actually has a project story (a discovered build system or a
  // non-idle facts entry); plain loose-file editing stays quiet.
  const reportCompletionScopeFallback = useCallback((
    state: CompletionScopeFactsState,
  ) => {
    if (state.status !== "scope-facts-missing") return;
    const discoveredCount = projectDescriptorDiscovery.discovery?.descriptors?.length ?? 0;
    const hasProjectStory = discoveredCount > 0 || projectFacts.status !== "idle";
    if (!hasProjectStory) return;
    setStatusMessage(`Completion project scope unavailable (${state.reason}); using document scope`);
  }, [projectDescriptorDiscovery.discovery, projectFacts.status, setStatusMessage]);

  const getLspCompletions = useCallback(
    async (
      file: OpenFileState,
      position: LspPosition,
      triggerCharacter: string | null,
      token: CompletionRequestToken,
      // §8.19.4 repeated-call facts; forwarded to the provider adapter.
      invocation?: CompletionInvocationRequest,
    ): Promise<LspCompletionResult | null> => {
      // Always resolve against the live buffer (openFilesRef), not the React
      // prop — typing is batched into the store and the prop is often one
      // burst behind CodeMirror. Force-flush didChange so the server sees the
      // same text the caret is in (IDEA-like: no empty popup mid-edit).
      // Bail before any wait loop when this buffer has no usable language server.
      if (!shouldLiveSyncLsp(file.languagePath, lspFilesRef.current[file.key])) return null;
      const live = await ensureLspDocumentSynced(file.key, true);
      if (!live) return null;
      if (!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      if (openFilesRef.current[live.key]?.text !== live.text) return null;
      if (!isCompletionTokenCurrent(token)) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      try {
        const result = await lspCompletion(descriptor, position, triggerCharacter, invocation);
        // Drop only when the buffer moved again while IPC was in flight; CM
        // re-queries on the next keystroke / incomplete list.
        if (!openFilesRef.current[live.key]) return null;
        if (openFilesRef.current[live.key]?.text !== live.text) return null;
        // Token identity must still match the live request origin; a stale
        // request from a switched file/restarted session is dropped here too.
        if (!isCompletionTokenCurrent(token)) return null;
        const currentLsp = lspFilesRef.current[live.key];
        if (
          !currentLsp?.status
          || currentLsp.status.active !== result.status.active
          || currentLsp.status.error !== result.status.error
        ) {
          updateLspStatusForFile(live, result.status);
        }
        return result;
      } catch {
        return null;
      }
    },
    [
      ensureLspDocumentSynced,
      isCompletionTokenCurrent,
      lspDescriptorForFile,
      updateLspStatusForFile,
    ],
  );

  const resolveLspCompletion = useCallback(
    async (
      file: OpenFileState,
      raw: unknown,
      token: CompletionRequestToken,
    ): Promise<LspCompletionResolveResult> => {
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return { kind: "unavailable", reason: "no-document-descriptor" };
      if (!isCompletionTokenCurrent(token)) return { kind: "unavailable", reason: "stale-request" };
      const resolved = await lspCompletionResolve(descriptor, raw);
      return isCompletionTokenCurrent(token) ? resolved : { kind: "unavailable", reason: "stale-request" };
    },
    [isCompletionTokenCurrent, lspDescriptorForFile],
  );

  // §8.20.2 W1 Parameter single channel: the provider adapter behind the
  // session. The controller owns identity/cancel; this closure only talks to
  // the language server through the §8.18.6 cancel bridge.
  const parameterInfoProvider = useCallback(
    createParameterInfoProvider({
    openFilesRef,
    lspFilesRef,
    ensureLspDocumentSynced,
    lspDescriptorForFile,
    workspaceInstanceId,
    lspSessionGeneration,
    updateLspStatusForFile,
  }),
    [
      ensureLspDocumentSynced,
      lspDescriptorForFile,
      lspSessionGeneration,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );

  /** Live file identity snapshot feeding the session's stale/closure checks.
   * Reads through openFilesRef: a typed edit bumps the revision synchronously
   * there, while the rendered OpenFileState can lag one flush behind. */
  const sessionContextForFile = useCallback((file: OpenFileState): ReferenceSessionContext | null => {
    const latest = openFilesRef.current[file.key] ?? file;
    if (latest.loading) return null;
    const descriptor = lspDescriptorForFile(latest);
    return {
      fileKey: latest.key,
      uri: descriptor?.documentUri
        ?? lspFilesRef.current[latest.key]?.status?.uri
        ?? descriptor?.filePath
        ?? latest.languagePath,
      languageId: descriptor?.languageId ?? "plaintext",
      documentRevision: latest.documentRevision,
      providerGeneration: lspSessionGeneration(),
    };
  }, [lspDescriptorForFile, lspSessionGeneration]);

  // File switches (and workspace remounts) close the old tooltip; per-edit
  // closure comes from the host's doc-changed/caret invalidation events.
  const activeParameterFileKey = activeFile?.key ?? null;
  useEffect(() => {
    if (!activeParameterFileKey) {
      parameterInfoSession.setContext(null);
      return;
    }
    const latest = openFilesRef.current[activeParameterFileKey];
    if (!latest) return;
    const context = sessionContextForFile(latest);
    if (context) parameterInfoSession.setContext(context);
  }, [activeParameterFileKey, parameterInfoSession, sessionContextForFile]);

  const handleParameterTrigger = useCallback((file: OpenFileState, event: {
    position: LspPosition;
    anchorOffset: number;
    triggerCharacter: string | null;
    origin: "explicit" | "typing";
  }) => {
    const context = sessionContextForFile(file);
    if (!context) return;
    // The edit that carried the trigger also bumped the identity; publishing
    // it here closes any pre-edit tooltip before the fresh query starts.
    parameterInfoSession.setContext(context);
    parameterInfoSession.request(event, (request, ticket) =>
      parameterInfoProvider(request, event.triggerCharacter, ticket));
  }, [parameterInfoProvider, parameterInfoSession, sessionContextForFile]);

  const handleParameterInvalidate = useCallback((reason: ParameterInvalidateReason) => {
    parameterInfoSession.invalidate(reason);
  }, [parameterInfoSession]);

  const handleParameterEscape = useCallback(() => parameterInfoSession.escape(), [parameterInfoSession]);

  const getLspHover = useCallback(
    createGetLspHover({
    debugRef,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    lspSessionGeneration,
    referenceInfoController,
    workspaceInstanceId,
    lspFilesRef,
    openFilesRef,
    updateLspStatusForFile,
    setLspFiles,
  }),
    [
      absolutePathForOpenFile,
      lspDescriptorForFile,
      lspSessionGeneration,
      referenceInfoController,
      updateLspStatusForFile,
      workspaceInstanceId,
    ],
  );
  getLspHoverRef.current = getLspHover;

  const navigateLocations = useCallback(async (
    title: string,
    locations: LspLocation[],
    emptyMessage: string,
    isCurrent?: () => boolean,
    origin?: { file: OpenFileState; ref: CodeWorkspaceFileRef; position: LspPosition },
  ) => {
    if (!locations.length) {
      setStatusMessage(emptyMessage);
      return false;
    }
    if (isCurrent && !isCurrent()) return false;
    if (locations.length === 1) {
      setLocationPeek(null);
      if (isCurrent && !isCurrent()) return false;
      return openLspLocation(locations[0], {
        isCurrent,
        originFile: origin?.file,
        recordHistory: !origin,
        onRevealed: origin
          ? (destinationRef, destinationPosition) => {
            // Reveal is the irreversible boundary for this navigation. Keep
            // the origin as the current entry, then add exactly one target.
            recordNavigationLocation(origin.ref, origin.position);
            recordNavigationLocation(destinationRef, destinationPosition, { replaceSameFile: false });
          }
          : undefined,
      });
    }
    if (isCurrent && !isCurrent()) return false;
    setLocationPeek({ title, locations });
    return true;
  }, [openLspLocation, recordNavigationLocation, setStatusMessage]);

  /**
   * Resolve the live buffer used by semantic location navigation. CodeMirror
   * edits are published to the language server on a short debounce, so an
   * explicit definition/declaration/type/implementation request can otherwise
   * race the pending didChange and ask jdtls to resolve a stale document.
   * Library buffers are virtual server documents and deliberately bypass this
   * barrier; their descriptor already points at the originating workspace
   * document.
   */
  const prepareSemanticNavigationRequest = useCallback(async (
    file: OpenFileState,
  ): Promise<{ file: OpenFileState; descriptor: LspDocumentDescriptor } | null> => {
    const live = openFilesRef.current[file.key] ?? file;
    if (live.library) {
      const descriptor = lspDescriptorForFile(live);
      return descriptor ? { file: live, descriptor } : null;
    }

    const lspState = lspFilesRef.current[live.key];
    if (lspState?.status?.active) {
      const synchronized = await ensureLspDocumentSynced(live.key, true);
      if (!synchronized) {
        setStatusMessage("Definition navigation requires the language server to finish synchronizing current editor buffers");
        return null;
      }
      const descriptor = lspDescriptorForFile(synchronized);
      return descriptor ? { file: synchronized, descriptor } : null;
    }

    const descriptor = lspDescriptorForFile(live);
    return descriptor ? { file: live, descriptor } : null;
  }, [ensureLspDocumentSynced, lspDescriptorForFile, setStatusMessage]);

  const goToDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const prepared = await prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      try {
        const query = beginSemanticQuery("definitions", live, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(live, result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No definition found");
          return false;
        }
        return navigateLocations(
          "Definitions",
          queryRes.items,
          "No definition found",
          query.isCurrent,
          { file: live, ref: live.ref, position },
        );
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, navigateLocations, prepareSemanticNavigationRequest, setStatusMessage, updateLspStatusForFile],
  );

  const peekDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const prepared = await prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      try {
        const query = beginSemanticQuery("definitions", live, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "definitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(live, result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No definition found");
          return false;
        }
        if (!queryRes.items.length) {
          setStatusMessage("No definition found");
          return false;
        }
        if (!query.isCurrent()) return false;
        setLocationPeek({ title: "Quick Definition", locations: queryRes.items });
        return true;
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, prepareSemanticNavigationRequest, setLocationPeek, setStatusMessage, updateLspStatusForFile],
  );

  const goToDeclaration = useCallback(
    createGoToDeclaration({
    openFilesRef,
    lspFilesRef,
    lspDescriptorForFile,
    goToDefinition,
    prepareSemanticNavigationRequest,
    setStatusMessage,
    beginSemanticQuery,
    semanticQueryHostRef,
    updateLspStatusForFile,
    navigateLocations,
  }),
    [beginSemanticQuery, goToDefinition, lspDescriptorForFile, navigateLocations, prepareSemanticNavigationRequest, setStatusMessage, updateLspStatusForFile],
  );

  const goToTypeDefinition = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const prepared = await prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      const caps = lspFilesRef.current[live.key]?.status?.capabilities;
      if (caps && !caps.typeDefinition) {
        setStatusMessage("Type definition is not supported by this language server");
        return false;
      }
      try {
        const query = beginSemanticQuery("typeDefinitions", live, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "typeDefinitions",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspTypeDefinition(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(live, result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No type definition found");
          return false;
        }
        return navigateLocations(
          "Type definitions",
          queryRes.items,
          "No type definition found",
          query.isCurrent,
          { file: live, ref: live.ref, position },
        );
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, navigateLocations, prepareSemanticNavigationRequest, setStatusMessage, updateLspStatusForFile],
  );

  const goToImplementation = useCallback(
    async (file: OpenFileState, position: LspPosition) => {
      const prepared = await prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      const caps = lspFilesRef.current[live.key]?.status?.capabilities;
      if (caps && !caps.implementation) {
        setStatusMessage("Go to implementation is not supported by this language server");
        return false;
      }
      try {
        const query = beginSemanticQuery("implementations", live, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "implementations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspImplementation(descriptor, position, query.lspOptions(signal));
            updateLspStatusForFile(live, result.status);
            return semanticLocationsFromResult(result);
          },
          guards: query.guards,
        });
        if (queryRes.status === "stale" || queryRes.status === "cancelled") {
          return false;
        }
        if (!query.isCurrent(queryRes.identity)) return false;
        if (queryRes.status === "unavailable" || queryRes.status === "error") {
          setStatusMessage(queryRes.error ?? "No implementation found");
          return false;
        }
        return navigateLocations(
          "Implementations",
          queryRes.items,
          "No implementation found",
          query.isCurrent,
          { file: live, ref: live.ref, position },
        );
      } catch (err) {
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
    [beginSemanticQuery, navigateLocations, prepareSemanticNavigationRequest, setStatusMessage, updateLspStatusForFile],
  );
  goToDefinitionRef.current = goToDefinition;
  peekDefinitionRef.current = peekDefinition;
  goToDeclarationRef.current = goToDeclaration;
  goToTypeDefinitionRef.current = goToTypeDefinition;
  goToImplementationRef.current = goToImplementation;
  const { inlineRename, refactorModalOptions, finishInlineRename, setRefactorModalOptions, handleExtractNamingTab, resolveExtractNamingPrompt, extractSessionRef, beginExtractSessionRef, continueExtractNamingRef, captureMethodSymbolsRef, finishExtractSessionRef, extractNamingPrompt } = useSymbolRefactoring({
    rootRef,
    activeEditorGroupIdRef,
    openFilesRef,
    lspDescriptorForFile,
    lspFilesRef,
    activeKey,
    semanticIndex,
    setStatusMessage,
    ensureWorkspaceSemanticDocumentsSynced,
    updateLspStatusForFile,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    rootsRef,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
    activeFile,
    editorSelectionRef,
    renameSymbolRef,
    workspaceInstanceId,
    revealNavLocation,
    intentionRequestAbortRef,
    requestCodeActions,
    editorPaneRef,
    showCodeActionsMenu,
    intentionSessionRef,
    runCodeAction,
    runExtractMethodRef,
    referencesRequestSequenceRef,
    setBottomDockOpen,
    setBottomDockTab,
    setReferencesResult,
    absolutePathForOpenFile,
    safeDeleteSymbolRef,
  });

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

  const showEditorContextMenu = useCallback(createShowEditorContextMenu({
    editorSelectionRef,
    lspFilesRef,
    activeEditorGroupIdRef,
    actionsController,
    executeEditorCommandFor,
    debugRef,
    breadcrumbSymbolsRef,
    openEditorContextMenuAt,
    t,
    editorAiPreferencesRef,
  }), [
    absolutePathForOpenFile,
    actionsController,
    editorCommandStateFor,
    executeEditorCommandFor,
    openEditorContextMenuAt,
    setStatusMessage,
    t,
  ]);

  const deferredActiveFile = activeKey ? deferredOpenFiles[activeKey] ?? activeFile : null;
  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyFiles = useMemo(
    () => openOrder.map((key) => openFiles[key]).filter((file): file is OpenFileState => !!file?.dirty),
    [openFiles, openOrder],
  );
  const problemFiles = useMemo<ProblemFileGroup[]>(
    () => openOrder.flatMap((key) => {
      const file = deferredOpenFiles[key];
      const diagnostics = lspFiles[key]?.diagnostics ?? [];
      return file && diagnostics.length > 0
        ? [{ key, title: file.title, subtitle: file.subtitle, path: inspectionPathForFileKey(key), diagnostics }]
        : [];
    }),
    [deferredOpenFiles, inspectionPathForFileKey, lspFiles, openOrder],
  );
  const { problemsScope, projectProblemFiles, problemPathToRef, setProblemsScope, rebuildProject, rebuildingProject, projectProblemsLoading } = useProjectDiagnostics({
    rootsRef,
    openFilesRef,
    looseFilesRef,
    workspaceInstanceId,
    mountedRef,
    findRoot,
    inspectionPathForFileKey,
    bottomDockOpen,
    bottomDockTab,
    lspDescriptorForPath,
    setStatusMessage,
  });

  const problemsScopeFiles = problemsScope === "project" ? projectProblemFiles : problemFiles;
  const analysisFiles = problemsScopeFiles;
  // §8.20.4 DoD: every diagnostic row shows provider/scope/revision/completeness.
  const problemEvidenceLinesByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of problemsScopeFiles) {
      const state = lspFilesRef.current[file.key];
      if (!state) continue;
      for (const wrapped of toProviderDiagnosticsV3(state.diagnostics ?? [], {
        languageId: state.status?.languageId ?? "plaintext",
        provider: { id: "jdtls", version: state.status?.displayName ?? null, generation: lspSessionGeneration() },
        projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: state.status?.uri ?? file.key,
        revision: openFilesRef.current[file.key]?.documentRevision ?? 0,
      })) {
        map.set(
          `${file.key}:${wrapped.diagnostic.message}:${wrapped.diagnostic.range.start.line}`,
          evidencePresentationLine(wrapped.evidence),
        );
      }
    }
    return map;
  }, [lspSessionGeneration, problemsScopeFiles, projectAnalysisSnapshot?.projectFingerprint]);
  const evidenceLineForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    problemEvidenceLinesByKey.get(`${fileKey}:${diagnostic.message}:${diagnostic.range.start.line}`) ?? null
  ), [problemEvidenceLinesByKey]);
  const suppressedInSourceForProblem = useCallback((fileKey: string, diagnostic: LspDiagnostic) => (
    suppressedInSourceKeys.has(
      `${inspectionPathForFileKey(fileKey)}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`,
    )
  ), [inspectionPathForFileKey, suppressedInSourceKeys]);
  const createInspectionBaselineFromScope = useCallback(() => {
    const sources = problemsScopeFiles.flatMap((file) => file.diagnostics.map((diagnostic) => ({
      diagnostic,
      path: inspectionPathForFileKey(file.key),
    })));
    persistInspectionProfile((current) => replaceInspectionBaseline(current, sources));
    setStatusMessage(`Inspection baseline replaced with ${sources.length} provider diagnostic${sources.length === 1 ? "" : "s"}`);
  }, [inspectionPathForFileKey, persistInspectionProfile, problemsScopeFiles, setStatusMessage]);
  const activeProblemCounts = useMemo(
    () => problemsScopeFiles.reduce(
      (counts, file) => {
        for (const diagnostic of file.diagnostics) {
          const display = inspectionTransform(diagnostic, file.path ?? file.subtitle);
          if (display?.severity === 1) counts.errors += 1;
          else if (display?.severity === 2) counts.warnings += 1;
        }
        return counts;
      },
      { errors: 0, warnings: 0 },
    ),
    [inspectionTransform, problemsScopeFiles],
  );

  const openProblem = useCallback(
    (fileKeyValue: string, diagnostic: LspDiagnostic) => {
      // Open-file key (open scope) → reveal in place.
      const openState = openFilesRef.current[fileKeyValue];
      if (openState) {
        revealEditorLocation(openState.key, diagnostic.range);
        void openFile(openState.ref);
        return;
      }
      // Project scope: the key is an absolute path to a (possibly unopened) file.
      const ref = problemPathToRef(fileKeyValue);
      if (!ref) return;
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), diagnostic.range));
    },
    [openFile, problemPathToRef, revealEditorLocation],
  );

  const openRelatedDiagnostic = useCallback((diagnostic: LspDiagnostic) => {
    const location = diagnostic.relatedInformation?.[0]?.location;
    if (location) void openLspLocation(location);
  }, [openLspLocation]);

  // M8 E: Java test discovery + terminal run. Discovery targets the active .java
  // file; running builds a Maven/Gradle command and reuses the terminal runner.
  const activeFileIsJava = !!activeFile
    && !activeFile.library
    && activeFile.languagePath.toLowerCase().endsWith(".java");
  const [javaRunBusy, setJavaRunBusy] = useState(false);
  const [projectBuildBusy, setProjectBuildBusy] = useState(false);
  const { activeExecutionModel, runConfigurationRevision, activeRunConfiguration, activeRunConfigurationOverride, activeDebugConfiguration, activeDebugConfigurationCatalog, activeRunConfigurations } = useExecutionTargets({
    workspaceInstanceId,
    openFilesRef,
    activeKey,
    findRoot,
    absolutePathForOpenFile,
    toolConfigRef,
    activeFileIsJava,
    setStatusMessage,
    toolConfig,
    activeFile,
    roots,
  });

  const launchWorkspaceTask = useCallback((task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
    if (runPanelRef.current) {
      runPanelRef.current.run(task, onExit);
    } else {
      runWorkspaceTask(task, onExit);
    }
  }, [runWorkspaceTask]);

  const runTaskAndWait = useCallback(async (task: WorkspaceTaskItem): Promise<void> => {
    const result = await executeTaskPlan([task], (next, onExit) => launchWorkspaceTask(next, onExit));
    if (result.exitCode !== 0) {
      throw new Error(`${result.failed?.label ?? task.label} exited with ${result.exitCode}`);
    }
  }, [launchWorkspaceTask]);

  const taskForRunConfiguration = useCallback((
    configuration: ExecutionRunConfiguration,
    root: CodeWorkspaceRootInfo,
    source: string,
  ): WorkspaceTaskItem => {
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, root.id);
    return {
      id: configuration.id,
      label: configuration.label,
      command: configuration.command.display,
      cwd: configuration.command.cwd,
      source,
      rootId: root.id,
      rootName: root.name,
      configuration: true,
      runConfiguration: configuration,
      execution: {
        executable: configuration.command.executable,
        args: configuration.command.args,
        source: configuration.command.source,
        error: configuration.command.error,
      },
      environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name, value]) => [
        name,
        { value, mode: configuration.environmentModes?.[name] ?? "replace" },
      ])),
      dependsOn: configuration.preLaunchTargets,
      buildTargets: activeExecutionModel?.buildTargets,
      configurationCatalog: activeExecutionModel
        ? materializeRunConfigurations(activeExecutionModel.runConfigurations, overrides)
        : undefined,
    };
  }, [activeExecutionModel, runConfigurationRevision, workspaceInstanceId]);

  const executeBeforeLaunch = useCallback(async (
    targetIds: readonly string[],
    targets: readonly ExecutionBuildTarget[],
    root: CodeWorkspaceRootInfo,
  ): Promise<void> => {
    if (targetIds.length === 0) return;
    const plan = resolveBuildTargetPlan(targetIds, targets);
    const tasks = plan.map((target): WorkspaceTaskItem => ({
      id: target.id,
      label: target.label,
      command: target.command.display,
      cwd: target.command.cwd,
      source: "Before launch",
      rootId: root.id,
      rootName: root.name,
      execution: {
        executable: target.command.executable,
        args: target.command.args,
        source: target.command.source,
        error: target.command.error,
      },
      environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
        name,
        { value, mode: "replace" as const },
      ])),
    }));
    const result = await executeTaskPlan(tasks, (task, onExit) => runWorkspaceTask(task, onExit));
    if (result.exitCode !== 0) {
      throw new Error(`Before launch failed: ${result.failed?.label ?? "build target"} exited with ${result.exitCode}`);
    }
  }, [runWorkspaceTask]);

  const readEnvironmentFile = useCallback(async (
    cwd: string,
    envFile: string | undefined,
  ): Promise<Record<string, string>> => {
    if (!envFile?.trim()) return {};
    const path = resolveEnvironmentFilePath(cwd, envFile);
    const file = await workspaceReadLooseFile(path, 1024 * 1024);
    return parseDotEnv(file.text);
  }, []);

  /** Compatibility fallback for a Java source file without a structured provider configuration. */
  const runActiveJavaFile = useCallback(() => {
    if (javaRunBusy) return;
    void (async () => {
      const file = openFilesRef.current[activeKey ?? ""];
      if (!file || file.ref.kind !== "root" || file.library) return;
      const root = findRoot(file.ref.rootId);
      if (!root) return;
      setJavaRunBusy(true);
      try {
        // Java launch discovery intentionally reads the on-disk source so a
        // dirty new main method must be persisted before resolving it.
        if (file.dirty) {
          await saveOpenBufferText(file.key, file.text);
        }
        const detected = javaRunTargetToExecutionRunConfiguration(
          await workspaceJavaRunTarget(root.path, file.ref.path, toolConfigRef.current),
        );
        const override = readRunConfigurationOverrides(workspaceInstanceId, root.id)[detected.id];
        const configuration = applyRunConfigurationOverride(detected, override);
        const task = taskForRunConfiguration(configuration, root, "Java · compatibility");
        await runTaskAndWait(task);
        setStatusMessage(`Running ${configuration.label}`);
      } catch (error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  }, [
    activeKey,
    findRoot,
    javaRunBusy,
    runTaskAndWait,
    saveOpenBufferText,
    taskForRunConfiguration,
    workspaceInstanceId,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  const runActiveTarget = useCallback(() => {
    if (activeRunConfiguration?.kind === "debug-only" || activeRunConfiguration?.command.error) {
      setStatusMessage(
        activeRunConfiguration.command.error
          ?? `${activeRunConfiguration.label} cannot be started with Run`,
      );
      return;
    }
    if (activeFileIsJava && !activeRunConfiguration) {
      runActiveJavaFile();
      return;
    }
    if (javaRunBusy || !activeRunConfiguration) return;
    void (async () => {
      const file = openFilesRef.current[activeKey ?? ""];
      if (!file || file.ref.kind !== "root" || file.library) return;
      const root = findRoot(file.ref.rootId);
      if (!root) return;
      setJavaRunBusy(true);
      try {
        if (file.dirty) await saveOpenBufferText(file.key, file.text);
        const project = activeExecutionModel?.projects.find((item) => item.id === activeRunConfiguration.projectId);
        await runTaskAndWait(taskForRunConfiguration(
          activeRunConfiguration,
          root,
          project ? `${project.languages.join("/")} · ${project.provider}` : "Run configuration",
        ));
        setStatusMessage(`Running ${activeRunConfiguration.label}`);
      } catch (error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  }, [
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    activeRunConfiguration,
    findRoot,
    javaRunBusy,
    runActiveJavaFile,
    runTaskAndWait,
    taskForRunConfiguration,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+F9: compile the active root using its real build tool. */
  const buildActiveProject = useCallback(createBuildActiveProject({
    projectBuildBusy,
    openFilesRef,
    activeKey,
    findRoot,
    rootsRef,
    setProjectBuildBusy,
    absolutePathForOpenFile,
    toolConfigRef,
    launchWorkspaceTask,
    setStatusMessage,
    setBottomDockTab,
    setBottomDockOpen,
    runTaskAndWait,
  }), [
    activeKey,
    absolutePathForOpenFile,
    findRoot,
    launchWorkspaceTask,
    projectBuildBusy,
    runTaskAndWait,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+Shift+F9: Recompile active file (save if dirty, then compile target). */
  const recompileActiveFile = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.library) return;
    if (file.dirty) {
      await saveFile();
    }
    await buildActiveProject(false);
  }, [activeKey, saveFile, buildActiveProject]);

  runActiveJavaFileRef.current = runActiveTarget;
  buildActiveProjectRef.current = buildActiveProject;
  recompileActiveFileRef.current = recompileActiveFile;
  const { discoverActiveJavaTests, runJavaTest, rerunStructuredTest, loadActiveJavaTestResults, openStructuredTestFailure, debugJavaTest, javaTestBuildTool, testResultsByRoot } = useWorkspaceTests({
    openFilesRef,
    activeKey,
    lspDescriptorForFile,
    findRoot,
    mountedRef,
    workspaceInstanceId,
    bottomDockOpen,
    bottomDockTab,
    activeFileIsJava,
    activeFile,
    toolConfigRef,
    runWorkspaceTask,
    setStatusMessage,
    problemPathToRef,
    openFile,
    revealEditorLocation,
    absolutePathForOpenFile,
    setBottomDockTab,
    setBottomDockOpen,
    get prepareJavaLaunchRef() { return prepareJavaLaunchRef; },
    debugRef,
  });

  // M9: debug session (breakpoints, stepping, variables, watch, console).
  const debug = useCodeDebugSession(workspaceInstanceId);
  // Ref so callbacks declared above the hook (debug-test, commands) can reach it.
  debugRef.current = debug;
  // Ref so debug-test (declared above prepareJavaLaunch) can reach the pre-launch
  // save+build gate without a forward reference.
  const prepareJavaLaunchRef = useRef<
    (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>
  >(() => Promise.resolve(true));
  const { debugSessionActive, openBreakpointPopup, setBreakpointPopup, setGutterMenu, debugRunToCursorLine, debugStoppedHere, editingBreakpoint, setEditingBreakpoint, setBreakpointsDialog, activeFileAbsPath, breakpointPopup, gutterMenu, breakpointsDialog, evaluateDialog, setEvaluateDialog } = useBreakpointControls({
    activeFile,
    absolutePathForOpenFile,
    debug,
    rootRef,
    toggleActiveBreakpointRef,
    editActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    addActiveBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    toggleTemporaryBreakpointRef,
    openEvaluateDialogRef,
    editorSelectionRef,
  });

  /**
   * Make-before-launch (Phase 3): save every dirty Java / build file in the
   * project, wait for the jdtls build barrier, then block the launch when the
   * compiler itself reports errors (`failed` / `withError`) — so the debuggee
   * never runs stale bytecode and source lines match the loaded classes.
   * Returns true when it is safe to launch. jdtls / build being unavailable is
   * NOT a block here (the DAP path surfaces those), and a clean build launches
   * even if stale or foreign-language diagnostics sit in the workspace store:
   * published diagnostics are not a compiler verdict, and sweeping them all
   * used to hijack the bottom dock onto Problems for projects that compile.
   */
  const prepareJavaLaunch = useCallback(createPrepareJavaLaunch({
    findRoot,
    openFilesRef,
    saveOpenBufferText,
    setStatusMessage,
    debug,
    lspDescriptorForPath,
    setProblemsScope,
    setBottomDockTab,
    setBottomDockOpen,
    mountedRef,
  }), [
    debug, findRoot, saveOpenBufferText, saveLspDocument, lspDescriptorForPath,
    setBottomDockOpen, setBottomDockTab, setProblemsScope, setStatusMessage,
  ]);
  prepareJavaLaunchRef.current = prepareJavaLaunch;

  /** Pending main-class choice when the active file resolves to several mains. */
  const [javaMainCandidates, setJavaMainCandidates] = useState<{
    candidates: JavaMainClassOption[];
    launch: Record<string, unknown>;
    override?: ReturnType<typeof readRunConfigurationOverrides>[string];
    environment: Record<string, string>;
    runtimeOptions: string[];
  } | null>(null);

  /** Interactive refactoring usages preview modal state. */
  const [refactoringPreviewModal, setRefactoringPreviewModal] = useState<{
    title: string;
    preview: WorkspaceEditPreview;
    originalEdit: LspWorkspaceEdit;
    plan?: RefactorPlanV3;
    sourceTexts?: Record<string, string | null>;
    resolve: (filtered: LspWorkspaceEdit | boolean) => void;
  } | null>(null);

  /** Start a Java debug session, optionally pinned to an explicit main class. */
  const launchJavaDebug = useCallback(
    (
      launch: Record<string, unknown>,
      main?: JavaMainClassOption,
      override = activeRunConfigurationOverride,
      environment: Record<string, string> = {},
      runtimeOptions: readonly string[] = activeRunConfiguration?.runtimeOptions ?? [],
    ) => {
      const config = main
        ? { ...launch, mainClass: main.mainClass, projectName: main.projectName }
        : launch;
      const configured = applyRunOverrideToJavaLaunch(config, override, environment, runtimeOptions);
      if (buildRunTools.stepFilters?.enabled) {
        configured.stepFilters = {
          classNameFilters: buildRunTools.stepFilters.patterns,
          skipSynthetics: buildRunTools.stepFilters.skipSynthetics,
          skipStaticInitializers: buildRunTools.stepFilters.skipStaticInitializers,
          skipConstructors: buildRunTools.stepFilters.skipConstructors,
        };
      }
      if (main) {
        // Resolving the classpath + asking java-debug for a port is another
        // multi-second server round trip: name the target so the panel is not
        // blank while it runs.
        debug.reportStartupProgress(`Launching ${main.mainClass}…`);
      }
      void debug.startDebug(configured).catch((err) => setStatusMessage(errorMessage(err)));
    },
    [activeRunConfiguration, activeRunConfigurationOverride, buildRunTools.stepFilters, debug, setStatusMessage],
  );

  /** Build a Java launch config for the active file and start debugging. */
  const startDebugActiveFile = useCallback(createStartDebugActiveFile({
    openFilesRef,
    activeKey,
    findRoot,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    workspaceInstanceId,
    setBottomDockTab,
    setBottomDockOpen,
    debug,
    saveOpenBufferText,
    executeBeforeLaunch,
    activeRunConfiguration,
    activeExecutionModel,
    setStatusMessage,
    prepareJavaLaunch,
    mountedRef,
    readEnvironmentFile,
    setJavaMainCandidates,
    activeRunConfigurationOverride,
    launchJavaDebug,
  }), [
    activeExecutionModel,
    activeKey,
    activeRunConfiguration,
    activeRunConfigurationOverride,
    debug,
    executeBeforeLaunch,
    findRoot,
    lspDescriptorForFile,
    absolutePathForOpenFile,
    launchJavaDebug,
    prepareJavaLaunch,
    readEnvironmentFile,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    workspaceInstanceId,
  ]);


  const startDebugActiveTarget = useCallback(createStartDebugActiveTarget({
    activeFileIsJava,
    activeRunConfiguration,
    activeDebugConfiguration,
    startDebugActiveFile,
    setStatusMessage,
    openFilesRef,
    activeKey,
    setBottomDockTab,
    setBottomDockOpen,
    debug,
    saveOpenBufferText,
    findRoot,
    activeDebugConfigurationCatalog,
    activeExecutionModel,
    roots,
    readEnvironmentFile,
    executeBeforeLaunch,
  }), [
    activeDebugConfiguration,
    activeDebugConfigurationCatalog,
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    debug,
    executeBeforeLaunch,
    findRoot,
    readEnvironmentFile,
    roots,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    startDebugActiveFile,
  ]);

  // ED-PARITY-022 DEC-022-03: run gutter ▶ only where a detected run
  // configuration of this very file exists (no facts → no icon).
  const runGutterKey = useMemo(() => {
    if (!activeFile || !activeFileIsJava || !activeRunConfiguration?.sourceFile) return "";
    const absolute = absolutePathForOpenFile(activeFile);
    if (!absolute || !fsPathEquals(normalizeFsPath(activeRunConfiguration.sourceFile), normalizeFsPath(absolute))) return "";
    const { classLine, mainLine } = javaMainRunLines(activeFile.text);
    if (mainLine === null) return "";
    return JSON.stringify({
      label: activeRunConfiguration.label,
      lines: classLine !== null && classLine !== mainLine ? [classLine, mainLine] : [mainLine],
    });
  }, [absolutePathForOpenFile, activeFile, activeFileIsJava, activeRunConfiguration]);
  const activeRunGutterTargets = useMemo<RunGutterTarget[]>(() => {
    if (!runGutterKey) return [];
    const parsed = JSON.parse(runGutterKey) as { label: string; lines: number[] };
    return parsed.lines.map((line) => ({ line, label: parsed.label }));
  }, [runGutterKey]);
  const handleRunGutterClick = useCallback((target: RunGutterTarget, anchor: { x: number; y: number }) => {
    openEditorContextMenuAt(anchor.x, anchor.y, [
      {
        label: `Run '${target.label}'`,
        testId: "code-workspace-run-gutter-run",
        shortcut: "Ctrl+Shift+F10",
        onClick: () => { void runActiveJavaFileRef.current(); },
      },
      {
        label: `Debug '${target.label}'`,
        testId: "code-workspace-run-gutter-debug",
        onClick: () => startDebugActiveTarget(),
      },
    ]);
  }, [openEditorContextMenuAt, startDebugActiveTarget]);

  /**
   * Attach to a JVM already running with `-agentlib:jdwp=...,server=y,address=…`
   * (IDEA's "Remote JVM Debug"). The active file still selects the jdtls session
   * so breakpoints resolve against this project's sources.
   */
  const attachRemoteDebug = useCallback(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) return;
    const descriptor = lspDescriptorForFile(file);
    void (async () => {
      const target = await promptAppDialog({
        title: "Attach to remote JVM",
        label: "Debug address — host:port, or just the port for localhost",
        initialValue: "localhost:5005",
      });
      if (target === null) return;
      const trimmed = target.trim();
      if (!trimmed) return;
      const [hostPart, portPart] = trimmed.includes(":")
        ? [trimmed.slice(0, trimmed.lastIndexOf(":")), trimmed.slice(trimmed.lastIndexOf(":") + 1)]
        : ["localhost", trimmed];
      const port = Number.parseInt(portPart, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        setStatusMessage(`Not a valid debug address: ${trimmed}`);
        return;
      }
      try {
        await debug.startDebug({
          workspaceId: descriptor?.workspaceId ?? workspaceInstanceId,
          rootPath: root.path,
          filePath: absolute,
          request: "attach",
          hostName: hostPart || "localhost",
          port,
          serverCommandId: descriptor?.serverCommandId ?? null,
          customServerCommand: descriptor?.customServerCommand ?? null,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [
    activeKey, debug, findRoot, lspDescriptorForFile, absolutePathForOpenFile,
    setBottomDockOpen, setBottomDockTab, setStatusMessage, workspaceInstanceId,
  ]);

  const openDebugFrame = useCallback((
    frame: Pick<DebugStackFrame, "path" | "line"> & Partial<Pick<DebugStackFrame, "sourceReference" | "sourceName" | "name">> & { column?: number },
  ) => {
    // D11.1: line/column arrive 1-based; convert to 0-based exactly once here
    const line0 = frame.line - 1;
    const char0 = (frame.column ?? 1) - 1;
    const range = { start: { line: line0, character: char0 }, end: { line: line0, character: char0 } };
    const ref = frame.path ? problemPathToRef(frame.path) : null;
    if (ref) {
      void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
      return;
    }
    // Outside the workspace (JDK / a dependency JAR): ask the adapter for the
    // attached or decompiled source and show it read-only, like IDEA does.
    const sourceReference = frame.sourceReference ?? 0;
    if (sourceReference <= 0) return;
    const origin = openFilesRef.current[activeKey ?? ""]
      ?? Object.values(openFilesRef.current).find((item) => !item.loading)
      ?? null;
    const descriptor = origin ? lspDescriptorForFile(origin) : null;
    if (!descriptor) return;
    void (async () => {
      const text = await debugRef.current?.fetchSource(sourceReference);
      if (!text) {
        setStatusMessage("No source available for this frame");
        return;
      }
      const title = frame.sourceName ?? `${frame.name ?? "frame"}.java`;
      await openLibraryBuffer(
        {
          uri: `dap-source:${sourceReference}/${title}`,
          title,
          container: frame.name ?? null,
          languageId: "java",
          originRootPath: descriptor.rootPath ?? null,
          originFilePath: descriptor.filePath,
          decompiled: true,
        },
        text,
        range,
      );
    })();
  }, [
    activeKey, lspDescriptorForFile, openFile, openLibraryBuffer, problemPathToRef,
    revealEditorLocation, setStatusMessage,
  ]);

  // IDEA-style: jump to the stopped location (breakpoint hit / step landing)
  // automatically, once per distinct location.
  const debugRevealRef = useRef<string | null>(null);
  useEffect(() => {
    const loc = debug.currentLocation;
    if (!loc || debug.state?.status !== "stopped") {
      debugRevealRef.current = null;
      return;
    }
    const key = `${loc.path}:${loc.line}`;
    if (debugRevealRef.current === key) return;
    debugRevealRef.current = key;
    openDebugFrame({ path: loc.path, line: loc.line });
  }, [debug.currentLocation, debug.state?.status, openDebugFrame]);
  showDebugExecutionPointRef.current = () => {
    const state = debug.state;
    const frame = state?.frames.find((candidate) => candidate.id === state.selectedFrameId) ?? state?.frames[0];
    if (frame && (frame.path || frame.sourceReference > 0)) openDebugFrame(frame);
  };

  // Real Java debugging drives the DAP kernel over Tauri IPC, which the browser
  // dev-preview stubs cannot provide (there is no JVM / java-debug adapter). Gate
  // the debug entry points on the desktop runtime so preview shows a clear reason
  // instead of crashing on an undefined `dap_start_session` result. Plain Java Run
  // uses the PTY and stays available, so it is deliberately not gated here.
  const debugRuntimeAvailable = isTauriRuntime();
  const activeFileJavaRoot = !!activeFileIsJava && !!activeFile && activeFile.ref.kind === "root";
  const activeFileRunnable = activeRunConfiguration
    ? activeRunConfiguration.kind !== "debug-only" && !activeRunConfiguration.command.error
    : activeFileJavaRoot && activeExecutionModel !== null;
  const activeFileDebuggable = debugRuntimeAvailable && (
    activeDebugConfiguration
      ? activeDebugConfiguration.available === true
      : activeFileJavaRoot
        && !activeRunConfiguration?.debugConfigurationId
        && activeRunConfiguration?.kind !== "debug-only"
  );

  useEffect(() => {
    if (!onSyncGitManager) return;
    onSyncGitManager(gitManagerPayload);
  }, [gitManagerPayload, onSyncGitManager]);

  useEffect(() => {
    const firstRoot = roots[0] ?? null;
    const openStates = openOrder.map((key) => deferredOpenFiles[key]).filter((file): file is OpenFileState => !!file);
    const toContextFile = (file: OpenFileState) => {
      const ref = file.ref;
      if (ref.kind === "root") {
        const root = roots.find((item) => item.id === ref.rootId);
        return {
          kind: "root" as const,
          rootId: ref.rootId,
          rootName: root?.name,
          rootPath: root?.path,
          path: ref.path,
        };
      }
      const loose = looseFiles.find((item) => item.id === ref.id);
      return {
        kind: "loose" as const,
        id: ref.id,
        name: loose?.name,
        path: ref.path,
      };
    };
    const lspDiagnostics = openStates
      .map((file) => {
        const diagnostics = displayDiagnosticsFor(
          lspFiles[file.key]?.diagnostics,
          inspectionPathForFileKey(file.key),
        );
        if (diagnostics.length === 0) return null;
        return {
          file: toContextFile(file),
          errorCount: diagnostics.filter((item) => item.severity === 1).length,
          warningCount: diagnostics.filter((item) => item.severity === 2).length,
          infoCount: diagnostics.filter((item) => item.severity !== 1 && item.severity !== 2).length,
          messages: diagnostics
            .slice()
            .sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99))
            .slice(0, 5)
            .map((item) => item.message),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);
    const activeStatus = activeLspState?.status
      ? {
          displayName: activeLspState.status.displayName,
          languageId: activeLspState.status.languageId,
          active: activeLspState.status.active,
          available: activeLspState.status.available,
          selectedCommand: activeLspState.status.selectedCommand,
          installHint: activeLspState.status.installHint,
          error: activeLspState.status.error ?? activeLspState.error,
        }
      : null;
    const lspContext = activeStatus || lspDiagnostics.length > 0
      ? {
          activeStatus,
          diagnostics: lspDiagnostics,
        }
      : null;
    setTabCodeWorkspaceContext(tabId, {
      repoRoot: firstRoot?.path ?? workspace.repoRoot ?? "",
      activePath: deferredActiveFile?.ref.kind === "root" && deferredActiveFile.ref.rootId === firstRoot?.id ? deferredActiveFile.ref.path : null,
      openPaths: firstRoot ? openStates.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      dirtyPaths: firstRoot ? dirtyFiles.filter((file) => file.ref.kind === "root" && file.ref.rootId === firstRoot.id).map((file) => file.ref.path) : [],
      roots,
      looseFiles,
      activeFile: deferredActiveFile ? toContextFile(deferredActiveFile) : null,
      openFiles: openStates.map(toContextFile),
      dirtyFiles: dirtyFiles.map(toContextFile),
      lsp: lspContext,
    });
  }, [
    activeLspState,
    deferredActiveFile,
    deferredOpenFiles,
    dirtyFiles,
    displayDiagnosticsFor,
    inspectionPathForFileKey,
    looseFiles,
    lspFiles,
    openOrder,
    roots,
    setTabCodeWorkspaceContext,
    tabId,
    workspace.repoRoot,
  ]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);

  // §8.19.6: move-tab menu entries only make sense with another split target.
  const leafCountForMenu = getAllLeafNodes(workspaceUi.layoutTreeV2).length;

  const renderEditorGroup = createRenderEditorGroup({
    editorGroups,
    openFiles,
    lspFiles,
    inspectionPathForFileKey,
    getFileHighlightingLevel,
    currentDiagnosticsForFile,
    displayDiagnosticsFor,
    markdownModes,
    readerModeByFile,
    workspaceInstanceId,
    editorAppearanceProfile,
    activeEditorFontSizes,
    navigationBarActiveByGroup,
    activeEditorGroupId,
    breadcrumbPathSegments,
    roots,
    absolutePathForOpenFile,
    debug,
    debugSessionActive,
    workspaceResourceOperationLocked,
    lspSessionGeneration,
    openLanguageServersSettings,
    dismissedBannerKeys,
    emptyEditorHints,
    filesWithErrors,
    setGoToLineRequest,
    lspFilesRef,
    showCodeInsightNotice,
    setStatusMessage,
    setLatestClipboardObservation,
    visible,
    setDismissedBannerKeys,
    actionsController,
    documentTransactionOwnerRef,
    claimWorkspaceHistory,
    viewStatesRef,
    handleViewStateChange,
    revealRenderedDocSource,
    columnSelectionMode,
    intelligencePreferences,
    parameterInfoRequestNonce,
    workspaceLspSessionManagerRef,
    handleParameterTrigger,
    handleParameterInvalidate,
    handleParameterEscape,
    parameterPopup,
    tabPolicy,
    mruFileKeysRef,
    highlightsByGroup,
    inlayHintsByGroup,
    semanticTokensByGroup,
    gitLineChangesByFile,
    showGitHeadDiff,
    activeKey,
    activeRunGutterTargets,
    handleRunGutterClick,
    get gitBlameByGroup() { return gitBlameByGroup; },
    coverageReport,
    coverageOverlayEnabled,
    getEffectiveCodeStyleForFile,
    openBreakpointPopup,
    setBreakpointPopup,
    setGutterMenu,
    debugRunToCursorLine,
    debugStoppedHere,
    setFileHighlightingLevel,
    navigateDiagnostic,
    editorPaneRef,
    inactiveEditorPaneRef,
    statusNavigationHost,
    breadcrumbSymbolsByGroup,
    cursorPositions,
    loadBreadcrumbPathChildren,
    navigateBreadcrumbPathChild,
    breadcrumbPathActions,
    setSelected,
    setExpandedDirs,
    loadDir,
    revealEditorLocation,
    recordNavigationLocation,
    setNavigationBarActiveByGroup,
    setRevealTarget,
    revealTarget,
    editorPaneStyle,
    flushPendingEditorText,
    setLeafActiveTab,
    updateEditorGroup,
    activateEditorGroup,
    ensureLspDocumentSynced,
    closeFile,
    setTabPinned,
    promotePreviewTab,
    closeGroupFiles,
    openFilesRef,
    splitEditor,
    leafCountForMenu,
    moveTabToAdjacentSplitFrom,
    copyEditorTabPath,
    revealEditorTabInTree,
    revealEditorTabInExplorer,
    openEditorTabInTerminal,
    openLocalHistoryForKey,
    downloadLibrarySources,
    downloadingSourcesKeys,
    setMarkdownModes,
    queueEditorTextUpdate,
    saveFile,
    getLspHover,
    pinQuickDocumentation,
    goToDefinition,
    findReferences,
    getLspCompletions,
    completionIdentityForFile,
    reportCompletionDiagnostic,
    reportCompletionScopeFallback,
    resolveLspCompletion,
    editorSelectionRef,
    setActiveSelectionStats,
    activeEditorCommandState,
    editorCommandSignatureRef,
    setEditorCommandContextRevision,
    setEditorAiSelection,
    noteCaretPosition,
    cursorPositionsRef,
    setCursorPositions,
    setViewportRanges,
    syncSplitScroll,
    splitOrientation,
    workspaceUi,
    syncScrollOriginGroupIdRef,
    getLspSelectionRanges,
    openCodeActionsForLine,
    showEditorContextMenu,
    registerEditorCommandPort,
    openMarkdownHref,
  });

  const renderRecursiveLayoutNode = (
    node: LayoutNode,
    renderGroup: (groupId: EditorGroupId) => ReactNode,
  ): ReactNode => {
    if (node.type === "leaf") {
      return renderGroup(node.id);
    }
    return (
      <PanelGroup
        key={node.id}
        orientation={node.orientation === "vertical" ? "horizontal" : "vertical"}
        id={`recursive-split-${node.id}`}
        className="h-full min-h-0"
          onLayoutChanged={(layout) => {
            const ratios = panelLayoutToRatios(layout, node.children.map((child) => child.id));
            if (ratios) setLayoutNodeRatios(workspaceInstanceId, node.id, ratios);
          }}
      >
        {node.children.map((child, index) => {
          const pct = node.ratios[index] ? `${Math.round(node.ratios[index] * 100)}%` : `${Math.round(100 / node.children.length)}%`;
          return (
            <Fragment key={child.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={node.orientation === "vertical"
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"
                    : "h-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]"}
                />
              )}
              <Panel id={`panel-${child.id}`} defaultSize={pct} minSize="10%" className="min-h-0 min-w-0">
                {renderRecursiveLayoutNode(child, renderGroup)}
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    );
  };

  // Bottom tool windows (IDEA bottom-docked set); rendered by the dock or,
  // when moved, by another tool window area (ED-PARITY-024).
  const replaceMatches: ((matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit, snapshot: import("./workspace/replaceInFilesModel").ReplacePreviewSnapshot) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>) | undefined = createReplaceMatches({
    setStatusMessage,
    workspaceInstanceId,
    rootsRef,
    openFilesRef,
    absolutePathForOpenFile,
    workspaceResourceOperationLockedRef,
    applyLspWorkspaceEdit,
  });

  const bottomDockTabs: BottomDockTab[] = [
    {
      id: "problems",
      label: "Problems",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      badge: activeProblemCounts.errors > 0 || activeProblemCounts.warnings > 0 ? (
        <span className="inline-flex items-center gap-1">
          {activeProblemCounts.errors > 0 && <span className="text-red-500">{activeProblemCounts.errors}</span>}
          {activeProblemCounts.warnings > 0 && <span className="text-amber-500">{activeProblemCounts.warnings}</span>}
        </span>
      ) : undefined,
      content: (
        <ProblemsPanel
          files={problemsScopeFiles}
          onOpenProblem={openProblem}
          onQuickFix={(fileKey, diagnostic) => void openQuickFixForProblem(fileKey, diagnostic)}
          onSuppress={suppressInspection}
          onAddToBaseline={addInspectionBaseline}
          scope={problemsScope}
          onScopeChange={setProblemsScope}
          onRebuild={() => void rebuildProject()}
          rebuilding={rebuildingProject}
          loading={problemsScope === "project" && projectProblemsLoading}
          diagnosticTransform={inspectionTransform}
          onOpenRelatedInformation={openRelatedDiagnostic}
          evidenceLine={evidenceLineForProblem}
          suppressedInSource={suppressedInSourceForProblem}
          fullProjectNote={activeCapabilities?.workspaceDiagnostics === true
            ? null
            : "On-the-fly diagnostics only — this server does not expose workspace-wide diagnostics."}
          readiness={activeKey ? languageServiceReadiness(activeLspState) : null}
          onConfigureLanguageService={() => openLanguageServersSettings(activeLspState?.status?.presetId)}
          onRetryLanguageService={restartLspServers}
        />
      ),
    },
    {
      id: "analysis",
      label: "Analysis",
      icon: <Activity className="h-3.5 w-3.5" />,
      badge: activeProblemCounts.errors + activeProblemCounts.warnings || undefined,
      content: (
        <AnalysisPanel
          files={analysisFiles}
          status={activeLspState?.status ?? null}
          semanticTokenCount={semanticTokensByGroup[activeEditorGroupId]?.length ?? 0}
          semanticIndex={semanticIndex.snapshot}
          projectAnalysis={projectAnalysisSnapshot}
          projectAnalysisProbing={projectAnalysisProbing}
          onRefreshProjectAnalysis={refreshProjectAnalysis}
          profile={inspectionProfile}
          onUpdateRule={updateInspectionProfileRule}
          onCreateBaseline={createInspectionBaselineFromScope}
          onClearBaseline={clearInspectionBaselineEntries}
          onRemoveBaselineEntry={removeInspectionBaseline}
          onRemoveSuppression={removeInspectionSuppressionEntry}
          onExportBaseline={() => void exportInspectionBaseline()}
          onImportBaseline={() => void importInspectionBaselineFromClipboard()}
          onOpenLocation={(location) => void openLspLocation(location)}
          onOpenDiagnostic={openProblem}
        />
      ),
    },
    {
      id: "search",
      label: "Search",
      icon: <Search className="h-3.5 w-3.5" />,
      content: (
        <FindInFilesPanel
          roots={roots}
          workspaceInstanceId={workspaceInstanceId}
          focusNonce={searchFocusNonce}
          focusTarget={searchFocusTarget}
          includePreset={searchIncludePreset}
          queryPreset={searchQueryPreset}
          onOpenMatch={openSearchMatch}
          onPrepareReplacePreimages={prepareReplacePreimages}
          onReplaceMatches={replaceMatches}
        />
      ),
    },
    {
      id: "structural",
      label: "Structural Search",
      icon: <Braces className="h-3.5 w-3.5" />,
      badge: structuralSearch.result?.matches.length || undefined,
      content: (
        <StructuralSearchPanel session={structuralSearch} onOpenMatch={openStructuralMatch} />
      ),
    },
    {
      id: "references",
      label: "References",
      icon: <ListTree className="h-3.5 w-3.5" />,
      badge: referencesResult.locations.length,
      content: (
        <ReferencesPanel
          result={referencesResult}
          roots={roots}
          semanticIndex={semanticIndex.snapshot}
          onOpenLocation={(location) => void openLspLocation(location)}
          pinned={referencesPinned}
          onPinChange={(pinned) => {
            setReferencesPinned(pinned);
            usageSessionRef.current?.setPinned(pinned);
          }}
          onRerun={rerunFindReferences}
          scopeSelection={usagesScopeSelection}
          recentSessions={usageSessionRef.current?.getRecent().map((snapshot) => ({
            id: snapshot.id,
            label: `${snapshot.symbol.displayName || "symbol"} · ${snapshot.envelope.results.length} · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
          })) ?? []}
          onRestoreRecent={(id) => {
            usageSessionRef.current?.restore(id);
            setUsagesRecentsRevision((revision) => revision + 1);
          }}
          recentsRevision={usagesRecentsRevision}
        />
      ),
    },
    {
      id: "call-hierarchy",
      label: "Call Hierarchy",
      icon: <GitFork className="h-3.5 w-3.5" />,
      content: (
        <HierarchyPanel
          mode="call"
          root={callHierarchyRoot}
          active={bottomDockOpen && bottomDockTab === "call-hierarchy"}
          staleReason={(() => {
            const provenance = hierarchyProvenanceRef.current.call;
            if (!provenance || !callHierarchyRoot) return null;
            void hierarchyProvenanceRevision;
            if (provenance.generation !== lspSessionGeneration()) {
              return "Provider restarted since this hierarchy was prepared";
            }
            const current = projectAnalysisSnapshot?.projectFingerprint ?? "";
            if (current && provenance.projectFingerprint !== current) {
              return "Project model changed since this hierarchy was prepared";
            }
            return null;
          })()}
          onRerunStale={() => void openHierarchy("call")}
          onOpenLocation={(location) => void openLspLocation(location)}
          queryHost={semanticQueryHostRef.current}
          liveLspGeneration={lspSessionGeneration}
          liveDocumentRevision={() => openFilesRef.current[callHierarchyRoot?.fileKey ?? ""]?.documentRevision ?? -1}
          onStatus={(status) => {
            if (activeFile) updateLspStatusForFile(activeFile, status);
          }}
        />
      ),
    },
    {
      id: "type-hierarchy",
      label: "Type Hierarchy",
      icon: <Network className="h-3.5 w-3.5" />,
      content: (
        <HierarchyPanel
          mode="type"
          root={typeHierarchyRoot}
          active={bottomDockOpen && bottomDockTab === "type-hierarchy"}
          staleReason={(() => {
            const provenance = hierarchyProvenanceRef.current.type;
            if (!provenance || !typeHierarchyRoot) return null;
            void hierarchyProvenanceRevision;
            if (provenance.generation !== lspSessionGeneration()) {
              return "Provider restarted since this hierarchy was prepared";
            }
            const current = projectAnalysisSnapshot?.projectFingerprint ?? "";
            if (current && provenance.projectFingerprint !== current) {
              return "Project model changed since this hierarchy was prepared";
            }
            return null;
          })()}
          onRerunStale={() => void openHierarchy("type")}
          onOpenLocation={(location) => void openLspLocation(location)}
          queryHost={semanticQueryHostRef.current}
          liveLspGeneration={lspSessionGeneration}
          liveDocumentRevision={() => openFilesRef.current[typeHierarchyRoot?.fileKey ?? ""]?.documentRevision ?? -1}
          onStatus={(status) => {
            if (activeFile) updateLspStatusForFile(activeFile, status);
          }}
        />
      ),
    },
    {
      id: "todos",
      label: "TODOs",
      icon: <ListTodo className="h-3.5 w-3.5" />,
      badge: (openFileTodos.length + bookmarks.length) > 0 ? (openFileTodos.length + bookmarks.length) : undefined,
      content: (
        <TodosBookmarksPanel
          todos={openFileTodos}
          bookmarks={bookmarks}
          onOpenTodo={(item) => void openTodoOrBookmark(item)}
          onOpenBookmark={(item) => void openTodoOrBookmark(item)}
          onRemoveBookmark={removeBookmark}
          onRenameBookmarkGroup={renameBookmarkGroup}
        />
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: <TerminalSquare className="h-3.5 w-3.5" />,
      badge: undefined,
      content: (
        <TerminalDockPanel
          ref={terminalDockRef}
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          defaultCwd={activeRoot?.path ?? roots[0]?.path ?? ""}
          active={bottomDockOpen && bottomDockTab === "terminal"}
        />
      ),
    },
    {
      id: "run",
      label: "Run",
      icon: <Play className="h-3.5 w-3.5" />,
      content: (
        <RunPanel
          ref={runPanelRef}
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          active={bottomDockOpen && bottomDockTab === "run"}
          onRun={runWorkspaceTask}
          toolConfig={toolConfig}
          onConfigureTools={() => setBuildRunToolsOpen(true)}
        />
      ),
    },
    {
      id: "build",
      label: "Build",
      icon: <Hammer className="h-3.5 w-3.5" />,
      content: (
        <BuildPanel
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          active={bottomDockOpen && bottomDockTab === "build"}
          onRunTask={(task, onExit) => runWorkspaceTask(task, onExit)}
          toolConfig={toolConfig}
          onLoadModules={(rootPath) =>
            // A synthetic .java path selects the root's jdtls session
            // (session keys on project scope, not on the file existing).
            lspJavaModules(lspDescriptorForPath(rootPath, "__taomni_modules__.java"))}
        />
      ),
    },
    {
      id: "tests",
      label: "Tests",
      icon: <FlaskConical className="h-3.5 w-3.5" />,
      content: (
        <TestsPanel
          activeFileTitle={activeFileIsJava ? activeFile?.title ?? null : null}
          canDiscover={activeFileIsJava}
          active={bottomDockOpen && bottomDockTab === "tests"}
          onDiscover={discoverActiveJavaTests}
          onRun={runJavaTest}
          onRerun={rerunStructuredTest}
          onLoadResults={activeFile?.ref.kind === "root" ? loadActiveJavaTestResults : undefined}
          results={activeFile?.ref.kind === "root" ? testResultsByRoot[activeFile.ref.rootId] ?? null : null}
          onOpenFailure={openStructuredTestFailure}
          onDebug={debugJavaTest}
          runDisabled={javaTestBuildTool === null}
        />
      ),
    },
    {
      id: "coverage",
      label: "Coverage",
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      badge: coverageReport ? `${coverageReport.totalPercentage}%` : undefined,
      content: (
        <CoveragePanel
          report={coverageReport}
          coverageEnabled={coverageOverlayEnabled}
          onToggleCoverage={() => setCoverageOverlayEnabled((prev) => !prev)}
          onOpenFile={(path, line) => {
            const ref = problemPathToRef(path);
            if (ref) {
              const targetLine = line && line > 0 ? line - 1 : 0;
              const range = { start: { line: targetLine, character: 0 }, end: { line: targetLine, character: 0 } };
              void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
            }
          }}
          onRefreshCoverage={() => void scanWorkspaceCoverage()}
        />
      ),
    },
    {
      // ED-PARITY-018 DEC-018-01: the workspace Git tool window hosts the
      // same Git manager as the Git tab, scoped to this workspace's repos.
      id: "git",
      label: "Git",
      icon: <GitBranch className="h-3.5 w-3.5" />,
      // Mounted on first open and kept, so the commit message and
      // selection survive hiding the tool window.
      content: gitRoots.length > 0 && (gitToolWindowMounted || (bottomDockOpen && bottomDockTab === "git")) ? (
        <div data-testid="code-workspace-git-tool-window" tabIndex={-1} className="relative h-full min-h-0 outline-none">
          <WorkspaceGitManager
            workspaceName={title}
            roots={gitRoots}
            activeRepoRoot={activeGitRoot?.repoRoot ?? gitRoots[0]?.repoRoot ?? null}
            visible={bottomDockOpen && bottomDockTab === "git"}
          />
        </div>
      ) : (
        <div data-testid="code-workspace-git-tool-window-empty" role="status" className="px-3 py-3 text-[11px] text-[var(--taomni-code-muted)]">
          {gitRootsLoading ? "Detecting Git repositories…" : "No Git repository in this workspace"}
        </div>
      ),
    },
    {
      id: "debug",
      label: "Debug",
      icon: <Bug className="h-3.5 w-3.5" />,
      content: (
        <DebugPanel
          debug={debug}
          onStart={activeFileDebuggable ? startDebugActiveTarget : null}
          onAttach={activeFileJavaRoot && debugRuntimeAvailable ? attachRemoteDebug : null}
          onOpenFrame={openDebugFrame}
          onOpenBreakpoint={(path, line, column) => openDebugFrame({ path, line, column })}
          onOpenLocation={(path, line, column) => openDebugFrame({ path, line, column })}
          editingBreakpoint={editingBreakpoint}
          onEditingBreakpointChange={setEditingBreakpoint}
          onViewBreakpoints={() => setBreakpointsDialog({ initial: null })}
          onEvaluateExpression={(expression) => openEvaluateDialogRef.current(expression ?? "")}
          onRunToCursor={debug.state?.status === "stopped" && activeFileAbsPath ? () => {
            const cursor = cursorPositionsRef.current[activeEditorGroupId];
            const line = (cursor?.line ?? editorSelectionRef.current.start.line) + 1;
            debugRunToCursorLine(line);
          } : null}
          runtimeAvailable={debugRuntimeAvailable}
          configurations={activeRunConfigurations
            .filter((configuration) => configuration.kind !== "module")
            .map((configuration) => {
              const detectedDebug = configuration.debugConfigurationId
                ? activeExecutionModel?.debugConfigurations.find((candidate) => (
                  candidate.id === configuration.debugConfigurationId
                ))
                : undefined;
              const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
              const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[configuration.id];
              const debugConfiguration = detectedDebug
                ? applyRunOverrideToDebugConfiguration(
                    detectedDebug,
                    override,
                    configuration.runtimeOptions,
                    configuration.envFile,
                  )
                : undefined;
              const canUseJavaCompatibilityDebug = activeFileJavaRoot
                && !configuration.debugConfigurationId
                && configuration.kind !== "debug-only";
              const available = debugRuntimeAvailable
                && (debugConfiguration
                  ? debugConfiguration.available === true
                  : canUseJavaCompatibilityDebug);
              const diagnostic = !debugRuntimeAvailable
                ? "Debugging is available in the desktop app only"
                : debugConfiguration?.diagnostic
                  ?? (!debugConfiguration && canUseJavaCompatibilityDebug
                    ? undefined
                    : "No available debug configuration is associated with this run target");
              return {
                id: configuration.id,
                label: configuration.label,
                source: configuration.configurationSource,
                available,
                diagnostic: available ? undefined : diagnostic,
              };
            })}
          activeConfigurationId={activeRunConfiguration?.id ?? null}
          workspaceInstanceId={workspaceInstanceId}
          onActiveConfigurationChange={(configurationId) => {
            if (!activeFile) return;
            const sourceFile = absolutePathForOpenFile(activeFile);
            if (sourceFile) writeActiveRunConfigurationSelection(
              workspaceInstanceId,
              sourceFile,
              configurationId,
            );
          }}
        />
      ),
    },
  ];

  // ED-PARITY-024: every tool window renders once into a re-parentable host;
  // the area showing it adopts the host node (state survives moves).
  const toolWindowContents: { id: string; label: string; content: ReactNode }[] = [
    {
      id: "project",
      label: "Project",
      content: (
      <FileTreePane
        paneRef={treePaneRef}
        style={treePaneStyle}
        onKeyDown={handleTreeKeyDown}
        filter={treeFilter}
        onFilterChange={setTreeFilter}
        viewMode={treeViewMode}
        onViewModeChange={setTreeViewMode}
        fontSize={treeFontSize}
        minFontSize={CODE_WORKSPACE_MIN_TREE_FONT_SIZE}
        maxFontSize={CODE_WORKSPACE_MAX_TREE_FONT_SIZE}
        defaultFontSize={CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE}
        onFontSizeChange={setTreeFontSize}
        collapsed={!languagePanelOpen}
        onToggleCollapse={toggleProjectTree}
        onOpenFile={() => executeWorkspaceCommand("workspace.tree.openLooseFile", { focus: "tree" })}
        onAddFolder={() => executeWorkspaceCommand("workspace.tree.addFolder", { focus: "tree" })}
        canCreate={!!selectedRootDirectory}
        canMutateSelection={!!selected}
        onCreateFile={() => executeWorkspaceCommand("workspace.tree.newFile", { focus: "tree" })}
        onCreateDirectory={() => executeWorkspaceCommand("workspace.tree.newDirectory", { focus: "tree" })}
        onRename={() => executeWorkspaceCommand("workspace.tree.rename", { focus: "tree" })}
        onDelete={() => executeWorkspaceCommand("workspace.tree.delete", { focus: "tree" })}
        onSelectOpenedFile={activeKey ? () => revealEditorTabInTree(activeKey) : undefined}
        onExpandAll={expandAllProjectTree}
        onCollapseAll={collapseAllProjectTree}
        toolWindowOptions={() => toolWindowOptionsItems("project")}
        showDetails={treeShowDetails}
        onShowDetailsChange={setTreeShowDetails}
      >
        <ProjectTree
          showDetails={treeShowDetails}
          roots={roots}
          looseFiles={looseFiles}
          directories={directories}
          compactChains={compactChains}
          flatFiles={flatFiles}
          treeViewMode={treeViewMode}
          treeFilter={treeFilter}
          expandedRoots={expandedRoots}
          expandedDirs={expandedDirs}
          selected={selected}
          activeKey={activeKey}
          openFiles={openFiles}
          gitChangeByRootPath={gitChangeByRootPath}
          {...projectTreeHandlers}
        />
      </FileTreePane>
      ),
    },
    {
      id: "structure",
      label: "Structure",
      content: (
      <OutlinePane
        symbols={breadcrumbSymbolsByGroup[activeEditorGroupId] ?? []}
        position={cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 }}
        loading={!!activeFile && (!!activeLspState?.syncing || (activeCapabilities?.documentSymbol === true && !activeLspState?.status))}
        unavailableReason={!activeFile
          ? "Open a file to view its outline"
          : activeCapabilities?.documentSymbol === false
            ? "Document symbols are not supported by this language server"
            : null}
        onPick={pickOutlineSymbol}
      />
      ),
    },
    {
      id: "documentation",
      label: "Documentation",
      content: (
      <DocumentationPane
        content={pinnedDoc}
        locked={pinnedDocLocked}
        onUnlock={() => setPinnedDocLocked(false)}
        onOpenSource={openReferenceSource}
        canGoBack={referenceHistory.canGoBack}
        canGoForward={referenceHistory.canGoForward}
        onBack={referenceHistoryBack}
        onForward={referenceHistoryForward}
        onClear={() => {
          setPinnedDoc(null);
          setPinnedDocLocked(false);
        }}
      />
      ),
    },
    ...bottomDockTabs.map((tab) => ({ id: tab.id, label: tab.label, content: tab.content })),
  ];
  const { toolWindowOptionsItems, leftStripeTop, stripeItemsAt, moreToolWindowsButton, stripeCallbacks, renderToolWindowSideArea, renderToolWindowPane, rightStripeTop } = createToolWindowChrome({
    toolWindowContents,
    toolWindowLayout,
    currentBottomDockHeight,
    handleBottomDockHeightChange,
    maxBottomDockHeight,
    projectPanelRef,
    rightPanelRef,
    handleReturnToEditor,
    handleRestoreToolWindowLayout,
    toolWindowNodes,
    leftToolRailItems,
    rightToolRailItems,
    bottomDockTabs,
    rightPaneTabRef,
  });

  const applyTabPolicy: (policy: WorkspaceTabPolicyV3) => boolean | void | Promise<boolean | void> = createApplyTabPolicy({
    workspaceInstanceId,
    tabPolicyRef,
    openFilesRef,
    mruFileKeysRef,
    baseLayoutRevision,
    resourceRecoveryCoordinatorRef,
    activeEditorGroupId,
    closeLspDocumentAndWait,
    pendingExternalFileEventsRef,
    saveTransactionRegistryRef,
    setOpenFiles,
    setMarkdownModes,
    setLspFiles,
    setClosedTabsStack,
    observeResourceCleanupOutcome,
    setTabPolicy,
    setTabPolicyRevision,
    libraryBuffersRef,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    languagePanelOpen,
    splitOrientation,
    expandedRootIds,
    expandedDirKeys,
    workspaceUi,
    setStatusMessage,
    setTabPolicyReceipt,
  });

  return (
    <WorkspaceClipboardSessionContext.Provider value={clipboardHandle}>
      <WorkspaceObservationBoundary
        ref={rootRef}
        bridge={observationBridge}
        data-testid="code-workspace-tab"
        data-layout-revision={layoutRevision}
        data-clipboard-revision={clipboardSnapshot.revision}
        data-clipboard-history-revision={clipboardSnapshot.historyRevision}
        data-clipboard-consumer-count={clipboardSnapshot.consumerCount}
        data-tab-policy-limit={tabPolicy.limitPerLeaf}
        data-tab-policy-order={tabPolicy.order}
        data-tab-policy-receipt-status={tabPolicyReceipt?.status}
        data-tab-policy-receipt-layout-revision={tabPolicyReceipt?.layoutRevision}
        data-tab-policy-receipt-active-key={tabPolicyReceipt?.activeKey ?? undefined}
        data-tab-policy-receipt-evicted-count={tabPolicyReceipt?.evictedCount}
        data-tab-policy-receipt-cleanup-count={tabPolicyReceipt?.cleanupCount}
        data-tab-policy-receipt-cleanup-committed-count={tabPolicyReceipt?.cleanupCommittedCount}
        data-tab-policy-receipt-cleanup-recovery-count={tabPolicyReceipt?.cleanupRecoveryCount}
        data-tab-policy-receipt-open-resource-count={tabPolicyReceipt?.openResourceCount}
        data-open-resource-count={Object.keys(openFiles).length}
        data-active-editor-key={activeKey ?? undefined}
        data-resource-recovery-count={resourceCleanupRecoveries.length}
        data-reopen-stack-count={closedTabsStack.length}
        className="relative h-full w-full min-h-0 flex flex-col overflow-hidden bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
      >
        <div
          id="code-workspace-save-observation"
          data-testid="code-workspace-save-observation"
          role="status"
          aria-label="Save status"
          aria-live="polite"
          aria-atomic="true"
          data-state={activeSaveObservationState}
          data-result-kind={latestSaveObservation?.resultKind}
          data-disk-effect={latestSaveObservation?.diskEffect}
          data-memory-effect={latestSaveObservation?.memoryEffect}
          data-provider-effect={latestSaveObservation?.providerEffect}
          data-file-path={latestSaveObservation?.filePath}
          data-uri={latestSaveObservation?.uri}
          data-buffer-revision={activeFile?.documentRevision ?? latestSaveObservation?.bufferRevision}
          data-dirty={activeFile?.dirty ?? latestSaveObservation?.isDirty ?? false}
          data-receipt-id={activeSaveReceipt?.receiptId}
          data-transaction-id={activeSaveReceipt?.transactionId ?? latestSaveObservation?.transactionId}
          data-final-text-sha256={activeSaveReceipt?.finalTextSha256}
          data-encoded-bytes-sha256={activeSaveReceipt?.encodedBytesSha256}
          data-encoded-byte-length={activeSaveReceipt?.encodedByteLength}
          data-disk-pre-sha256={activeSaveReceipt?.diskPreSha256 ?? undefined}
          data-disk-post-sha256={activeSaveReceipt?.diskPostSha256}
          data-write-count={activeSaveReceipt?.writeCount}
          data-encoding={activeSaveReceipt?.policy.encoding}
          data-bom={activeSaveReceipt ? String(activeSaveReceipt.policy.bom) : undefined}
          data-eol={activeSaveReceipt?.policy.eol}
          data-history-id={activeSaveReceipt?.historyId}
          data-recovery-id={latestSaveObservation?.recoverySnapshotId ?? activeSaveReceipt?.recoveryId}
          data-verified-at={latestSaveObservation?.lastVerifiedAt}
          className="sr-only"
        >
          {activeSaveAnnouncement}
        </div>
        {/*
          ED-CLIP-004 clipboard observation seam. Metadata only: outcome, OS
          effect, permission epoch, payload SHAPE and caret count. Never the
          copied text — a runner must not be able to reconstruct the payload
          from the DOM.
        */}
        <div
          id="code-workspace-clipboard-observation"
          data-testid="code-workspace-clipboard-observation"
          role="status"
          aria-label="Clipboard status"
          aria-live="polite"
          aria-atomic="true"
          data-operation={latestClipboardObservation?.operation}
          data-outcome={latestClipboardObservation?.outcome}
          data-system-effect={latestClipboardObservation?.systemEffect}
          data-permission={latestClipboardObservation?.permission ?? clipboardSnapshot.permission}
          data-permission-generation={
            latestClipboardObservation?.permissionGeneration ?? clipboardSnapshot.permissionGeneration
          }
          data-base-generation={latestClipboardObservation?.baseGeneration ?? undefined}
          data-workspace-fallback={
            latestClipboardObservation ? String(latestClipboardObservation.usedWorkspaceFallback) : undefined
          }
          data-segment-count={latestClipboardObservation?.segmentCount ?? undefined}
          data-rectangular={
            latestClipboardObservation ? String(latestClipboardObservation.rectangular) : undefined
          }
          data-payload-length={latestClipboardObservation?.payloadLength ?? undefined}
          data-history-exclusion={latestClipboardObservation?.historyExclusion}
          data-payload-revision={latestClipboardObservation?.payloadRevision ?? clipboardSnapshot.payloadRevision}
          data-caret-count={latestClipboardObservation?.caretCount ?? undefined}
          data-observed-at={latestClipboardObservation?.observedAt ?? undefined}
          className="sr-only"
        >
          {clipboardAnnouncement}
        </div>
      <WorkspaceToolbar
  title={title}
  roots={roots}
  looseFiles={looseFiles}
  dirtyCount={dirtyCount}
  visible={visible}
  workspaceWidgetHost={workspaceWidgetHost}
  projectFactsRoot={projectFactsRoot}
  projectFacts={projectFacts}
  projectDescriptorDiscovery={projectDescriptorDiscovery}
  refreshProjectFacts={refreshProjectFacts}
  gitRootsLoading={gitRootsLoading}
  onOpenGitManager={onOpenGitManager}
  gitRoots={gitRoots}
  executeWorkspaceCommand={executeWorkspaceCommand}
  projectBuildBusy={projectBuildBusy}
  buildActiveProject={buildActiveProject}
  activeRunConfiguration={activeRunConfiguration}
  javaRunBusy={javaRunBusy}
  activeFileRunnable={activeFileRunnable}
  runActiveTarget={runActiveTarget}
  activeRunConfigurations={activeRunConfigurations}
  activeFile={activeFile}
  absolutePathForOpenFile={absolutePathForOpenFile}
  workspaceInstanceId={workspaceInstanceId}
  debugRuntimeAvailable={debugRuntimeAvailable}
  activeDebugConfiguration={activeDebugConfiguration}
  activeFileDebuggable={activeFileDebuggable}
  debugSessionActive={debugSessionActive}
  startDebugActiveTarget={startDebugActiveTarget}
  toolbarMoreOpen={toolbarMoreOpen}
  setToolbarMoreOpen={setToolbarMoreOpen}
  navCan={navCan}
  currentEditorFontSize={currentEditorFontSize}
  stepCodeViewFontSize={stepCodeViewFontSize}
  setCodeViewFontSize={setCodeViewFontSize}
  activeFileSoftWrap={activeFileSoftWrap}
  toggleSoftWrap={toggleSoftWrap}
  columnSelectionMode={columnSelectionMode}
  toggleColumnSelectionMode={toggleColumnSelectionMode}
  splitOrientation={splitOrientation}
  splitEditor={splitEditor}
  syncSplitScroll={syncSplitScroll}
  setSyncSplitScroll={setSyncSplitScroll}
  setStatusMessage={setStatusMessage}
  closeSplit={closeSplit}
  activeInlayHintsEnabled={activeInlayHintsEnabled}
  activeLanguageId={activeLanguageId}
  activeCapabilities={activeCapabilities}
  toggleInlayHintsForActiveLanguage={toggleInlayHintsForActiveLanguage}
  intelligencePreferences={intelligencePreferences}
  activeGitRoot={activeGitRoot}
  toggleInlineBlame={toggleInlineBlame}
  rightPaneOpen={rightPaneOpen}
  rightPaneTab={rightPaneTab}
  openTabPolicySettings={openTabPolicySettings}
/>

      {resourceCleanupRecoveries.length > 0 && (
        <div
          data-testid="workspace-resource-cleanup-recovery"
          role="status"
          aria-live="polite"
          className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px]"
        >
          {resourceCleanupRecoveries.map((recovery) => (
            <div
              key={recovery.recoveryId}
              data-testid="workspace-resource-cleanup-recovery-item"
              data-recovery-id={recovery.recoveryId}
              data-next-stage={recovery.nextStage}
              data-completed-stage-count={recovery.completedStageCount}
              data-attempt-count={recovery.attemptCount}
              className="flex min-w-0 items-center gap-2"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="min-w-0 flex-1 truncate">
                Cleanup paused at {recovery.nextStage} for {recovery.fileKey}: {recovery.error}
              </span>
              <button
                type="button"
                data-testid="workspace-resource-cleanup-retry"
                className="taomni-btn h-6 shrink-0 px-2"
                aria-label={`Retry resource cleanup for ${recovery.fileKey}`}
                onClick={() => void replayResourceCleanup(recovery.recoveryId)}
              >
                Retry
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {(() => {
          const merged = visible && mainRailMergeActive && !!mainRailHost;
          const leftStripe = (
            <ToolWindowRail
              side="left"
              embedded={merged}
              top={leftStripeTop}
              bottom={stripeItemsAt("bottom-left")}
              footer={moreToolWindowsButton}
              width={toolWindowLayout.stripeWidth("left")}
              onResize={(width) => toolWindowLayout.setStripeWidth("left", width)}
              {...stripeCallbacks}
            />
          );
          return merged && mainRailHost ? createPortal(leftStripe, mainRailHost) : leftStripe;
        })()}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-1 min-h-0 flex">
        <PanelGroup
          orientation="horizontal"
          id={`code-workspace-${workspaceInstanceId}`}
          className="flex-1 min-h-0 min-w-0"
          onLayoutChanged={() => {
            // Pointer drags report here only on release (never per move), which
            // is the library's intended persistence point for saved layouts.
            if (lastProjectPanelSizeRef.current > 40) {
              setShellChromeState(workspaceInstanceId, {
                projectWidthPx: lastProjectPanelSizeRef.current,
              });
            }
          }}
        >
          <Panel
            panelRef={projectPanelRef}
            id="project"
            defaultSize={initialProjectPanelSize}
            // IDEA tool windows keep their width when the frame resizes, e.g.
            // when the main sidebar collapses into its rail (ED-PARITY-027).
            groupResizeBehavior="preserve-pixel-size"
            minSize={0}
            collapsible
            collapsedSize={0}
            onResize={handleProjectPanelResize}
            className="min-w-0"
          >
            <div
              className="h-full min-h-0 overflow-hidden"
              data-testid="code-workspace-left-tool-area"
              style={leftToolAreaOpen ? undefined : { display: "none" }}
            >
              {renderToolWindowSideArea("left")}
            </div>
          </Panel>
          <PanelResizeHandle
            id="code-workspace-project-resize-handle"
            data-testid="code-workspace-project-resize-handle"
            disabled={!leftToolAreaOpen}
            className={leftToolAreaOpen
              ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors cursor-col-resize shrink-0 relative after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:z-20"
              : "hidden"}
          />
          <Panel
            id="editor"
            defaultSize={languagePanelOpen ? "56%" : "80%"}
            minSize="37px"
            className="min-w-0"
          >
          {workspaceUi.layoutTreeV2.type === "split" ? (
            <div data-testid="code-workspace-editor-split" className="h-full min-h-0">
              {renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
            </div>
          ) : renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
        </Panel>
          <PanelResizeHandle
            className={rightToolAreaOpen
              ? "w-1 bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
              : "hidden"}
          />
          <Panel
            panelRef={rightPanelRef}
            id="documentation"
            defaultSize="20%"
            groupResizeBehavior="preserve-pixel-size"
            minSize="12%"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            onResize={handleRightPanelResize}
            className="min-w-0"
          >
            <aside
              data-testid="code-workspace-right-pane"
              className="h-full min-h-0 flex flex-col border-l border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
              style={rightToolAreaOpen ? undefined : { display: "none" }}
            >
              {renderToolWindowSideArea("right")}
            </aside>
          </Panel>
      </PanelGroup>
        </div>
      <div ref={toolWindowNodes.setParking} hidden data-testid="code-workspace-tool-window-parking" />
      {toolWindowContents.map((entry) => (
        <ToolWindowPortal
          key={entry.id}
          nodes={toolWindowNodes}
          id={entry.id}
          label={entry.label}
          active={toolWindowLayout.isVisible(entry.id)}
          // The terminal keeps Esc for the shell and the tree handles its own.
          onEscape={entry.id === "terminal" || entry.id === "project" ? undefined : handleReturnToEditor}
        >
          {entry.content}
        </ToolWindowPortal>
      ))}
      <BottomDock
        onRestoreLayout={handleRestoreToolWindowLayout}
        renderPane={(id, placement) => renderToolWindowPane(id, { legacyTestIds: placement === "primary" })}
        secondaryTab={toolWindowLayout.visibleAt("bottom-right")}
        open={bottomDockOpen && toolWindowLayout.anchorOf(bottomDockTab) === "bottom-left"}
        height={currentBottomDockHeight}
        maxHeight={maxBottomDockHeight}
        onHeightChange={handleBottomDockHeightChange}
        onEscape={handleReturnToEditor}
        activeTab={bottomDockTab}
        tabs={bottomDockTabs}
        onOpenChange={setBottomDockOpen}
        onActiveTabChange={(tab) => setBottomDockTab(tab as BottomDockTabId)}
      />
        </div>
        <ToolWindowRail
          side="right"
          top={rightStripeTop}
          bottom={stripeItemsAt("bottom-right")}
          width={toolWindowLayout.stripeWidth("right")}
          onResize={(width) => toolWindowLayout.setStripeWidth("right", width)}
          {...stripeCallbacks}
        />
      </div>
      <TabSwitcher
        open={tabSwitcherOpen}
        entries={switcherSnapshot?.editors ?? []}
        toolWindows={switcherSnapshot?.tools ?? []}
        selectedIndex={tabSwitcherIndex}
        onHover={setTabSwitcherIndex}
        onCommit={commitTabSwitcher}
        onCancel={() => {
          setTabSwitcherOpen(false);
          setSwitcherSnapshot(null);
        }}
      />
      <WorkspacePopupsHost
        searchEverywhereOpen={searchEverywhereOpen}
        searchEverywhereMode={searchEverywhereMode}
        goToFileItems={goToFileItems}
        goToFileLoading={goToFileLoading}
        goToFileTruncated={goToFileTruncated}
        actionSnapshots={actionsController.snapshot.filter((entry) => entry.id !== "workspace.goToFile")}
        symbolsAvailable={seSymbolsAvailable}
        semanticIndex={semanticIndex.snapshot}
        fetchWorkspaceSymbols={fetchWorkspaceSymbols}
        onCloseSearchEverywhere={() => setSearchEverywhereOpen(false)}
        onOpenFileItem={openGoToFileItem}
        onOpenSymbol={(symbol, options) => void openWorkspaceSymbol(symbol, options)}
        onRunCommand={runSearchEverywhereCommand}
        onAssignShortcut={(commandId) => {
          // ED-PARITY-013 DEC-013-03: Find Action Alt+Enter = Assign Shortcut.
          setSearchEverywhereOpen(false);
          setKeymapAssignActionId(commandId);
          setKeymapSettingsOpen(true);
        }}
        onSearchText={(query) => {
          setSearchEverywhereOpen(false);
          setBottomDockOpen(true);
          setBottomDockTab("search");
          setSearchFocusNonce((nonce) => nonce + 1);
          setSearchQueryPreset((current) => ({ value: query, nonce: current.nonce + 1 }));
        }}
        recentFilesOpen={recentFilesOpen}
        recentEntries={recentEntries}
        recentAdvanceNonce={recentAdvanceNonce}
        recentChangedOnly={recentChangedOnly}
        onCloseRecent={() => setRecentFilesOpen(false)}
        onPickRecent={pickRecentFile}
        onToggleRecentChangedOnly={() => openRecentFiles({ changedOnly: !recentChangedOnly })}
        recentToolWindows={RECENT_FILES_TOOL_WINDOWS}
        onActivateRecentToolWindow={(id) => {
          setRecentFilesOpen(false);
          handleActivateToolWindow(id);
        }}
        onOpenRecentLocationsFromRecent={() => {
          setRecentFilesOpen(false);
          setRecentLocationsChangedOnly(false);
          setRecentLocationsOpen(true);
        }}
        recentLocationsOpen={recentLocationsOpen}
        recentLocationsChangedOnly={recentLocationsChangedOnly}
        workspaceId={workspaceInstanceId}
        locationController={workspaceLocationControllerRef.current}
        navigationFacade={navigationHistoryFacade}
        onCloseRecentLocations={() => setRecentLocationsOpen(false)}
        onPickRecentLocation={(loc) => {
          setRecentLocationsOpen(false);
          const targetOpen = openFiles[loc.fileIdentity];
          if (targetOpen) {
            void openFile(targetOpen.ref).then(() => {
              revealEditorLocation(targetOpen.key, {
                start: { line: loc.line, character: loc.character },
                end: { line: loc.line, character: loc.character },
              });
            });
          } else {
            const matchingRoot = roots.find((r) => loc.filePath.startsWith(r.path));
            if (matchingRoot) {
              const relPath = loc.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
              void openFile({ kind: "root", rootId: matchingRoot.id, path: relPath }).then(() => {
                const key = `root:${matchingRoot.id}:${relPath}`;
                revealEditorLocation(key, {
                  start: { line: loc.line, character: loc.character },
                  end: { line: loc.line, character: loc.character },
                });
              });
            } else {
              void openFile({ kind: "loose", id: loc.fileIdentity, path: loc.filePath }).then(() => {
                revealEditorLocation(loc.fileIdentity, {
                  start: { line: loc.line, character: loc.character },
                  end: { line: loc.line, character: loc.character },
                });
              });
            }
          }
        }}
        structureOpen={structureOpen}
        structureFileTitle={activeFile?.title ?? null}
        structureSymbols={structureSymbols}
        structureLoading={structureLoading}
        structureUnavailable={structureUnavailable}
        structureSyntaxOnly={structureSyntaxOnly}
        onCloseStructure={() => setStructureOpen(false)}
        onPickStructure={pickStructureSymbol}
        quickDocOpen={quickDocOpen}
        quickDocContent={quickDocContent}
        onCloseQuickDoc={() => setQuickDocOpen(false)}
        onPinQuickDoc={pinQuickDocumentation}
        onOpenQuickDocSource={openReferenceSource}
        quickDocCanGoBack={referenceHistory.canGoBack}
        quickDocCanGoForward={referenceHistory.canGoForward}
        onQuickDocBack={referenceHistoryBack}
        onQuickDocForward={referenceHistoryForward}
        locationPeek={locationPeek}
        onCloseLocationPeek={() => setLocationPeek(null)}
        onOpenLocation={(location) => {
          setLocationPeek(null);
          void openLspLocation(location);
        }}
      />
      {treeContextMenu}
      {editorContextMenu}
      {visible ? <StructuralSearchDialog session={structuralSearch} /> : null}
      <UsagesScopeDialog
        open={!!usagesScopeDialog?.open}
        symbolHint={usagesScopeDialog?.file.subtitle ?? null}
        onConfirm={confirmUsagesScope}
        onCancel={() => {
          setUsagesScopeDialog(null);
          setStatusMessage("Find Usages cancelled");
        }}
      />
      {visible && lspMessageRequest && (
        <LspMessageRequestDialog
          request={lspMessageRequest}
          onSelect={resolveLspMessageRequest}
        />
      )}
      {visible && externalFileConflicts[0] && (
        <ExternalFileConflictDialog
          path={externalFileConflicts[0].path}
          baseText={externalFileConflicts[0].baseText}
          localText={externalFileConflicts[0].localText}
          diskText={externalFileConflicts[0].disk?.text ?? null}
          onKeepLocal={() => keepLocalExternalFileConflict(externalFileConflicts[0]!)}
          onLoadDisk={() => {
            void loadDiskExternalFileConflict(externalFileConflicts[0]!);
          }}
          onApplyMerge={(text) => mergeExternalFileConflict(externalFileConflicts[0]!, text)}
          onCancel={() => dismissExternalFileConflict(externalFileConflicts[0]!.key)}
        />
      )}
      {visible && workspaceRecoveryOpen && (workspaceRecoveryEntries.length > 0 || diskEffectLedgerEntries.length > 0) && externalFileConflicts.length === 0 && (
        <WorkspaceRecoveryDialog
          entries={workspaceRecoveryEntries}
          onRecover={(entry) => {
            void recoverWorkspaceEntry(entry);
          }}
          onDiscard={discardWorkspaceRecoveryEntry}
          onRecoverAll={recoverAllWorkspaceEntries}
          onDiscardAll={discardAllWorkspaceRecoveryEntries}
          onClose={() => setWorkspaceRecoveryOpen(false)}
          ledgerEntries={diskEffectLedgerEntries}
          onAcknowledgeLedgerEntry={acknowledgeDiskEffectLedgerEntry}
          onReopenLedgerEntry={reopenDiskEffectLedgerFile}
        />
      )}
      {visible && fileEncodingDialogOpen && activeFile && !activeFile.library && (
        <FileEncodingDialog
          path={activeFile.path}
          currentEncoding={activeFile.encoding ?? "UTF-8"}
          currentBom={activeFile.bom ?? false}
          dirty={activeFile.dirty}
          onReload={(encoding) => reloadActiveFileWithEncoding(encoding)}
          onConvert={convertActiveFileEncoding}
          onClose={() => setFileEncodingDialogOpen(false)}
        />
      )}
      {localHistoryTarget && openFiles[localHistoryTarget.key] && (
        <LocalHistoryDialog
          path={localHistoryTarget.path}
          onClose={() => setLocalHistoryTarget(null)}
          onRestore={(text) => restoreLocalHistoryText(localHistoryTarget.key, text)}
          onCompare={(entry, text) => {
            compareLocalHistorySnapshot(localHistoryTarget.key, entry, text);
          }}
        />
      )}
      <EditorSelectionAiToolbar
        visible={!!editorAiSelection && !aiRewriteState}
        rect={editorAiSelection?.rect ?? null}
        selectionText={editorAiSelection?.text ?? ""}
        answerLanguage={editorAiPreferences.answerLanguage}
        onAction={(action, text) => {
          void handleEditorAiAction(action, text);
        }}
        onSetAnswerLanguage={setAiAnswerLanguage}
        onDismiss={() => setEditorAiSelection(null)}
      />
      {aiRewriteState && (
        <EditorAiRewriteDialog
          path={aiRewriteState.path}
          original={aiRewriteState.original}
          proposal={aiRewriteState.proposal}
          instruction={aiRewriteState.instruction}
          onInstructionChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, instruction: value } : current
          ))}
          onProposalChange={(value) => setAiRewriteState((current) => (
            current ? { ...current, proposal: value } : current
          ))}
          onClose={() => setAiRewriteState(null)}
          onRegenerate={() => void regenerateAiRewrite()}
          onApply={() => {
            applySelectionReplacement(aiRewriteState.key, aiRewriteState.range, aiRewriteState.proposal);
            setAiRewriteState(null);
            setStatusMessage("Applied AI proposal to the selection");
          }}
        />
      )}
      {editorAppearanceSettingsOpen && (
        <WorkspaceEditorAppearanceSettingsDialog
          open={editorAppearanceSettingsOpen}
          profile={editorAppearanceProfile}
          onApply={(next) => {
            updateEditorAppearanceProfile(next);
            setStatusMessage("Saved workspace editor appearance settings");
          }}
          onClearClipboardHistory={() => {
            clipboardHandle.clearHistory();
            setClipboardHistoryEntries([]);
            setStatusMessage("Cleared clipboard history for current workspace session");
          }}
          onClose={() => setEditorAppearanceSettingsOpen(false)}
        />
      )}
      {tabPolicySettingsOpen && (
        <WorkspaceTabPolicySettingsDialog
          open={tabPolicySettingsOpen}
          policy={tabPolicy}
          openTabs={openOrder.map((key) => ({
            key,
            title: openFiles[key]?.title ?? key,
            dirty: !!openFiles[key]?.dirty,
            pinned: (selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[activeEditorGroupId]?.pinnedKeys ?? []).includes(key),
            preview: selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[activeEditorGroupId]?.previewKey === key,
          }))}
          onApply={applyTabPolicy}
          onClose={closeTabPolicySettings}
        />
      )}
      {intelligenceSettingsOpen && (
        <WorkspaceIntelligenceSettingsDialog
          open={intelligenceSettingsOpen}
          preferences={intelligencePreferences}
          onApply={(next) => {
            setIntelligencePreferences(next);
            setStatusMessage("Saved editor intelligence settings");
          }}
          onClose={() => setIntelligenceSettingsOpen(false)}
        />
      )}
      {buildRunToolsOpen && (
        <WorkspaceBuildRunToolsDialog
          config={buildRunTools}
          onSave={(next) => {
            setBuildRunTools(writeWorkspaceBuildRunTools(workspaceInstanceId, next));
            setBuildRunToolsOpen(false);
            setStatusMessage("Saved build and run tool settings");
          }}
          onClose={() => setBuildRunToolsOpen(false)}
        />
      )}
      <JavaMainClassPicker
        open={!!javaMainCandidates}
        candidates={javaMainCandidates?.candidates ?? []}
        onClose={() => setJavaMainCandidates(null)}
        onPick={(main) => {
          const pending = javaMainCandidates;
          setJavaMainCandidates(null);
          if (pending) launchJavaDebug(
            pending.launch,
            main,
            pending.override,
            pending.environment,
            pending.runtimeOptions,
          );
        }}
      />
      {inlineRename && (
        <InlineRenamePopup
          key={inlineRename.id}
          kind={inlineRename.kind}
          anchor={inlineRename.anchor}
          initialValue={inlineRename.initialValue}
          suggestions={inlineRename.suggestions}
          initialError={inlineRename.initialError}
          validate={(name) => inlineRenameNameError(name, inlineRename.languageId)}
          modalOptions={refactorModalOptions}
          onCommit={(name) => finishInlineRename(inlineRename, { kind: "commit", name })}
          onCancel={() => finishInlineRename(inlineRename, { kind: "cancel" })}
          onOpenDialog={(value) => finishInlineRename(inlineRename, { kind: "dialog", value })}
          onToggleModalOptions={(modal) => {
            writeRefactorOptionsMode(modal ? "dialog" : "editor");
            setRefactorModalOptions(modal);
          }}
        />
      )}
      {refactoringPreviewModal && (
        <RefactoringPreviewDialog
          open={true}
          title={refactoringPreviewModal.title}
          preview={refactoringPreviewModal.preview}
          originalEdit={refactoringPreviewModal.originalEdit}
          plan={refactoringPreviewModal.plan}
          sourceTexts={refactoringPreviewModal.sourceTexts}
          onConfirm={(filteredEdit) => {
            refactoringPreviewModal.resolve(filteredEdit);
            setRefactoringPreviewModal(null);
          }}
          onCancel={() => {
            refactoringPreviewModal.resolve(false);
            setRefactoringPreviewModal(null);
          }}
        />
      )}
      {refactorRecoveryReview && (
        <RefactorRecoveryReviewDialog
          entry={refactorRecoveryReview.entry}
          workspaceRoot={roots[0]?.path ?? refactorRecoveryReview.entry.workspaceRoot}
          preconditions={refactorRecoveryReview.preconditions}
          loading={refactorRecoveryReview.loading}
          error={refactorRecoveryReview.error}
          busy={refactorRecoveryReview.busy}
          onKeep={() => keepRecoveryReview(refactorRecoveryReview.entry.recoveryId)}
          onRestore={() => {
            const current = refactorRecoveryReviewRef.current;
            if (!current || !current.preconditions) return;
            void runRecoveryRestore(current.entry, current.preconditions, current.ownerInstanceId);
          }}
          onDismiss={() => {
            const current = refactorRecoveryReviewRef.current;
            if (!current) return;
            void runRecoveryDismiss(current.entry, current.ownerInstanceId);
          }}
          onClose={() => keepRecoveryReview(refactorRecoveryReview.entry.recoveryId)}
        />
      )}
      {activeCompareSession && (
        <EditorCompareDialog
          session={activeCompareSession}
          onClose={() => setActiveCompareSession(null)}
          onApplyRight={(newText) => applyCompareSession(activeCompareSession, newText)}
        />
      )}
      <ClipboardHistoryPopup
        open={clipboardHistoryOpen}
        entries={clipboardHistoryEntries}
        onPaste={(index) => {
          executeActiveEditorCommand("pasteFromHistory", { historyIndex: index });
        }}
        onDelete={(index) => {
          clipboardHandle.removeHistoryEntry(index);
          setClipboardHistoryEntries([...clipboardHandle.historyEntries()]);
        }}
        onClear={() => {
          clipboardHandle.clearHistory();
          setClipboardHistoryEntries([]);
        }}
        onClose={() => setClipboardHistoryOpen(false)}
      />
      <GenerateCodeDialog
        open={generateCode.open}
        phase={generateCode.phase}
        candidates={generateCode.candidates}
        error={generateCode.error}
        onApply={(ids) => void applyGenerateCandidates(ids)}
        onRetry={() => void requestGenerateCandidates()}
        onCancel={closeGenerateDialog}
      />
      <SurroundWithDialog
        open={surroundWithDialogOpen}
        languageId={activeLanguageId}
        onClose={() => setSurroundWithDialogOpen(false)}
        onPick={(kindId) => {
          const dispatched = executeActiveEditorCommand("surroundWith", {
            surroundKindId: kindId,
            onSemanticEditApplied: ({ applied, provenance }) => {
              if (!applied) {
                setStatusMessage("Surround requires a whole-line selection in one range");
                return;
              }
              // §8.19.8 honest provenance surfacing: local templates never
              // masquerade as Semantic in status reporting.
              setStatusMessage(
                provenance?.kind === "syntax-tree"
                  ? `Surround applied (syntax node ${provenance.nodeType})`
                  : "Surround applied (local template)",
              );
            },
          });
          if (!dispatched) setStatusMessage("Surround requires an active editor");
        }}
      />
      {keymapCheatSheetOpen && (
        <KeymapCheatSheetDialog
          open={true}
          actionSnapshots={actionsController.snapshot}
          onClose={() => setKeymapCheatSheetOpen(false)}
          onExecuteCommand={(cmdId) => {
            // §8.17.3: cheatsheet runs the rendered frozen evaluation.
            const entry = actionsController.snapshot.find((item) => item.id === cmdId);
            if (!entry) return;
            void actionsController.host.executePrepared(entry.evaluation);
          }}
        />
      )}
      {codeInsightNotice && (
        <CodeInsightNotice
          notice={codeInsightNotice}
          onClose={() => setCodeInsightNotice(null)}
          onConfigure={() => openLanguageServersSettings(activeLspState?.status?.presetId)}
        />
      )}
      {goToLineRequest && (
        <GoToLineDialog
          current={goToLineRequest.current}
          lineCount={goToLineRequest.lineCount}
          onGo={(target) => {
            const request = goToLineRequest;
            setGoToLineRequest(null);
            request.apply(target);
          }}
          onCancel={() => {
            const request = goToLineRequest;
            setGoToLineRequest(null);
            request.cancel();
          }}
          restoreFocusFallback={handleReturnToEditor}
        />
      )}
      {keymapMigrationNoticeOpen && !keymapSettingsOpen && (
        <KeymapMigrationNotice
          onOpenKeymap={() => {
            dismissKeymapDefaultsMigrationNotice();
            setKeymapMigrationNoticeOpen(false);
            setKeymapSettingsOpen(true);
          }}
          onDismiss={() => {
            dismissKeymapDefaultsMigrationNotice();
            setKeymapMigrationNoticeOpen(false);
          }}
        />
      )}
      {keymapSettingsOpen && (
        <KeymapSettingsDialog
          open={true}
          snapshot={actionsController.snapshot}
          schemes={keymapSchemes}
          activeSchemeId={activeKeymapSchemeId}
          defaultSchemeName="IDEA defaults"
          corruptDiagnostic={keymapCorruptDiagnostic}
          onActiveSchemeChange={setActiveKeymapSchemeId}
          onSchemesChange={(schemes) => setKeymapSchemes([...schemes])}
          onApplyScheme={applyKeymapScheme}
          presets={BUILTIN_KEYMAP_PRESETS}
          assignActionId={keymapAssignActionId}
          restoreFocusFallback={handleReturnToEditor}
          onClose={() => {
            setKeymapSettingsOpen(false);
            setKeymapAssignActionId(null);
          }}
        />
      )}
      <CodeStyleSettingsDialog
        open={codeStyleSettingsOpen}
        store={codeStyleSchemes}
        activeLanguageId={(() => {
          const ext = activeFile?.languagePath.split(".").pop()?.toLowerCase() ?? "";
          return ext || null;
        })()}
        provenance={activeFile ? {
          filePath: activeFile.subtitle,
          effectiveLabel: getEffectiveCodeStyleForFile(activeFile)?.label ?? "—",
          source: getEffectiveCodeStyleForFile(activeFile)?.source ?? "fallback",
          schemeName: activeSchemeForLanguage(
            codeStyleSchemes,
            activeFile.languagePath.split(".").pop()?.toLowerCase() || null,
          ).name,
        } : null}
        onChange={changeCodeStyleSchemes}
        onClose={() => setCodeStyleSettingsOpen(false)}
      />
      {dapGuideOpen && (
        <DapAdapterGuideDialog
          open={true}
          onClose={() => setDapGuideOpen(false)}
        />
      )}
      {breakpointPopup && (() => {
        const target = debug.breakpoints[breakpointPopup.path]?.find((bp) => bp.line === breakpointPopup.line);
        if (!target) return null;
        return (
          <BreakpointPopup
            key={`${breakpointPopup.path}:${breakpointPopup.line}`}
            path={breakpointPopup.path}
            breakpoint={target}
            anchor={breakpointPopup.anchor}
            expanded={breakpointPopup.expanded}
            otherBreakpoints={Object.entries(debug.breakpoints).flatMap(([path, list]) => (
              list.map((bp) => ({ path, line: bp.line }))
            ))}
            onChange={(options) => debug.setBreakpointOptions(breakpointPopup.path, breakpointPopup.line, options)}
            onMore={() => {
              setBreakpointPopup(null);
              setBreakpointsDialog({ initial: { path: breakpointPopup.path, line: breakpointPopup.line } });
            }}
            onClose={() => setBreakpointPopup(null)}
          />
        );
      })()}
      {gutterMenu && (
        <GutterBreakpointMenu
          menu={gutterMenu}
          onClose={() => setGutterMenu(null)}
          onAdd={(kind) => {
            const { path, line, x, y } = gutterMenu;
            setGutterMenu(null);
            if (kind === "plain") {
              debug.addBreakpoint(path, line);
            } else if (kind === "conditional") {
              debug.addBreakpoint(path, line);
              openBreakpointPopup(path, line, { x, y });
            } else {
              debug.addBreakpoint(path, line, { suspend: false, logHitMessage: true });
              openBreakpointPopup(path, line, { x, y }, true);
            }
          }}
        />
      )}
      {breakpointsDialog && (
        <BreakpointsDialog
          debug={debug}
          initial={breakpointsDialog.initial}
          onOpenBreakpoint={(path, line) => openDebugFrame({ path, line })}
          onClose={() => setBreakpointsDialog(null)}
        />
      )}
      {evaluateDialog && (
        <EvaluateExpressionDialog
          debug={debug}
          initialExpression={evaluateDialog.expression}
          onClose={() => setEvaluateDialog(null)}
        />
      )}
      {newJavaClassDialogState && (
        <NewJavaClassDialog
          open={newJavaClassDialogState.open}
          targetDirectory={newJavaClassDialogState.targetDirectory}
          sourceRoots={newJavaClassDialogState.sourceRoots}
          existingFiles={newJavaClassDialogState.existingFiles}
          projectFactsStatus={newJavaClassDialogState.projectFactsStatus}
          onClose={() => setNewJavaClassDialogState(null)}
          onCreate={createJavaClassFromPlan}
          onOpenSettings={() => setFileTemplateSettingsOpen(true)}
        />
      )}
      <FileTemplateSettingsDialog
        open={fileTemplateSettingsOpen}
        onClose={() => setFileTemplateSettingsOpen(false)}
      />
      <AutoImportSettingsDialog
        open={autoImportSettingsOpen}
        onClose={() => setAutoImportSettingsOpen(false)}
      />
      {autoImportCandidatePrompt && (
        <AutoImportCandidateDialog
          open={true}
          candidates={autoImportCandidatePrompt.candidates}
          onSelect={autoImportCandidatePrompt.onSelect}
          onClose={autoImportCandidatePrompt.onClose}
        />
      )}
      {workspaceUndoConfirmOpen && (
        <UndoWorkspaceEditConfirmDialog
          label={workspaceEditHistoryState.undoLabel}
          returnFocusTo={undoConfirmTriggerRef.current}
          onCancel={closeWorkspaceUndoConfirmation}
          onConfirm={() => {
            setWorkspaceUndoConfirmOpen(false);
            void undoWorkspaceEdit();
          }}
        />
      )}
      {extractNamingPrompt && (
        <div data-testid="extract-method-name-prompt" onKeyDown={handleExtractNamingTab}>
          <TextInputDialog
            title={extractNamingPrompt.title}
            label={extractNamingPrompt.label}
            initialValue={extractNamingPrompt.initialValue}
            confirmLabel={extractNamingPrompt.confirmLabel}
            onCancel={() => resolveExtractNamingPrompt(null)}
            onConfirm={(value) => resolveExtractNamingPrompt(value)}
          />
        </div>
      )}
      </WorkspaceObservationBoundary>
    </WorkspaceClipboardSessionContext.Provider>
  );
}





















export { type CodeWorkspaceGitManagerPayload, isDeclarationDefinitionEquivalentLanguage, extractContextSnippet, debugCurrentLineForFile } from "./workspace/controller/model";
