import { Fragment, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { AlertTriangle, Activity, ArrowLeft, ArrowRight, Braces, GitBranch, GitCommitHorizontal, ListTree, GitFork, Network, ListTodo, Loader2, RefreshCw, RotateCcw, Save, BookOpen, PanelRight, Columns2, Rows2, TerminalSquare, Play, Hammer, FlaskConical, Bug, Search, X, ZoomIn, ZoomOut, WrapText, Columns3, ShieldCheck, Link2, AlignHorizontalJustifyCenter, Maximize2, Square, SlidersHorizontal, FolderTree, MoreVertical, Settings as SettingsIcon } from "lucide-react";
import { workspaceListDir, workspaceReadFile, workspaceReadLooseFile, workspaceReadFileWithEncoding, workspaceReadLooseFileWithEncoding, workspaceJavaRunTarget, workspaceExecutionModel, workspaceTaskTree, workspaceTestResults, workspaceWriteFileEncoded, workspaceWriteLooseFileEncoded, type WorkspaceFile, type WorkspaceExecutionModel, type ExecutionRunConfiguration, type ExecutionDebugConfiguration, type ExecutionBuildTarget, type WorkspaceToolConfig, type StructuredTestResult, type StructuredTestResults, type WorkspaceWriteAck } from "../../lib/editor/workspace";
import type { WorkspaceSearchMatch } from "../../lib/editor/workspaceSearch";
import { gitBlameLines, gitBlobPair, type GitBlameLine, type GitChange } from "../../lib/git";
import { lspCodeActionResolve, lspCompletion, lspCompletionResolve, lspDocumentSymbols, lspDocumentHighlights, lspFormatting, lspDeclaration, lspDefinition, lspCancelReferenceRequest, lspHover, lspImplementation, lspInlayHints, lspJavaModules, javaTestDiscover, javaTestResolveLaunch, lspPrepareRename, lspRangeFormatting, lspResolveWorkspaceEdit, lspDownloadSources, lspWorkspaceDidChangeWatchedFiles, lspStartWorkspaceWatcher, lspStopWorkspaceWatcher, lspReloadProject, lspBuildWorkspace, lspWorkspaceDiagnostics, lspSelectionRanges, lspSemanticTokens, lspSignatureHelp, lspTypeDefinition, lspWorkspaceSymbolResolve, lspWorkspaceSymbols, nextLspRequestSequence, type LspCodeAction, type JavaTestItem, type LspCompletionResolveResult, type LspCompletionResult, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentSymbol, type LspDocumentHighlight, type LspInlayHint, type LspSemanticToken, type LspLocation, type LspPosition, type LspRange, type LspWorkspaceEdit, type LspWorkspaceApplyEditRequest, type LspWorkspaceEditOperation, type LspExternalFileChange } from "../../lib/editor/lsp";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { selectFilePath } from "../../lib/ipc";
import { loadCodeViewProfile } from "../../lib/codeViewProfile";
import { registerShellKeyClaim } from "../../lib/shellKeyClaims";
import { useAppStore } from "../../stores/appStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { createEditorGroup, selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type CodeWorkspaceEditorGroupState, type EditorGroupId, type EditorSplitOrientation, type RightPaneTabId } from "../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "./workspace/editorGroupTypes";
import { useCodeWorkspaceStatusStore, type WorkspaceEol } from "../../stores/codeWorkspaceStatusStore";
import { type EffectiveCodeStyle, type ExplicitIndentationOverride, resolveEffectiveCodeStyle } from "./workspace/codeStyleModel";
import type { ResolvedCodeStyle } from "./workspace/editorConfigResolver";
import { createWorkspaceStyleController, type PreparedSaveCommitter, type WorkspaceStyleController } from "./workspace/workspaceStyleController";
import type { CompletionAcceptanceDiagnostic, CompletionInvocationRequest, CompletionRequestIdentity, CompletionRequestToken } from "./workspace/lspCompletion";
import { resolveCompletionScopeFacts, sameCompletionScopeFacts, type CompletionScopeFactsState } from "./workspace/completionScopeAdapter";
import { buildFinalBytesReceipt, buildPreparedSave, classifySaveWriteback, classifyUnknownDiskEffect, nextSaveTransactionId, prepareSaveTextForWriter, resolveUnknownDiskResolution, resolveWritePolicy, saveCommitResultFromError, SaveTransactionRegistry, validatePreparedSaveBoundary, type DiskResolution, type PreparedSave, type SaveCommitResult } from "./workspace/saveCommit";
import { type SaveObservationRecord, type SaveObservationState } from "./workspace/saveObservationContract";
import { applySaveRaceWriteFault, holdSaveRaceStage, recordSaveRaceEvent } from "./workspace/saveRaceProbe";
import { hasBlockingDiskEffectResolution, listDiskEffectLedgerEntries, recordDiskEffectLedgerEntry, resolveDiskEffectLedgerEntry, workspaceFileIdentity, type WorkspaceDiskEffectLedgerEntryV4 } from "./workspace/workspaceRecovery";
import { applyTabPolicyGroupImagesToLayout, applyWorkspaceTabPolicyTransaction, pushClosedTab, buildReopenTreeRoute, DEFAULT_WORKSPACE_TAB_POLICY_V3, type ClosedTabEntry, type WorkspaceTabPolicyV3 } from "./workspace/workspaceTabPolicy";
import { listToolWindowsForCycle, syncBottomDockToolWindows, unregisterAllToolWindows } from "./workspace/toolWindowRegistry";
import { attachWorkspaceMouseDispatcher } from "./workspace/workspaceMouseDispatcher";
import { createWorkspaceLocationController, isPathContainedInRoot, NavigationHistoryFacade, workspacePathComparisonKey, type BackForwardHistoryBridge, type WorkspaceLocationController } from "./workspace/navigationHistoryModel";
import { WorkspaceSemanticQueryHost, type SemanticQueryIdentity, type SemanticQueryKind, type SemanticQueryLiveGuards } from "./workspace/workspaceSemanticQueryHost";
import { createSingleLeafLayout, findLeafNode, getAllLeafNodes, navigateLeafOrder, panelLayoutToRatios, cloneLayoutTree, type LayoutNode } from "./workspace/recursiveLayoutTree";
import { historyList, historyRead, historySnapshot, type LocalHistoryEntry } from "../../lib/localHistory";
import { defaultWorkspaceLayoutSnapshot, enrichViewStatesWithIdentity, layoutSnapshotHasOpenFiles, readWorkspaceLayoutSnapshot, snapshotFromWorkspaceUi, uniqueOrderedKeys, writeWorkspaceLayoutSnapshot, type PersistedEditorViewState, type WorkspaceViewStates } from "./workspace/workspaceLayoutPersistence";
import { LocalHistoryDialog } from "./workspace/LocalHistoryDialog";
import { CodeStyleSettingsDialog } from "./workspace/CodeStyleSettingsDialog";
import { WorkspaceTabPolicySettingsDialog } from "./workspace/WorkspaceTabPolicySettingsDialog";
import { NewJavaClassDialog } from "./workspace/NewJavaClassDialog";
import { FileTemplateSettingsDialog } from "./workspace/FileTemplateSettingsDialog";
import { AutoImportSettingsDialog } from "./workspace/AutoImportSettingsDialog";
import { AutoImportCandidateDialog } from "./workspace/AutoImportCandidateDialog";
import { loadAutoImportPreferences } from "../../lib/autoImportPreferences";
import { type AutoImportCandidate } from "./workspace/autoImportModel";
import type { PlanTemplateCreationResult } from "./workspace/fileTemplateModel";
import { filterFormattingRanges } from "./workspace/workspaceCodeStyleScheme";
import { BUILT_IN_SCHEME_ID, activeSchemeForLanguage, readCodeStyleSchemeStore, schemeStyleFields, writeCodeStyleSchemeStore, type CodeStyleSchemeStoreState } from "./workspace/workspaceCodeStyleSchemes";
import { EditorSelectionAiToolbar } from "./workspace/EditorSelectionAiToolbar";
import { CONTEXT_LINE_RADIUS, MAX_DIAGNOSTICS, buildEditorAiPrompt, describeScopeChain, extractImports, fenceLanguageFor, languageLabelFor, surroundingLines, truncateSelection, type EditorAiAction, type EditorAiContext } from "./workspace/editorAiPrompts";
import { nextAnswerLanguage, readEditorAiPreferences, writeEditorAiPreferences } from "./workspace/editorAiPreferences";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { EditorAiRewriteDialog } from "./workspace/EditorAiRewriteDialog";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { readText, readTextResult, writeText } from "../../lib/clipboard";
import { useContextMenu, type ContextMenuCloseReason } from "../ContextMenu";
import { useChatStore } from "../../stores/chatStore";
import { type EditorCommandId, type EditorCommandOptions, type EditorCommandPort, type EditorCommandPortRegistration, type EditorCommandState, type EditorCommandTarget, type EditorContextMenuRequest, type EditorSelectionRange } from "./workspace/CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "./workspace/workspaceDocumentTransactionOwner";
import { SurroundWithDialog } from "./workspace/SurroundWithDialog";
import { GenerateCodeDialog } from "./workspace/GenerateCodeDialog";
import { applyGenerateSelection, type GenerateCandidate } from "./workspace/generateCodeWorkflow";
import { filterGenerateCodeActions } from "./workspace/workspaceSemanticEditing";
import { copyReferenceCandidates } from "./workspace/workspaceCopyReference";
import { ClipboardHistoryPopup } from "./workspace/ClipboardHistoryPopup";
import { acquireClipboardStore, createDefaultClipboardPermissionAdapter, type EditorClipboardSession, WorkspaceClipboardSessionContext } from "./workspace/workspaceClipboardSession";
import type { ClipboardObservationRecord } from "./workspace/clipboardObservationContract";
import { WorkspaceObservationBridge } from "./workspace/workspaceObservationBridge";
import { WorkspaceObservationBoundary } from "./workspace/WorkspaceObservationBoundary";
import { buildEditorContextMenuItems } from "./workspace/editorContextMenu";
import { fieldDeclarationAt } from "./workspace/dataBreakpointTarget";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { isTauriRuntime } from "../../lib/runtime";
import { useMountedRef } from "../../hooks/useMountedRef";
import { fallbackWordHighlights, wordAt } from "./workspace/lspIntelligenceChrome";
import { inlayHintsEnabledForLanguage, readWorkspaceIntelligencePreferences, writeWorkspaceIntelligencePreferences, type WorkspaceIntelligencePreferences } from "./workspace/intelligencePreferences";
import { WorkspaceLspSessionManager } from "./workspace/workspaceLspSessionManager";
import { applyLspTextEditsToString } from "./workspace/lspTextEdits";
import { isLargeFileContent } from "./workspace/largeFile";
import { workspaceEditApplyResponse, type WorkspaceEditApplyTransactionSummary } from "./workspace/workspaceEditApply";
import { formatWorkspaceEditPreview, workspaceEditOperations, type WorkspaceEditPreview } from "./workspace/workspaceEditPreview";
import { RefactoringPreviewDialog } from "./workspace/RefactoringPreviewDialog";
import { EditorView } from "@codemirror/view";
import { InlineRenamePopup, type InlineRenameAnchor } from "./workspace/InlineRenamePopup";
import { inlineRenameNameError, showInlineRenameMarks, suggestInlineRenameNames, type InlineRenameRange } from "./workspace/inlineRename";
import { readRefactorOptionsMode, writeRefactorOptionsMode } from "./workspace/refactorOptions";
import { javaMainRunLines, type RunGutterTarget } from "./workspace/runGutter";
import { RefactorRecoveryReviewDialog } from "./workspace/RefactorRecoveryReviewDialog";
import { getRefactorRecoveryJournalV2, updateRefactorRecoveryJournalV2, listRefactorRecoveryJournalsV2, isPendingRefactorRecoveryEntry, dismissRefactorRecoveryEntry, type RefactorPlanV3, type RefactorRecoveryJournalEntryV2 } from "./workspace/refactorPlan";
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
import { TabSwitcher, switcherArrowIndex, type TabSwitcherEntry, type TabSwitcherToolWindow } from "./workspace/TabSwitcher";
import { DapAdapterGuideDialog } from "./workspace/DapAdapterGuideDialog";
import { disabledReasonLabel } from "./workspace/workspaceCodeMirrorKeymap";
import { buildWorkspacePathSnapshotEdit, WorkspaceEditHistory, type WorkspaceEditPathSnapshot } from "./workspace/workspaceEditHistory";
import { evidencePresentationLine } from "./workspace/capabilityEvidence";
import { toProviderDiagnosticsV3 } from "./workspace/inspectionProviderAdapter";
import { IntentionSession } from "./workspace/intentionSession";
import { CanonicalCodeActionService, extractAffectedResourcesFromWorkspaceEdit, type CodeActionTransactionSnapshot } from "./workspace/codeActionProviderAdapter";
import type { MenuItem } from "../ContextMenu";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "./workspace/workspaceResourceRecoveryCoordinator";
import { BottomDock, BOTTOM_DOCK_MIN_HEIGHT, BOTTOM_DOCK_MAX_HEIGHT, type BottomDockTab } from "./workspace/panels/BottomDock";
import { MoreToolWindowsButton, ToolWindowRail, type ToolWindowRailItem } from "./workspace/panels/ToolWindowRail";
import { useLatestHandlers } from "./workspace/useLatestHandlers";
import { useToolWindowLayout } from "./workspace/useToolWindowLayout";
import { ToolWindowPane, ToolWindowPortal, ToolWindowSlot, ToolWindowSplitArea, useToolWindowNodes } from "./workspace/panels/ToolWindowHost";
import { TOOL_WINDOW_ANCHORS, TOOL_WINDOW_ANCHOR_LABELS, anchorSide, type ToolWindowAnchor } from "./workspace/toolWindowLayout";
import { workspaceNavigationSegments } from "./workspace/workspaceNavigationBar";
import { ReferencesPanel, type ReferencesResultState } from "./workspace/panels/ReferencesPanel";
import { ProblemsPanel, type ProblemFileGroup, type ProblemsScope } from "./workspace/panels/ProblemsPanel";
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
import { findFileCoverage, parseCoverageReport, type WorkspaceCoverageReport } from "./workspace/coverageModel";
import { findBookmarkByMnemonic, isValidMnemonic, mergeWorkspaceBookmarkSnapshot, normalizeMnemonic, readWorkspaceBookmarks, renameWorkspaceBookmarkGroup, restoreWorkspaceBookmarksForFile, setMnemonicBookmark, toggleWorkspaceBookmark, writeWorkspaceBookmarks, type WorkspaceBookmark } from "./workspace/todoBookmarks";
import { createOccurrenceSession, formatOccurrenceStatus, isOccurrenceSessionValid, stepOccurrence, type OccurrenceHighlightSession } from "./workspace/occurrenceHighlightModel";
import { selectActiveBanners, type EditorBannerItem } from "./workspace/editorBannerModel";
import { readHighlightingLevel, writeHighlightingLevel, type HighlightingLevel } from "./workspace/highlightingLevelModel";
import { classifyCompareReadError, createClipboardCompareSession, createFileCompareSession, createUnavailableCompareSession, MAX_COMPARE_SIZE_BYTES, normalizeCompareText, type CompareSelection, type CompareTarget, type EditorCompareSession } from "./workspace/editorCompareModel";
import { EditorCompareDialog } from "./workspace/EditorCompareDialog";
import { HighlightingWidget } from "./workspace/HighlightingWidget";
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
import { selectQueryProjectGeneration } from "./workspace/projectFactsConsumers";
import { DEFAULT_SCOPE_SELECTION, UsageQuerySession, type UsagesScopeSelection } from "./workspace/usageQuerySession";
import { UsagesScopeDialog } from "./workspace/UsagesScopeDialog";
import { type LocationPeekState } from "./workspace/LocationPeek";
import { type GoToSymbolQueryResult, type GoToSymbolItem, type SearchEverywhereMode } from "./workspace/SearchEverywhere";
import { type RecentFileEntry } from "./workspace/RecentFilesPopup";
import { EditorGroup } from "./workspace/EditorGroup";
import { WorkspacePopupsHost } from "./workspace/WorkspacePopupsHost";
import { UndoWorkspaceEditConfirmDialog } from "./workspace/UndoWorkspaceEditConfirmDialog";
import { WorkspaceSdkStatus } from "./workspace/WorkspaceSdkStatus";
import { ProjectFactsStatusBadge } from "./workspace/ProjectFactsStatusBadge";
import { WorkspaceBuildRunToolsDialog } from "./workspace/WorkspaceBuildRunToolsDialog";
import { WorkspaceIntelligenceSettingsDialog } from "./workspace/WorkspaceIntelligenceSettingsDialog";
import { WorkspaceEditorAppearanceSettingsDialog } from "./workspace/WorkspaceEditorAppearanceSettingsDialog";
import { DEFAULT_EDITOR_APPEARANCE_PROFILE, matchesBreadcrumbLanguage, matchesSoftWrapPath, normalizeEditorAppearanceProfile, readEditorAppearanceProfileWithDiagnostics, writeEditorAppearanceProfile, type EditorAppearanceProfile } from "./workspace/editorAppearanceProfile";
import { applyRunConfigurationOverride, applyRunOverrideToDebugConfiguration, applyRunOverrideToJavaLaunch, javaRunTargetToExecutionRunConfiguration, materializeRunConfigurations, parseDotEnv, readActiveRunConfigurationSelection, readRunConfigurationOverrides, resolveEnvironmentFilePath, RUN_CONFIGURATION_CHANGED_EVENT, writeActiveRunConfigurationSelection } from "./workspace/runConfigurationPersistence";
import { executeTaskPlan, resolveBuildTargetPlan } from "./workspace/executionPlan";
import { FileTreePane } from "./workspace/FileTreePane";
import { ProjectTree } from "./workspace/ProjectTree";
import { navigateProjectTree } from "./workspace/projectTreeNavigation";
import { MarkdownPreview } from "./workspace/MarkdownPreview";
import { IconButton, LspStatusPill } from "./workspace/workspaceChrome";
import { OutlinePane } from "./workspace/OutlinePane";
import { useDeferredGitLineChanges } from "./workspace/useDeferredGitLineChanges";
import { useWorkspaceActionsController } from "./workspace/useWorkspaceActionsController";
import { eventLogicalKey, type WorkspaceCommand, type WorkspaceCommandContext } from "./workspace/workspaceCommands";
import type { ShellShortcutClaim } from "./workspace/shellShortcutRouter";
import type { WorkspaceFocus } from "./workspace/workspaceActionRegistry";
import { buildReplaceWorkspaceEdit, workspaceSearchMatchKey } from "./workspace/buildReplaceEdits";
import { codePointOffsetToUtf16Offset, collectReplacePreimages, replaceMatchAbsolutePath, replacePreimageExpectedHashes, replacePreimagePathKey, searchMatchesToReplaceInputs, summarizeReplaceCommitReport, validateReplacePreflight, validateReplacePreviewSelection, verifyReplaceMatchFreshness, type ReplaceFilePreimage, type ReplacePreflightFileInput, type ReplacePrepareOptions } from "./workspace/replaceInFilesModel";
import type { CodeWorkspaceFileRef, CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../types";
import { type LibraryBufferInfo, type LspFileState, type MarkdownViewMode, type OpenFileState, type TreeSelection, type TreeViewMode, type WorkspaceBuildRunTools, type WorkspaceTreeCommandPayload, readWorkspaceBuildRunTools, writeWorkspaceBuildRunTools, workspaceToolConfig, CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE, CODE_WORKSPACE_MAX_FONT_SIZE, CODE_WORKSPACE_MAX_TREE_FONT_SIZE, CODE_WORKSPACE_MIN_FONT_SIZE, CODE_WORKSPACE_MIN_TREE_FONT_SIZE, absoluteWorkspacePath, basename, clampCodeWorkspaceFontSize, clampCodeWorkspaceTreeFontSize, emptyLspFileState, errorMessage, fileKey, formatBytes, formatMtime, gitRootForWorkspacePath, gitPathForWorkspacePath, gitRootsForWorkspaceRoot, initialFileRef, initialLooseFiles, initialRoots, isExternalHref, isLspFeatureReady, isMarkdownPath, applyEditorEol, lspPresetIdForPath, shouldLiveSyncLsp, shouldProbeLsp, makeLibraryFile, fsPathComparisonKey, fsPathEquals, normalizeEditorText, normalizeFsPath, parentPath, readCodeWorkspaceTreeFontSize, relativePathWithinRoot, resolveLooseMarkdownLink, resolveRootMarkdownLink, rootDirKey, shouldHideEntry, workspacePathForGitPath, workspaceTitle, writeCodeWorkspaceTreeFontSize, writeCodeWorkspaceTreeViewMode } from "./workspace/codeWorkspaceModel";
import { useWorkspaceTreeData } from "./workspace/useWorkspaceTreeData";
import { LSP_DIAGNOSTICS_REFRESH_EVENT, useWorkspaceLspSession } from "./workspace/useWorkspaceLspSession";
import { useWorkspaceGitSnapshots } from "./workspace/useWorkspaceGitSnapshots";
import { useWorkspaceNavigation } from "./workspace/useWorkspaceNavigation";
import { useWorkspaceFileActions } from "./workspace/useWorkspaceFileActions";
import { Breadcrumbs, symbolChainAtPosition, type BreadcrumbPathAction, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "./workspace/Breadcrumbs";
import { useT } from "../../lib/i18n";
import { TerminalDockPanel, type TerminalDockHandle } from "./workspace/panels/TerminalDockPanel";
import { RunPanel, type RunPanelHandle, type WorkspaceTaskItem } from "./workspace/panels/RunPanel";
import { BuildPanel } from "./workspace/panels/BuildPanel";
import { AnalysisPanel } from "./workspace/panels/AnalysisPanel";
import { TestsPanel } from "./workspace/panels/TestsPanel";
import { javaTestRunCommand, type JavaTestBuildTool } from "./workspace/panels/javaTestRun";
import { DebugPanel } from "./workspace/panels/DebugPanel";
import { JavaMainClassPicker } from "./workspace/JavaMainClassPicker";
import { useCodeDebugSession } from "./workspace/useCodeDebugSession";
import { type JavaMainClassOption } from "../../lib/editor/dap";
import { effectiveSuspend, type DebugBreakpoint, type DebugStackFrame } from "./workspace/dapDebugModel";
import { breakpointMasterKeys, breakpointRefKey, breakpointTooltipLines, masterOf } from "./workspace/debugBreakpointProperties";
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
import { extractBufferMatches, extractReceiptMatches, type ExtractOwnerSnapshot, type ExtractReceipt, type ExtractSession } from "./workspace/extractMethodFlow";
import { TextInputDialog } from "../sidebar/ConfirmDialog";
import { createOpenFile, createHandleExternalFileChange, createCloseFile } from "./workspace/controller/fileActions";
import { createCommitClosedFilePreparedSave, createSaveFile } from "./workspace/controller/saveActions";
import { createOpenHierarchy, createOpenLspLocation, createOpenQuickDocumentation, createNavigateDiagnostic, createRunFindReferences } from "./workspace/controller/navigationActions";
import { createApplyLspResourceOperationUnlocked } from "./workspace/controller/resourceActions";
import { createApplyLspWorkspaceEditNow } from "./workspace/controller/workspaceEditActions";
import { createRunRecoveryRestore } from "./workspace/controller/recoveryActions";
import { createRequestCodeActions, createRunCodeAction, createShowCodeActionsMenu } from "./workspace/controller/codeActionActions";
import { createExecuteAutoImportOnTheFly, createExecutePasteWithAutoImport, createRunRearrangeExecute, createRunCleanupExecute } from "./workspace/controller/styleActions";
import { createWorkspaceCommands } from "./workspace/controller/commandCatalog";
import { createRenameSymbolAt, createContinueExtractNaming, createRunExtractMethod, createSafeDeleteSymbolAtCursor } from "./workspace/controller/refactorActions";
import { createBuildActiveProject, createStartDebugActiveFile, createStartDebugActiveTarget } from "./workspace/controller/runActions";
import { type CodeWorkspaceTabProps, type PendingExternalFileConflict, type PendingExternalFileEvent, WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES, type TabPolicyLifecycleReceiptView, type ExtractSessionState, type ExtractNamingPromptState, type ResourceCleanupRecoveryView, TREE_DETAILS_STORAGE_KEY, type PendingClosedFile, extractContextSnippet, LSP_CHANGE_SYNC_DELAY_MS, LSP_FEATURE_SYNC_WAIT_MS, EDITOR_TEXT_COMMIT_IDLE_DELAY_MS, type WorkspaceEditTabSnapshot, compareSelectionFromEditorSelection, compareTargetForOpenFile, compareDescriptorForOpenFile, type FormatFileOutcome, type ExternalDiskSnapshot, externalDiskSnapshot, coalesceExternalFileChange, EXTERNAL_FILE_EVENT_SETTLE_MS, EMPTY_DISPLAY_DIAGNOSTICS, LSP_HIGHLIGHT_IDLE_DELAY_MS, initialInlayHintRange, LSP_INLAY_HINT_IDLE_DELAY_MS, LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS, breadcrumbSegmentsForFile, LSP_DOCUMENT_SYMBOLS_IDLE_DELAY_MS, type CodeWorkspaceGitManagerPayload, encodingSupportsBom, type LspLocationOpenOptions, compareTargetMatches, replaceCompareSelection, semanticLocationsFromResult, isDeclarationDefinitionEquivalentLanguage, type InlineRenameRequest, type InlineNameResult, isJavaBuildFile, debugCurrentLineForFile, EMPTY_RUN_GUTTER, RECENT_FILES_TOOL_WINDOWS } from "./workspace/controller/model";
import { type TreeOpenIntent, type BufferMutationPatch, type MutationReason, type WorkspaceEditApplyOptions } from "./workspace/controller/mutationTypes";




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
  const [editorAiPreferences, setEditorAiPreferences] = useState(
    () => readEditorAiPreferences(workspaceInstanceId),
  );
  // Read through a ref inside the context-menu builder so a language change
  // does not have to rebuild that callback.
  const editorAiPreferencesRef = useRef(editorAiPreferences);
  editorAiPreferencesRef.current = editorAiPreferences;
  const setAiAnswerLanguage = useCallback((answerLanguage: AiAnswerLanguage) => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  /** Keyboard/command path — steps through the options without opening a menu. */
  const cycleAiAnswerLanguage = useCallback(() => {
    setEditorAiPreferences((current) => {
      const next = { ...current, answerLanguage: nextAnswerLanguage(current.answerLanguage) };
      writeEditorAiPreferences(workspaceInstanceId, next);
      return next;
    });
  }, [workspaceInstanceId]);
  const [bookmarks, setBookmarks] = useState<WorkspaceBookmark[]>(
    () => readWorkspaceBookmarks(workspaceInstanceId),
  );
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const replaceBookmarks = useCallback((next: WorkspaceBookmark[]) => {
    bookmarksRef.current = next;
    setBookmarks(next);
  }, []);
  const restoreBookmarksForFileKey = useCallback((fileKeyValue: string, pathLabel?: string) => {
    const current = bookmarksRef.current;
    if (!current.some((bookmark) => bookmark.fileKey === fileKeyValue && bookmark.state === "missing")) return;
    const next = restoreWorkspaceBookmarksForFile(current, fileKeyValue, pathLabel);
    writeWorkspaceBookmarks(workspaceInstanceId, next);
    replaceBookmarks(next);
  }, [replaceBookmarks, workspaceInstanceId]);
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
  const [gitHeadTextByFile, setGitHeadTextByFile] = useState<Record<string, { sourceKey: string; text: string | null }>>({});
  const [gitBlameByGroup, setGitBlameByGroup] = useState<Record<EditorGroupId, GitBlameLine | null>>({
    primary: null,
    secondary: null,
  });
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
  const gitHeadRequestsRef = useRef(new Set<string>());
  const gitBlameCacheRef = useRef(new Map<string, GitBlameLine | null>());
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
  // ED-PARITY-007: one local Extract Method transaction owner. Ref-backed so
  // the shared candidate menu (defined earlier in this component) can join the
  // same naming chain without a circular hook dependency.
  const extractSessionRef = useRef<ExtractSessionState | null>(null);
  const beginExtractSessionRef = useRef<((input: {
    file: OpenFileState;
    range: LspRange;
    uri: string;
    beforeSymbols: LspDocumentSymbol[] | null;
  }) => ExtractSessionState | null) | null>(null);
  const continueExtractNamingRef = useRef<((receipt: ExtractReceipt) => Promise<void>) | null>(null);
  const captureMethodSymbolsRef = useRef<((file: OpenFileState) => Promise<LspDocumentSymbol[] | null>) | null>(null);
  const finishExtractSessionRef = useRef<((session: ExtractSessionState) => void) | null>(null);
  const runExtractMethodRef = useRef<() => Promise<void>>(async () => {});
  const [extractNamingPrompt, setExtractNamingPrompt] = useState<ExtractNamingPromptState | null>(null);
  const extractNamingPromptRef = useRef<ExtractNamingPromptState | null>(null);
  extractNamingPromptRef.current = extractNamingPrompt;
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

  const beginSemanticQuery = useCallback((
    kind: SemanticQueryKind,
    file: OpenFileState,
    descriptor: LspDocumentDescriptor,
    position: LspPosition,
  ) => {
    const documentRevision = openFilesRef.current[file.key]?.documentRevision ?? file.documentRevision;
    const capturedLspSessionGeneration = lspSessionGeneration();
    const requestId = `${workspaceInstanceId}:${kind}:${++semanticQuerySequenceRef.current}`;
    semanticQueryLatestRequestRef.current[kind] = requestId;
    const cancelKey = `${workspaceInstanceId}|${file.key}`;
    const requestSeq = nextLspRequestSequence();
    // ED-PROJECT-005: pin the ready project-facts generation into the query
    // identity so facts invalidation stales the in-flight request with zero
    // downstream effect. Files without ready same-workspace facts pin nothing
    // and run scope-less instead of leaking a foreign generation.
    // (Mirrors absolutePathForOpenFile: library buffers have no host path.)
    let queryFileAbsPath: string | null = null;
    const queryRef = file.ref;
    if (!file.library) {
      if (queryRef.kind === "loose") {
        queryFileAbsPath = queryRef.path;
      } else {
        const queryRoot = rootsRef.current.find((root) => root.id === queryRef.rootId);
        if (queryRoot) queryFileAbsPath = absoluteWorkspacePath(queryRoot, queryRef.path);
      }
    }
    const capturedFactsGeneration = selectQueryProjectGeneration(projectFactsRoot, queryFileAbsPath);
    const identity: SemanticQueryIdentity = {
      workspaceId: workspaceInstanceId,
      fileKey: file.key,
      uri: descriptor.documentUri ?? descriptor.filePath,
      position,
      documentRevision,
      lspSessionGeneration: capturedLspSessionGeneration,
      ...(capturedFactsGeneration !== undefined ? { projectGeneration: capturedFactsGeneration } : {}),
      requestId,
    };
    const isCurrent = (candidate?: SemanticQueryIdentity): boolean => {
      const current = openFilesRef.current[file.key];
      const currentDescriptor = current ? lspDescriptorForFile(current) : null;
      const currentUri = currentDescriptor?.documentUri ?? currentDescriptor?.filePath;
      return workspaceInstanceIdRef.current === workspaceInstanceId
        && semanticQueryLatestRequestRef.current[kind] === requestId
        && (!candidate || candidate.requestId === requestId)
        && current != null
        && current.documentRevision === documentRevision
        && currentUri === identity.uri
        && lspSessionGeneration() === capturedLspSessionGeneration;
    };
    const guards: SemanticQueryLiveGuards = {
      getLiveDocumentRevision: () => openFilesRef.current[file.key]?.documentRevision ?? -1,
      getLiveLspGeneration: () => lspSessionGeneration(),
      getLiveProjectGeneration: () => useProjectFactsStore.getState().getWorkspaceFacts(projectFactsRoot).generation,
      guardDelivery: (candidate) => isCurrent(candidate),
    };
    return {
      identity,
      cancelKey,
      requestSeq,
      guards,
      isCurrent,
      lspOptions: (signal: AbortSignal) => ({ signal, cancelKey, requestSeq }),
    };
  }, [lspDescriptorForFile, lspSessionGeneration, projectFactsRoot, workspaceInstanceId]);

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

  const persistWorkspaceLayoutNow = useCallback((targetInstanceId = workspaceInstanceId) => {
    if (!targetInstanceId) return;
    if (layoutRestoredOpenFilesRef.current) return;
    // Library buffers come from a live language server, so they cannot be
    // restored on the next launch — keep them out of the persisted layout.
    const persistableGroups = Object.fromEntries(
      (Object.entries(editorGroups) as Array<[EditorGroupId, typeof editorGroups.primary]>)
        .map(([groupId, group]) => [groupId, {
          ...group,
          openOrder: group.openOrder.filter((key) => !libraryBuffersRef.current[key]),
          pinnedKeys: group.pinnedKeys.filter((key) => !libraryBuffersRef.current[key]),
          activeKey: group.activeKey && libraryBuffersRef.current[group.activeKey]
            ? null
            : group.activeKey,
          previewKey: group.previewKey && libraryBuffersRef.current[group.previewKey]
            ? null
            : group.previewKey,
        }]),
    ) as typeof editorGroups;
    writeWorkspaceLayoutSnapshot(targetInstanceId, snapshotFromWorkspaceUi({
      bottomDockOpen,
      bottomDockTab,
      rightPaneOpen,
      rightPaneTab,
      languagePanelOpen,
      splitOrientation,
      activeEditorGroupId,
      expandedRootIds,
      expandedDirKeys,
      editorGroups: persistableGroups,
      layoutTreeV2: workspaceUi.layoutTreeV2,
      tabPolicy: tabPolicyRef.current,
      shellChromeState: workspaceUi.shellChromeState,
      // ED-REPAIR-009: Preserve captured snapshot identities without re-stamping from live text.
      viewStates: enrichViewStatesWithIdentity(
        viewStatesRef.current,
        (fileKey) => openFilesRef.current[fileKey]?.text,
      ),
    }), {
      // §8.17.4 step 3: persistence refusals surface as a recovery
      // diagnostic, not only a console line.
      onIssue: (message) => setStatusMessage(message),
    });
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
  const loadBreadcrumbPathChildren = useCallback(async (
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
    trail: BreadcrumbPathSegment[],
  ): Promise<BreadcrumbPathChild[]> => {
    const segmentIndex = trail.findIndex((item) =>
      item.path === segment.path && item.kind === segment.kind && item.label === segment.label
    );
    // Nothing to browse inside a JAR / decompiled class.
    if (file.library) return [];
    const nextSegment = segmentIndex >= 0 ? trail[segmentIndex + 1] ?? null : null;
    const activeChildPath = nextSegment && nextSegment.kind !== "root" ? nextSegment.path : null;

    const toChildren = (
      entries: Array<{ name: string; path: string; fileType: string; isHidden?: boolean }>,
      pathOf: (entry: { name: string; path: string }) => string,
    ): BreadcrumbPathChild[] => entries
      .filter((entry) => entry.fileType === "file" || entry.fileType === "dir")
      .filter((entry) => !shouldHideEntry({
        name: entry.name,
        path: entry.path,
        fileType: entry.fileType as "file" | "dir" | "symlink" | "other",
        size: 0,
        mtime: 0,
        isHidden: entry.isHidden ?? false,
      }))
      .map((entry) => {
        const path = pathOf(entry);
        const kind = entry.fileType === "dir" ? "directory" as const : "file" as const;
        return {
          label: entry.name,
          path,
          kind,
          active: activeChildPath === path,
        };
      });

    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      const root = rootsRef.current.find((item) => item.id === rootId);
      if (!root) return [];
      // File segment → siblings in parent; directory/root → children of that path.
      const listPath = segment.kind === "file" ? parentPath(segment.path) : segment.path;
      void loadDir(rootId, listPath);
      const result = await workspaceListDir(root.path, listPath);
      if (result.state !== "ready") return [];
      return toChildren([...result.entries], (entry) => entry.path);
    }

    // Loose file: list an absolute directory via workspace_list_dir(dir, "").
    const absolute = normalizeFsPath(segment.path);
    const dirToList = segment.kind === "file" ? parentPath(absolute) : absolute;
    if (!dirToList) return [];
    const result = await workspaceListDir(dirToList, "");
    if (result.state !== "ready") return [];
    return toChildren([...result.entries], (entry) =>
      normalizeFsPath(`${dirToList.replace(/[/\\]+$/, "")}/${entry.name}`)
    );
  }, [loadDir]);

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

  const breadcrumbPathActions = useCallback((
    segment: BreadcrumbPathSegment,
    file: OpenFileState,
  ): BreadcrumbPathAction[] => {
    // Copy path / reveal / open-in-terminal make no sense for a class inside a JAR.
    if (file.library) return [];
    const actions: BreadcrumbPathAction[] = [];
    actions.push({
      id: "reveal-tree",
      label: "Select in Project Tree",
      onSelect: () => {
        if (file.ref.kind !== "root") {
          setSelected({ kind: "file", ref: file.ref });
          treePaneRef.current?.focus();
          return;
        }
        const rootId = file.ref.rootId;
        if (segment.kind === "root") {
          setSelected({ kind: "root", rootId });
          setExpandedRoots((current) => new Set(current).add(rootId));
        } else if (segment.kind === "directory") {
          setSelected({ kind: "dir", rootId, path: segment.path });
          setExpandedRoots((current) => new Set(current).add(rootId));
          setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
          void loadDir(rootId, segment.path);
        } else {
          setSelected({ kind: "file", ref: file.ref });
          revealEditorTabInTree(file.key);
          return;
        }
        treePaneRef.current?.focus();
      },
    });
    if (file.ref.kind === "root") {
      const rootId = file.ref.rootId;
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => { void copyTreePath(rootId, segment.path, true); },
      });
      actions.push({
        id: "copy-relative",
        label: "Copy Relative Path",
        onSelect: () => { void copyTreePath(rootId, segment.path, false); },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => { void revealInExplorer(rootId, segment.path); },
      });
    } else {
      const absolute = normalizeFsPath(segment.path);
      actions.push({
        id: "copy-path",
        label: "Copy Path",
        onSelect: () => {
          void writeText(absolute)
            .then(() => setStatusMessage(`Copied ${absolute}`))
            .catch((err) => setStatusMessage(errorMessage(err)));
        },
      });
      actions.push({
        id: "reveal-explorer",
        label: "Reveal in Explorer",
        onSelect: () => {
          void invoke("sftp_open_path", { path: absolute })
            .then(() => setStatusMessage(`Opened ${absolute}`))
            .catch((err) => setStatusMessage(errorMessage(err)));
        },
      });
    }
    return actions;
  }, [copyTreePath, loadDir, revealEditorTabInTree, revealInExplorer, setStatusMessage]);

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
    (event: React.MouseEvent, selection: TreeSelection) => {
      setSelected(selection);
      treeContextMenuSessionRef.current = {
        workspaceInstanceId,
        selection,
        consumed: false,
      };
      const run = (commandId: string, payload: WorkspaceTreeCommandPayload) => () => {
        if (treeContextMenuSessionRef.current) {
          treeContextMenuSessionRef.current.consumed = true;
        }
        workspaceCommandRunnerRef.current(commandId, { focus: "tree", payload });
      };
      const clipboardItems = (
        rootId: string,
        path: string,
        directory: { rootId: string; path: string },
        isDirectory: boolean,
      ) => [
        {
          label: "Cut",
          onClick: () => stageTreeClipboard("cut", rootId, path, isDirectory),
        },
        {
          label: "Copy",
          onClick: () => stageTreeClipboard("copy", rootId, path, isDirectory),
        },
        {
          label: "Paste",
          disabled: !canPasteTreeClipboard(),
          onClick: () => void pasteTreeClipboard(directory),
        },
      ];
      if (selection.kind === "file") {
        if (selection.ref.kind === "loose") {
          const ref = selection.ref;
          const absolute = normalizeFsPath(ref.path);
          openTreeContextMenu(event, [
            { label: "Open", onClick: run("workspace.tree.open", { selection }) },
            { separator: true, label: "" },
            { label: "Copy Path", onClick: () => void writeText(absolute) },
            {
              label: "Reveal in Explorer",
              onClick: () => {
                void invoke("sftp_open_path", { path: absolute })
                  .then(() => setStatusMessage(`Opened ${absolute}`))
                  .catch((err) => setStatusMessage(errorMessage(err)));
              },
            },
          ]);
          return;
        }
        const ref = selection.ref;
        const dir = parentPath(ref.path);
        openTreeContextMenu(event, [
          { label: "Open", onClick: run("workspace.tree.open", { selection }) },
          { separator: true, label: "" },
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: ref.rootId, path: dir } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(ref.rootId, ref.path, { rootId: ref.rootId, path: dir }, false),
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: ref.rootId, path: ref.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: ref.rootId, path: ref.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(ref.rootId, ref.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(ref.rootId, ref.path, true) },
        ]);
        return;
      }
      if (selection.kind === "dir") {
        openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: selection.path } }) },
          { label: "Rename...", onClick: run("workspace.tree.rename", { selection }) },
          { label: "Delete", danger: true, onClick: run("workspace.tree.delete", { selection }) },
          { label: "Add to .gitignore", onClick: run("workspace.tree.addToGitignore", { selection }) },
          { separator: true, label: "" },
          ...clipboardItems(
            selection.rootId,
            selection.path,
            { rootId: selection.rootId, path: selection.path },
            true,
          ),
          { separator: true, label: "" },
          { label: "Find in Directory...", onClick: run("workspace.tree.findInDirectory", { path: selection.path }) },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: selection.path }) },
          { label: "Copy Relative Path", onClick: run("workspace.tree.copyRelativePath", { rootId: selection.rootId, path: selection.path }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, selection.path),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, selection.path) },
        ]);
        return;
      }
      if (selection.kind === "root") {
        openTreeContextMenu(event, [
          { label: "New File...", onClick: run("workspace.tree.newFile", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Java Class...", onClick: run("workspace.tree.newJavaClass", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "New Directory...", onClick: run("workspace.tree.newDirectory", { directory: { rootId: selection.rootId, path: "" } }) },
          { label: "Rename Root...", onClick: run("workspace.tree.rename", { selection }) },
          { separator: true, label: "" },
          {
            label: "Paste",
            disabled: !canPasteTreeClipboard(),
            onClick: () => void pasteTreeClipboard({ rootId: selection.rootId, path: "" }),
          },
          { separator: true, label: "" },
          { label: "Copy Path", onClick: run("workspace.tree.copyPath", { rootId: selection.rootId, path: "" }) },
          {
            label: "Reveal in Explorer",
            onClick: () => void revealInExplorer(selection.rootId, ""),
          },
          { label: "Open in Terminal", onClick: () => openTerminalAt(selection.rootId, "") },
          { separator: true, label: "" },
          { label: "Remove from Workspace", danger: true, onClick: run("workspace.tree.delete", { selection }) },
        ]);
      }
    },
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

  const mutateOpenBuffer = useCallback((
    key: string,
    patch: BufferMutationPatch,
    reason: MutationReason,
  ): OpenFileState | null => {
    const current = openFilesRef.current[key];
    if (!current) return null;

    const nextText = reason === "save-metadata" ? current.text : (patch.text !== undefined ? patch.text : current.text);
    const nextSavedText = patch.savedText !== undefined ? patch.savedText : current.savedText;
    const isTextChanged = reason !== "save-metadata" && patch.text !== undefined && patch.text !== current.text;

    let nextRevision = current.documentRevision ?? 0;
    if (reason === "save-writeback") {
      nextRevision = patch.documentRevision !== undefined
        ? Math.max(current.documentRevision ?? 0, patch.documentRevision)
        : (current.documentRevision ?? 0);
    } else if (reason === "save-metadata") {
      nextRevision = current.documentRevision ?? 0;
    } else if (isTextChanged || reason === "reload" || reason === "workspace-edit" || reason === "history-replay") {
      nextRevision = (current.documentRevision ?? 0) + 1;
    }

    const calculatedDirty = patch.dirty !== undefined
      ? patch.dirty
      : (nextText !== nextSavedText);

    const next: OpenFileState = {
      ...current,
      ...patch,
      text: nextText,
      savedText: nextSavedText,
      dirty: calculatedDirty,
      documentRevision: nextRevision,
      // Preserve the replay identity across save metadata/writeback for the
      // same text. React may observe these together with the restored text;
      // clearing it early would create a second document undo entry.
      historyReplay: reason === "history-replay"
        || (current.historyReplay === true && !isTextChanged
          && (reason === "save-metadata" || reason === "save-writeback")),
    };

    openFilesRef.current = { ...openFilesRef.current, [key]: next };
    if (reason === "user-edit") {
      pendingEditorTextByFileRef.current.set(key, next);
    } else {
      pendingEditorTextByFileRef.current.delete(key);
      pendingEditorCaretByFileRef.current.delete(key);
      setOpenFiles((prev) => ({ ...prev, [key]: next }));
    }
    return next;
  }, [setOpenFiles]);

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

  const queueEditorTextUpdate = useCallback((
    key: string,
    text: string,
    caret?: LspPosition,
    caretOffset?: number,
  ) => {
    const file = openFilesRef.current[key];
    if (!file || file.text === text) return;
    // ED-PARITY-003 S1: typing promotes any preview tab for this file to a
    // formal tab. EditorGroup's onChange wrapper captures previewKey in a
    // memo-skipped CodeMirrorHost closure, so a preview set without a doc
    // change would never promote there; promote here where the edit is
    // guaranteed to be observed (dirty proves this path runs).
    const liveUiForPreview = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    for (const [previewGroupId, previewGroup] of Object.entries(liveUiForPreview.editorGroups)) {
      if (previewGroup.previewKey === key) {
        updateEditorGroup(previewGroupId as EditorGroupId, (current) => (
          current.previewKey === key ? { ...current, previewKey: null } : current
        ));
      }
    }
    // Once the user starts a new character-level edit, CodeMirror becomes the
    // active undo owner. Retaining an older cross-file transaction here would
    // make Ctrl/Cmd+Z skip over the fresh typing and surprise the user.
    const historyState = workspaceEditHistory.state();
    if (historyState.canUndo || historyState.canRedo) {
      workspaceEditHistory.clear();
      setWorkspaceEditHistoryRevision((revision) => revision + 1);
    }
    const next = mutateOpenBuffer(key, { text, error: null }, "user-edit");
    if (!next) return;
    pendingEditorCaretByFileRef.current.set(key, {
      position: caret ?? editorSelectionRef.current.start,
      offset: caretOffset,
    });
    const activeFilePath = next.path ?? next.title;
    semanticIndex.invalidateSilently("document-edited", [activeFilePath]);
    // Drive didChange from the live buffer only when a language server can
    // actually use it — plain text / missing LSP must not pay IPC cost.
    scheduleLiveLspSync(key);
    if (pendingEditorTextTimerRef.current !== null) {
      window.clearTimeout(pendingEditorTextTimerRef.current);
    }
    pendingEditorTextTimerRef.current = window.setTimeout(
      flushPendingEditorText,
      EDITOR_TEXT_COMMIT_IDLE_DELAY_MS,
    );
  }, [
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

  const readWorkspaceEditPathSnapshot = useCallback(async (
    absolutePath: string,
  ): Promise<WorkspaceEditPathSnapshot | null> => {
    const normalizedPath = normalizeFsPath(absolutePath);
    const open = Object.values(openFilesRef.current).find((file) => {
      const path = absolutePathForOpenFile(file);
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
    for (const root of rootsRef.current) {
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
  }, [absolutePathForOpenFile]);

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
  const buildEditorAiContext = useCallback(async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
    instruction?: string,
  ): Promise<EditorAiContext> => {
    const pathLabel = file.subtitle || file.path;
    const languageId = lspFilesRef.current[file.key]?.status?.languageId ?? null;
    const fenceLanguage = fenceLanguageFor(languageId, file.languagePath);
    const { text: selectionText, truncated } = truncateSelection(text);
    // LSP positions are 0-based; the prompt reports 1-based lines to match the
    // gutter the user is looking at.
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    const scopeChain = describeScopeChain(
      symbolChainAtPosition(
        breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current] ?? [],
        selection.start,
      ),
    );

    const diagnostics = (lspFilesRef.current[file.key]?.diagnostics ?? [])
      .filter((item) => (
        item.range.end.line >= selection.start.line
        && item.range.start.line <= selection.end.line
      ))
      .slice(0, MAX_DIAGNOSTICS)
      .map((item) => {
        const where = `L${item.range.start.line + 1}`;
        const code = item.code ? ` [${item.code}]` : "";
        const source = item.source ? `${item.source}: ` : "";
        return `${where} ${source}${item.message}${code}`;
      });

    const { before, after } = surroundingLines(file.text, startLine, endLine, CONTEXT_LINE_RADIUS);

    // Hover is best-effort: a cold or unsupported server must not block the ask.
    let hover: string | null = null;
    try {
      hover = (await getLspHoverRef.current(file, selection.start))?.body ?? null;
    } catch {
      hover = null;
    }

    return {
      action,
      filePath: pathLabel,
      languageLabel: languageLabelFor(languageId, file.languagePath),
      fenceLanguage,
      selection: selectionText,
      selectionStartLine: startLine,
      selectionEndLine: endLine,
      scopeChain,
      imports: extractImports(file.text, fenceLanguage),
      linesBefore: before,
      linesAfter: after,
      hover,
      diagnostics,
      instruction,
      truncated,
    };
  }, []);

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

  const writeTextSnapshot = useCallback(async (request: {
    fileKey?: string;
    filePath: string;
    logicalText: string;
    expectedDiskHash: string | null;
    policy: {
      eol: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    };
    bufferVersion?: number;
    styleGeneration?: number;
  }): Promise<WorkspaceWriteAck> => {
    const targetEncoding = request.policy.encoding ?? "UTF-8";
    const targetBom = request.policy.bom ?? false;
    const rawEol = request.policy.eol ?? "LF";
    const eol = (typeof rawEol === "string" ? rawEol.toLowerCase() : "lf") as "lf" | "crlf" | "cr";

    const normalizedText = prepareSaveTextForWriter(request.logicalText, {
      eol,
      encoding: targetEncoding,
      bom: targetBom,
    });

    let rootPath: string | null = null;
    let relPath: string | null = null;

    if (request.fileKey) {
      const file = openFilesRef.current[request.fileKey];
      if (file && file.ref.kind === "root") {
        const root = rootsRef.current.find((r) => r.id === (file.ref as { rootId: string }).rootId);
        if (root) {
          rootPath = root.path;
          relPath = file.ref.path;
        }
      }
    }

    if (!rootPath || !relPath) {
      const matchingRoot = rootsRef.current.find(
        (r) => request.filePath.startsWith(r.path + "/") || request.filePath === r.path,
      );
      if (matchingRoot) {
        rootPath = matchingRoot.path;
        relPath = request.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
      }
    }

    const pendingWrite = rootPath && relPath
      ? workspaceWriteFileEncoded(
        rootPath,
        relPath,
        normalizedText,
        request.expectedDiskHash,
        targetEncoding,
        targetBom,
      )
      : workspaceWriteLooseFileEncoded(
        request.filePath,
        normalizedText,
        request.expectedDiskHash,
        targetEncoding,
        targetBom,
      );
    // ED-PARITY-002 QA build only: the real write attempt above runs first;
    // the probe may withhold its response (and optionally delay it) so the
    // production unknown-effect read-back path classifies real disk bytes.
    // A no-op in normal builds and when the probe is not armed.
    let writtenAck: WorkspaceWriteAck | null = null;
    let writeFailure: unknown = null;
    try {
      writtenAck = await pendingWrite;
    } catch (error) {
      writeFailure = error;
    }
    return applySaveRaceWriteFault(request.filePath, writtenAck, writeFailure);
  }, []);

  /**
   * Re-read verification for an unknown-effect IPC failure (§8.18.1): the
   * native layer could not prove whether bytes landed, so the frontend reads
   * the real file back and classifies against the intended/old hashes.
   * Returns null when even the read fails — that stays `unknown`.
   */
  const readBackDiskSnapshot = useCallback(async (
    prepared: PreparedSave,
  ): Promise<Pick<WorkspaceFile, "hash" | "text" | "encoding" | "bom" | "size" | "mtime"> | null> => {
    try {
      const matchingRoot = rootsRef.current.find(
        (r) => prepared.filePath.startsWith(r.path + "/") || prepared.filePath === r.path,
      );
      if (matchingRoot) {
        const relPath = prepared.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
        const read = await workspaceReadFileWithEncoding(matchingRoot.path, relPath, prepared.policy.encoding);
        return read ?? null;
      }
      return await workspaceReadLooseFileWithEncoding(prepared.filePath, prepared.policy.encoding);
    } catch {
      return null;
    }
  }, []);

  /**
   * Record one unresolved unknown-effect ledger row for the recovery center
   * (§8.19.1): the row carries the native intent hash (non-null whenever the
   * encoded bytes were computed) and its blocking is decided by `resolution`
   * — a foreign observed hash never counts as verified.
   */
  const recordUnknownDiskEffect = useCallback((
    prepared: PreparedSave,
    observedHash: string | null,
    intendedNewHash: string | null,
  ): void => {
    const resolution: DiskResolution = resolveUnknownDiskResolution({
      intendedNewHash,
      expectedOldHash: prepared.expectedDiskHash,
      observedHash,
    });
    recordDiskEffectLedgerEntry({
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: (() => {
        const file = openFilesRef.current[prepared.fileKey];
        return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
      })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash,
      observedHash,
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      resolution,
      createdAt: Date.now(),
      // Only confirmed resolutions may claim verification; blocked rows keep
      // a null timestamp so no legacy field can act as "unblocked".
      verifiedAt: resolution === "confirmed-committed" || resolution === "confirmed-none"
        ? Date.now()
        : null,
      resolvedAt: null,
    });
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Record the fact that bytes provably landed on disk but every editor
   * writeback was discarded (§8.19.1): the recovery center shows
   * "saved to disk, buffer state discarded" with Reopen/Acknowledge instead
   * of silently dropping a real disk effect.
   */
  const recordCommittedDiscardLedgerEntry = useCallback((
    prepared: PreparedSave,
    writtenHash: string,
  ): void => {
    const now = Date.now();
    const entry: WorkspaceDiskEffectLedgerEntryV4 = {
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: prepared.fileKey.startsWith("closed:")
        ? prepared.fileKey.slice("closed:".length)
        : (() => {
          const file = openFilesRef.current[prepared.fileKey];
          return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
        })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash: writtenHash,
      observedHash: writtenHash,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      createdAt: now,
      verifiedAt: now,
      resolvedAt: null,
    };
    recordDiskEffectLedgerEntry(entry);
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Shared closed-file committer (§8.19.1). Closed-file WorkspaceEdit writes
   * go through the same PreparedSave identity, byte writer, unknown-effect
   * read-back, recovery ledger and generation-gated watcher effects as
   * open-buffer saves, and return the full typed result — callers must never
   * treat an uncertain write as success.
   */
  const commitClosedFilePreparedSave = useCallback(createCommitClosedFilePreparedSave({
    saveTransactionRegistryRef,
    rootsRef,
    get cancelledSaveCommit() { return cancelledSaveCommit; },
    writeTextSnapshot,
    readBackDiskSnapshot,
    recordUnknownDiskEffect,
    recordCommittedDiscardLedgerEntry,
  }), [
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    writeTextSnapshot,
  ]);

  /** Typed cancellation with provably zero disk effect (§8.18.1). */
  function cancelledSaveCommit(
    prepared: PreparedSave,
    phase: "prepare" | "pre-write",
    reason: string,
  ): SaveCommitResult {
    return {
      kind: "cancelled",
      transactionId: prepared.transactionId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      phase,
      reason,
    };
  }

  /**
   * Single open-buffer save commit core (§8.18.1). Takes an immutable
   * PreparedSave, registers a transaction owner, runs the synchronous
   * pre-write boundary, invokes the one byte writer in the same turn, then is
   * the ONLY result classifier: it reports disk / memory / provider effects
   * verbatim. Bytes landed can never yield plain `cancelled`;
   * close/rename/unmount after the write yields
   * `committed-writeback-discarded`; an uncertain IPC failure is re-read
   * against hashes instead of pretending zero side effects.
   */
  const commitOpenBufferPreparedSave = useCallback(async (
    prepared: PreparedSave,
  ): Promise<SaveCommitResult> => {
    const key = prepared.fileKey;
    const registry = saveTransactionRegistryRef.current;
    const owner = registry.begin(prepared.workspaceId, key, prepared.transactionId);
    try {
      const fileAtPrepare = openFilesRef.current[key];
      if (!fileAtPrepare) {
        return cancelledSaveCommit(prepared, "pre-write", "Open buffer was closed before write");
      }

      mutateOpenBuffer(key, { saving: true, error: null }, "save-metadata");

      let historyId: string | undefined;
      // Prepare-phase await: snapshot the previous on-disk contents before any
      // overwrite. Never mutates buffer text and never bumps a revision.
      if (prepared.filePath && fileAtPrepare.savedText.length <= 2 * 1024 * 1024) {
        const historyText = `${fileAtPrepare.bom ? "\uFEFF" : ""}${applyEditorEol(fileAtPrepare.savedText, fileAtPrepare.eol)}`;
        const historyEntry = await historySnapshot(prepared.filePath, historyText, "save").catch(() => null);
        if (historyEntry) historyId = `local-history-${historyEntry.id}`;
      }

      // ED-PARITY-002 QA build only: the probe may hold this prepare point
      // (writer not yet invoked) so the runner can type a real edit and prove
      // the pre-write boundary cancels with zero writer calls. Immediately
      // resolved in normal builds and when not armed.
      await holdSaveRaceStage({
        stage: "prepare",
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
        revision: () => openFilesRef.current[key]?.documentRevision ?? null,
        stillValid: () => !!openFilesRef.current[key],
      });

      // 2. Pre-write commit boundary (SYNCHRONOUS, NO AWAIT)
      const currentBeforeWrite = openFilesRef.current[key];
      let cancellation: string | null = validatePreparedSaveBoundary(prepared, currentBeforeWrite
        ? {
            filePath: absolutePathForOpenFile(currentBeforeWrite) ?? currentBeforeWrite.path ?? "",
            documentRevision: currentBeforeWrite.documentRevision ?? 0,
            styleGeneration: workspaceStyleControllerRef.current.getGeneration(),
          }
        : null);
      if (!cancellation) {
        const ownerCheck = registry.check(owner);
        if (!ownerCheck.active) cancellation = ownerCheck.reason;
      }
      if (cancellation) {
        mutateOpenBuffer(key, { saving: false }, "save-metadata");
        return cancelledSaveCommit(prepared, "pre-write", cancellation);
      }

      // In the SAME synchronous turn, invoke the byte writer.
      const writerPromise = writeTextSnapshot({
        fileKey: key,
        filePath: prepared.filePath,
        logicalText: prepared.text,
        expectedDiskHash: prepared.expectedDiskHash,
        policy: prepared.policy,
      });
      recordSaveRaceEvent("writer-invoked", {
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
      }, { byteLength: prepared.text.length });

      // ED-PARITY-002 QA build only: the writer above is the real native
      // writer; the probe may hold the ack delivery point (W1) so the runner
      // can type while the UI waits for the real write acknowledgement.
      await holdSaveRaceStage({
        stage: "ack",
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
        revision: () => openFilesRef.current[key]?.documentRevision ?? null,
        stillValid: () => !!openFilesRef.current[key],
      });

      // 3. Writeback phase (merge, never overwrite text; generation-gated)
      try {
        let ack: WorkspaceWriteAck;
        try {
          ack = await writerPromise;
        } catch (writeError) {
          // §8.18.1: classify the typed IPC error by its native effect fact.
          const mapped = saveCommitResultFromError(prepared.transactionId, writeError);
          recordSaveRaceEvent("writer-failed", {
            workspaceId: prepared.workspaceId,
            fileKey: key,
            transactionId: prepared.transactionId,
            filePath: prepared.filePath,
          }, { kind: mapped.kind, diskEffect: mapped.diskEffect ?? null });
          mutateOpenBuffer(key, { dirty: true, saving: false, error: mapped.error.message }, "save-metadata");
          if (mapped.diskEffect === "unknown") {
            // The bridge could not prove whether bytes landed: verify against
            // the real on-disk hash before reporting anything.
            const observed = await readBackDiskSnapshot(prepared);
            const verification = classifyUnknownDiskEffect({
              writtenHash: mapped.error.intentHash ?? mapped.error.writtenHash,
              expectedOldHash: prepared.expectedDiskHash,
              observedHash: observed?.hash ?? null,
            });
            recordSaveRaceEvent("unknown-readback", {
              workspaceId: prepared.workspaceId,
              fileKey: key,
              transactionId: prepared.transactionId,
              filePath: prepared.filePath,
            }, {
              outcome: verification.outcome,
              observedHash: observed?.hash ?? null,
              writtenHash: mapped.error.intentHash ?? mapped.error.writtenHash ?? null,
              expectedOldHash: prepared.expectedDiskHash,
            });
            if (verification.outcome === "committed" && observed) {
              // Intended bytes are provably on disk: continue through the
              // normal committed classification with recovered metadata.
              ack = {
                file: {
                  path: prepared.filePath,
                  text: observed.text,
                  encoding: observed.encoding ?? prepared.policy.encoding,
                  bom: observed.bom ?? prepared.policy.bom,
                  size: observed.size ?? 0,
                  mtime: observed.mtime ?? 0,
                  hash: observed.hash,
                },
                writtenHash: mapped.error.writtenHash ?? observed.hash,
                writtenByteLength: mapped.error.writtenByteLength ?? observed.size ?? 0,
                intentHash: mapped.error.intentHash ?? mapped.error.writtenHash ?? observed.hash,
                oldHash: mapped.error.oldHash ?? prepared.expectedDiskHash,
                atomicReplaceUsed: true,
              };
            } else if (verification.outcome === "none") {
              // Verified zero disk effect — the write genuinely failed; clear
              // any stale ledger row for this exact transaction/path only.
              resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
              return mapped.kind === "conflict"
                ? {
                  kind: "conflict",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                }
                : {
                  kind: "failed",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                };
            } else {
              // Foreign content or unreadable: create a recovery entry with
              // the native intent hash and never auto-retry this path until a
              // user resolves it (§8.19.1).
              recordUnknownDiskEffect(
                prepared,
                verification.outcome === "foreign" ? verification.observedHash : observed?.hash ?? null,
                mapped.error.intentHash ?? mapped.error.writtenHash ?? null,
              );
              return {
                kind: "failed",
                transactionId: prepared.transactionId,
                diskEffect: "unknown",
                memoryEffect: "unchanged",
                providerEffect: "unknown",
                error: mapped.error,
                recoveryId: prepared.transactionId,
              };
            }
          } else if (mapped.kind === "conflict") {
            return {
              kind: "conflict",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          } else {
            return {
              kind: "failed",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          }
        }

        recordSaveRaceEvent("ack-delivered", {
          workspaceId: prepared.workspaceId,
          fileKey: key,
          transactionId: prepared.transactionId,
          filePath: prepared.filePath,
        }, {
          writtenHash: ack.writtenHash,
          writtenByteLength: ack.writtenByteLength,
          oldHash: ack.oldHash ?? null,
          documentRevision: openFilesRef.current[key]?.documentRevision ?? null,
        });

        const receipt = buildFinalBytesReceipt(prepared, ack, { historyId });

        // Disk acknowledged. From here only committed kinds exist (§8.18.1).
        const ownerAfterWrite = registry.check(owner);
        if (!ownerAfterWrite.active) {
          // Bytes landed on disk, but the owning buffer/tab/workspace is gone:
          // discard writeback, watcher, git/semantic and LSP side effects and
          // leave a recovery row the user can Reopen/Acknowledge (§8.19.1).
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: ownerAfterWrite.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }

        const liveBeforeWatcher = openFilesRef.current[key];
        const writebackBeforeWatcher = classifySaveWriteback(prepared, liveBeforeWatcher
          ? { documentRevision: liveBeforeWatcher.documentRevision ?? 0 }
          : null);
        if (writebackBeforeWatcher.kind === "discarded") {
          // Buffer closed while the writer was in flight: the disk write is
          // real, but no buffer or provider state may be resurrected.
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: writebackBeforeWatcher.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }

        const savedPath = absolutePathForOpenFile(fileAtPrepare);
        let watcherCompletion: Promise<number> | null = null;
        if (savedPath && registry.check(owner).active) {
          if (savedPath.endsWith(".editorconfig")) {
            workspaceStyleControllerRef.current.invalidate(savedPath);
          }
          watcherCompletion = lspWorkspaceDidChangeWatchedFiles(prepared.workspaceId, [{
            path: savedPath,
            type: 2,
          }]);
          recordSaveRaceEvent("watcher-invoked", {
            workspaceId: prepared.workspaceId,
            fileKey: key,
            transactionId: prepared.transactionId,
            filePath: prepared.filePath,
          }, { path: savedPath });
        }
        // ED-PARITY-002 QA build only: the notify above is real; the probe may
        // hold its completion delivery (W2) so the runner can type after the
        // real ack but before the writeback merge. No-op otherwise.
        await holdSaveRaceStage({
          stage: "watcher",
          workspaceId: prepared.workspaceId,
          fileKey: key,
          transactionId: prepared.transactionId,
          filePath: prepared.filePath,
          revision: () => openFilesRef.current[key]?.documentRevision ?? null,
          stillValid: () => registry.check(owner).active,
        });
        if (watcherCompletion) await watcherCompletion.catch(() => 0);
        if (!registry.check(owner).active) {
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after watcher notify",
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        // Re-read and re-classify after the watcher await: edits typed while
        // the notify was pending must merge against the current live buffer,
        // never the pre-await snapshot (they would otherwise be overwritten
        // and their revision would falsely report a clean save).
        const liveAfterWrite = openFilesRef.current[key];
        const writeback = classifySaveWriteback(prepared, liveAfterWrite
          ? { documentRevision: liveAfterWrite.documentRevision ?? 0 }
          : null);
        if (writeback.kind === "discarded") {
          // Buffer closed while the watcher notify was in flight: the disk
          // write is real, but no buffer or provider state may be resurrected.
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: writeback.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        const normalized = normalizeEditorText(ack.file.text);
        const savedBom = prepared.policy.bom;
        const stale = writeback.kind === "saved-stale-snapshot";

        const latestNow = liveAfterWrite!;

        mutateOpenBuffer(
          key,
          {
            savedText: normalized.text,
            text: latestNow.text,
            eol: (prepared.policy.eol.toUpperCase() as OpenFileEol) ?? normalized.eol,
            encoding: prepared.policy.encoding,
            bom: savedBom,
            hash: ack.writtenHash || ack.file.hash,
            mtime: ack.file.mtime,
            size: ack.file.size,
            loading: false,
            saving: false,
            dirty: stale,
            error: null,
            documentRevision: latestNow.documentRevision,
          },
          "save-writeback",
        );

        if (!registry.check(owner).active) {
          // Closed between merge and provider sync; skip didSave/didChange
          // and leave the committed recovery row for Reopen/Acknowledge.
          recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after writeback merge",
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        if (fileAtPrepare.ref.kind === "root") {
          notifyWorkspacePathGitChanged(fileAtPrepare.ref.rootId, fileAtPrepare.ref.path);
        }
        semanticIndex.invalidate("document-saved", [savedPath ?? fileAtPrepare.path]);

        // A settled save clears its own ledger row for this path only — never
        // other workspaces or paths (§8.18.1).
        resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);

        if (!stale) {
          try {
            await saveLspDocument({ ...fileAtPrepare, text: prepared.text }, prepared.text);
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "did-save",
              file: ack.file,
              receipt,
              historyId: receipt.historyId,
            };
          } catch {
            // Provider sync failed after the disk write: do not roll back or
            // downgrade the disk fact; report the failed provider effect.
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "failed",
              file: ack.file,
              receipt,
              historyId: receipt.historyId,
            };
          }
        }
        try {
          // Stale-snapshot save: the disk now holds an older revision than the
          // live buffer. Sending didSave(snapshotText) would let the provider
          // observe an old document as the saved one; sync only the current
          // buffer via didChange and let the next explicit save own didSave.
          await syncLspDocument(latestNow, "change");
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "did-change-current",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
            receipt,
            historyId: receipt.historyId,
          };
        } catch {
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "failed",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
            receipt,
            historyId: receipt.historyId,
          };
        }
      } catch (err) {
        const message = errorMessage(err);
        mutateOpenBuffer(
          key,
          {
            dirty: true,
            saving: false,
            error: message,
          },
          "save-metadata",
        );
        throw err instanceof Error ? err : new Error(message);
      }
    } finally {
      registry.settle(owner);
    }
  }, [
    absolutePathForOpenFile,
    mutateOpenBuffer,
    notifyWorkspacePathGitChanged,
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    saveLspDocument,
    semanticIndex.invalidate,
    syncLspDocument,
    writeTextSnapshot,
  ]) as PreparedSaveCommitter;

  /** Public open-buffer save: prepares one transaction, then commits it. */
  const saveOpenBufferText = useCallback(async (
    key: string,
    textToSave?: string,
    saveOptions?: {
      eol?: OpenFileEol | "lf" | "crlf" | "cr";
      encoding?: string;
      bom?: boolean;
    },
    /** ED-IMPROVE-002: observes the shared committer's typed result. */
    onCommitResult?: (result: SaveCommitResult) => void,
  ): Promise<WorkspaceFile | null> => {
    const file = openFilesRef.current[key];
    if (!file || file.loading) {
      throw new Error("Open buffer is not available to save");
    }
    if (file.library) {
      throw new Error(`${file.title} is a read-only library source`);
    }

    // §8.19.1: a `pending-readback`/`foreign-blocked` ledger row blocks
    // automatic retries against the same path until a re-read confirms the
    // real bytes or the user resolves the row.
    const pendingUnknownPath = absolutePathForOpenFile(file) ?? file.path ?? file.title;
    if (hasBlockingDiskEffectResolution(workspaceInstanceId, pendingUnknownPath)) {
      throw new Error(
        `A previous save of ${file.subtitle} has an unverified disk result. Confirm the file contents in the recovery center before saving again.`,
      );
    }

    // 1. Prepare phase: capture the immutable PreparedSave through the shared
    // builder so every path (open-dirty, open-clean, replay) shares one shape.
    const prepared = buildPreparedSave({
      transactionId: nextSaveTransactionId(),
      workspaceId: workspaceInstanceId,
      fileKey: key,
      filePath: absolutePathForOpenFile(file) ?? file.path ?? file.title,
      text: textToSave !== undefined ? textToSave : file.text,
      bufferRevision: file.documentRevision ?? 0,
      styleGeneration: workspaceStyleControllerRef.current.getGeneration(),
      expectedDiskHash: file.hash ?? null,
      policy: resolveWritePolicy({
        explicit: {
          eol: saveOptions?.eol,
          encoding: saveOptions?.encoding,
          bom: saveOptions?.bom,
        },
        file,
      }),
    });

    const result = await commitOpenBufferPreparedSave(prepared);
    onCommitResult?.(result);
    if (result.diskEffect === "committed") return result.file;
    return null;
  }, [
    absolutePathForOpenFile,
    commitOpenBufferPreparedSave,
    workspaceInstanceId,
  ]);

  const formatFileText = useCallback(async (
    file: OpenFileState,
    selection: EditorSelectionRange | null = null,
  ): Promise<FormatFileOutcome> => {
    // No language-server preset means no provider can ever answer for this
    // file: report the typed unavailable reason instead of calling one.
    if (!lspPresetIdForPath(file.languagePath)) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${file.languagePath} is available`,
      };
    }
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${file.languagePath} is available`,
      };
    }
    const capabilities = lspFilesRef.current[file.key]?.status?.capabilities ?? null;
    const languageLabel = lspFilesRef.current[file.key]?.status?.languageId
      ?? file.languagePath.split(".").pop()
      ?? file.languagePath;
    const hasSelection = !!selection && !selection.empty
      && (selection.start.line !== selection.end.line
        || selection.start.character !== selection.end.character);
    const useRange = hasSelection && (capabilities?.rangeFormatting ?? false);
    if (capabilities && hasSelection && !capabilities.rangeFormatting) {
      return {
        state: "unavailable",
        reason: capabilities.formatting
          ? "The provider does not support range formatting — clear the selection to reformat the whole file"
          : `No formatter provider for ${languageLabel} supports selection reformatting`,
      };
    }
    if (capabilities && !capabilities.formatting) {
      return {
        state: "unavailable",
        reason: `No formatter provider for ${languageLabel} is running`,
      };
    }

    const absPath = absolutePathForOpenFile(file) ?? file.languagePath;
    const schemeLanguageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
    const codeStyle = await workspaceStyleControllerRef.current.resolveForFile({
      filePath: absPath,
      explicitOverride: indentationOverridesRef.current[file.key],
      text: file.text,
      activeSchemeFields: schemeStyleFields(
        activeSchemeForLanguage(codeStyleSchemesRef.current, schemeLanguageKey || null),
      ),
    });
    resolvedCodeStylesRef.current[file.key] = codeStyle;

    const ranges = filterFormattingRanges(
      file.text,
      hasSelection && selection ? { startLine: selection.start.line, endLine: selection.end.line } : null,
      true,
    );
    if (ranges.length === 0) return { state: "unchanged", text: file.text };

    const result = useRange && selection
      ? await lspRangeFormatting(descriptor, {
        start: selection.start,
        end: selection.end,
      }, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      })
      : await lspFormatting(descriptor, {
        tabSize: codeStyle.tabSize,
        insertSpaces: codeStyle.insertSpaces,
      });
    updateLspStatusForFile(file, result.status);
    if (!result.edits.length) return { state: "unchanged", text: file.text };
    const filteredEdits = result.edits.filter((edit) => (
      ranges.some((range) => edit.range.start.line >= range.startLine && edit.range.end.line <= range.endLine)
    ));
    if (!filteredEdits.length) return { state: "unchanged", text: file.text };
    const nextText = applyLspTextEditsToString(file.text, filteredEdits);
    return nextText === file.text
      ? { state: "unchanged", text: nextText }
      : { state: "formatted", text: nextText };
  }, [absolutePathForOpenFile, findRoot, lspDescriptorForFile, updateLspStatusForFile, workspaceInstanceId]);

  const promptReloadProject = useCallback(
    async (key: string, subtitle: string) => {
      const file = openFilesRef.current[key];
      if (!file) return;
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      const confirmed = await confirmAppDialog({
        title: "Reload Java project",
        message: `${subtitle} changed. Reload the project so the language server picks up dependency and classpath changes?`,
        confirmLabel: "Reload",
      });
      if (!confirmed) return;
      try {
        await lspReloadProject(descriptor);
        setStatusMessage("Reloading Java project…");
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [lspDescriptorForFile, setStatusMessage],
  );

  const saveFile = useCallback(
    createSaveFile({
    activeKey,
    openFilesRef,
    absolutePathForOpenFile,
    workspaceInstanceId,
    setStatusMessage,
    workspaceStyleControllerRef,
    lspDescriptorForFile,
    lspFilesRef,
    findRoot,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    indentationOverridesRef,
    codeStyleSchemesRef,
    intelligencePreferences,
    commitOpenBufferPreparedSave,
    formatFileText,
    get canonicalCodeActionServiceRef() { return canonicalCodeActionServiceRef; },
    setSaveObservations,
    publishWorkspaceObservation,
    promptReloadProject,
  }),
    [
      activeKey,
      commitOpenBufferPreparedSave,
      formatFileText,
      findRoot,
      intelligencePreferences.formatOnSave,
      lspDescriptorForFile,
      lspSessionGeneration,
      publishWorkspaceObservation,
      promptReloadProject,
      projectAnalysisSnapshot?.projectFingerprint,
      setStatusMessage,
      workspaceInstanceId,
    ],
  );

  const reloadFile = useCallback(
    async (key: string | null = activeKey) => {
      if (!key) return;
      const file = openFilesRef.current[key];
      if (!file) return;
      if (file.library) {
        setStatusMessage(`${file.title} is a read-only library source`);
        return;
      }
      if (file.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${file.subtitle}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      setOpenFiles((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? file),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = file.ref.kind === "root"
          ? await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
          : await workspaceReadLooseFile(file.ref.path);
        const normalized = normalizeEditorText(reloaded.text);
        mutateOpenBuffer(
          key,
          {
            text: normalized.text,
            savedText: normalized.text,
            eol: normalized.eol,
            encoding: reloaded.encoding ?? file.encoding ?? "UTF-8",
            bom: reloaded.bom ?? reloaded.text.startsWith("\uFEFF"),
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
          "reload",
        );
        setStatusMessage(`Reloaded ${file.subtitle}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [key]: {
            ...(current[key] ?? file),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activeKey, findRoot, mutateOpenBuffer, setStatusMessage],
  );

  const readDiskSnapshot = useCallback(async (file: OpenFileState): Promise<ExternalDiskSnapshot> => {
    const preferredEncoding = file.encoding ?? "UTF-8";
    const disk = file.ref.kind === "root"
      ? preferredEncoding !== "UTF-8" && typeof workspaceReadFileWithEncoding === "function"
        ? await workspaceReadFileWithEncoding(
          findRoot(file.ref.rootId)?.path ?? "",
          file.ref.path,
          preferredEncoding,
        )
        : await workspaceReadFile(findRoot(file.ref.rootId)?.path ?? "", file.ref.path)
      : preferredEncoding !== "UTF-8" && typeof workspaceReadLooseFileWithEncoding === "function"
        ? await workspaceReadLooseFileWithEncoding(file.ref.path, preferredEncoding)
        : await workspaceReadLooseFile(file.ref.path);
    return externalDiskSnapshot(disk);
  }, [findRoot]);

  const applyDiskSnapshot = useCallback((file: OpenFileState, disk: ExternalDiskSnapshot) => {
    const latest = openFilesRef.current[file.key] ?? file;
    lastTrackedBufferTextRef.current[file.key] = disk.text;
    const next = mutateOpenBuffer(
      file.key,
      {
        text: disk.text,
        savedText: disk.text,
        eol: disk.eol,
        encoding: disk.encoding,
        bom: disk.bom,
        hash: disk.hash,
        mtime: disk.mtime,
        size: disk.size,
        loading: false,
        saving: false,
        dirty: false,
        error: null,
      },
      "reload",
    );
    if (next && latest.text !== next.text && lspFilesRef.current[file.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
  }, [mutateOpenBuffer, syncLspDocument]);

  const enqueueExternalFileConflict = useCallback((
    file: OpenFileState,
    disk: ExternalDiskSnapshot | null,
  ) => {
    const conflict: PendingExternalFileConflict = {
      key: file.key,
      path: absolutePathForOpenFile(file) ?? file.path,
      baseText: file.savedText,
      localText: file.text,
      disk,
    };
    setExternalFileConflicts((current) => (
      current.some((item) => item.key === conflict.key) ? current : [...current, conflict]
    ));
  }, [absolutePathForOpenFile]);

  const handleExternalFileChange = useCallback(createHandleExternalFileChange({
    workspaceStyleControllerRef,
    semanticIndex,
    openFilesRef,
    absolutePathForOpenFile,
    refreshTree,
    restoreEchoSuppressorRef,
    setStatusMessage,
    enqueueExternalFileConflict,
    setOpenFiles,
    readDiskSnapshot,
    applyDiskSnapshot,
  }), [
    absolutePathForOpenFile,
    applyDiskSnapshot,
    enqueueExternalFileConflict,
    readDiskSnapshot,
    refreshTree,
    semanticIndex.invalidate,
    setOpenFiles,
    setStatusMessage,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<LspExternalFileChange>("lsp://external-file-change", (event) => {
      const change = event.payload;
      if (change.workspaceId !== workspaceInstanceId) return;
      const pathKey = normalizeFsPath(change.path);
      const pending = pendingExternalFileEventsRef.current.get(pathKey);
      if (pending) window.clearTimeout(pending.timer);
      const merged = pending
        ? coalesceExternalFileChange(pending.change, change)
        : change;
      const timer = window.setTimeout(() => {
        pendingExternalFileEventsRef.current.delete(pathKey);
        if (!disposed) void handleExternalFileChange(merged);
      }, EXTERNAL_FILE_EVENT_SETTLE_MS);
      pendingExternalFileEventsRef.current.set(pathKey, { change: merged, timer });
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      for (const pending of pendingExternalFileEventsRef.current.values()) {
        window.clearTimeout(pending.timer);
      }
      pendingExternalFileEventsRef.current.clear();
    };
  }, [handleExternalFileChange, workspaceInstanceId]);

  const closeFile = useCallback(
    createCloseFile({
    activeEditorGroupId,
    workspaceInstanceId,
    openFilesRef,
    get mruFileKeysRef() { return mruFileKeysRef; },
    closeLayoutTabInLeaf,
    tabPolicyRef,
    resourceRecoveryCoordinatorRef,
    pendingClosedFilesRef,
    get setClosedTabsStack() { return setClosedTabsStack; },
    closeLspDocumentAndWait,
    pendingExternalFileEventsRef,
    saveTransactionRegistryRef,
    setOpenFiles,
    setMarkdownModes,
    setLspFiles,
    observeResourceCleanupOutcome,
    setStatusMessage,
  }),
    [activeEditorGroupId, closeLayoutTabInLeaf, closeLspDocumentAndWait, observeResourceCleanupOutcome, workspaceInstanceId],
  );
  closeFileRef.current = closeFile;

  const dismissExternalFileConflict = useCallback((key: string) => {
    setExternalFileConflicts((current) => current.filter((item) => item.key !== key));
  }, []);

  const keepLocalExternalFileConflict = useCallback((conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (latest) {
      const next: OpenFileState = conflict.disk
        ? {
            ...latest,
            savedText: conflict.disk.text,
            eol: conflict.disk.eol,
            encoding: conflict.disk.encoding,
            bom: conflict.disk.bom,
            hash: conflict.disk.hash,
            mtime: conflict.disk.mtime,
            size: conflict.disk.size,
            dirty: latest.text !== conflict.disk.text,
            error: null,
          }
        : {
            ...latest,
            dirty: true,
            error: "File deleted on disk; local changes are preserved",
          };
      setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
      setStatusMessage(conflict.disk
        ? `Kept local changes for ${latest.subtitle}; the next save will replace the disk version`
        : `Kept local changes for deleted file ${latest.subtitle}`);
    }
    dismissExternalFileConflict(conflict.key);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage]);

  const loadDiskExternalFileConflict = useCallback(async (conflict: PendingExternalFileConflict) => {
    const latest = openFilesRef.current[conflict.key];
    if (!latest) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    if (conflict.disk) {
      applyDiskSnapshot(latest, conflict.disk);
      setStatusMessage(`Loaded disk version of ${latest.subtitle}`);
      dismissExternalFileConflict(conflict.key);
      return;
    }

    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    for (const group of Object.values(currentUi.editorGroups)) {
      if (group.openOrder.includes(conflict.key)) {
        await closeFile(conflict.key, group.id, { discard: true });
      }
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Closed deleted file ${latest.subtitle}`);
  }, [
    applyDiskSnapshot,
    closeFile,
    dismissExternalFileConflict,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const mergeExternalFileConflict = useCallback((
    conflict: PendingExternalFileConflict,
    mergedText: string,
  ) => {
    const latest = openFilesRef.current[conflict.key];
    const disk = conflict.disk;
    if (!latest || !disk) {
      dismissExternalFileConflict(conflict.key);
      return;
    }
    const normalized = normalizeEditorText(mergedText);
    const next: OpenFileState = {
      ...latest,
      text: normalized.text,
      savedText: disk.text,
      eol: disk.eol,
      encoding: disk.encoding,
      bom: disk.bom,
      hash: disk.hash,
      mtime: disk.mtime,
      size: disk.size,
      dirty: normalized.text !== disk.text,
      error: null,
    };
    setOpenFiles((current) => ({ ...current, [conflict.key]: next }));
    if (latest.text !== next.text && lspFilesRef.current[conflict.key]?.status?.active) {
      void syncLspDocument(next, "change");
    }
    dismissExternalFileConflict(conflict.key);
    setStatusMessage(`Applied merged changes to ${latest.subtitle}`);
  }, [dismissExternalFileConflict, setOpenFiles, setStatusMessage, syncLspDocument]);

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

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    const requestGeneration = ++autoHighlightRequestGenerationRef.current;
    const canApply = () => (
      autoHighlightRequestGenerationRef.current === requestGeneration
      && occurrenceActiveFileKeyRef.current === file?.key
      && occurrenceActiveGroupIdRef.current === groupId
      && !occurrenceSessionRef.current
      && (!file || openFilesRef.current[file.key]?.text === file.text)
    );
    // Explicit occurrence highlighting owns this overlay until the session is
    // cleared. Cursor-driven refreshes must not replace it asynchronously.
    if (file && occurrenceSessionRef.current?.fileKey === file.key) return;
    // Large-file mode: no per-cursor highlight (LSP request nor text-scan fallback).
    if (!file || file.loading || activeFileIsLarge) {
      setHighlightsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    let cancelled = false;
    const position = cursorPositions[groupId] ?? { line: 0, character: 0 };
    const descriptor = lspDescriptorForFile(file);
    // ED-PARITY-022 DEC-022-04: Java usages are semantic; while the provider
    // cannot answer, show none rather than a same-text imitation.
    const semanticOnly = /\.java$/i.test(file.ref.path);
    if (!activeCapabilities?.documentHighlight || !descriptor) {
      const timer = window.setTimeout(() => {
        if (!cancelled && canApply()) {
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: semanticOnly ? [] : fallbackWordHighlights(file.text, position),
          }));
        }
      }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    if (!activeLspDocumentIsSynced) {
      setHighlightsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return () => { cancelled = true; };
    }
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
      void lspDocumentHighlights(descriptor, position)
        .then((result) => {
          if (cancelled || !canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setHighlightsByGroup((current) => ({ ...current, [groupId]: result.highlights }));
        })
        .catch(() => {
          if (cancelled || !canApply() || !isCurrentLspDocumentRequest(file, epoch)) return;
          setHighlightsByGroup((current) => ({
            ...current,
            [groupId]: semanticOnly ? [] : fallbackWordHighlights(file.text, position),
          }));
        });
    }, LSP_HIGHLIGHT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.documentHighlight,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    cursorPositions,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

  useEffect(() => {
    if (!occurrenceSession) return;
    const currentRev = activeFile ? (lspDocumentEpochRef.current[activeFile.key] ?? 0) : -1;
    if (!activeFile || !isOccurrenceSessionValid(occurrenceSession, activeFile.key, currentRev)) {
      setOccurrenceSession(null);
      occurrenceSessionRef.current = null;
      setHighlightsByGroup((current) => ({
        ...current,
        [activeEditorGroupId]: [],
      }));
    }
  }, [activeEditorGroupId, activeFile, occurrenceSession]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeInlayHintsEnabled || !activeCapabilities?.inlayHint) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setInlayHintsByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const range = viewportRanges[groupId] ?? initialInlayHintRange(file.text);
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspInlayHints(descriptor, range)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setInlayHintsByGroup((current) => ({ ...current, [groupId]: result.hints }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setInlayHintsByGroup((current) => (
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_INLAY_HINT_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.inlayHint,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeInlayHintsEnabled,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
    viewportRanges,
  ]);

  useEffect(() => {
    const groupId = activeEditorGroupId;
    const file = activeFile;
    if (!file || file.loading || activeFileIsLarge || !activeCapabilities?.semanticTokens) {
      setSemanticTokensByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    if (!activeLspDocumentIsSynced) {
      setSemanticTokensByGroup((current) => (
        (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
      ));
      return;
    }
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return;
    let cancelled = false;
    const epoch = lspDocumentEpochRef.current[file.key] ?? 0;
    const timer = window.setTimeout(() => {
      if (!isCurrentLspDocumentRequest(file, epoch)) return;
      void lspSemanticTokens(descriptor)
        .then((result) => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          updateLspStatusForFile(file, result.status);
          setSemanticTokensByGroup((current) => ({ ...current, [groupId]: result.tokens }));
        })
        .catch(() => {
          if (cancelled || !isCurrentLspDocumentRequest(file, epoch)) return;
          setSemanticTokensByGroup((current) => (
            (current[groupId] ?? []).length === 0 ? current : { ...current, [groupId]: [] }
          ));
        });
    }, LSP_SEMANTIC_TOKENS_IDLE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCapabilities?.semanticTokens,
    activeEditorGroupId,
    activeFile,
    activeFileIsLarge,
    activeLspDocumentIsSynced,
    isCurrentLspDocumentRequest,
    lspDescriptorForFile,
    updateLspStatusForFile,
  ]);

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

  const reloadActiveFileWithEncoding = useCallback(async (encoding: string) => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library || file.loading || file.saving) return;
    if (file.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Reload file with encoding",
        message: `Discard unsaved changes in ${file.subtitle} and decode it as ${encoding}?`,
        confirmLabel: "Reload",
        danger: true,
      });
      if (!confirmed) return;
    }
    if (typeof workspaceReadFileWithEncoding !== "function"
      || typeof workspaceReadLooseFileWithEncoding !== "function") {
      throw new Error("Explicit file encoding is available in the desktop workspace only");
    }
    setOpenFiles((current) => ({
      ...current,
      [key]: { ...(current[key] ?? file), loading: true, error: null },
    }));
    try {
      const reloaded = file.ref.kind === "root"
        ? await workspaceReadFileWithEncoding(findRoot(file.ref.rootId)?.path ?? "", file.ref.path, encoding)
        : await workspaceReadLooseFileWithEncoding(file.ref.path, encoding);
      const normalized = normalizeEditorText(reloaded.text);
      const next = mutateOpenBuffer(
        key,
        {
          text: normalized.text,
          savedText: normalized.text,
          eol: normalized.eol,
          encoding: reloaded.encoding ?? encoding,
          bom: reloaded.bom ?? false,
          hash: reloaded.hash,
          mtime: reloaded.mtime,
          size: reloaded.size,
          loading: false,
          saving: false,
          dirty: false,
          error: null,
        },
        "reload",
      );
      setFileEncodingDialogOpen(false);
      if (next) {
        setStatusMessage(`Reloaded ${file.subtitle} as ${next.encoding}${next.bom ? " BOM" : ""}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setOpenFiles((current) => ({
        ...current,
        [key]: { ...(current[key] ?? file), loading: false, saving: false, error: message },
      }));
      setStatusMessage(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [activeKey, findRoot, mutateOpenBuffer, setStatusMessage]);

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

  const gitChangeByRootPath = useMemo(() => {
    const map = new Map<string, GitChange>();
    for (const root of roots) {
      for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
        const snapshot = gitSnapshots[repo.repoRoot];
        if (!snapshot?.changes.length) continue;
        for (const change of snapshot.changes) {
          const workspacePath = workspacePathForGitPath(root, repo, change.path);
          if (workspacePath === null) continue;
          map.set(`${root.id}:${workspacePath}`, change);
        }
      }
    }
    return map;
  }, [gitRoots, gitSnapshots, roots]);

  const gitTargetForFile = useCallback((file: OpenFileState | null) => {
    // A root reference is enough to prefetch the immutable HEAD blob while
    // the working-tree buffer is loading. Buffer-dependent consumers still
    // gate on `file.loading` before they render or query.
    if (!file || file.ref.kind !== "root") return null;
    const ref = file.ref;
    const root = roots.find((candidate) => candidate.id === ref.rootId);
    if (!root) return null;
    const repo = gitRootForWorkspacePath(root, ref.path, gitRoots);
    if (!repo) return null;
    const path = gitPathForWorkspacePath(root, repo, ref.path);
    if (!path) return null;
    const snapshot = gitSnapshots[repo.repoRoot];
    return {
      repoRoot: repo.repoRoot,
      path,
      headOid: snapshot?.headOid ?? null,
      sourceKey: `${repo.repoRoot}:${snapshot?.headOid ?? "no-head"}:${path}`,
    };
  }, [gitRoots, gitSnapshots, roots]);

  // §8.17.4 step 1: every chrome consumer derives its per-leaf inputs from
  // the recursive tree's leaves — no `editorGroups.primary/secondary` enum and
  // no two-group swap fallback. A third split leaf gets the same treatment.
  const layoutLeafActiveEntries = useMemo(
    () => getAllLeafNodes(workspaceUi.layoutTreeV2).map((leaf) => ({
      groupId: leaf.id as EditorGroupId,
      activeKey: (editorGroups[leaf.id]?.activeKey ?? leaf.activeKey ?? null) as string | null,
    })),
    [editorGroups, workspaceUi.layoutTreeV2],
  );

  const activeGitFileStateSignature = useMemo(() => {
    const stateForKey = (key: string | null) => {
      if (!key) return "empty";
      const file = openFiles[key];
      if (!file) return "missing";
      if (file.loading) return "loading";
      return `${file.documentRevision ?? 0}:${isLargeFileContent(file.text) ? "large" : "ready"}`;
    };
    return layoutLeafActiveEntries
      .map(({ groupId, activeKey }) => `${groupId}:${activeKey ?? "empty"}:${stateForKey(activeKey)}`)
      .join("|");
  }, [layoutLeafActiveEntries, openFiles]);

  const gitDiffSources = useMemo(() => {
    const seen = new Set<string>();
    return layoutLeafActiveEntries.flatMap(({ activeKey }) => {
      if (!activeKey || seen.has(activeKey)) return [];
      seen.add(activeKey);
      const file = openFiles[activeKey];
      const target = gitTargetForFile(file ?? null);
      const head = gitHeadTextByFile[activeKey];
      const largeFile = file ? isLargeFileContent(file.text) : false;
      // A repository without a HEAD cannot have a comparable line diff. Keep
      // the hook idle until the snapshot exposes a real HEAD and its blob is
      // read, avoiding a throwaway debounce during Git discovery.
      if (!file || file.loading || largeFile || !target?.headOid || !head || head.sourceKey !== target.sourceKey) return [];
      return [{
        key: activeKey,
        filePath: `${target.repoRoot}/${target.path}`,
        sourceKey: target.sourceKey,
        headOid: target.headOid,
        textVersion: file.documentRevision ?? 0,
        headText: head.text,
        bufferText: file.text,
        largeFile,
      }];
    });
  }, [
    gitHeadTextByFile,
    gitTargetForFile,
    layoutLeafActiveEntries,
    openFiles,
  ]);
  const gitLineChangesByFile = useDeferredGitLineChanges(gitDiffSources);

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set(layoutLeafActiveEntries
      .map(({ activeKey }) => activeKey)
      .filter((key): key is string => !!key));
    for (const key of activeKeys) {
      const file = openFilesRef.current[key];
      const target = gitTargetForFile(file ?? null);
      if (!file || file.loading || isLargeFileContent(file.text) || !target || gitHeadTextByFile[key]?.sourceKey === target.sourceKey) continue;
      if (!target.headOid) {
        setGitHeadTextByFile((current) => ({
          ...current,
          [key]: { sourceKey: target.sourceKey, text: "" },
        }));
        continue;
      }
      if (gitHeadRequestsRef.current.has(target.sourceKey)) continue;
      gitHeadRequestsRef.current.add(target.sourceKey);
      void gitBlobPair(target.repoRoot, target.path, "HEAD", "")
        .then((pair) => {
          if (cancelled) return;
          setGitHeadTextByFile((current) => ({
            ...current,
            [key]: {
              sourceKey: target.sourceKey,
              text: pair.binary || pair.oversize ? null : pair.oldText ?? "",
            },
          }));
        })
        .catch(() => {
          if (!cancelled) {
            setGitHeadTextByFile((current) => ({
              ...current,
              [key]: { sourceKey: target.sourceKey, text: null },
            }));
          }
        })
        .finally(() => gitHeadRequestsRef.current.delete(target.sourceKey));
    }
    return () => { cancelled = true; };
  }, [activeGitFileStateSignature, gitHeadTextByFile, gitTargetForFile]);

  const gitBlameRequestSignature = useMemo(() => (
    layoutLeafActiveEntries.map(({ groupId, activeKey }) => {
      const key = activeKey;
      // Input batching keeps the store snapshot stable during a typing burst,
      // but the ref is updated immediately.  Use it here so inline blame is
      // disabled from the first dirty keystroke rather than one batch later.
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
        return `${groupId}:${key ?? "empty"}:disabled`;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      return `${groupId}:${key}:${target.sourceKey}:${file.hash}:${line}`;
    }).join("|")
  ), [
    cursorPositions,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
    layoutLeafActiveEntries,
    openFilesRef,
  ]);

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const cacheBlame = (cacheKey: string, blame: GitBlameLine | null) => {
      const cache = gitBlameCacheRef.current;
      cache.delete(cacheKey);
      cache.set(cacheKey, blame);
      if (cache.size > 256) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
    };
    const leafGroupIds: EditorGroupId[] = (() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
      return getAllLeafNodes(ui.layoutTreeV2).map((leaf) => leaf.id);
    })();
    const loadForGroup = (groupId: EditorGroupId) => {
      const groupState = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .editorGroups[groupId];
      const key = groupState?.activeKey ?? null;
      const file = key ? openFilesRef.current[key] ?? null : null;
      const target = gitTargetForFile(file);
      if (!intelligencePreferences.inlineBlameEnabled || !file || file.loading || file.dirty || !target?.headOid) {
        setGitBlameByGroup((current) => current[groupId] === null ? current : { ...current, [groupId]: null });
        return;
      }
      const line = (cursorPositions[groupId]?.line ?? 0) + 1;
      const cacheKey = `${target.sourceKey}:${file.hash}:${line}`;
      if (gitBlameCacheRef.current.has(cacheKey)) {
        const cached = gitBlameCacheRef.current.get(cacheKey) ?? null;
        cacheBlame(cacheKey, cached);
        setGitBlameByGroup((current) => current[groupId] === cached ? current : { ...current, [groupId]: cached });
        return;
      }
      timers.push(window.setTimeout(() => {
        void gitBlameLines(target.repoRoot, target.path, line, line)
          .then((lines) => {
            const blame = lines[0] ?? null;
            cacheBlame(cacheKey, blame);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: blame }));
          })
          .catch(() => {
            cacheBlame(cacheKey, null);
            if (!cancelled) setGitBlameByGroup((current) => ({ ...current, [groupId]: null }));
          });
      }, 500));
    };
    for (const leafId of leafGroupIds) loadForGroup(leafId);
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    gitBlameRequestSignature,
    gitTargetForFile,
    intelligencePreferences.inlineBlameEnabled,
  ]);

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

  const fetchWorkspaceSymbols = useCallback(async (query: string): Promise<GoToSymbolQueryResult> => {
    const file = activeFile ?? Object.values(openFilesRef.current).find((item) => !item.loading) ?? null;
    const unavailable = (): GoToSymbolQueryResult => {
      return {
        symbols: [],
        semanticGeneration: null,
        semanticRevision: null,
        sessionCount: 0,
        providerCount: 0,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: false,
        truncated: false,
        diagnostics: [],
      };
    };
    if (!file) return unavailable();
    const expectedRevision = semanticIndex.current().revision;
    const live = await ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) return unavailable();
    const descriptor = lspDescriptorForFile(live);
    if (!descriptor) return unavailable();
    const buildToken = semanticIndex.beginBuild("language-server");
    try {
      const result = await lspWorkspaceSymbols(descriptor, query);
      updateLspStatusForFile(live, result.status);
      const symbols = result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        path: symbol.path ?? symbol.uri,
        uri: symbol.uri,
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
        resolved: symbol.resolved,
        resolveToken: symbol.resolveToken ?? null,
      }));
      const completion = semanticIndex.finishQuery(buildToken, {
        kind: "symbols",
        resultCount: symbols.length,
        coverage: {
          scope: "workspace",
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics ?? [],
        },
      });
      return completion.accepted
        ? {
          symbols,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
          sessionCount: result.sessionCount,
          providerCount: result.providerCount,
          skippedProviderCount: result.skippedProviderCount,
          failedProviderCount: result.failedProviderCount,
          complete: result.complete,
          truncated: result.truncated,
          diagnostics: result.diagnostics ?? [],
        }
        : unavailable();
    } catch (error) {
      semanticIndex.failBuild(buildToken, errorMessage(error));
      return unavailable();
    }
  }, [
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

  const runRecoveryDismiss = useCallback(async (
    targetEntry: RefactorRecoveryJournalEntryV2,
    ownerInstanceId: string,
  ): Promise<void> => {
    const released = () => workspaceInstanceIdRef.current !== ownerInstanceId;
    const recoveryId = targetEntry.recoveryId;
    if (released()) return;
    if (refactorRecoveryBusyRef.current.has(recoveryId)) return;
    refactorRecoveryBusyRef.current.add(recoveryId);
    setRefactorRecoveryReview((current) => (
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
        setStatusMessage("Refactor recovery entry is no longer pending.");
        refactorRecoveryBusyRef.current.delete(recoveryId);
        closeRefactorRecoveryReview(recoveryId);
        return;
      }
      const result = dismissRefactorRecoveryEntry(recoveryId, targetEntry.updatedAt);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      if (released()) return;
      const affectedCount = targetEntry.documents.length + (targetEntry.resourceMoves ?? []).length;
      setStatusMessage(
        `Abandoned refactor recovery for ${affectedCount} file(s); files left exactly as they are now.`,
      );
      refactorRecoveryBusyRef.current.delete(recoveryId);
      closeRefactorRecoveryReview(recoveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!released()) {
        setRefactorRecoveryReview((current) => (
          current && current.entry.recoveryId === recoveryId
            ? { ...current, busy: false, error: `Could not abandon recovery: ${message}` }
            : current
        ));
      }
      refactorRecoveryBusyRef.current.delete(recoveryId);
    }
  }, [closeRefactorRecoveryReview, setStatusMessage]);

  const keepRecoveryReview = useCallback((recoveryId: string) => {
    closeRefactorRecoveryReview(recoveryId);
  }, [closeRefactorRecoveryReview]);

  const promptRefactorRecoveryEntry = useCallback(async (
    entry: RefactorRecoveryJournalEntryV2,
    ownerInstanceId: string,
  ): Promise<void> => {
    const released = () => workspaceInstanceIdRef.current !== ownerInstanceId;
    if (released()) return;
    // RC-02: dismissed/committed entries are never pending; skip without UI.
    const latestAtOpen = getRefactorRecoveryJournalV2(entry.recoveryId) ?? entry;
    if (!isPendingRefactorRecoveryEntry(latestAtOpen)) return;
    if (refactorRecoveryBusyRef.current.has(entry.recoveryId)) return;
    // Bridge the dialog's user action back to the sequential discover loop:
    // resolve only when the review closes (keep/restore-success/dismiss).
    // Restore/dismiss failures keep the dialog open and do not resolve.
    await new Promise<void>((resolve) => {
      refactorRecoveryResolveRef.current.set(entry.recoveryId, resolve);
      setRefactorRecoveryReview({
        entry: latestAtOpen,
        ownerInstanceId,
        preconditions: null,
        loading: true,
        error: null,
        busy: false,
      });
      void (async () => {
        try {
          const preconditions = await classifyRecoveryEntry(latestAtOpen);
          if (released()) {
            closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          if (preconditions.overall === "already-restored") {
            updateRefactorRecoveryJournalV2(entry.recoveryId, (currentEntry) => ({
              ...currentEntry,
              status: "rolled-back",
              verification: { mismatchedUris: Object.freeze([]), checkedAt: Date.now() },
            }));
            setStatusMessage("Refactor recovery: every affected file already matches its pre-refactor content; entry closed.");
            closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          // Functional update with creation fallback: the loading state set
          // above may not have rendered yet when a fast classify resolves
          // (state updater would see null and drop this update). Either way
          // the dialog ends loaded with preconditions.
          setRefactorRecoveryReview((currentState) => {
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
            closeRefactorRecoveryReview(entry.recoveryId);
            return;
          }
          const message = `Could not verify the pending entry: ${error instanceof Error ? error.message : String(error)}`;
          setRefactorRecoveryReview((currentState) => {
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
  }, [classifyRecoveryEntry, closeRefactorRecoveryReview, setStatusMessage]);
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

  const createJavaClassFromPlan = useCallback(async (
    plan: PlanTemplateCreationResult & { valid: true },
  ) => {
    if (!newJavaClassDialogState) return false;
    const {
      root,
      dirRelPath,
      projectFactsGeneration,
      projectFactsFingerprint,
    } = newJavaClassDialogState;

    const assertCurrentProjectFacts = () => {
      const currentFacts = useProjectFactsStore.getState().getWorkspaceFacts(root.path);
      const isCurrent = currentFacts.status === "ready"
        && !currentFacts.isStale
        && currentFacts.structure !== null
        && currentFacts.generation === projectFactsGeneration
        && currentFacts.fingerprint === projectFactsFingerprint;
      if (isCurrent) return;

      const reason = currentFacts.status === "ready"
        && !currentFacts.isStale
        && currentFacts.generation === projectFactsGeneration
        && currentFacts.fingerprint === projectFactsFingerprint
        ? "project facts are no longer ready"
        : "project facts changed";
      throw new Error(`Cannot create ${plan.className}.java: ${reason}`);
    };

    const relPath = relativePathWithinRoot(root.path, plan.targetPath) ?? `${plan.className}.java`;
    const edit: LspWorkspaceEdit = {
      operations: [
        {
          kind: "create",
          uri: "",
          path: plan.targetPath,
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        },
        {
          kind: "text",
          document: {
            uri: "",
            path: plan.targetPath,
            version: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: plan.content,
              },
            ],
          },
        },
      ],
      documentEdits: [
        {
          uri: "",
          path: plan.targetPath,
          version: null,
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: plan.content,
            },
          ],
        },
      ],
    };

    try {
      assertCurrentProjectFacts();
      const outcomes = await applyLspWorkspaceEdit(edit, {
        label: `Create ${plan.kind} ${plan.className}`,
        preflightMutation: assertCurrentProjectFacts,
      });
      const response = workspaceEditApplyResponse(outcomes);
      if (!response.applied) {
        setStatusMessage(
          `Could not create ${plan.className}.java: ${response.failureReason ?? "workspace edit was not applied"}`,
        );
        return false;
      }
      await loadDir(root.id, dirRelPath);
      const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: relPath };
      setSelected({ kind: "file", ref });
      await openFile(ref);
      notifyWorkspacePathGitChanged(root.id, relPath);
      setStatusMessage(`Created ${plan.className}.java in ${plan.packageName || "(default package)"}`);
      return true;
    } catch (err) {
      setStatusMessage(errorMessage(err));
      return false;
    }
  }, [
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
    extractSessionRef,
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
  const copyReferenceAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const path = absolutePathForOpenFile(file);
    const outcome = copyReferenceCandidates({
      path,
      isLibrary: !!file.library,
      roots: rootsRef.current.map((root) => root.path),
      line: editorSelectionRef.current.start.line,
      symbolName: null,
    });
    if (outcome.kind === "unavailable") {
      setStatusMessage(`Copy Reference unavailable (${outcome.reason}): ${outcome.detail}`);
      return;
    }
    // Best-effort provider symbol identity; failure degrades to path-only
    // rather than blocking the copy.
    let symbolName: string | null = null;
    if (!file.library) {
      try {
        const live = openFilesRef.current[file.key];
        const descriptor = live ? lspDescriptorForFile(live) : null;
        if (descriptor) {
          const position = editorSelectionRef.current.start;
          const prepared = await lspPrepareRename(descriptor, position);
          const range = prepared.range ?? null;
          const lineText = live?.text.split("\n")[position.line] ?? "";
          symbolName = (range && range.start.line === range.end.line
            ? lineText.slice(range.start.character, range.end.character).trim()
            : "")
            || lineText.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0]
            || null;
        }
      } catch {
        symbolName = null;
      }
    }
    const final = symbolName
      ? copyReferenceCandidates({
        path,
        isLibrary: !!file.library,
        roots: rootsRef.current.map((root) => root.path),
        line: editorSelectionRef.current.start.line,
        symbolName,
      })
      : outcome;
    if (final.kind === "unavailable") {
      setStatusMessage(`Copy Reference unavailable (${final.reason}): ${final.detail}`);
      return;
    }
    if (final.candidates.length === 1) {
      await writeText(final.candidates[0].text);
      setStatusMessage(`Copied reference: ${final.candidates[0].text}`);
      return;
    }
    const rect = editorPaneRef.current?.getBoundingClientRect();
    openTreeContextMenuAt(
      (rect?.left ?? 0) + 80,
      (rect?.top ?? 0) + 80,
      final.candidates.map((candidate) => ({
        label: `${candidate.label}: ${candidate.text}`,
        onClick: () => {
          void writeText(candidate.text).then(() => {
            setStatusMessage(`Copied reference: ${candidate.text}`);
          });
        },
      })),
    );
  }, [
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
    beginExtractSessionRef,
    captureMethodSymbolsRef,
    runCodeAction,
    continueExtractNamingRef,
    finishExtractSessionRef,
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

  const toggleProjectTree = useCallback(() => {
    setLanguagePanelOpen((open) => !open);
  }, [setLanguagePanelOpen]);

  // Keep the resizable project panel in sync with the persisted open flag.
  // Drag-to-min collapses via onResize; toolbar / Alt+1 toggles go through this effect.
  useEffect(() => {
    const panel = projectPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!leftToolAreaOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastProjectPanelSizeRef.current}px`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [leftToolAreaOpen]);

  const handleProjectPanelResize = useCallback((size: PanelSize) => {
    const pixels = size.inPixels > 0 ? Math.round(size.inPixels) : 0;
    if (pixels > 40) {
      // Only record the live width here. Writing it to the store on every
      // pointer move re-renders the shell, changes the Panel's `defaultSize`
      // and kills the in-flight drag session inside react-resizable-panels;
      // persistence happens on release via the group's onLayoutChanged.
      lastProjectPanelSizeRef.current = pixels;
    }
    // Dragging the area closed hides its tool windows; dragging it open
    // shows Project (IDEA restores the last left window).
    const next = size.asPercentage > 2 && (pixels > 40 || size.inPixels === 0);
    const layout = toolWindowLayoutRef.current;
    const areaOpen = layout.sideOpen("left");
    if (next === areaOpen) return;
    if (!next) layout.hideSide("left");
    else layout.show(layout.visibleAt("left-top") ?? "project");
  }, []);

  const [workspaceContainerHeight, setWorkspaceContainerHeight] = useState<number>(() => {
    return typeof window !== "undefined" ? window.innerHeight : 800;
  });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWorkspaceContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxBottomDockHeight = useMemo(() => {
    // 40px top toolbar header + 37px minimum reserved editor sliver = 77px
    const available = Math.max(BOTTOM_DOCK_MIN_HEIGHT, workspaceContainerHeight - 77);
    return Math.min(BOTTOM_DOCK_MAX_HEIGHT, available);
  }, [workspaceContainerHeight]);

  const currentBottomDockHeight = useMemo(() => {
    const chrome = workspaceUi.shellChromeState;
    if (!chrome) return 323;
    if (chrome.bottomHeightByTool && bottomDockTab in chrome.bottomHeightByTool) {
      return chrome.bottomHeightByTool[bottomDockTab] ?? 323;
    }
    return chrome.bottomHeightPx ?? 323;
  }, [workspaceUi.shellChromeState, bottomDockTab]);

  const handleBottomDockHeightChange = useCallback((height: number) => {
    setBottomDockHeightForTool(workspaceInstanceId, bottomDockTab, height);
  }, [bottomDockTab, setBottomDockHeightForTool, workspaceInstanceId]);

  const focusToolWindowSoon = useCallback((toolId: string) => {
    requestAnimationFrame(() => {
      if (toolId === "project") {
        treePaneRef.current?.focus();
        return;
      }
      const pane = document.querySelector(`[data-testid="code-workspace-tool-window-${toolId}"]`);
      const target = pane?.querySelector<HTMLElement>('[data-tool-window-content] [tabindex="0"], [data-tool-window-content] button, [data-tool-window-content] input, [data-tool-window-content] textarea')
        ?? pane?.querySelector<HTMLElement>("button");
      target?.focus();
    });
  }, []);

  /**
   * IDEA Activate<Tool>Window (Alt+N, stripe clicks): a hidden window is
   * shown at its anchor and focused; a visible unfocused one takes focus; a
   * focused one hides and returns focus to the editor.
   */
  const handleActivateToolWindow = useCallback((requestedId: string) => {
    const toolId = requestedId === "outline" ? "structure" : requestedId;
    const layout = toolWindowLayoutRef.current;
    const pane = toolId === "project"
      ? treePaneRef.current
      : document.querySelector(`[data-testid="code-workspace-tool-window-${toolId}"]`);
    const hasFocus = !!pane && pane.contains(document.activeElement);
    if (!layout.isVisible(toolId)) {
      if (toolId === "structure") rightPaneTabRef.current = "outline";
      if (toolId === "documentation") rightPaneTabRef.current = "documentation";
      layout.show(toolId);
      focusToolWindowSoon(toolId);
    } else if (hasFocus) {
      layout.hide(toolId);
      handleReturnToEditor();
    } else {
      focusToolWindowSoon(toolId);
    }
  }, [focusToolWindowSoon, handleReturnToEditor]);

  const handleRestoreToolWindowLayout = useCallback(() => {
    // IDEA Window | Restore Default Layout: default anchors, Project only.
    toolWindowLayoutRef.current.restoreDefaultLayout();
    toolWindowLayoutRef.current.hideSide("right");
    toolWindowLayoutRef.current.hide("structure");
    restoreDefaultToolWindowLayout(workspaceInstanceId);
    lastProjectPanelSizeRef.current = 452;
    try {
      projectPanelRef.current?.resize("452px");
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      handleReturnToEditor();
    });
    setStatusMessage("Restored default tool window layout");
  }, [handleReturnToEditor, restoreDefaultToolWindowLayout, setStatusMessage, workspaceInstanceId]);

  // ED-PARITY-013 DEC-013-05: IDEA F12 / Shift+Esc / Ctrl+Shift+F12. The last
  // tool window is the most recently opened one; Project is the fallback.
  const lastToolWindowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (bottomDockOpen) lastToolWindowIdRef.current = bottomDockTab;
  }, [bottomDockOpen, bottomDockTab]);
  useEffect(() => {
    if (rightPaneOpen && rightPaneTab === "outline") lastToolWindowIdRef.current = "structure";
  }, [rightPaneOpen, rightPaneTab]);
  const hiddenToolWindowsRef = useRef<{ project: boolean; bottom: boolean; right: boolean } | null>(null);

  const focusBottomDockSoon = useCallback(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="code-workspace-bottom-dock"] [tabindex="0"], [data-testid="code-workspace-bottom-dock"] button, [data-testid="code-workspace-bottom-dock"] input',
      );
      el?.focus();
    });
  }, []);

  const jumpToLastToolWindow = useCallback(() => {
    const toolId = lastToolWindowIdRef.current ?? "project";
    hiddenToolWindowsRef.current = null;
    if (toolId === "project") {
      setLanguagePanelOpen(true);
      requestAnimationFrame(() => treePaneRef.current?.focus());
      return;
    }
    if (toolId === "structure") {
      setRightPaneTab("outline");
      setRightPaneOpen(true);
      return;
    }
    setBottomDockTab(toolId as BottomDockTabId);
    setBottomDockOpen(true);
    focusBottomDockSoon();
  }, [focusBottomDockSoon, setBottomDockOpen, setBottomDockTab, setLanguagePanelOpen, setRightPaneOpen, setRightPaneTab]);

  const hideActiveToolWindow = useCallback((): boolean => {
    const active = document.activeElement;
    const bottomDock = document.querySelector('[data-testid="code-workspace-bottom-dock"]');
    const rightPane = document.querySelector('[data-testid="code-workspace-right-pane"]');
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    let hid = false;
    if (active && treePaneRef.current?.contains(active)) {
      setLanguagePanelOpen(false);
      hid = true;
    } else if (active && bottomDock?.contains(active)) {
      setBottomDockOpen(false);
      hid = true;
    } else if (active && rightPane?.contains(active)) {
      setRightPaneOpen(false);
      hid = true;
    } else {
      // Editor focus: hide the last active tool window when it is open.
      const last = lastToolWindowIdRef.current;
      if (last === "structure" && ui.rightPaneOpen) {
        setRightPaneOpen(false);
        hid = true;
      } else if (last && last !== "project" && last !== "structure" && ui.bottomDockOpen) {
        setBottomDockOpen(false);
        hid = true;
      }
    }
    if (hid) {
      // IDEA moves focus to the editor as the tool window hides; the frame
      // retry covers a layout that was still settling.
      handleReturnToEditor();
      requestAnimationFrame(() => handleReturnToEditor());
    }
    return hid;
  }, [handleReturnToEditor, setBottomDockOpen, setLanguagePanelOpen, setRightPaneOpen, workspaceInstanceId]);

  const toggleAllToolWindows = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const anyOpen = ui.languagePanelOpen || ui.bottomDockOpen || ui.rightPaneOpen;
    if (anyOpen) {
      hiddenToolWindowsRef.current = {
        project: ui.languagePanelOpen,
        bottom: ui.bottomDockOpen,
        right: ui.rightPaneOpen,
      };
      setLanguagePanelOpen(false);
      setBottomDockOpen(false);
      setRightPaneOpen(false);
      handleReturnToEditor();
      requestAnimationFrame(() => handleReturnToEditor());
      return;
    }
    const restore = hiddenToolWindowsRef.current;
    hiddenToolWindowsRef.current = null;
    if (!restore) return;
    if (restore.project) setLanguagePanelOpen(true);
    if (restore.bottom) setBottomDockOpen(true);
    if (restore.right) setRightPaneOpen(true);
  }, [handleReturnToEditor, setBottomDockOpen, setLanguagePanelOpen, setRightPaneOpen, workspaceInstanceId]);

  const toggleOutlinePane = useCallback(() => {
    if (rightPaneOpen && rightPaneTab === "outline") {
      setRightPaneOpen(false);
      return;
    }
    setRightPaneTab("outline");
    setRightPaneOpen(true);
  }, [rightPaneOpen, rightPaneTab, setRightPaneOpen, setRightPaneTab]);

  // Keep the resizable right pane panel in sync with the persisted open flag.
  // Follows the same collapse/expand pattern as the project tree panel.
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!rightToolAreaOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastRightPanelSizeRef.current}%`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [rightToolAreaOpen]);

  const handleRightPanelResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 2) {
      lastRightPanelSizeRef.current = percentage;
    }
    const layout = toolWindowLayoutRef.current;
    const next = percentage > 2;
    if (next === layout.sideOpen("right")) return;
    if (!next) layout.hideSide("right");
  }, []);

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

  const highlightUsagesInFile = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const requestGeneration = ++occurrenceRequestGenerationRef.current;
    // A manual request supersedes any cursor-driven request that is still in
    // flight. Its response may not overwrite the explicit session afterward.
    autoHighlightRequestGenerationRef.current += 1;
    // The caret state commits in a transition; Ctrl+Shift+F7 right after a
    // caret move must use the position the editor reported synchronously.
    const position = cursorPositionsRef.current[activeEditorGroupId] ?? { line: 0, character: 0 };
    const descriptor = lspDescriptorForFile(file);
    const rev = lspDocumentEpochRef.current[file.key] ?? 0;
    const needsLiveLspCheck = Boolean(
      activeCapabilities?.documentHighlight && descriptor && activeLspDocumentIsSynced,
    );
    const canApply = () => (
      occurrenceRequestGenerationRef.current === requestGeneration
      && occurrenceActiveFileKeyRef.current === file.key
      && occurrenceActiveGroupIdRef.current === activeEditorGroupId
      && openFilesRef.current[file.key]?.text === file.text
      && (!needsLiveLspCheck || isCurrentLspDocumentRequest(file, rev))
    );
    const lines = file.text.split("\n");
    let offset = 0;
    for (let l = 0; l < Math.min(position.line, lines.length); l += 1) {
      offset += lines[l].length + 1;
    }
    offset += Math.min(position.character, lines[position.line]?.length ?? 0);
    const token = wordAt(file.text, offset);
    const word = token?.word || "symbol";

    let highlights: LspDocumentHighlight[] = [];
    if (activeCapabilities?.documentHighlight && descriptor && activeLspDocumentIsSynced) {
      try {
        const result = await lspDocumentHighlights(descriptor, position);
        highlights = result.highlights;
      } catch {
        highlights = fallbackWordHighlights(file.text, position);
      }
    } else {
      highlights = fallbackWordHighlights(file.text, position);
    }

    if (!canApply()) return;
    if (highlights.length === 0) {
      setStatusMessage(`No occurrences found for "${word}"`);
      setOccurrenceSession(null);
      occurrenceSessionRef.current = null;
      return;
    }

    const session = createOccurrenceSession(file.key, rev, word, highlights, position);
    setOccurrenceSession(session);
    occurrenceSessionRef.current = session;
    // An explicit action paints with its status message; only caret-driven
    // highlighting renders as a transition.
    setHighlightsByGroupNow((current) => ({
      ...current,
      [activeEditorGroupId]: highlights,
    }));
    setStatusMessage(formatOccurrenceStatus(session));
  }, [
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

  const compareWithClipboard = useCallback(async () => {
    const file = activeFile;
    if (!file) return;
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const rightDescriptor = {
      ...compareDescriptorForOpenFile(file, "buffer", file.path, rightText, rightTitle),
      readOnly: !!file.library,
    };
    try {
      const clipboard = await readTextResult();
      if (!clipboard.ok) {
        setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: "read-failed",
          message: "The system clipboard could not be read.",
          right: rightDescriptor,
          target,
        }));
        return;
      }
      const result = createClipboardCompareSession(
        file.title,
        file.path,
        file.text,
        clipboard.text,
        selection,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Clipboard is unavailable");
        setActiveCompareSession(createUnavailableCompareSession({
          source: "clipboard",
          title: `Compare ${rightTitle} with Clipboard`,
          unavailableTitle: "Clipboard",
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "clipboard",
        title: `Compare ${rightTitle} with Clipboard`,
        unavailableTitle: "Clipboard",
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [activeFile]);

  const compareWithFile = useCallback(async () => {
    const file = activeFile;
    if (!file || file.library) return;
    const selection = compareSelectionFromEditorSelection(editorSelectionRef.current);
    const rightText = selection?.text ?? file.text;
    const rightTitle = selection ? `${file.title} (Selection)` : file.title;
    const target = compareTargetForOpenFile(file, selection);
    const activePath = absolutePathForOpenFile(file) ?? file.path;
    const rightDescriptor = compareDescriptorForOpenFile(file, "buffer", activePath, rightText, rightTitle);
    const selectedPath = await selectFilePath();
    if (!selectedPath) {
      setStatusMessage("Compare with file cancelled");
      return;
    }

    const normalizedPath = normalizeFsPath(selectedPath);
    const root = rootsRef.current.find((candidate) => (
      relativePathWithinRoot(candidate.path, normalizedPath) !== null
    ));
    const title = normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;
    try {
      const selected = root
        ? await workspaceReadFile(
          root.path,
          relativePathWithinRoot(root.path, normalizedPath) ?? "",
          MAX_COMPARE_SIZE_BYTES + 1,
        )
        : await workspaceReadLooseFile(normalizedPath, MAX_COMPARE_SIZE_BYTES + 1);
      const result = createFileCompareSession(
        {
          title,
          path: normalizedPath,
          text: selected.text,
          encoding: selected.encoding ?? "UTF-8",
          bom: selected.bom ?? false,
          sizeBytes: selected.size,
          source: "file",
          readOnly: true,
        },
        rightDescriptor,
        target,
      );
      if (!result.session) {
        const unavailable = classifyCompareReadError(result.error || "Selected file is unavailable");
        setActiveCompareSession(createUnavailableCompareSession({
          source: "file",
          title: `Compare ${rightTitle} with ${title}`,
          unavailableTitle: title,
          reason: unavailable.reason,
          message: unavailable.message,
          right: rightDescriptor,
          target,
        }));
        return;
      }
      setActiveCompareSession(result.session);
    } catch (error) {
      const unavailable = classifyCompareReadError(error);
      setActiveCompareSession(createUnavailableCompareSession({
        source: "file",
        title: `Compare ${rightTitle} with ${title}`,
        unavailableTitle: title,
        reason: unavailable.reason,
        message: unavailable.message,
        right: rightDescriptor,
        target,
      }));
    }
  }, [absolutePathForOpenFile, activeFile, setStatusMessage]);

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

  const applyCompareSession = useCallback(async (
    session: EditorCompareSession,
    newText: string,
  ) => {
    const target = session.target;
    if (!target) throw new Error("Comparison target is no longer available");
    if (workspaceResourceOperationLocked) {
      throw new Error("Workspace resource operations are busy");
    }
    flushPendingEditorText();
    let current = openFilesRef.current[target.fileKey] ?? null;
    if (current?.library) throw new Error(`${current.title} is a read-only library source`);
    if (!compareTargetMatches(current, target)) {
      throw new Error("Comparison target is stale; no changes were applied");
    }
    if (!current) throw new Error("Comparison target is no longer open");
    if (current.dirty) {
      const confirmed = await confirmAppDialog({
        title: "Apply comparison",
        message: `Replace unsaved changes in ${current.subtitle} with the comparison result?`,
        confirmLabel: "Apply",
      });
      if (!confirmed) {
        setStatusMessage("Comparison apply cancelled; unsaved changes were kept");
        return;
      }
      flushPendingEditorText();
      current = openFilesRef.current[target.fileKey] ?? null;
      if (current?.library) throw new Error(`${current.title} is a read-only library source`);
      if (!compareTargetMatches(current, target)) {
        throw new Error("Comparison target became stale; no changes were applied");
      }
      if (!current) throw new Error("Comparison target is no longer open");
    }

    const nextText = target.selection
      ? replaceCompareSelection(current.text, target.selection, newText)
      : normalizeCompareText(newText);
    if (nextText === null) {
      throw new Error("Comparison selection is stale; no changes were applied");
    }
    if (nextText === current.text) {
      setStatusMessage("Comparison already matches the current buffer");
      return;
    }

    const beforeText = current.text;
    const next = mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "workspace-edit");
    if (!next) throw new Error("Comparison target closed before apply");
    const affectedPath = absolutePathForOpenFile(next) ?? next.path;
    semanticIndex.invalidate("document-edited", [affectedPath]);
    workspaceEditHistory.push({
      id: `${workspaceInstanceId}:compare:${Date.now()}`,
      label: `Apply comparison from ${session.left.title}`,
      affectedPaths: [affectedPath],
      undo: async () => {
        const live = openFilesRef.current[target.fileKey] ?? null;
        if (!compareTargetMatches(live, {
          ...target,
          documentRevision: next.documentRevision ?? 0,
          expectedText: next.text,
        })) {
          throw new Error("Cannot undo comparison: the buffer changed after apply");
        }
        const restored = mutateOpenBuffer(target.fileKey, { text: beforeText, error: null }, "history-replay");
        if (!restored) throw new Error("Cannot undo comparison: target is closed");
        semanticIndex.invalidate("document-edited", [affectedPath]);
        await syncLspDocument(restored, "change");
      },
      redo: async () => {
        const live = openFilesRef.current[target.fileKey] ?? null;
        if (!live || live.text !== beforeText) {
          throw new Error("Cannot redo comparison: the buffer changed after undo");
        }
        const redone = mutateOpenBuffer(target.fileKey, { text: nextText, error: null }, "history-replay");
        if (!redone) throw new Error("Cannot redo comparison: target is closed");
        semanticIndex.invalidate("document-edited", [affectedPath]);
        await syncLspDocument(redone, "change");
      },
    });
    setWorkspaceEditHistoryRevision((revision) => revision + 1);
    await syncLspDocument(next, "change");
    setActiveCompareSession(null);
    setStatusMessage(`Applied comparison to ${next.subtitle}; undo is available`);
  }, [
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

  // §8.16.5 N2.6: Ctrl+Tab MRU Switcher state. Hold-to-cycle, release-to-commit,
  // Esc cancels; hovering an entry previews without mutating MRU order.
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [tabSwitcherIndex, setTabSwitcherIndex] = useState(0);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const tabSwitcherOpenRef = useRef(false);
  const tabSwitcherIndexRef = useRef(0);
  tabSwitcherOpenRef.current = tabSwitcherOpen;
  tabSwitcherIndexRef.current = tabSwitcherIndex;
  const mruFileKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeKey) return;
    mruFileKeysRef.current = [
      activeKey,
      ...mruFileKeysRef.current.filter((key) => key !== activeKey),
    ].slice(0, 24);
  }, [activeKey]);

  // §8.19.6: bottom-dock panels mirror their REAL dock state into the
  // workspace-scoped tool-window registry; the Switcher consumes registry
  // snapshots instead of constructing its own list.
  useEffect(() => {
    syncBottomDockToolWindows(workspaceInstanceId, { open: bottomDockOpen, activeTab: bottomDockTab });
  }, [workspaceInstanceId, bottomDockOpen, bottomDockTab]);
  useEffect(() => () => unregisterAllToolWindows(workspaceInstanceId), [workspaceInstanceId]);

  // §8.17.5 step 4 + §8.19.6: the popup cycles over ONE frozen snapshot
  // captured at open time — editor MRU entries plus registry cycle snapshots.
  // Tool windows opened/closed in the background cannot shift the index
  // space or reorder entries mid-cycle; release commits against the snapshot.
  const [switcherSnapshot, setSwitcherSnapshot] = useState<{
    editors: TabSwitcherEntry[];
    tools: TabSwitcherToolWindow[];
  } | null>(null);
  const switcherSnapshotRef = useRef(switcherSnapshot);
  switcherSnapshotRef.current = switcherSnapshot;

  const buildSwitcherSnapshot = useCallback(() => {
    // §8.18.5 leaf identity: resolve which layout leaf currently owns each
    // file so commit reactivates the ORIGINAL view instead of the active one.
    const ownerByFileKey = new Map<string, string>();
    for (const leaf of getAllLeafNodes(workspaceUi.layoutTreeV2)) {
      for (const key of leaf.openFileKeys) {
        if (!ownerByFileKey.has(key)) ownerByFileKey.set(key, leaf.id);
      }
    }
    const editors: TabSwitcherEntry[] = mruFileKeysRef.current
      .map((key) => openFiles[key])
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .map((entry) => {
        const owningGroup = Object.values(editorGroups).find(
          (group) => group.openOrder.includes(entry.key),
        );
        return {
          key: entry.key,
          title: entry.title,
          subtitle: entry.subtitle,
          dirty: entry.dirty,
          active: entry.key === activeKey,
          leafId: ownerByFileKey.get(entry.key) ?? owningGroup?.id ?? null,
          pinned: owningGroup?.pinnedKeys?.includes(entry.key) ?? false,
          preview: owningGroup?.previewKey === entry.key,
        };
      });
    const tools: TabSwitcherToolWindow[] = listToolWindowsForCycle(workspaceInstanceId).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.title,
      open: snapshot.state === "open",
    }));
    return { editors, tools };
  }, [activeKey, editorGroups, openFiles, workspaceInstanceId, workspaceUi.layoutTreeV2]);
  const buildSwitcherSnapshotRef = useRef(buildSwitcherSnapshot);
  buildSwitcherSnapshotRef.current = buildSwitcherSnapshot;

  const switcherTotalCountRef = useRef(0);
  switcherTotalCountRef.current = switcherSnapshot
    ? switcherSnapshot.editors.length + switcherSnapshot.tools.length
    : 0;

  /**
   * Leaf-aware switcher close, graded per §8.19.6: pinned tabs refuse with a
   * reason (protected work is never silently closed), dirty tabs go through
   * the same confirm path as the tab strip, and tool windows only hide.
   */
  const closeFromTabSwitcher = useCallback(async () => {
    const snapshot = switcherSnapshotRef.current;
    if (!snapshot) return;
    const index = Math.min(
      tabSwitcherIndexRef.current,
      snapshot.editors.length + snapshot.tools.length - 1,
    );
    const editorEntry = snapshot.editors[index];
    if (editorEntry) {
      if (editorEntry.pinned) {
        setStatusMessage(`${editorEntry.title} is pinned — unpin it before closing`);
        return;
      }
      setTabSwitcherOpen(false);
      setSwitcherSnapshot(null);
      await closeFile(editorEntry.key, editorEntry.leafId ?? activeEditorGroupId);
      return;
    }
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      // Single-tab dock: hiding the dock IS hiding this window; it stays
      // registered as hidden and reopens through the Switcher.
      setBottomDockOpen(false);
    }
  }, [activeEditorGroupId, closeFile, setBottomDockOpen, setStatusMessage]);

  const commitTabSwitcher = useCallback((index: number) => {
    const snapshot = switcherSnapshotRef.current;
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    if (!snapshot) return;
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      setBottomDockOpen(true);
      setBottomDockTab(toolWindow.id as BottomDockTabId);
      return;
    }
    const target = snapshot.editors[index];
    if (!target) return;
    const targetRef = openFilesRef.current[target.key]?.ref ?? null;
    if (target.key === activeKeyRef.current && target.leafId) {
      setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
      return;
    }
    if (target.leafId) {
      const leafStillExists = getAllLeafNodes(workspaceUi.layoutTreeV2).some((leaf) => leaf.id === target.leafId);
      if (leafStillExists) {
        // Original leaf activation (§8.18.5): never reroute through the
        // currently active group.
        setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
        setLeafActiveTab(workspaceInstanceId, target.leafId, target.key);
        return;
      }
      setStatusMessage(`${target.title}: its split was closed — reopened in the current editor`);
    }
    if (targetRef) void openFile(targetRef);
  }, [workspaceUi.layoutTreeV2, openFile, setStoreActiveEditorGroup, setLeafActiveTab, setStatusMessage, setBottomDockOpen, setBottomDockTab, workspaceInstanceId]);
  const commitTabSwitcherRef = useRef(commitTabSwitcher);
  commitTabSwitcherRef.current = commitTabSwitcher;
  const closeFromTabSwitcherRef = useRef(closeFromTabSwitcher);
  closeFromTabSwitcherRef.current = closeFromTabSwitcher;
  const dispatchWorkspaceKeydownV2 = actionsController.dispatchKeydownV2;

  useEffect(() => {
    if (!visible) return;
    // §8.17.3 step 2: ONE capture keydown listener for the whole workspace.
    // The Ctrl+Tab switcher runs inside this listener through the action
    // host's normalized key identity (`eventLogicalKey`), so macOS Meta+Tab
    // and Windows/Linux Ctrl+Tab share one code path and no second window
    // listener competes with the host dispatch below.
    const handleWorkspaceCommand = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // Navigation bar and popup controls own their keyboard state. They are
      // rendered in the workspace or a portal, so the window capture listener
      // must not turn Home/arrows/Enter/Escape into editor actions first.
      if (isSurfaceOwnedKeyEvent(event.target)) return;
      const logicalKey = eventLogicalKey(event);
      const targetElement = event.target instanceof Element ? event.target : null;
      if (
        !event.ctrlKey && !event.metaKey && !event.altKey
        && targetElement?.closest('[data-testid="code-workspace-find-file-group"]')
        && ["delete", "arrowup", "arrowdown", "enter"].includes(logicalKey)
      ) return;
      // IDEA debugger trees own their navigation and value keys (F2 Set
      // Value, Delete removes a watch, Ctrl+C copies the value); stepping keys
      // such as F7/F8/F9 still reach the workspace dispatcher.
      if (
        targetElement?.closest('[data-testid="debug-variables-tree"], [data-testid="debug-frames-list"]')
        && !event.altKey
        && (
          (!event.ctrlKey && !event.metaKey
            && ["f2", "f4", "delete", "insert", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end"].includes(logicalKey))
          || ((event.ctrlKey || event.metaKey) && !event.shiftKey && logicalKey === "c")
        )
      ) return;
      // Native text controls own their character history. A workspace journal
      // must never consume Ctrl/Cmd+Z, redo, or Ctrl/Cmd+Y while an input is
      // focused, otherwise replacing files would be undone from the query box.
      if (
        isNativeTextInputTarget(event.target)
        && (event.ctrlKey || event.metaKey)
        && !event.altKey
        && ["z", "y"].includes(logicalKey)
      ) return;
      const switcherModifier = event.ctrlKey || event.metaKey;
      if (logicalKey === "tab" && switcherModifier && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!tabSwitcherOpenRef.current) {
          // Openable when there are editor entries OR tool windows to list;
          // the snapshot is frozen here for the whole cycle (§8.19.6).
          const snapshot = buildSwitcherSnapshotRef.current();
          if (snapshot.editors.length + snapshot.tools.length === 0) return;
          setSwitcherSnapshot(snapshot);
          setTabSwitcherIndex(snapshot.editors.length > 1 ? 1 : 0);
          setTabSwitcherOpen(true);
          return;
        }
        setTabSwitcherIndex((index) => {
          const count = switcherTotalCountRef.current;
          if (count === 0) return 0;
          return event.shiftKey
            ? (index - 1 + count) % count
            : (index + 1) % count;
        });
        return;
      }
      if (logicalKey === "escape" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setTabSwitcherOpen(false);
        return;
      }
      // IDEA Switcher: arrows walk the columns while the modifier is held.
      if (
        tabSwitcherOpenRef.current
        && (logicalKey === "arrowup" || logicalKey === "arrowdown" || logicalKey === "arrowleft" || logicalKey === "arrowright")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const snapshot = switcherSnapshotRef.current;
        setTabSwitcherIndex((index) => switcherArrowIndex(
          index,
          logicalKey,
          snapshot?.editors.length ?? 0,
          snapshot?.tools.length ?? 0,
        ));
        return;
      }
      // Bare Tab belongs to the focused native control outside the editor.
      // Otherwise the active editor's insertTab action would consume a banner,
      // tree, or settings control's browser focus navigation.
      if (logicalKey === "tab" && !switcherModifier && !isEditorSurfaceKeyEvent(event.target)) return;
      // Ctrl+Shift+T is shared with MainLayout's shell owner. Let the root
      // router consume it so the workspace claim and terminal fallback cannot
      // both run for the same key event.
      if (
        logicalKey === "t"
        && (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && !event.altKey
        && onCommandsChange
      ) return;
      // §8.18.5: Backspace inside the open Switcher closes the selected
      // editor entry (dirty tabs confirm) or hides the selected tool window.
      if (logicalKey === "backspace" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        void closeFromTabSwitcherRef.current();
        return;
      }
      const editorEventOwner = isEditorSurfaceKeyEvent(event.target)
        ? activeEditorCommandOwner()
        : null;
      // Completion is an editor-local state machine. The workspace capture
      // listener runs before CodeMirror, so it must yield these unmodified
      // navigation/accept/cancel keys while the popup is active. Bare Tab
      // always stays local: CodeMirror accepts completion/live templates and
      // then falls through to indentation when neither applies.
      if (editorEventOwner && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (logicalKey === "tab") return;
        const activeCompletionId = targetElement?.getAttribute("aria-activedescendant");
        const hasActiveCompletionCandidate = !!activeCompletionId
          && !!document.getElementById(activeCompletionId)?.closest(".cm-tooltip-autocomplete");
        if (
          !event.shiftKey
          && (
            editorEventOwner.port.state().completionActive
            || hasActiveCompletionCandidate
          )
          && ["arrowup", "arrowdown", "pageup", "pagedown", "enter", "escape"].includes(logicalKey)
        ) return;
      }
      const dispatchResult = dispatchWorkspaceKeydownV2({
        event,
        workspaceId: workspaceInstanceId,
        // CodeMirrorHost registers each split by its stable leaf/view id;
        // fileKey is shared by split views and cannot identify a live view.
        // Non-editor surfaces must resolve their own focus from the event
        // target; otherwise a tree Delete is evaluated against the editor
        // context before the tree can consume it.
        targetViewId: editorEventOwner
          ? activeEditorGroupIdRef.current
          : null,
        composing: editorEventOwner?.port.state().composing ?? false,
      });
      if (
        dispatchResult.kind === "rejected"
        && dispatchResult.reason === "disabled"
        && dispatchResult.disabledReason
      ) {
        // §8.19.2 typed no-op reason: a matched-but-disabled binding names its
        // blocked state instead of silently skipping the shortcut.
        setStatusMessage(
          disabledReasonLabel(dispatchResult.disabledReason) ?? dispatchResult.disabledReason,
        );
      }
    };
    // Modifier-release commit cannot be a keydown action; it stays a keyup
    // listener and commits on whichever platform modifier started the cycle.
    const release = (event: KeyboardEvent) => {
      if (!tabSwitcherOpenRef.current) return;
      if (event.key !== "Control" && event.key !== "Meta") return;
      commitTabSwitcherRef.current(Math.min(tabSwitcherIndexRef.current, switcherTotalCountRef.current - 1));
    };
    window.addEventListener("keydown", handleWorkspaceCommand, true);
    window.addEventListener("keyup", release, true);
    return () => {
      window.removeEventListener("keydown", handleWorkspaceCommand, true);
      window.removeEventListener("keyup", release, true);
    };
  }, [dispatchWorkspaceKeydownV2, isEditorSurfaceKeyEvent, isNativeTextInputTarget, isSurfaceOwnedKeyEvent, onCommandsChange, openFile, visible]);

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
    async (
      request: { fileKey: string; uri: string; position: LspPosition; documentRevision: number; providerGeneration: number },
      triggerCharacter: string | null,
      { signal }: { signal: AbortSignal },
    ) => {
      const file = openFilesRef.current[request.fileKey];
      if (!file) return null;
      if (!shouldLiveSyncLsp(file.languagePath, lspFilesRef.current[file.key])) return null;
      const live = await ensureLspDocumentSynced(file.key);
      if (!live) return null;
      if (!isLspFeatureReady(lspFilesRef.current[live.key])) return null;
      const descriptor = lspDescriptorForFile(live);
      if (!descriptor) return null;
      const cancelKey = `${workspaceInstanceId}|${file.key}`;
      const requestSeq = nextLspRequestSequence();
      const onAbort = () => {
        void lspCancelReferenceRequest(cancelKey, requestSeq).catch(() => 0);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await lspSignatureHelp(
          descriptor,
          request.position,
          triggerCharacter ?? null,
          { cancelKey, requestSeq },
        );
        if (signal.aborted) return null;
        const current = openFilesRef.current[live.key];
        if (
          !current
          || current.documentRevision !== request.documentRevision
          || lspSessionGeneration() !== request.providerGeneration
        ) {
          return null;
        }
        updateLspStatusForFile(live, result.status);
        if (!result.signatures.length || !result.status.active) return null;
        return {
          state: "payload" as const,
          payload: {
            kind: "parameter-info" as const,
            signatures: result.signatures,
            activeSignature: result.activeSignature,
            activeParameter: result.activeParameter,
          },
        };
      } catch {
        // Request-level failures close the popup quietly; the next explicit
        // action or trigger re-queries.
        return null;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
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
    async (file: OpenFileState, position: LspPosition): Promise<QuickDocContent | null> => {
      // While the debugger is stopped in this file, the hover belongs to the
      // debugger (IDEA shows the value, not the javadoc). Read through the ref:
      // the debug hook is declared later in this component.
      const session = debugRef.current;
      if (session?.state?.status === "stopped") {
        const stoppedPath = session.currentLocation?.path;
        const filePath = absolutePathForOpenFile(file);
        if (stoppedPath && filePath && fsPathEquals(stoppedPath, filePath)) {
          return null;
        }
      }
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return null;
      const requestRevision = file.documentRevision;
      const requestGeneration = lspSessionGeneration();
      const lines = file.text.split("\n");
      const line = lines[position.line] ?? "";
      const left = line.slice(0, position.character);
      const right = line.slice(position.character);
      const start = left.search(/[A-Za-z0-9_$]+$/);
      const endMatch = right.match(/^[A-Za-z0-9_$]*/);
      const from = start >= 0 ? start : position.character;
      const to = position.character + (endMatch?.[0].length ?? 0);
      let providerLabel = "Language Server";
      let providerUri: string | null = null;
      const outcome = await referenceInfoController.requestTyped({
        kind: "quick-documentation",
        workspaceId: workspaceInstanceId,
        fileKey: file.key,
        uri: descriptor.documentUri ?? lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath,
        languageId: descriptor.languageId ?? "plaintext",
        position,
        documentRevision: requestRevision,
        providerGeneration: requestGeneration,
      }, async ({ signal }) => {
        // §8.18.6: same provider-cancellation identity as the explicit path.
        const cancelKey = `${workspaceInstanceId}|${file.key}`;
        const requestSeq = nextLspRequestSequence();
        const result = await lspHover(descriptor, position, { cancelKey, requestSeq });
        if (signal.aborted) return null;
        const current = openFilesRef.current[file.key];
        if (
          !current
          || current.documentRevision !== requestRevision
          || lspSessionGeneration() !== requestGeneration
        ) {
          return null;
        }
        updateLspStatusForFile(file, result.status);
        if (!result.contents) return null;
        providerLabel = result.status.displayName ?? "Language Server";
        providerUri = result.status.uri ?? null;
        return {
          state: "payload" as const,
          payload: {
            kind: "quick-documentation" as const,
            markdown: result.contents,
            source: result.range && result.status.uri
              ? {
                  uri: result.status.uri,
                  path: result.status.path ?? null,
                  range: result.range,
                }
              : null,
          },
        };
      });
      if (outcome.state !== "ready" || outcome.payload.kind !== "quick-documentation") {
        if (outcome.state === "failed") {
          setLspFiles((current) => ({
            ...current,
            [file.key]: {
              ...(current[file.key] ?? emptyLspFileState()),
              error: outcome.state === "failed" ? outcome.message : "",
            },
          }));
        }
        return null;
      }
      // Hover refreshes the cursor-linked popup but never writes history —
      // only ready explicit QuickDoc does (§8.20.2).
      return {
        title: line.slice(from, to) || file.title,
        body: outcome.payload.markdown,
        source: providerLabel,
        uri: providerUri,
        sourceLocation: outcome.payload.source,
        revision: requestRevision,
        generation: requestGeneration,
      };
    },
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
    async (file: OpenFileState, position: LspPosition) => {
      // Languages whose declaration is the definition (Java, Kotlin, …) go
      // straight to the definition query. Preparing here first forced a second
      // buffer sync inside goToDefinition, which could supersede the query and
      // drop Ctrl+B silently (ED-PARITY-013: Ctrl+B is now the navigation key).
      const current = openFilesRef.current[file.key] ?? file;
      const currentLanguageId = lspFilesRef.current[current.key]?.status?.languageId
        ?? lspDescriptorForFile(current)?.languageId
        ?? current.languagePath;
      if (isDeclarationDefinitionEquivalentLanguage(currentLanguageId, current.path)) {
        return goToDefinition(current, position);
      }
      const prepared = await prepareSemanticNavigationRequest(file);
      if (!prepared) return false;
      const { file: live, descriptor } = prepared;
      const caps = lspFilesRef.current[live.key]?.status?.capabilities;
      if (caps && caps.declaration === false) {
        if (caps.definition !== false) {
          return goToDefinition(live, position);
        }
        setStatusMessage("Go to declaration is not supported by this language server");
        return false;
      }
      try {
        const query = beginSemanticQuery("declarations", live, descriptor, position);
        const queryRes = await semanticQueryHostRef.current.executeEnvelope<LspLocation>({
          kind: "declarations",
          identity: query.identity,
          fetcher: async ({ signal }) => {
            const result = await lspDeclaration(descriptor, position, query.lspOptions(signal));
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
          if (caps?.definition !== false) {
            return goToDefinition(live, position);
          }
          setStatusMessage(queryRes.error ?? "No declaration found");
          return false;
        }
        if (queryRes.items.length === 0 && caps?.definition !== false) {
          return goToDefinition(live, position);
        }
        return navigateLocations(
          "Declarations",
          queryRes.items,
          "No declaration found",
          query.isCurrent,
          { file: live, ref: live.ref, position },
        );
      } catch (err) {
        if (caps?.definition !== false) {
          return goToDefinition(live, position);
        }
        setStatusMessage(errorMessage(err));
        return false;
      }
    },
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

  // ---------------------------------------------------------------------------
  // ED-PARITY-017 DEC-017-01..04: in-place naming for Rename / Extract Method
  // ---------------------------------------------------------------------------
  const [inlineRename, setInlineRename] = useState<InlineRenameRequest | null>(null);
  const inlineRenameRef = useRef<InlineRenameRequest | null>(null);
  const [refactorModalOptions, setRefactorModalOptions] = useState(() => readRefactorOptionsMode() === "dialog");

  const finishInlineRename = useCallback((request: InlineRenameRequest, result: InlineNameResult) => {
    if (inlineRenameRef.current !== request) return;
    inlineRenameRef.current = null;
    setInlineRename(null);
    try {
      showInlineRenameMarks(request.view, null);
    } catch {
      // The view may already be destroyed (tab closed during the session).
    }
    // Focus returns to the editor at the untouched caret (DEC-017-03).
    if (request.view.dom.isConnected) request.view.focus();
    request.resolve(result);
  }, []);

  const activeEditorViewFor = useCallback((fileKey: string): EditorView | null => {
    const root = rootRef.current;
    const groupId = activeEditorGroupIdRef.current;
    const host = root?.querySelector<HTMLElement>(
      `[data-testid="code-workspace-editor-pane"][data-editor-group-id="${CSS.escape(groupId)}"] [data-testid="code-workspace-editor"] .cm-editor`,
    );
    const view = host ? EditorView.findFromDOM(host) : null;
    const live = openFilesRef.current[fileKey];
    if (!view || !live || view.state.doc.toString() !== live.text) return null;
    return view;
  }, []);

  /**
   * Open the in-place naming session over `range`. Resolves `dialog` when the
   * editor view cannot host it (no view, moved document) so the caller falls
   * back to the modal prompt instead of silently doing nothing.
   */
  const promptInlineName = useCallback(async (input: {
    fileKey: string;
    kind: "rename" | "extract";
    range: LspRange;
    defaultName: string;
    initialValue?: string;
    error?: string | null;
  }): Promise<InlineNameResult> => {
    const view = activeEditorViewFor(input.fileKey);
    if (!view) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    const doc = view.state.doc;
    const offset = (position: LspPosition) => {
      const line = doc.line(Math.min(Math.max(position.line + 1, 1), doc.lines));
      return Math.min(line.from + position.character, line.to);
    };
    const target: InlineRenameRange = { from: offset(input.range.start), to: offset(input.range.end) };
    if (target.to <= target.from) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    if (inlineRenameRef.current) finishInlineRename(inlineRenameRef.current, { kind: "cancel" });
    view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "nearest" }) });
    await new Promise<void>((resolve) => { window.requestAnimationFrame(() => resolve()); });
    const coords = view.coordsAtPos(target.from);
    if (!coords) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    const style = window.getComputedStyle(view.contentDOM);
    const anchor: InlineRenameAnchor = {
      left: coords.left,
      top: coords.top,
      height: Math.max(12, coords.bottom - coords.top),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
    };
    showInlineRenameMarks(view, { target, occurrences: [] });
    const live = openFilesRef.current[input.fileKey];
    const descriptor = live ? lspDescriptorForFile(live) : null;
    return new Promise<InlineNameResult>((resolve) => {
      const request: InlineRenameRequest = {
        id: Date.now(),
        kind: input.kind,
        fileKey: input.fileKey,
        view,
        anchor,
        initialValue: input.initialValue ?? input.defaultName,
        suggestions: suggestInlineRenameNames(input.defaultName),
        initialError: input.error ?? null,
        languageId: descriptor?.languageId
          ?? (/\.java$/i.test(live?.ref.path ?? "") ? "java" : null),
        resolve,
      };
      inlineRenameRef.current = request;
      setRefactorModalOptions(readRefactorOptionsMode() === "dialog");
      setInlineRename(request);
      // Other occurrences in this file are boxed when the provider can answer
      // document highlights; the session never waits for them.
      const caps = lspFilesRef.current[input.fileKey]?.status?.capabilities;
      if (input.kind === "rename" && descriptor && caps?.documentHighlight) {
        void lspDocumentHighlights(descriptor, input.range.start)
          .then((result) => {
            if (inlineRenameRef.current !== request) return;
            const occurrences = result.highlights
              .map((highlight) => ({ from: offset(highlight.range.start), to: offset(highlight.range.end) }))
              .filter((range) => range.to > range.from);
            showInlineRenameMarks(view, { target, occurrences });
          })
          .catch(() => {});
      }
    });
  }, [activeEditorViewFor, finishInlineRename, lspDescriptorForFile]);

  // The session belongs to one editor document; switching files ends it.
  useEffect(() => {
    const request = inlineRenameRef.current;
    if (request && request.fileKey !== activeKey) finishInlineRename(request, { kind: "cancel" });
  }, [activeKey, finishInlineRename]);

  /** DEC-017-01: in-place naming by default, the modal prompt as the option / fallback. */
  const promptSymbolName = useCallback(async (input: {
    file: OpenFileState;
    kind: "rename" | "extract";
    range: LspRange | null;
    defaultName: string;
    initialValue?: string;
    error?: string | null;
    dialog: (initialValue: string) => Promise<string | null>;
  }): Promise<string | null> => {
    if (readRefactorOptionsMode() === "dialog" || !input.range) {
      return input.dialog(input.initialValue ?? input.defaultName);
    }
    const result = await promptInlineName({
      fileKey: input.file.key,
      kind: input.kind,
      range: input.range,
      defaultName: input.defaultName,
      initialValue: input.initialValue,
      error: input.error,
    });
    if (result.kind === "commit") return result.name;
    if (result.kind === "dialog") return input.dialog(result.value);
    return null;
  }, [promptInlineName]);

  // "The workspace changed" alone cannot separate a genuine concurrent edit
  // from a watcher echo of the provider's own project metadata
  // (.project/.classpath/.settings) arriving during a rename. Name it.
  const describeSemanticInvalidation = useCallback((
    snapshot: ReturnType<typeof semanticIndex.current>,
    tokenRevision: number,
  ): string => [
    snapshot.staleReasons.length > 0 ? `reasons=${snapshot.staleReasons.join(",")}` : null,
    snapshot.invalidatedPaths.length > 0
      ? `paths=${snapshot.invalidatedPaths.slice(0, 3).join(",")}`
      : null,
    `revision=${snapshot.revision}/${tokenRevision}`,
  ].filter(Boolean).join(" "), []);

  const renameSymbolAt = useCallback(createRenameSymbolAt({
    lspFilesRef,
    setStatusMessage,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    updateLspStatusForFile,
    promptSymbolName,
    describeSemanticInvalidation,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    rootsRef,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
  }), [
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    promptSymbolName,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);

  const renameSymbolAtCursor = useCallback(async () => {
    const file = activeFile;
    if (!file || file.loading) return;
    const position = editorSelectionRef.current.start;
    if (readRefactorOptionsMode() === "dialog") {
      await renameSymbolAt(file, position);
      return;
    }
    // DEC-017-03: a provider rejection reopens the in-place session with the
    // rejected name and the real error, so the user can correct and retry
    // without anything having been written.
    let retry: { value: string; error: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let submitted: string | null = null;
      const carried: { value: string; error: string } | null = retry;
      const live = openFilesRef.current[file.key] ?? file;
      const outcome = await renameSymbolAt(live, position, {
        promptName: async (defaultName, range) => {
          submitted = await promptSymbolName({
            file: live,
            kind: "rename",
            range,
            defaultName,
            initialValue: carried?.value,
            error: carried?.error,
            dialog: (initialValue) => promptAppDialog({
              title: "Rename Symbol",
              label: "New name",
              initialValue,
              confirmLabel: "Rename",
            }),
          });
          return submitted;
        },
      });
      if (outcome.status !== "failed" || !outcome.retryable || !submitted) return;
      retry = { value: submitted, error: outcome.message ?? "Rename failed" };
    }
  }, [activeFile, promptSymbolName, renameSymbolAt]);
  renameSymbolRef.current = renameSymbolAtCursor;

  // ---------------------------------------------------------------------------
  // ED-PARITY-007 DEC-02/03/05/06/07: direct Extract Method transaction
  // ---------------------------------------------------------------------------
  const extractLiveUri = useCallback((fileKey: string): string => {
    const live = openFilesRef.current[fileKey];
    if (!live) return "";
    const descriptor = lspDescriptorForFile(live);
    return descriptor?.documentUri
      ?? lspFilesRef.current[live.key]?.status?.uri
      ?? descriptor?.filePath
      ?? "";
  }, [lspDescriptorForFile]);

  const extractOwnerSnapshot = useCallback((session: ExtractSession): ExtractOwnerSnapshot => ({
    sessionId: session.id,
    workspaceInstance: workspaceInstanceId,
    sourceViewId: activeEditorGroupIdRef.current,
    fileKey: session.fileKey,
    uri: extractLiveUri(session.fileKey),
    providerGeneration: lspSessionGeneration(),
    projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
  }), [
    extractLiveUri,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    workspaceInstanceId,
  ]);

  const dismissExtractNamingPrompt = useCallback((sessionId?: string) => {
    const current = extractNamingPromptRef.current;
    if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return;
    extractNamingPromptRef.current = null;
    setExtractNamingPrompt(null);
    current.resolve(null);
  }, []);

  const resolveExtractNamingPrompt = useCallback((value: string | null) => {
    const current = extractNamingPromptRef.current;
    if (!current) return;
    extractNamingPromptRef.current = null;
    setExtractNamingPrompt(null);
    current.resolve(value);
  }, []);

  const finishExtractSession = useCallback((session: ExtractSessionState) => {
    session.phase = "finished";
    if (extractSessionRef.current === session) extractSessionRef.current = null;
    dismissExtractNamingPrompt(session.id);
  }, [dismissExtractNamingPrompt]);
  finishExtractSessionRef.current = finishExtractSession;

  const invalidateExtractSession = useCallback(() => {
    const session = extractSessionRef.current;
    if (!session) return;
    // Aborting only stops this owner from accepting further replies; it never
    // claims the language server cancelled anything.
    session.abortController.abort();
    finishExtractSession(session);
  }, [finishExtractSession]);

  /** DEC-03: zero-candidate boundary text; provider failures use DEC-05 text. */
  const captureMethodSymbols = useCallback(async (
    file: OpenFileState,
  ): Promise<LspDocumentSymbol[] | null> => {
    const live = openFilesRef.current[file.key];
    const descriptor = live ? lspDescriptorForFile(live) : null;
    if (!live || !descriptor) return null;
    try {
      const result = await lspDocumentSymbols(descriptor);
      updateLspStatusForFile(live, result.status);
      return result.symbols;
    } catch {
      return null;
    }
  }, [lspDescriptorForFile, updateLspStatusForFile]);
  captureMethodSymbolsRef.current = captureMethodSymbols;

  /**
   * DEC-03: an outline that is missing or empty is damaged provider data, not a
   * real answer (a Java file always has at least its class). Re-read once before
   * it can poison the post-extraction diff into an ambiguity.
   */
  const captureMethodSymbolsSettled = useCallback(async (
    file: OpenFileState,
  ): Promise<LspDocumentSymbol[] | null> => {
    for (let read = 0; read < 2; read += 1) {
      if (read > 0) {
        await new Promise((resolve) => { window.setTimeout(resolve, 300); });
      }
      const symbols = await captureMethodSymbols(file);
      if (symbols && symbols.length > 0) return symbols;
    }
    return null;
  }, [captureMethodSymbols]);

  const beginExtractSession = useCallback((input: {
    file: OpenFileState;
    range: LspRange;
    uri: string;
    beforeSymbols: LspDocumentSymbol[] | null;
  }): ExtractSessionState | null => {
    const live = openFilesRef.current[input.file.key];
    if (!live || live.loading) return null;
    const previous = extractSessionRef.current;
    if (previous) {
      // A newer request supersedes the old local owner; the old prompt is
      // resolved with null so it can never write for the new selection.
      previous.abortController.abort();
      finishExtractSession(previous);
    }
    const session: ExtractSessionState = {
      id: `extract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      workspaceInstance: workspaceInstanceId,
      sourceViewId: activeEditorGroupIdRef.current,
      fileKey: input.file.key,
      uri: input.uri,
      providerGeneration: lspSessionGeneration(),
      projectFingerprint: projectAnalysisSnapshot?.projectFingerprint ?? "",
      baseRevision: live.documentRevision,
      baseText: live.text,
      selection: { start: input.range.start, end: input.range.end },
      phase: "request",
      beforeSymbols: input.beforeSymbols,
      abortController: new AbortController(),
    };
    extractSessionRef.current = session;
    return session;
  }, [
    finishExtractSession,
    lspSessionGeneration,
    projectAnalysisSnapshot?.projectFingerprint,
    workspaceInstanceId,
  ]);
  beginExtractSessionRef.current = beginExtractSession;

  const promptExtractName = useCallback((
    sessionId: string,
    options: { title: string; label: string; confirmLabel: string; initialValue: string },
  ): Promise<string | null> => new Promise<string | null>((resolve) => {
    const pending: ExtractNamingPromptState = { sessionId, ...options, resolve };
    extractNamingPromptRef.current = pending;
    setExtractNamingPrompt(pending);
  }), []);

  // The local Extract prompt reuses TextInputDialog but owns its own focus
  // loop: Tab/Shift+Tab cycle input -> Cancel -> Confirm and never escape to
  // the workspace behind the modal. Enter/Escape stay with the dialog itself
  // (which already ignores composing Enter).
  const handleExtractNamingTab = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
    const dialog = event.currentTarget.querySelector<HTMLElement>('[data-testid="text-input-dialog"]');
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, button"),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const index = focusable.findIndex((element) => element === document.activeElement);
    const nextIndex = event.shiftKey
      ? (index <= 0 ? focusable.length - 1 : index - 1)
      : (index === -1 || index === focusable.length - 1 ? 0 : index + 1);
    event.preventDefault();
    event.stopPropagation();
    focusable[nextIndex]?.focus();
  }, []);

  const continueExtractNaming = useCallback(createContinueExtractNaming({
    extractSessionRef,
    extractOwnerSnapshot,
    openFilesRef,
    ensureWorkspaceSemanticDocumentsSynced,
    semanticIndex,
    captureMethodSymbolsSettled,
    setStatusMessage,
    renameSymbolAt,
    promptSymbolName,
    promptExtractName,
    revealNavLocation,
    finishExtractSession,
  }), [
    captureMethodSymbolsSettled,
    ensureWorkspaceSemanticDocumentsSynced,
    extractOwnerSnapshot,
    finishExtractSession,
    promptExtractName,
    promptSymbolName,
    renameSymbolAt,
    revealNavLocation,
    semanticIndex.current,
    setStatusMessage,
  ]);
  continueExtractNamingRef.current = continueExtractNaming;

  const runExtractMethod = useCallback(createRunExtractMethod({
    activeFile,
    extractSessionRef,
    editorSelectionRef,
    beginExtractSession,
    extractLiveUri,
    finishExtractSession,
    ensureWorkspaceSemanticDocumentsSynced,
    semanticIndex,
    captureMethodSymbolsSettled,
    intentionRequestAbortRef,
    requestCodeActions,
    editorPaneRef,
    setStatusMessage,
    showCodeActionsMenu,
    intentionSessionRef,
    runCodeAction,
    continueExtractNaming,
  }), [
    activeFile,
    beginExtractSession,
    captureMethodSymbolsSettled,
    continueExtractNaming,
    ensureWorkspaceSemanticDocumentsSynced,
    finishExtractSession,
    requestCodeActions,
    runCodeAction,
    semanticIndex.current,
    setStatusMessage,
    showCodeActionsMenu,
  ]);
  runExtractMethodRef.current = runExtractMethod;

  // DEC-07 invalidation: switching files or workspaces (including closing the
  // source view and reopening the same key) drops the local owner and only its
  // own prompt. The guard also drops a pre-commit session whose frozen B0 no
  // longer matches the live buffer, or a post-commit session whose B1 moved.
  const extractGuardRevision = activeFile
    ? `${activeFile.key}:${activeFile.documentRevision}:${activeFile.text.length}:${activeFile.dirty ? 1 : 0}`
    : "";
  useEffect(() => {
    const session = extractSessionRef.current;
    if (!session) return;
    if (workspaceInstanceId !== session.workspaceInstance || activeKey !== session.fileKey) {
      invalidateExtractSession();
      return;
    }
    const live = openFilesRef.current[session.fileKey];
    if (!live) {
      invalidateExtractSession();
      return;
    }
    const current = { revision: live.documentRevision, text: live.text };
    if (session.receipt) {
      if (!extractReceiptMatches(session.receipt, current)) invalidateExtractSession();
      return;
    }
    // Before the commit the request window is the only phase where an external
    // edit must drop the owner eagerly; during resolve/commit the canonical
    // revision/generation guards already reject the apply, and after the commit
    // the receipt check above owns the decision.
    if (!session.receipt && session.phase === "request") {
      if (!extractBufferMatches(
        { revision: session.baseRevision, text: session.baseText },
        current,
      )) {
        invalidateExtractSession();
      }
    }
  }, [activeKey, extractGuardRevision, invalidateExtractSession, workspaceInstanceId]);

  useEffect(() => () => {
    const session = extractSessionRef.current;
    if (session) {
      session.phase = "finished";
      extractSessionRef.current = null;
      session.abortController.abort();
    }
    const pending = extractNamingPromptRef.current;
    if (pending) {
      extractNamingPromptRef.current = null;
      pending.resolve(null);
    }
  }, []);

  const safeDeleteSymbolAtCursor = useCallback(createSafeDeleteSymbolAtCursor({
    activeFile,
    setStatusMessage,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced,
    referencesRequestSequenceRef,
    lspDescriptorForFile,
    editorSelectionRef,
    setBottomDockOpen,
    setBottomDockTab,
    setReferencesResult,
    updateLspStatusForFile,
    absolutePathForOpenFile,
    rootsRef,
    lspFilesRef,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    buildPlanOpenFiles,
    applyLspWorkspaceEdit,
  }), [
    absolutePathForOpenFile,
    activeFile,
    applyLspWorkspaceEdit,
    ensureWorkspaceSemanticDocumentsSynced,
    lspDescriptorForFile,
    semanticIndex.beginBuild,
    semanticIndex.abandonBuild,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    semanticIndex.current,
    setStatusMessage,
    updateLspStatusForFile,
  ]);
  safeDeleteSymbolRef.current = safeDeleteSymbolAtCursor;

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

  const showEditorContextMenu = useCallback((
    file: OpenFileState,
    request: EditorContextMenuRequest & { groupId?: string },
  ) => {
    // Keep selection/cursor in sync for commands that read editorSelectionRef.
    editorSelectionRef.current = {
      start: request.selectionStart,
      end: request.selectionEnd,
      empty: !request.hasSelection,
      text: request.selectedText,
      rect: null,
    };
    const status = lspFilesRef.current[file.key]?.status;

    // §8.16.3 Gate-R1: the menu is a projection of one fresh host evaluation.
    // The payload freezes the clicked leaf/file/position, so a later active-
    // group change cannot redirect execution to another split editor.
    const targetPayload = {
      groupId: request.groupId ?? activeEditorGroupIdRef.current,
      fileKey: file.key,
      position: request.position,
      selectionStart: request.selectionStart,
      selectionEnd: request.selectionEnd,
      hasSelection: request.hasSelection,
      clientX: request.clientX,
      clientY: request.clientY,
    };
    const invocationContext = {
      focus: "editor" as const,
      hasSelection: request.hasSelection,
    };
    const host = actionsController.host;
    // §8.17.3 step 1: `run` executes the FROZEN evaluation captured at menu
    // build time. Re-entering executeAction would re-derive a fresh context
    // and let a stale/disabled row resurrect itself.
    const prepareBinding = (actionId: string, payload?: unknown) => {
      const prepared = host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: payload ?? targetPayload,
      });
      return {
        actionId,
        prepare: prepared,
        run: () => {
          void host.executePrepared(prepared);
        },
      };
    };
    // Clipboard rows execute through the pinned editor port (frozen target),
    // not the request closures, so ownership matches the enabled state.
    const portBinding = (actionId: string, commandId: EditorCommandId) => ({
      actionId,
      prepare: host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: targetPayload,
      }),
      run: () => { executeEditorCommandFor(targetPayload, commandId); },
    });

    const debugSession = debugRef.current;
    const fieldDeclaration = debugSession?.state && debugSession.state.status !== "terminated"
      ? fieldDeclarationAt(
        breadcrumbSymbolsRef.current[targetPayload.groupId as EditorGroupId] ?? [],
        request.position,
      )
      : null;

    openEditorContextMenuAt(
      request.clientX,
      request.clientY,
      buildEditorContextMenuItems({
        capabilities: status?.capabilities ?? null,
        hasSelection: request.hasSelection,
        clientX: request.clientX,
        clientY: request.clientY,
        shortcutFor: (actionId) => host.effectiveKeybindingDisplay(actionId)[0],
        bindings: {
          "workspace.gotoDefinition": prepareBinding("workspace.gotoDefinition"),
          "workspace.gotoDeclaration": prepareBinding("workspace.gotoDeclaration"),
          "workspace.gotoTypeDefinition": prepareBinding("workspace.gotoTypeDefinition"),
          "workspace.gotoImplementation": prepareBinding("workspace.gotoImplementation"),
          "workspace.findReferences": prepareBinding("workspace.findReferences"),
          "workspace.callHierarchy": prepareBinding("workspace.callHierarchy"),
          "workspace.typeHierarchy": prepareBinding("workspace.typeHierarchy"),
          "workspace.renameSymbol": prepareBinding("workspace.renameSymbol"),
          "workspace.safeDeleteSymbol": prepareBinding("workspace.safeDeleteSymbol"),
          "workspace.quickDocumentation": prepareBinding("workspace.quickDocumentation"),
          "workspace.codeActions": prepareBinding("workspace.codeActions", {
            ...targetPayload,
            diagnostics: (lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
              item.range.start.line === request.position.line
              || item.range.end.line === request.position.line
            )),
          }),
          "workspace.format": prepareBinding("workspace.format"),
          "workspace.editor.foldAll": prepareBinding("workspace.editor.foldAll"),
          "workspace.editor.unfoldAll": prepareBinding("workspace.editor.unfoldAll"),
          "workspace.editor.cut": portBinding("workspace.editor.cut", "cut"),
          "workspace.editor.copy": portBinding("workspace.editor.copy", "copy"),
          "workspace.editor.paste": portBinding("workspace.editor.paste", "paste"),
        },
        debug: debugSession?.state && debugSession.state.status !== "terminated" ? {
          runToCursor: prepareBinding("workspace.runToCursor", {
            ...targetPayload,
            line: request.position.line + 1,
          }),
          ...(fieldDeclaration ? {
            dataBreakpoint: prepareBinding("workspace.addDataBreakpoint", {
              name: fieldDeclaration.name,
              frameId: debugSession.state?.selectedFrameId
                ?? debugSession.state?.frames[0]?.id
                ?? undefined,
            }),
          } : {}),
        } : null,
        ai: {
          explainSyntaxLabel: t("codeWorkspaceAi.contextExplainSyntax"),
          explainCodeLabel: t("codeWorkspaceAi.contextExplainCode"),
          explainSyntax: prepareBinding("workspace.aiExplainSyntax"),
          explainCode: prepareBinding("workspace.aiExplainCode"),
          answerLanguage: {
            label: t("codeWorkspaceAi.answerLanguageMenu"),
            current: editorAiPreferencesRef.current.answerLanguage,
            options: AI_ANSWER_LANGUAGES.map((language) => ({
              value: language,
              label: t(answerLanguageLabelKey(language)),
              binding: prepareBinding("workspace.aiSetAnswerLanguage", { language }),
            })),
          },
        },
      }),
    );
  }, [
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
  // M7-C: whole-project Problems. jdtls stores diagnostics for unopened files
  // after a build; we poll the aggregate while the panel is in "project" scope
  // (push events were dropped — see lsp.rs C-1). `key` is the absolute path.
  const [problemsScope, setProblemsScope] = useState<ProblemsScope>("open");
  const [projectProblemFiles, setProjectProblemFiles] = useState<ProblemFileGroup[]>([]);
  const [projectProblemsLoading, setProjectProblemsLoading] = useState(false);
  const [rebuildingProject, setRebuildingProject] = useState(false);

  const problemPathToRef = useCallback((rawPath: string): CodeWorkspaceFileRef | null => {
    if (!rawPath) return null;
    let cleanPath = rawPath.trim();
    if (cleanPath.startsWith("file://")) {
      cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\/\/?/, "/"));
    }
    cleanPath = cleanPath.replace(/\\/g, "/");

    // 1. Direct absolute / canonical match against roots
    for (const root of rootsRef.current) {
      const rel = relativePathWithinRoot(root.path, cleanPath);
      if (rel !== null && rel !== "") {
        return { kind: "root", rootId: root.id, path: rel };
      }
    }

    // 2. Search currently open files by matching path, languagePath, or path suffix
    const openFiles = Object.values(openFilesRef.current);
    const matchingOpen = openFiles.find(
      (f) =>
        f.ref.path === cleanPath ||
        f.path === cleanPath ||
        f.languagePath === cleanPath ||
        f.ref.path.endsWith(`/${cleanPath}`) ||
        f.path.endsWith(`/${cleanPath}`),
    );
    if (matchingOpen) {
      return matchingOpen.ref;
    }

    // 3. If relative path and not starting with '/' or Windows drive 'C:/'
    const isAbsolute = cleanPath.startsWith("/") || /^[a-zA-Z]:\//.test(cleanPath);
    if (!isAbsolute && rootsRef.current.length > 0) {
      // If single root or active root matches, use it
      const targetRoot = rootsRef.current[0];
      if (targetRoot) {
        return { kind: "root", rootId: targetRoot.id, path: cleanPath.replace(/^\/+/, "") };
      }
    }

    // 4. Check loose files
    const looseMatch = looseFilesRef.current.find(
      (lf) => lf.path === cleanPath || lf.path.endsWith(`/${cleanPath}`),
    );
    if (looseMatch) {
      return { kind: "loose", id: looseMatch.id, path: looseMatch.path };
    }

    return null;
  }, []);

  const refreshProjectProblems = useCallback(async () => {
    try {
      const files = await lspWorkspaceDiagnostics(workspaceInstanceId);
      if (!mountedRef.current) return;
      setProjectProblemFiles(files.map((entry): ProblemFileGroup => {
        const ref = problemPathToRef(entry.path);
        const rootName = ref?.kind === "root" ? findRoot(ref.rootId)?.name : undefined;
        const subtitle = ref?.kind === "root"
          ? (rootName ? `${rootName} / ${ref.path}` : ref.path)
          : entry.path;
        return {
          key: entry.path,
          title: basename(entry.path),
          subtitle,
          path: inspectionPathForFileKey(entry.path),
          diagnostics: entry.diagnostics,
        };
      }));
    } catch {
      // No active jdtls session / command unsupported: leave the list as-is.
    }
  }, [findRoot, inspectionPathForFileKey, problemPathToRef, workspaceInstanceId]);

  // A pull-capable server may invalidate workspace diagnostics between polling
  // ticks. Refresh the aggregate immediately when the backend forwards the
  // standard `workspace/diagnostic/refresh` request.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ workspaceId?: unknown }>(LSP_DIAGNOSTICS_REFRESH_EVENT, (event) => {
      if (disposed || event.payload?.workspaceId !== workspaceInstanceId) return;
      void refreshProjectProblems();
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshProjectProblems, workspaceInstanceId]);

  // Poll project diagnostics while the Problems panel is open in project scope.
  useEffect(() => {
    if (!(bottomDockOpen
      && (bottomDockTab === "problems" || bottomDockTab === "analysis")
      && problemsScope === "project")) return;
    let cancelled = false;
    setProjectProblemsLoading(true);
    void refreshProjectProblems().finally(() => {
      if (!cancelled && mountedRef.current) setProjectProblemsLoading(false);
    });
    const timer = window.setInterval(() => void refreshProjectProblems(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bottomDockOpen, bottomDockTab, problemsScope, refreshProjectProblems]);

  const rebuildProject = useCallback(async () => {
    const root = rootsRef.current[0];
    if (!root) return;
    // A synthetic .java path selects the root's jdtls session (keyed on scope).
    const descriptor = lspDescriptorForPath(root.path, "__taomni_build__.java");
    setRebuildingProject(true);
    try {
      await lspBuildWorkspace(descriptor);
      setStatusMessage("Rebuilding project…");
    } catch (err) {
      setStatusMessage(errorMessage(err));
    } finally {
      if (mountedRef.current) setRebuildingProject(false);
    }
    // Give jdtls a beat to publish, then refresh.
    window.setTimeout(() => void refreshProjectProblems(), 1200);
  }, [lspDescriptorForPath, refreshProjectProblems, setStatusMessage]);

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
  const [testResultsByRoot, setTestResultsByRoot] = useState<Record<string, StructuredTestResults>>({});
  const testResultsWorkspaceRef = useRef(workspaceInstanceId);
  testResultsWorkspaceRef.current = workspaceInstanceId;

  const [activeExecutionModel, setActiveExecutionModel] = useState<WorkspaceExecutionModel | null>(null);
  const [javaFallbackConfiguration, setJavaFallbackConfiguration] = useState<ExecutionRunConfiguration | null>(null);
  const [runConfigurationRevision, setRunConfigurationRevision] = useState(0);

  useEffect(() => {
    setTestResultsByRoot({});
  }, [workspaceInstanceId]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceInstanceId?: string }>).detail;
      if (detail?.workspaceInstanceId === workspaceInstanceId) {
        setRunConfigurationRevision((revision) => revision + 1);
      }
    };
    window.addEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
  }, [workspaceInstanceId]);

  useEffect(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || file.library) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    let cancelled = false;
    setActiveExecutionModel(null);
    setJavaFallbackConfiguration(null);
    void workspaceExecutionModel(root.path, absolute, toolConfigRef.current)
      .then((model) => {
        if (cancelled) return;
        setActiveExecutionModel(model);
        if (activeFileIsJava) {
          void workspaceJavaRunTarget(root.path, file.ref.path, toolConfigRef.current)
            .then((target) => {
              if (!cancelled) setJavaFallbackConfiguration(javaRunTargetToExecutionRunConfiguration(target));
            })
            .catch(() => {
              if (!cancelled) setJavaFallbackConfiguration(null);
            });
        }
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Run target discovery failed: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [absolutePathForOpenFile, activeFileIsJava, activeKey, findRoot, setStatusMessage, toolConfig]);

  const activeRunConfigurations = useMemo<ExecutionRunConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const absolute = absolutePathForOpenFile(activeFile);
    if (!absolute) return [];
    const normalized = normalizeFsPath(absolute);
    const activeRootId = activeFile.ref.kind === "root" ? activeFile.ref.rootId : null;
    const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) : undefined;
    if (!activeRoot) return [];
    const projectRoots = new Map(
      activeExecutionModel.projects.map((project) => [project.id, normalizeFsPath(project.root)]),
    );
    const configurations = javaFallbackConfiguration
      ? [
          ...activeExecutionModel.runConfigurations.filter((configuration) => (
            configuration.configurationSource === "shared"
            || !configuration.sourceFile
            || !fsPathEquals(configuration.sourceFile, javaFallbackConfiguration.sourceFile ?? "")
          )),
          javaFallbackConfiguration,
        ]
      : activeExecutionModel.runConfigurations;
    const matches = configurations.filter((configuration) => {
      const sourceFile = configuration.sourceFile && normalizeFsPath(configuration.sourceFile);
      if (sourceFile) {
        return fsPathEquals(sourceFile, normalized)
          && relativePathWithinRoot(activeRoot.path, sourceFile) !== null;
      }
      const projectRoot = projectRoots.get(configuration.projectId);
      // A project-level configuration belongs to the active file only when its
      // project is rooted below the active workspace root. This keeps multiple
      // workspace roots and nested Maven/Gradle modules isolated.
      return !!projectRoot
        && relativePathWithinRoot(activeRoot.path, projectRoot) !== null
        && relativePathWithinRoot(projectRoot, normalized) !== null;
    });
    return materializeRunConfigurations(
      matches,
      readRunConfigurationOverrides(workspaceInstanceId, activeRoot.id),
    );
  }, [absolutePathForOpenFile, activeExecutionModel, activeFile, javaFallbackConfiguration, roots, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfiguration = useMemo<ExecutionRunConfiguration | null>(() => {
    const candidates = activeRunConfigurations.filter((configuration) => configuration.kind !== "module");
    if (candidates.length === 0) return null;
    const selectedId = activeFile
      ? readActiveRunConfigurationSelection(workspaceInstanceId, absolutePathForOpenFile(activeFile) ?? "")
      : null;
    return candidates.find((configuration) => configuration.id === selectedId) ?? candidates[0];
  }, [absolutePathForOpenFile, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfiguration = useMemo<ExecutionDebugConfiguration | null>(() => {
    const id = activeRunConfiguration?.debugConfigurationId;
    if (!id || !activeExecutionModel) return null;
    const detected = activeExecutionModel.debugConfigurations.find((configuration) => configuration.id === id) ?? null;
    if (!detected) return null;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[activeRunConfiguration.id];
    return applyRunOverrideToDebugConfiguration(
      detected,
      override,
      activeRunConfiguration.runtimeOptions,
      activeRunConfiguration.envFile,
    );
  }, [activeExecutionModel, activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfigurationCatalog = useMemo<ExecutionDebugConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, activeFile.ref.rootId);
    const runByDebugId = new Map<string, ExecutionRunConfiguration>();
    for (const run of activeRunConfigurations) {
      if (run.debugConfigurationId && !runByDebugId.has(run.debugConfigurationId)) {
        runByDebugId.set(run.debugConfigurationId, run);
      }
    }
    return activeExecutionModel.debugConfigurations.map((configuration) => {
      const run = runByDebugId.get(configuration.id);
      const override = run
        ? overrides[run.id] ?? (run.baseConfigurationId ? overrides[run.baseConfigurationId] : undefined)
        : undefined;
      return applyRunOverrideToDebugConfiguration(
        configuration,
        override,
        run?.runtimeOptions,
        run?.envFile,
      );
    });
  }, [activeExecutionModel, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfigurationOverride = useMemo(() => {
    if (!activeRunConfiguration) return undefined;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, rootId);
    return overrides[activeRunConfiguration.id]
      ?? (activeRunConfiguration.baseConfigurationId
        ? overrides[activeRunConfiguration.baseConfigurationId]
        : undefined);
  }, [activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);

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
  const [javaTestBuildTool, setJavaTestBuildTool] = useState<JavaTestBuildTool | null>(null);
  const [javaTestCommand, setJavaTestCommand] = useState<string | null>(null);

  const discoverActiveJavaTests = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    return javaTestDiscover(descriptor);
  }, [activeKey, lspDescriptorForFile]);

  const loadTestResultsForRoot = useCallback(async (
    root: CodeWorkspaceRootInfo,
    notBeforeMs?: number,
  ): Promise<StructuredTestResults> => {
    const results = await workspaceTestResults(root.path, notBeforeMs);
    const currentRoot = findRoot(root.id);
    if (
      mountedRef.current
      && testResultsWorkspaceRef.current === workspaceInstanceId
      && currentRoot?.path === root.path
    ) {
      setTestResultsByRoot((current) => ({ ...current, [root.id]: results }));
    }
    return results;
  }, [findRoot, mountedRef, workspaceInstanceId]);

  const loadActiveJavaTestResults = useCallback(async (): Promise<StructuredTestResults | null> => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return null;
    const root = findRoot(file.ref.rootId);
    return root ? loadTestResultsForRoot(root) : null;
  }, [activeKey, findRoot, loadTestResultsForRoot]);

  // Detect the active file's build tool (Maven/Gradle) for the run command; only
  // while the Tests tab is open for a Java file. Cached per detection.
  useEffect(() => {
    if (!(bottomDockOpen && bottomDockTab === "tests" && activeFileIsJava && activeFile)) return;
    if (activeFile.ref.kind !== "root") {
      setJavaTestBuildTool(null);
      setJavaTestCommand(null);
      return;
    }
    const root = findRoot(activeFile.ref.rootId);
    if (!root) return;
    let cancelled = false;
    void workspaceTaskTree(root.path, toolConfigRef.current)
      .then((groups) => {
        if (cancelled) return;
        const mavenTask = groups
          .find((group) => group.source === "Maven")
          ?.tasks.find((task) => task.label === "test");
        const gradleTask = groups
          .find((group) => group.source === "Gradle")
          ?.tasks.find((task) => task.label === "test");
        const task = mavenTask ?? gradleTask;
        setJavaTestBuildTool(mavenTask ? "maven" : gradleTask ? "gradle" : null);
        setJavaTestCommand(task?.command ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setJavaTestBuildTool(null);
          setJavaTestCommand(null);
        }
      });
    return () => { cancelled = true; };
  }, [activeFile, activeFileIsJava, bottomDockOpen, bottomDockTab, findRoot]);

  const runJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || !javaTestBuildTool || !javaTestCommand) return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const command = javaTestRunCommand(javaTestBuildTool, item, javaTestCommand);
    const startedAt = Date.now();
    runWorkspaceTask({
      id: `java-test:${item.fullName}`,
      label: `Test ${item.name}`,
      command,
      cwd: root.path,
      source: "Test",
      rootId: root.id,
      rootName: root.name,
    }, (exitCode) => {
      // The terminal exit code is only execution status; the JUnit report is
      // the durable test protocol and remains authoritative for individual
      // cases, skips, errors, and stack traces.
      // Filesystems with coarse timestamp resolution can report a freshly
      // written XML file a few milliseconds before the PTY start marker.
      void loadTestResultsForRoot(root, Math.max(0, startedAt - 2000)).catch((error) => {
        if (testResultsWorkspaceRef.current !== workspaceInstanceId) return;
        setStatusMessage(`Test results unavailable after exit ${exitCode}: ${errorMessage(error)}`);
      });
    });
  }, [
    activeKey,
    findRoot,
    javaTestBuildTool,
    javaTestCommand,
    loadTestResultsForRoot,
    runWorkspaceTask,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const rerunStructuredTest = useCallback((result: StructuredTestResult) => {
    runJavaTest({
      name: result.name,
      fullName: result.selector,
      kind: result.selector.includes("#") ? "method" : "class",
      uri: null,
      range: null,
      children: [],
    });
  }, [runJavaTest]);

  const openStructuredTestFailure = useCallback((result: StructuredTestResult) => {
    if (!result.filePath || result.line == null) {
      setStatusMessage("This test result has no source location");
      return;
    }
    const file = openFilesRef.current[activeKey ?? ""];
    const root = file?.ref.kind === "root" ? findRoot(file.ref.rootId) : null;
    if (!root) {
      setStatusMessage("Cannot locate the test result outside an active workspace root");
      return;
    }
    const rawPath = normalizeFsPath(result.filePath);
    const relativePath = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? null
      : rawPath.replace(/^\/+/, "");
    if (relativePath?.split("/").some((segment) => segment === "..")) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const absolute = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? rawPath
      : absoluteWorkspacePath(root, rawPath);
    const ref = problemPathToRef(absolute);
    if (!ref) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const range: LspRange = {
      start: { line: Math.max(0, result.line - 1), character: 0 },
      end: { line: Math.max(0, result.line - 1), character: 0 },
    };
    void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
  }, [activeKey, findRoot, openFile, problemPathToRef, revealEditorLocation, setStatusMessage]);

  // M9 debug-test: resolve the test's JUnit launch config (java-test) and start
  // a debug session through the DAP path.
  const debugJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const descriptor = lspDescriptorForFile(file);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !descriptor || !absolute) return;
    void (async () => {
      try {
        setBottomDockTab("debug");
        setBottomDockOpen(true);
        // Make-before-launch: save + build + block on compile errors.
        if (!(await prepareJavaLaunchRef.current(root.id, descriptor))) return;
        const launch = await javaTestResolveLaunch(descriptor, item);
        await debugRef.current?.startDebug({
          workspaceId: descriptor.workspaceId,
          rootPath: root.path,
          filePath: absolute,
          cwd: root.path,
          mainClass: launch.mainClass,
          projectName: launch.projectName,
          classPaths: launch.classPaths,
          modulePaths: launch.modulePaths,
          args: launch.args,
          vmArgs: launch.vmArgs,
          serverCommandId: descriptor.serverCommandId ?? null,
          customServerCommand: descriptor.customServerCommand ?? null,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [activeKey, findRoot, lspDescriptorForFile, absolutePathForOpenFile, setBottomDockOpen, setBottomDockTab, setStatusMessage]);

  // M9: debug session (breakpoints, stepping, variables, watch, console).
  const debug = useCodeDebugSession(workspaceInstanceId);
  // Ref so callbacks declared above the hook (debug-test, commands) can reach it.
  debugRef.current = debug;
  // Ref so debug-test (declared above prepareJavaLaunch) can reach the pre-launch
  // save+build gate without a forward reference.
  const prepareJavaLaunchRef = useRef<
    (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>
  >(() => Promise.resolve(true));
  /** Breakpoint whose editor is open in the Debug panel's breakpoints view. */
  const [editingBreakpoint, setEditingBreakpoint] = useState<{ path: string; line: number } | null>(null);
  const activeFileAbsPath = activeFile ? absolutePathForOpenFile(activeFile) : null;
  const debugSessionActive = !!debug.state && debug.state.status !== "terminated";
  const activeDebugCurrentLine = useMemo<number | null>(() => {
    const loc = debug.currentLocation;
    if (!loc || !activeFileAbsPath) return null;
    return fsPathEquals(loc.path, activeFileAbsPath) ? loc.line : null;
  }, [activeFileAbsPath, debug.currentLocation]);
  /** The editor is showing the stopped frame: inline values + hover apply here. */
  const debugStoppedHere = debug.state?.status === "stopped" && activeDebugCurrentLine != null;
  const debugRunToCursorLine = useCallback((line: number) => {
    if (activeFileAbsPath) debug.runToCursor(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);
  const toggleActiveBreakpoint = useCallback((line: number) => {
    if (activeFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(activeFileAbsPath), line);
  }, [activeFileAbsPath, debug]);

  /** IDEA's breakpoint balloon (gutter right-click / Ctrl+Shift+F8 on a breakpoint). */
  const [breakpointPopup, setBreakpointPopup] = useState<{
    path: string;
    line: number;
    anchor: { x: number; y: number };
    expanded: boolean;
  } | null>(null);
  /** IDEA's View Breakpoints dialog, optionally opened on one breakpoint. */
  const [breakpointsDialog, setBreakpointsDialog] = useState<{ initial: { path: string; line: number } | null } | null>(null);
  /** IDEA's Evaluate dialog (Alt+F8). */
  const [evaluateDialog, setEvaluateDialog] = useState<{ expression: string } | null>(null);
  const [gutterMenu, setGutterMenu] = useState<{ path: string; line: number; x: number; y: number } | null>(null);

  /** The caret row's gutter, where IDEA anchors the keyboard-opened popup. */
  const caretGutterAnchor = useCallback((): { x: number; y: number } => {
    const scope = rootRef.current ?? document;
    const row = scope.querySelector<HTMLElement>(".cm-editor.cm-focused .cm-activeLineGutter")
      ?? scope.querySelector<HTMLElement>(".cm-editor .cm-activeLineGutter")
      ?? scope.querySelector<HTMLElement>(".cm-editor .cm-activeLine");
    const rect = row?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return { x: rect.left, y: rect.bottom };
    return { x: Math.round(window.innerWidth / 3), y: Math.round(window.innerHeight / 3) };
  }, []);

  const openBreakpointPopup = useCallback((
    path: string,
    line: number,
    anchor?: { x: number; y: number },
    expanded = false,
  ) => {
    setGutterMenu(null);
    setBreakpointPopup({ path, line, anchor: anchor ?? caretGutterAnchor(), expanded });
  }, [caretGutterAnchor]);

  /**
   * Right-click a breakpoint (or Ctrl+Shift+F8 on its line): create it if
   * needed and open IDEA's breakpoint balloon next to the gutter.
   */
  const editActiveBreakpoint = useCallback((line: number, anchor?: { x: number; y: number }) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    if (!(debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
      debug.toggleBreakpoint(key, line);
    }
    openBreakpointPopup(key, line, anchor);
  }, [activeFileAbsPath, debug, openBreakpointPopup]);
  toggleActiveBreakpointRef.current = toggleActiveBreakpoint;
  editActiveBreakpointRef.current = editActiveBreakpoint;
  viewBreakpointsAtCaretRef.current = (line: number) => {
    const key = activeFileAbsPath ? normalizeFsPath(activeFileAbsPath) : null;
    if (key && (debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
      openBreakpointPopup(key, line);
      return;
    }
    setBreakpointPopup(null);
    setBreakpointsDialog({ initial: null });
  };
  addActiveBreakpointRef.current = (line, options) => {
    if (activeFileAbsPath) debug.addBreakpoint(normalizeFsPath(activeFileAbsPath), line, options);
  };
  toggleActiveBreakpointEnabledRef.current = (line) => {
    if (activeFileAbsPath) debug.toggleBreakpointEnabled(normalizeFsPath(activeFileAbsPath), line);
  };
  // IDEA Ctrl+Alt+Shift+F8: remove an existing breakpoint, else add a
  // Remove-once-hit one.
  toggleTemporaryBreakpointRef.current = (line) => {
    if (!activeFileAbsPath) return;
    const key = normalizeFsPath(activeFileAbsPath);
    if ((debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) debug.removeBreakpoint(key, line);
    else debug.addBreakpoint(key, line, { temporary: true });
  };
  openEvaluateDialogRef.current = (expression?: string) => {
    const selected = expression ?? editorSelectionRef.current.text?.trim() ?? "";
    setEvaluateDialog({ expression: selected.includes("\n") ? "" : selected });
  };

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
  const prepareJavaLaunch = useCallback(async (
    rootId: string,
    launchDescriptor?: LspDocumentDescriptor | null,
  ): Promise<boolean> => {
    const root = findRoot(rootId);
    if (!root) return true;
    // Save every dirty file in this root that jdtls builds from: .java sources
    // and Maven/Gradle build descriptors. saveOpenBufferText awaits didSave so
    // jdtls receives it before the build barrier below.
    const dirty = Object.values(openFilesRef.current).filter((f) =>
      f.ref.kind === "root"
      && f.ref.rootId === rootId
      && f.dirty
      && !f.library
      && (f.languagePath.toLowerCase().endsWith(".java") || isJavaBuildFile(f.languagePath)),
    );
    for (const f of dirty) {
      try {
        await saveOpenBufferText(f.key, f.text);
      } catch (err) {
        const message = `Cannot start debug: failed to save ${f.subtitle}: ${errorMessage(err)}`;
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return false;
      }
    }
    // Build barrier. Use the descriptor of the file being launched, NOT a
    // synthetic path at the root: the jdtls session key includes the SDK
    // resolver's `project_scope_path` (the nearest module walking up from the
    // file), so in a multi-module build a root-level path keys the aggregator
    // and misses the module session the launch itself uses — the build then
    // reports "no language server session is active" and gets skipped.
    // Incremental (full = false): jdtls autobuilds on save, so a clean rebuild
    // would add minutes to every debug start for no benefit.
    const descriptor = launchDescriptor
      ?? lspDescriptorForPath(root.path, "__taomni_debug_build__.java");
    debug.reportStartupProgress("Building project…");
    try {
      let status = await lspBuildWorkspace(descriptor, false);
      if (status === "withError") {
        // An incremental build can report stale compiler errors if files or dependencies
        // changed outside jdtls. Retry once with a clean rebuild before failing.
        debug.reportStartupProgress("Rebuilding project…");
        status = await lspBuildWorkspace(descriptor, true).catch(() => "withError" as const);
      }
      if (status === "failed") {
        // The build itself broke (infrastructure, not a compiler verdict). Say
        // so instead of launching stale bytecode.
        const message = "Cannot start debug: the project build failed";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        return false;
      }
      if (status === "withError") {
        // jdtls compiled and reported errors: the compiler's own verdict. Show
        // them where they live instead of launching broken classes.
        const message = "Cannot start debug: the project compiled with errors";
        setStatusMessage(message);
        debug.reportStartupFailure(message);
        setProblemsScope("project");
        setBottomDockTab("problems");
        setBottomDockOpen(true);
        return false;
      }
    } catch (err) {
      // No jdtls session / build unsupported: don't block. The adapter's own
      // main-class / classpath resolution will report a clear error if needed.
      debug.reportStartupProgress(`Skipping pre-launch build: ${errorMessage(err)}`);
      return true;
    }
    if (!mountedRef.current) return false;
    return true;
  }, [
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

  const renderEditorGroup = (groupId: EditorGroupId) => {
    const group = editorGroups[groupId] ?? createEditorGroup(groupId);
    const groupFile = group.activeKey ? openFiles[group.activeKey] ?? null : null;
    const groupLspState = group.activeKey ? lspFiles[group.activeKey] ?? null : null;
    const groupPath = groupFile ? inspectionPathForFileKey(groupFile.key) : undefined;
    const groupHighlightingLevel = groupFile ? getFileHighlightingLevel(groupFile.key) : "all";
    const groupDiagnosticsCurrent = groupFile
      ? currentDiagnosticsForFile(groupFile, groupLspState)
      : null;
    const groupDiagnosticsReady = groupDiagnosticsCurrent !== null;
    const groupDiagnosticsRaw = displayDiagnosticsFor(groupDiagnosticsCurrent, groupPath);
    const groupDiagnostics = groupHighlightingLevel === "none" || groupHighlightingLevel === "syntax"
      ? []
      : groupDiagnosticsRaw;
    const groupCapabilities = groupLspState?.status?.capabilities ?? null;
    const groupMarkdownMode = groupFile && isMarkdownPath(groupFile.languagePath)
      ? markdownModes[groupFile.key] ?? "edit"
      : "edit";
    const groupLanguageId = groupLspState?.status?.languageId
      ?? groupFile?.languagePath.split(".").pop()?.toLowerCase()
      ?? "plain-text";
    const groupReaderMode = groupFile
      ? readerModeByFile[groupFile.key] ?? readReaderModePreference(workspaceInstanceId, groupFile.key)
      : false;
    const groupSoftWrap = !!groupFile && matchesSoftWrapPath(
      groupFile.languagePath,
      editorAppearanceProfile.softWrap.patterns,
    );
    const groupAppearance = {
      fontFamily: editorAppearanceProfile.fontFamily,
      fontSizePx: editorAppearanceProfile.zoomScope === "active-editor"
        ? activeEditorFontSizes[groupId] ?? editorAppearanceProfile.fontSizePx
        : editorAppearanceProfile.fontSizePx,
      lineHeight: editorAppearanceProfile.lineHeight,
      ligatures: editorAppearanceProfile.ligatures,
      colorSchemeId: editorAppearanceProfile.colorSchemeId,
      highContrast: editorAppearanceProfile.highContrast,
      virtualSpace: editorAppearanceProfile.virtualSpace,
    };
    const showGroupBreadcrumbs = (
      editorAppearanceProfile.breadcrumbs.visible
      && matchesBreadcrumbLanguage(
        groupLanguageId,
        editorAppearanceProfile.breadcrumbs.languages,
      )
    ) || navigationBarActiveByGroup[groupId];
    const groupBreadcrumbSegments = groupId === activeEditorGroupId
      ? breadcrumbPathSegments
      : groupFile ? breadcrumbSegmentsForFile(groupFile, roots) : [];

    const groupFileAbsPath = groupFile ? absolutePathForOpenFile(groupFile) : null;
    const groupDebugBreakpoints = (() => {
      if (!groupFileAbsPath) return undefined;
      const key = normalizeFsPath(groupFileAbsPath);
      const list = debug.breakpoints[key] ?? debug.breakpoints[groupFileAbsPath] ?? [];
      const runtime = debug.breakpointRuntime[key] ?? debug.breakpointRuntime[groupFileAbsPath] ?? {};
      const muted = debug.breakpointsMuted;
      const masters = breakpointMasterKeys(debug.breakpoints);
      return list.map((bp) => {
        const enabled = bp.enabled !== false && !muted;
        const state = runtime[bp.line];
        const verified = !debugSessionActive || state?.status === "verified";
        return {
          line: bp.line,
          conditional: !!(bp.condition || bp.hitCondition),
          suspend: effectiveSuspend(bp),
          enabled,
          muted,
          verified,
          bound: debugSessionActive && state?.status === "verified",
          temporary: !!bp.temporary,
          dependent: !!masterOf(bp, debug.breakpoints) || masters.has(breakpointRefKey(key, bp.line)),
          tooltip: breakpointTooltipLines(bp, key, { muted, map: debug.breakpoints }).join("\n"),
        };
      });
    })();
    const groupDebugCurrentLine = (() => {
      return debugCurrentLineForFile(
        debug.currentLocation,
        debug.state?.frames ?? [],
        debug.state?.selectedFrameId,
        groupFileAbsPath,
        debug.state?.status === "stopped",
      );
    })();
    const groupDebugStoppedHere = debug.state?.status === "stopped" && groupDebugCurrentLine != null;
    const groupDebugInlineValues = groupDebugStoppedHere ? debug.frameVariables : undefined;

    const groupBanners = (() => {
      const list: EditorBannerItem[] = [];
      if (workspaceResourceOperationLocked || !!groupFile?.library) {
        list.push({
          id: `ro:${groupFile?.key ?? "global"}`,
          fileKey: groupFile?.key,
          category: "read-only",
          severity: "info",
          title: "File is read-only",
          description: "Modifications cannot be written directly to disk.",
          priority: 100,
          dismissible: false,
          conditionGeneration: "persistent-read-only",
          createdAt: 0,
        });
      }
      const lspError = groupLspState?.status?.error ?? groupLspState?.error ?? null;
      if (lspError && groupFile) {
        const presetId = groupLspState?.status?.presetId ?? "default";
        list.push({
          id: `lsp-error:${groupFile.key}:${presetId}`,
          fileKey: groupFile.key,
          category: "indexing-degraded",
          severity: "warning",
          title: "Language Server Degraded",
          description: lspError,
          priority: 60,
          conditionGeneration: `session-${lspSessionGeneration()}-error-${groupLspState?.errorGeneration ?? 0}`,
          actions: [
            {
              id: "open-settings",
              label: "Configure",
              primary: true,
              run: () => openLanguageServersSettings(groupLspState?.status?.presetId),
            },
          ],
          createdAt: 0,
        });
      }
      return selectActiveBanners(list, groupFile?.key, dismissedBannerKeys);
    })();

    return (
      <EditorGroup
        emptyHints={emptyEditorHints}
        filesWithErrors={filesWithErrors}
        onGoToLineRequest={setGoToLineRequest}
        onCompletionUnavailable={() => {
          const readiness = languageServiceReadiness(groupFile ? lspFilesRef.current[groupFile.key] ?? null : null);
          const reason = readiness.kind === "ready" || readiness.kind === "idle"
            ? "the language server returned no result"
            : readiness.message;
          showCodeInsightNotice(`Member completion unavailable: ${reason}`, readiness.action === "configure" ? "configure" : null);
        }}
        onClipboardUnavailable={setStatusMessage}
        onClipboardObservation={setLatestClipboardObservation}
        groupId={groupId}
        workspaceInstanceId={workspaceInstanceId}
        visible={visible}
        isActiveGroup={groupId === activeEditorGroupId}
        editorBanners={groupBanners}
        onDismissBanner={(key) => setDismissedBannerKeys((prev) => new Set(prev).add(key))}
        workspaceActionHost={actionsController.host}
        transactionOwner={documentTransactionOwnerRef.current}
        onWorkspaceHistoryClaim={claimWorkspaceHistory}
        readOnly={workspaceResourceOperationLocked}
        initialViewState={groupFile ? viewStatesRef.current[groupId]?.[groupFile.key] ?? null : null}
        onViewStateChange={handleViewStateChange}
        softWrap={groupSoftWrap}
        appearance={groupAppearance}
        renderedDocEnabled={groupReaderMode}
        renderedDocLanguageId={groupLanguageId}
        onToggleRenderedDocRaw={() => {
          if (groupFile) revealRenderedDocSource(groupFile.key);
        }}
        columnSelectionMode={columnSelectionMode}
        showHoverDocumentation={
          intelligencePreferences.quickDoc.showOnHover
          && groupCapabilities?.hover === true
        }
        hoverDocumentationDelayMs={intelligencePreferences.quickDoc.hoverDelayMs}
        parameterInfoRequestNonce={groupId === activeEditorGroupId ? parameterInfoRequestNonce : 0}
        parameterInfoShowFullSignatures={intelligencePreferences.parameterInfo.showFullSignatures}
        completionController={workspaceLspSessionManagerRef.current?.getCompletionController()}
        onParameterTrigger={handleParameterTrigger}
        onParameterInvalidate={handleParameterInvalidate}
        onParameterEscape={handleParameterEscape}
        // Only the active leaf renders the session-published tooltip; an
        // inactive split must never show another document's anchor.
        parameterPopup={groupId === activeEditorGroupId && parameterPopup.phase === "shown"
          ? parameterPopup.view
          : null}
        tabPolicy={tabPolicy}
        lastUsedByKey={new Map(mruFileKeysRef.current.map((k, idx) => [k, 1_000_000 - idx]))}
        openOrder={group.openOrder}
        openFiles={openFiles}
        activeKey={group.activeKey}
        previewKey={group.previewKey}
        pinnedKeys={group.pinnedKeys}
        activeFile={groupFile}
        activeMarkdownMode={groupMarkdownMode}
        activeDiagnostics={groupDiagnostics}
        activeHighlights={highlightsByGroup[groupId] ?? []}
        activeInlayHints={inlayHintsByGroup[groupId] ?? []}
        activeSemanticTokens={semanticTokensByGroup[groupId] ?? []}
        activeGitChanges={groupFile ? gitLineChangesByFile[groupFile.key] ?? [] : []}
        onShowGitDiff={showGitHeadDiff}
        activeRunGutterTargets={groupFile && groupFile.key === activeKey ? activeRunGutterTargets : EMPTY_RUN_GUTTER}
        onRunGutterClick={handleRunGutterClick}
        activeGitBlame={gitBlameByGroup[groupId] ?? null}
        activeCoverage={groupFile && coverageReport ? findFileCoverage(coverageReport, absolutePathForOpenFile(groupFile) ?? groupFile.languagePath) : null}
        coverageEnabled={coverageOverlayEnabled}
        activeCodeStyle={getEffectiveCodeStyleForFile(groupFile)}
        activeDebugBreakpoints={groupDebugBreakpoints}
        activeDebugCurrentLine={groupDebugCurrentLine}
        activeDebugInlineValues={groupDebugInlineValues}
        onToggleBreakpoint={(line) => {
          if (groupFileAbsPath) debug.toggleBreakpoint(normalizeFsPath(groupFileAbsPath), line);
        }}
        onEditBreakpoint={(line, anchor) => {
          if (!groupFileAbsPath) return;
          const key = normalizeFsPath(groupFileAbsPath);
          if (!(debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
            debug.toggleBreakpoint(key, line);
          }
          openBreakpointPopup(key, line, anchor);
        }}
        breakpointGutterActions={groupFileAbsPath ? {
          toggleEnabled: (line) => debug.toggleBreakpointEnabled(normalizeFsPath(groupFileAbsPath), line),
          add: (line, kind, anchor) => {
            const key = normalizeFsPath(groupFileAbsPath);
            if (kind === "temporary") {
              debug.addBreakpoint(key, line, { temporary: true });
              return;
            }
            // IDEA Shift+click: a non-suspending breakpoint that logs its hit,
            // with the full property popup open.
            debug.addBreakpoint(key, line, { suspend: false, logHitMessage: true });
            openBreakpointPopup(key, line, anchor, true);
          },
          openMenu: (line, anchor) => {
            setBreakpointPopup(null);
            setGutterMenu({ path: normalizeFsPath(groupFileAbsPath), line, x: anchor.x, y: anchor.y });
          },
        } : undefined}
        debugStep={groupId === activeEditorGroupId && debugSessionActive ? debug.step : null}
        debugRunToCursor={groupId === activeEditorGroupId && debugSessionActive ? debugRunToCursorLine : null}
        debugStop={groupId === activeEditorGroupId && debugSessionActive ? debug.terminate : null}
        debugEvaluate={groupId === activeEditorGroupId && debugStoppedHere ? debug.hoverEvaluate : null}
        activeCapabilities={groupCapabilities}
        activeLspSyncing={!!groupLspState?.syncing}
        lspStatusPill={(
          <LspStatusPill
            state={groupLspState}
            diagnostics={groupDiagnostics}
            onOpenSettings={() => openLanguageServersSettings(groupLspState?.status?.presetId)}
          />
        )}
        highlightingWidget={groupFile ? (
          <HighlightingWidget
            fileKey={groupFile.key}
            diagnosticScope={groupDiagnosticsReady ? groupLspState?.diagnosticScope : null}
            diagnostics={groupDiagnosticsRaw}
            diagnosticsReady={groupDiagnosticsReady}
            diagnosticsError={groupLspState?.error ?? groupLspState?.status?.error ?? null}
            level={groupHighlightingLevel}
            onChangeLevel={(lvl) => setFileHighlightingLevel(groupFile.key, lvl)}
            providerName={groupLspState?.status?.displayName}
            providerActive={!!groupLspState?.status?.active}
            onNavigateNextError={() => navigateDiagnostic(1)}
            onNavigatePrevError={() => navigateDiagnostic(-1)}
            onOpenSettings={() => openLanguageServersSettings(groupLspState?.status?.presetId)}
            onRestoreEditorFocus={() => {
              const pane = groupId === activeEditorGroupId
                ? editorPaneRef.current
                : inactiveEditorPaneRef.current;
              pane?.querySelector<HTMLElement>(".cm-content")?.focus();
            }}
          />
        ) : null}
        breadcrumbs={showGroupBreadcrumbs && groupFile ? (
          <Breadcrumbs
            variant={editorAppearanceProfile.breadcrumbs.placement === "status-bar" && statusNavigationHost ? "statusbar" : "bar"}
            pathSegments={groupBreadcrumbSegments}
            symbols={breadcrumbSymbolsByGroup[groupId] ?? []}
            position={cursorPositions[groupId] ?? { line: 0, character: 0 }}
            loadPathChildren={(segment) =>
              loadBreadcrumbPathChildren(segment, groupFile, groupBreadcrumbSegments)
            }
            onPathNavigate={(child) => navigateBreadcrumbPathChild(child, groupFile)}
            pathActionsForSegment={(segment) => breadcrumbPathActions(segment, groupFile)}
            onPathClick={(segment) => {
              // Fallback when listing is unavailable: reveal the segment in the tree.
              if (groupFile.ref.kind !== "root") return;
              const rootId = groupFile.ref.rootId;
              if (segment.kind === "root") {
                setSelected({ kind: "root", rootId });
              } else if (segment.kind === "directory") {
                setSelected({ kind: "dir", rootId, path: segment.path });
                setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
                void loadDir(rootId, segment.path);
              } else {
                setSelected({ kind: "file", ref: groupFile.ref });
              }
            }}
            onSymbolClick={(symbol) => {
              revealEditorLocation(groupFile.key, symbol.selectionRange);
              recordNavigationLocation(groupFile.ref, {
                line: symbol.selectionRange.start.line,
                character: symbol.selectionRange.start.character,
              }, { replaceSameFile: false });
            }}
            activeNavigationBar={navigationBarActiveByGroup[groupId]}
            onCloseNavigationBar={() => setNavigationBarActiveByGroup((prev) => ({ ...prev, [groupId]: false }))}
          />
        ) : null}
        breadcrumbsPlacement={editorAppearanceProfile.breadcrumbs.placement}
        activeSymbols={breadcrumbSymbolsByGroup[groupId] ?? []}
        stickyLinesEnabled={intelligencePreferences.stickyLinesEnabled !== false}
        onRevealTargetLine={(line) => groupFile && setRevealTarget({ key: groupFile.key, line, character: 0, nonce: Date.now() })}
        revealTarget={revealTarget}
        editorPaneRef={groupId === activeEditorGroupId ? editorPaneRef : inactiveEditorPaneRef}
        editorPaneStyle={editorPaneStyle}
        onActivate={(key) => {
          flushPendingEditorText();
          setLeafActiveTab(workspaceInstanceId, groupId, key);
          updateEditorGroup(groupId, (current) => ({ ...current, activeKey: key }));
          activateEditorGroup(groupId);
          if (key) {
            void ensureLspDocumentSynced(key);
          }
        }}
        onActivateGroup={() => activateEditorGroup(groupId)}
        onClose={(key) => void closeFile(key, groupId)}
        onPin={(key, pinned) => setTabPinned(groupId, key, pinned)}
        onPromotePreview={(key) => promotePreviewTab(groupId, key)}
        onCloseOthers={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => entry !== key && !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseRight={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          const index = latest.openOrder.indexOf(key);
          void closeGroupFiles(groupId, latest.openOrder.slice(index + 1).filter(
            (entry) => !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseUnmodified={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => !openFilesRef.current[entry]?.dirty,
          ));
        }}
        onCloseAll={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[groupId];
          void closeGroupFiles(groupId, latest.openOrder);
        }}
        onSplitRight={(key) => splitEditor("vertical", key, groupId)}
        onSplitDown={(key) => splitEditor("horizontal", key, groupId)}
        onMoveTabToNextSplit={leafCountForMenu > 1 ? (key) => moveTabToAdjacentSplitFrom(groupId, key, 1) : undefined}
        onMoveTabToPreviousSplit={leafCountForMenu > 1 ? (key) => moveTabToAdjacentSplitFrom(groupId, key, -1) : undefined}
        onCopyPath={(key, absolute) => void copyEditorTabPath(key, absolute)}
        onRevealInTree={revealEditorTabInTree}
        onRevealInSystem={revealEditorTabInExplorer}
        onOpenInTerminal={openEditorTabInTerminal}
        onLocalHistory={openLocalHistoryForKey}
        onDownloadSources={(key) => void downloadLibrarySources(key)}
        downloadingSourcesKeys={downloadingSourcesKeys}
        onMarkdownModeChange={(mode) => {
          if (!groupFile) return;
          setMarkdownModes((current) => ({ ...current, [groupFile.key]: mode }));
        }}
        onChangeText={queueEditorTextUpdate}
        onSave={(key) => void saveFile(key)}
        onHover={getLspHover}
        onPinHoverDoc={pinQuickDocumentation}
        onDefinition={goToDefinition}
        onReferences={findReferences}
        onComplete={getLspCompletions}
        onCompletionIdentity={completionIdentityForFile}
        onCompletionDiagnostic={reportCompletionDiagnostic}
        onScopeFallback={reportCompletionScopeFallback}
        onCompleteResolve={resolveLspCompletion}
        onSelectionChange={(selection) => {
          if (groupId === activeEditorGroupId) {
            editorSelectionRef.current = selection;
            const chars = selection.empty ? 0 : selection.text.length;
            const lineBreaks = selection.empty ? 0 : (selection.text.match(/\n/g)?.length ?? 0);
            setActiveSelectionStats((current) => (
              current.chars === chars && current.lineBreaks === lineBreaks ? current : { chars, lineBreaks }
            ));
            // The action context only reads selection-derived flags; bump its
            // revision when one of them changed instead of re-rendering the
            // whole workspace for every caret move.
            const commandState = activeEditorCommandState();
            const commandSignature = commandState
              ? `${commandState.hasSelection}|${commandState.caretCount}|${commandState.readOnly}|${commandState.composing}|${commandState.occurrenceSessionActive}`
              : "none";
            if (commandSignature !== editorCommandSignatureRef.current) {
              editorCommandSignatureRef.current = commandSignature;
              setEditorCommandContextRevision((revision) => revision + 1);
            }
            // ED-PARITY-011 DEC-011-07: only user-made drag/Shift selections
            // raise the AI toolbar; Find, navigation, double-click and Select
            // All selections do not.
            setEditorAiSelection(!selection.empty && selection.userSelected !== false && selection.text.trim().length >= 2 ? selection : null);
          }
          if (groupFile) {
            noteCaretPosition(groupFile.key, selection.end);
          }
          const syncCursor = cursorPositionsRef.current[groupId];
          if (!syncCursor || syncCursor.line !== selection.end.line || syncCursor.character !== selection.end.character) {
            cursorPositionsRef.current = { ...cursorPositionsRef.current, [groupId]: selection.end };
          }
          setCursorPositions((current) => {
            const prev = current[groupId];
            if (prev && prev.line === selection.end.line && prev.character === selection.end.character) {
              return current;
            }
            return { ...current, [groupId]: selection.end };
          });
        }}
        onViewportChange={(range) => {
          setViewportRanges((current) => {
            const prev = current[groupId];
            if (
              prev &&
              prev.start.line === range.start.line &&
              prev.start.character === range.start.character &&
              prev.end.line === range.end.line &&
              prev.end.character === range.end.character
            ) {
              return current;
            }
            return { ...current, [groupId]: range };
          });
          if (syncSplitScroll && splitOrientation) {
            // §8.17.4: sync to every OTHER tree leaf (any depth/count), not a
            // hardcoded primary<->secondary swap.
            const siblingLeaves = getAllLeafNodes(workspaceUi.layoutTreeV2)
              .map((leaf) => leaf.id as EditorGroupId)
              .filter((leafId) => leafId !== groupId);
            for (const siblingId of siblingLeaves) {
              const siblingActiveKey = editorGroups[siblingId]?.activeKey;
              const siblingFile = siblingActiveKey ? openFiles[siblingActiveKey] : null;
              if (!siblingFile || syncScrollOriginGroupIdRef.current === siblingId) continue;
              syncScrollOriginGroupIdRef.current = groupId;
              revealEditorLocation(siblingFile.key, {
                start: { line: range.start.line, character: 0 },
                end: { line: range.start.line, character: 0 },
              });
              setTimeout(() => {
                if (syncScrollOriginGroupIdRef.current === groupId) {
                  syncScrollOriginGroupIdRef.current = null;
                }
              }, 50);
              break;
            }
          }
        }}
        onExpandSelection={getLspSelectionRanges}
        onLightbulb={(line) => void openCodeActionsForLine(line)}
        onEditorContextMenu={showEditorContextMenu}
        onEditorCommandPortChange={registerEditorCommandPort}
        onOpenMarkdownHref={openMarkdownHref}
        formatBytes={formatBytes}
        formatMtime={formatMtime}
        isMarkdownPath={isMarkdownPath}
        renderMarkdownPreview={(file, onOpenHref) => (
          <MarkdownPreview file={file} onOpenHref={onOpenHref} />
        )}
      />
    );
  };

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
          onReplaceMatches={async (matches, replacement, edit, snapshot) => {
            void replacement;
            if (!snapshot) {
              const message = "Replace refused: replace preview snapshot missing";
              setStatusMessage(message);
              return { ok: false, message };
            }
            if (snapshot.requestIdentity && snapshot.requestIdentity.workspaceInstanceId !== workspaceInstanceId) {
              const message = "Replace refused: workspace instance mismatch";
              setStatusMessage(message);
              return { ok: false, message };
            }
            // ED-FIND-004 A2/A3 / ED-REPAIR-002: pre-commit atomic whole-set preflight
            // before the shared WorkspaceEdit path applies anything.
            const byFile = new Map<string, WorkspaceSearchMatch[]>();
            for (const match of matches) {
              const absolute = replaceMatchAbsolutePath(match);
              const list = byFile.get(absolute);
              if (list) list.push(match);
              else byFile.set(absolute, [match]);
            }
            if (byFile.size === 0) {
              return { ok: false, message: "Nothing to replace" };
            }

            // ED-REPAIR-002: Validate selected matches and edits against the frozen snapshot
            const selectedMatchKeys = new Set(matches.map(workspaceSearchMatchKey));
            const expectedEdit = buildReplaceWorkspaceEdit(matches, snapshot.replacement);
            const selectionValidation = validateReplacePreviewSelection(
              snapshot,
              selectedMatchKeys,
              edit,
              expectedEdit,
            );
            if (!selectionValidation.ok) {
              const message = selectionValidation.reason ?? "Selection validation failed";
              setStatusMessage(message);
              return { ok: false, message };
            }

            // ED-REPAIR-002: Whole-set atomic preflight across ALL files before any mutation
            const preflightInputs: ReplacePreflightFileInput[] = [];
            const diskTexts = new Map<string, string>();
            for (const absolute of byFile.keys()) {
              const containing = rootsRef.current.find(
                (root) => relativePathWithinRoot(root.path, absolute) !== null,
              );
              if (!containing) {
                const message = `Replace refused: ${absolute} is outside the workspace`;
                setStatusMessage(message);
                return { ok: false, message };
              }
              const open = Object.values(openFilesRef.current).find((file) => {
                const currentPath = absolutePathForOpenFile(file);
                return currentPath !== null && fsPathEquals(currentPath, absolute);
              });
              let exists = false;
              let diskHash: string | null = null;
              let diskText: string | null = null;
              let encoding: string | undefined;
              let bom: boolean | undefined;
              let eol: ("lf" | "crlf" | "cr") | undefined;
              try {
                const relative = relativePathWithinRoot(containing.path, absolute) ?? "";
                const disk = await workspaceReadFile(containing.path, relative);
                exists = true;
                diskHash = disk.hash;
                diskText = disk.text;
                encoding = disk.encoding;
                bom = disk.bom;
                eol = disk.text.includes("\r\n") ? "crlf" : disk.text.includes("\r") && !disk.text.includes("\n") ? "cr" : "lf";
              } catch {
                exists = false;
              }
              if (diskText !== null) {
                diskTexts.set(absolute, diskText);
              }
              preflightInputs.push({
                path: absolute,
                exists,
                diskHash,
                diskText,
                encoding,
                bom,
                eol,
                isOpen: Boolean(open),
                openBufferRevision: open?.documentRevision ?? null,
                openBufferDirty: open?.dirty ?? false,
                openBufferReadOnly: Boolean(open?.library) || workspaceResourceOperationLockedRef.current,
              });
            }

            const preflight = validateReplacePreflight(
              snapshot,
              workspaceInstanceId,
              preflightInputs,
            );

            let modelMatches: ReturnType<typeof searchMatchesToReplaceInputs>;
            try {
              modelMatches = searchMatchesToReplaceInputs(matches);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setStatusMessage(message);
              return { ok: false, message };
            }
            const freshness = verifyReplaceMatchFreshness(diskTexts, modelMatches);
            const conflicts = [
              ...preflight.conflicts,
              ...freshness.map((conflict) => ({
                path: conflict.path,
                reason: conflict.reason,
              })),
            ];
            if (conflicts.length > 0) {
              const message = `Replace blocked: ${conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`).join("; ")}`;
              setStatusMessage(message);
              return { ok: false, message };
            }

            // ED-AUDIT-003: the applier's per-operation ledger is the
            // only truth for what actually changed. A failed or skipped
            // document (readonly file, disk write failure, declined
            // retry) must surface the real applied set — never a
            // planned-count "all complete" report.
            // ED-MAIN-005: hand the frozen preview hashes to the applier
            // so the closed-file write precondition is the preview
            // preimage, not the second read.
            // ED-REPAIR-002: pass expectedPreimages to enforce open buffer revision and dirty
            // integrity throughout mutation.
            const selectedPaths = new Set(Array.from(byFile.keys(), replacePreimagePathKey));
            const selectedSnapshot = {
              ...snapshot,
              preimages: snapshot.preimages?.filter((preimage) => selectedPaths.has(replacePreimagePathKey(preimage.path))),
            };
            const expectedDiskHashes = replacePreimageExpectedHashes(selectedSnapshot);
            const summaryHolder: { current: WorkspaceEditApplyTransactionSummary | null } = { current: null };
            const outcomes = await applyLspWorkspaceEdit(edit, {
              label: "Replace in files",
              kind: "replace",
              expectedDiskHashes: expectedDiskHashes.size > 0 ? expectedDiskHashes : null,
              expectedPreimages: selectedSnapshot.preimages ?? null,
              onTransactionSummary: (summary) => {
                summaryHolder.current = summary;
              },
            });
            const report = summarizeReplaceCommitReport(outcomes, modelMatches);
            const recoveryId = summaryHolder.current?.recoveryId ?? null;
            const statusMsg = recoveryId && !report.ok && report.appliedCount > 0
              ? `${report.message}; recovery required (entry: ${recoveryId})`
              : report.message;
            setStatusMessage(statusMsg);
            return {
              ok: report.ok,
              appliedCount: report.appliedCount,
              fileCount: report.fileCount,
              ...(report.ok ? {} : { message: statusMsg }),
            };
          }}
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
  const toolWindowLabel = (id: string) => toolWindowContents.find((entry) => entry.id === id)?.label ?? id;
  // IDEA tool window ⋮ Options: View Mode, Move to, Resize, Remove from
  // Sidebar (ToolWindowImpl.GearActionGroup), plus Hide / Restore Layout.
  const stretchToolWindow = (id: string, direction: "left" | "right" | "up" | "down" | "maximize") => {
    const side = anchorSide(toolWindowLayout.anchorOf(id));
    const step = 40;
    if (side === "bottom") {
      const current = currentBottomDockHeight;
      if (direction === "maximize") {
        handleBottomDockHeightChange(current >= maxBottomDockHeight - 1 ? BOTTOM_DOCK_MIN_HEIGHT + 250 : maxBottomDockHeight);
      } else if (direction === "up" || direction === "down") {
        handleBottomDockHeightChange(current + (direction === "up" ? step : -step));
      }
      return;
    }
    const panel = side === "left" ? projectPanelRef.current : rightPanelRef.current;
    if (!panel) return;
    const size = panel.getSize();
    const widen = side === "left" ? direction === "right" : direction === "left";
    const narrow = side === "left" ? direction === "left" : direction === "right";
    if (direction === "maximize") {
      panel.resize("70%");
      return;
    }
    if (!widen && !narrow) return;
    panel.resize(`${Math.max(120, Math.round(size.inPixels + (widen ? step : -step)))}px`);
  };
  const toolWindowOptionsItems = (id: string): MenuItem[] => {
    const anchor = toolWindowLayout.anchorOf(id);
    const side = anchorSide(anchor);
    return [
      {
        label: "View Mode",
        testId: "code-workspace-tool-window-view-mode",
        children: [
          { label: "Dock Pinned", checked: true, onClick: () => undefined },
          { label: "Dock Unpinned", disabled: true },
          { label: "Undock", disabled: true },
          { label: "Float", disabled: true },
          { label: "Window", disabled: true },
        ],
      },
      {
        label: "Move to",
        testId: "code-workspace-tool-window-move",
        children: TOOL_WINDOW_ANCHORS.map((target) => ({
          label: TOOL_WINDOW_ANCHOR_LABELS[target],
          testId: `code-workspace-tool-window-move-${target}`,
          checked: target === anchor,
          onClick: () => toolWindowLayout.move(id, target),
        })),
      },
      {
        label: "Resize",
        testId: "code-workspace-tool-window-resize",
        children: [
          { label: "Stretch to Left", disabled: side === "bottom", onClick: () => stretchToolWindow(id, "left") },
          { label: "Stretch to Right", disabled: side === "bottom", onClick: () => stretchToolWindow(id, "right") },
          { label: "Stretch to Top", disabled: side !== "bottom", onClick: () => stretchToolWindow(id, "up") },
          { label: "Stretch to Bottom", disabled: side !== "bottom", onClick: () => stretchToolWindow(id, "down") },
          { label: "", separator: true },
          { label: "Maximize Tool Window", onClick: () => stretchToolWindow(id, "maximize") },
        ],
      },
      { label: "", separator: true },
      {
        label: "Remove from Sidebar",
        testId: "code-workspace-tool-window-remove",
        onClick: () => {
          toolWindowLayout.removeFromSidebar(id);
          handleReturnToEditor();
        },
      },
      { label: "", separator: true },
      {
        label: "Hide",
        testId: "code-workspace-tool-window-options-hide",
        shortcut: "Shift+Esc",
        onClick: () => {
          toolWindowLayout.hide(id);
          handleReturnToEditor();
        },
      },
      {
        label: "Restore Default Layout",
        testId: "code-workspace-tool-window-options-restore",
        shortcut: "Shift+F12",
        onClick: handleRestoreToolWindowLayout,
      },
    ];
  };
  const renderToolWindowPane = (id: string, options: { legacyTestIds?: boolean } = {}) => {
    // Project keeps its own IDEA header (title, toolbar, ⋮, —) in FileTreePane.
    if (id === "project") {
      return <ToolWindowSlot nodes={toolWindowNodes} id="project" label="Project" />;
    }
    const title = toolWindowLabel(id);
    return (
      <ToolWindowPane
        nodes={toolWindowNodes}
        toolId={id}
        title={title}
        legacyTestIds={options.legacyTestIds}
        optionsItems={toolWindowOptionsItems(id)}
        onHide={() => {
          toolWindowLayout.hide(id);
          handleReturnToEditor();
        }}
      />
    );
  };
  // ED-PARITY-024 stripes: every tool window's button sits on the stripe of
  // its anchor (IDEA new UI), so a moved window's button moves with it.
  const stripeMeta = new Map<string, { label: string; icon: ReactNode; badge?: ReactNode; shortcut?: string }>();
  for (const item of [...leftToolRailItems, ...rightToolRailItems]) {
    stripeMeta.set(item.id, { label: item.id === "documentation" ? "Documentation" : item.label, icon: item.icon, shortcut: item.shortcut });
  }
  for (const tab of bottomDockTabs) stripeMeta.set(tab.id, { label: tab.label, icon: tab.icon, badge: tab.badge });
  const stripeToolIds = ["project", "structure", "documentation", ...bottomDockTabs.map((tab) => tab.id)];
  const toggleToolWindowFromStripe = (id: string) => {
    if (toolWindowLayout.isVisible(id)) {
      toolWindowLayout.hide(id);
      handleReturnToEditor();
      return;
    }
    if (id === "structure") rightPaneTabRef.current = "outline";
    if (id === "documentation") rightPaneTabRef.current = "documentation";
    toolWindowLayout.show(id);
  };
  const stripeItem = (id: string): ToolWindowRailItem | null => {
    const meta = stripeMeta.get(id);
    if (!meta || !toolWindowLayout.onStripe(id)) return null;
    const bottomTool = bottomDockTabs.some((tab) => tab.id === id);
    return {
      id,
      label: meta.label,
      icon: meta.icon,
      badge: meta.badge,
      shortcut: meta.shortcut,
      anchor: toolWindowLayout.anchorOf(id),
      active: toolWindowLayout.isVisible(id),
      testId: bottomTool ? `code-workspace-bottom-tab-${id}` : `code-workspace-tool-rail-${id}`,
      onSelect: () => toggleToolWindowFromStripe(id),
    };
  };
  const stripeItemsAt = (anchor: ToolWindowAnchor) => stripeToolIds
    .filter((id) => toolWindowLayout.anchorOf(id) === anchor)
    .map(stripeItem)
    .filter((item): item is ToolWindowRailItem => item !== null);
  const commitStripeItem = leftToolRailItems.find((item) => item.id === "commit");
  const leftStripeTop = [
    ...stripeItemsAt("left-top"),
    ...(commitStripeItem ? [{ ...commitStripeItem, active: toolWindowLayout.isVisible("git") }] : []),
    ...stripeItemsAt("left-bottom"),
  ];
  const rightStripeTop = [...stripeItemsAt("right-top"), ...stripeItemsAt("right-bottom")];
  const stripeCallbacks = {
    showNames: toolWindowLayout.stripes.showNames,
    onToggleShowNames: toolWindowLayout.toggleShowNames,
    onMove: toolWindowLayout.move,
    onHide: (id: string) => {
      toolWindowLayout.hide(id);
      handleReturnToEditor();
    },
    onRemoveFromSidebar: (id: string) => toolWindowLayout.removeFromSidebar(id),
  };
  const moreToolWindowsButton = (
    <MoreToolWindowsButton
      tools={stripeToolIds.map((id) => ({ id, label: stripeMeta.get(id)?.label ?? id, icon: stripeMeta.get(id)?.icon }))}
      onPick={(id) => {
        toolWindowLayout.restoreToSidebar(id);
        if (!toolWindowLayout.isVisible(id)) toggleToolWindowFromStripe(id);
      }}
    />
  );
  const renderToolWindowSideArea = (side: "left" | "right") => {
    const primary = toolWindowLayout.visibleAt(side === "left" ? "left-top" : "right-top");
    const secondary = toolWindowLayout.visibleAt(side === "left" ? "left-bottom" : "right-bottom");
    return (
      <ToolWindowSplitArea
        side={side}
        primary={primary ? renderToolWindowPane(primary) : null}
        secondary={secondary ? renderToolWindowPane(secondary) : null}
      />
    );
  };

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
      <header className="h-10 shrink-0 flex items-center gap-2 overflow-x-auto px-3 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-code-muted)] truncate max-w-[620px]">
            {roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : "No project roots"}
            {looseFiles.length > 0 ? ` · ${looseFiles.length} loose file${looseFiles.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        {/* ED-PARITY-010 DEC-010-05: SDK / project-facts widgets live in the
            status bar (portal) like IDEA's status widgets. */}
        {visible && workspaceWidgetHost
          ? createPortal(<>
        <WorkspaceSdkStatus roots={roots} />
            {projectFactsRoot && (
              <ProjectFactsStatusBadge
                status={projectFacts.status}
                discoveryStatus={projectDescriptorDiscovery.status}
                discovery={projectDescriptorDiscovery.discovery}
                discoveryReason={projectDescriptorDiscovery.reason}
                reason={projectFacts.reason}
                generation={projectFacts.generation}
                isStale={projectFacts.isStale}
                onRefresh={refreshProjectFacts}
              />
            )}
          </>, workspaceWidgetHost)
          : (
            <>
        <WorkspaceSdkStatus roots={roots} />
            {projectFactsRoot && (
              <ProjectFactsStatusBadge
                status={projectFacts.status}
                discoveryStatus={projectDescriptorDiscovery.status}
                discovery={projectDescriptorDiscovery.discovery}
                discoveryReason={projectDescriptorDiscovery.reason}
                reason={projectFacts.reason}
                generation={projectFacts.generation}
                isStale={projectFacts.isStale}
                onRefresh={refreshProjectFacts}
              />
            )}
            </>
          )}
        <IconButton
          label="Open Git tab"
          testId="code-workspace-git-panel-toggle"
          icon={gitRootsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
          disabled={gitRootsLoading || !onOpenGitManager || gitRoots.length === 0}
          onClick={() => executeWorkspaceCommand("workspace.openGit")}
        />
        <div className="flex-1" />
        <IconButton
          label="Build project (Ctrl+F9)"
          testId="code-workspace-build-project"
          icon={projectBuildBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Hammer className="w-3.5 h-3.5" />}
          disabled={roots.length === 0 || projectBuildBusy}
          onClick={() => buildActiveProject(false)}
        />
        <IconButton
          label={activeRunConfiguration ? `Run ${activeRunConfiguration.label} (Shift+F10)` : "Run current target (Shift+F10)"}
          testId="code-workspace-run-target"
          icon={javaRunBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Play className="w-3.5 h-3.5" />}
          disabled={!activeFileRunnable || javaRunBusy}
          onClick={runActiveTarget}
        />
        {activeRunConfigurations.length > 1 && activeFile && (() => {
          const sourceFile = absolutePathForOpenFile(activeFile);
          if (!sourceFile) return null;
          return (
            <select
              data-testid="code-workspace-active-run-configuration"
              aria-label="Active run configuration"
              title="Select active Run/Debug configuration"
              value={activeRunConfiguration?.id ?? ""}
              onChange={(event) => writeActiveRunConfigurationSelection(
                workspaceInstanceId,
                sourceFile,
                event.target.value || null,
              )}
              className="h-6 max-w-44 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            >
              {activeRunConfigurations.map((configuration) => (
                <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
              ))}
            </select>
          );
        })()}
        <IconButton
          label={
            activeFileRunnable && !debugRuntimeAvailable
              ? "Debugging requires the desktop app (run: pnpm tauri dev)"
              : activeDebugConfiguration?.diagnostic ?? "Debug current target"
          }
          testId="code-workspace-debug-target"
          icon={<Bug className="w-3.5 h-3.5" />}
          disabled={!activeFileDebuggable || debugSessionActive}
          onClick={startDebugActiveTarget}
        />
        {/* ED-PARITY-010 DEC-010-04: IDEA main toolbar keeps project, VCS, run
            and search/settings; secondary editor controls moved behind ⋮. */}
        <IconButton
          label="Search Everywhere (Double Shift)"
          testId="code-workspace-toolbar-search"
          icon={<Search className="w-3.5 h-3.5" />}
          onClick={() => executeWorkspaceCommand("workspace.searchEverywhere")}
        />
        <IconButton
          label="Settings"
          testId="code-workspace-toolbar-settings"
          icon={<SettingsIcon className="w-3.5 h-3.5" />}
          onClick={() => openSettingsSection("general")}
        />
        <div className="relative">
          <IconButton
            label="More actions"
            testId="code-workspace-toolbar-more"
            icon={<MoreVertical className="w-3.5 h-3.5" />}
            active={toolbarMoreOpen}
            onClick={() => setToolbarMoreOpen((open) => !open)}
          />
          {toolbarMoreOpen && (
            <>
              <div
                role="toolbar"
                aria-label="More editor actions"
                data-testid="code-workspace-toolbar-more-menu"
                onClick={() => setToolbarMoreOpen(false)}
                className="absolute right-0 top-8 z-50 flex w-max max-w-[420px] flex-wrap items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] p-1.5 shadow-lg"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setToolbarMoreOpen(false);
                  }
                }}
              >
        <IconButton
                  label="Back"
                  testId="code-workspace-nav-back"
                  icon={<ArrowLeft className="w-3.5 h-3.5" />}
                  disabled={!navCan.back}
                  onClick={() => executeWorkspaceCommand("workspace.navigateBack")}
                />
                <IconButton
                  label="Forward"
                  testId="code-workspace-nav-forward"
                  icon={<ArrowRight className="w-3.5 h-3.5" />}
                  disabled={!navCan.forward}
                  onClick={() => executeWorkspaceCommand("workspace.navigateForward")}
                />
                <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
                  <IconButton
                    label="Editor zoom out"
                    testId="code-workspace-zoom-out"
                    icon={<ZoomOut className="w-3.5 h-3.5" />}
                    disabled={currentEditorFontSize <= CODE_WORKSPACE_MIN_FONT_SIZE}
                    onClick={() => stepCodeViewFontSize(-1)}
                  />
                  <button
                    type="button"
                    data-testid="code-workspace-zoom-reset"
                    title="Reset editor zoom"
                    aria-label="Reset editor zoom"
                    className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                    onClick={() => setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx)}
                  >
                    {currentEditorFontSize}px
                  </button>
                  <IconButton
                    label="Editor zoom in"
                    testId="code-workspace-zoom-in"
                    icon={<ZoomIn className="w-3.5 h-3.5" />}
                    disabled={currentEditorFontSize >= CODE_WORKSPACE_MAX_FONT_SIZE}
                    onClick={() => stepCodeViewFontSize(1)}
                  />
                </div>
                <IconButton
                  label={activeFileSoftWrap ? "Disable soft wrap" : "Enable soft wrap"}
                  testId="code-workspace-soft-wrap"
                  active={activeFileSoftWrap}
                  icon={<WrapText className="w-3.5 h-3.5" />}
                  onClick={toggleSoftWrap}
                />
                <IconButton
                  label={columnSelectionMode ? "Disable column selection mode" : "Enable column selection mode"}
                  testId="code-workspace-column-selection"
                  active={columnSelectionMode}
                  icon={<Columns3 className="w-3.5 h-3.5" />}
                  onClick={toggleColumnSelectionMode}
                />
                <IconButton
                  label="Save"
                  icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
                  onClick={() => executeWorkspaceCommand("workspace.save", { focus: "editor" })}
                />
                <IconButton
                  label="Reload"
                  icon={<RotateCcw className="w-3.5 h-3.5" />}
                  disabled={!activeFile || activeFile.loading}
                  onClick={() => executeWorkspaceCommand("workspace.reload", { focus: "editor" })}
                />
                <IconButton
                  label="Refresh tree"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  onClick={() => executeWorkspaceCommand("workspace.refreshTree")}
                />
                <IconButton
                  label="Split editor right"
                  testId="code-workspace-split-right"
                  icon={<Columns2 className="h-3.5 w-3.5" />}
                  active={splitOrientation === "vertical"}
                  disabled={!activeFile}
                  onClick={() => splitEditor("vertical")}
                />
                <IconButton
                  label="Split editor down"
                  testId="code-workspace-split-down"
                  icon={<Rows2 className="h-3.5 w-3.5" />}
                  active={splitOrientation === "horizontal"}
                  disabled={!activeFile}
                  onClick={() => splitEditor("horizontal")}
                />
                {splitOrientation && (
                  <>
                    <IconButton
                      label={syncSplitScroll ? "Disable synchronized split scrolling" : "Enable synchronized split scrolling"}
                      testId="code-workspace-split-sync-scroll"
                      icon={<Link2 className="h-3.5 w-3.5" />}
                      active={syncSplitScroll}
                      onClick={() => {
                        setSyncSplitScroll((v) => {
                          const next = !v;
                          setStatusMessage(next ? "Synchronized split scrolling enabled" : "Synchronized split scrolling disabled");
                          return next;
                        });
                      }}
                    />
                    <IconButton
                      label="Equalize split proportions"
                      testId="code-workspace-split-equalize"
                      icon={<AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.equalizeSplitProportions")}
                    />
                    <IconButton
                      label="Stretch active split"
                      testId="code-workspace-split-stretch"
                      icon={<Maximize2 className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.stretchActiveSplit")}
                    />
                    <IconButton
                      label="Unsplit all (keep tabs)"
                      testId="code-workspace-split-unsplit-all"
                      icon={<Square className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.unsplitAll")}
                    />
                    <IconButton
                      label="Close editor split"
                      testId="code-workspace-split-close"
                      icon={<X className="h-3.5 w-3.5" />}
                      onClick={closeSplit}
                    />
                  </>
                )}
                <IconButton
                  label={`${activeInlayHintsEnabled ? "Disable" : "Enable"} inlay hints${activeLanguageId ? ` for ${activeLanguageId}` : ""}`}
                  testId="code-workspace-inlay-hints-toggle"
                  icon={<Braces className="h-3.5 w-3.5" />}
                  active={activeInlayHintsEnabled}
                  disabled={!activeCapabilities?.inlayHint}
                  onClick={toggleInlayHintsForActiveLanguage}
                />
                <IconButton
                  label={`${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} inline Git blame`}
                  testId="code-workspace-inline-blame-toggle"
                  icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
                  active={intelligencePreferences.inlineBlameEnabled}
                  disabled={!activeGitRoot}
                  onClick={toggleInlineBlame}
                />
                <IconButton
                  label="Toggle outline pane"
                  testId="code-workspace-right-pane-toggle"
                  icon={<PanelRight className="w-3.5 h-3.5" />}
                  active={rightPaneOpen && rightPaneTab === "outline"}
                  onClick={() => executeWorkspaceCommand("workspace.toggleDocumentationPane")}
                />
                <IconButton
                  label="Editor tab policy settings"
                  testId="code-workspace-tab-policy-settings"
                  icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
                  onClick={openTabPolicySettings}
                />
              </div>
            </>
          )}
        </div>
      </header>

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
          onApply={async (nextPolicyRaw) => {
            const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
            const cleanupOutcomes: ResourceCleanupOutcome[] = [];
            const result = await applyWorkspaceTabPolicyTransaction({
              workspaceInstanceId,
              nextPolicyRaw,
              currentPolicy: tabPolicyRef.current,
              currentGroups: currentUi.editorGroups,
              openFiles: openFilesRef.current,
              mruFileKeys: mruFileKeysRef.current,
              baseLayoutRevision: baseLayoutRevision,
              currentLayoutRevision: currentUi.layoutRevision,
              getLiveLayoutRevision: () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).layoutRevision,
              confirmDirtyClose: async (dirtyKeys) => {
                const names = dirtyKeys.map((k) => openFilesRef.current[k]?.title ?? k).join(", ");
                return confirmAppDialog({
                  title: "Apply editor tab policy",
                  message: `The following files have unsaved changes:\n${names}\n\nApply tab limit policy and discard changes?`,
                  confirmLabel: "Apply and discard",
                  danger: true,
                });
              },
              onEvictClosedFile: async (evictedKey) => {
                const file = openFilesRef.current[evictedKey];
                const coordinator = resourceRecoveryCoordinatorRef.current;
                const currentUiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
                const currentTree = currentUiNow.layoutTreeV2;
                const activeLeaf = findLeafNode(currentTree, activeEditorGroupId);

                const cleanupHandlers: ResourceCleanupHandlers = {
                  didClose: async () => {
                    if (file) await closeLspDocumentAndWait(file);
                  },
                  watcher: () => {
                    const pending = pendingExternalFileEventsRef.current.get(evictedKey);
                    if (pending) {
                      window.clearTimeout(pending.timer);
                      pendingExternalFileEventsRef.current.delete(evictedKey);
                    }
                  },
                  buffer: () => {
                    saveTransactionRegistryRef.current.discardFile(
                      workspaceInstanceId,
                      evictedKey,
                      `Buffer ${file?.subtitle ?? evictedKey} was evicted`,
                    );
                    setOpenFiles((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                    setMarkdownModes((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                    setLspFiles((prev) => {
                      if (!(evictedKey in prev)) return prev;
                      const next = { ...prev };
                      delete next[evictedKey];
                      return next;
                    });
                  },
                  history: () => {
                    if (file) {
                      setClosedTabsStack((stack) =>
                        pushClosedTab(stack, {
                          fileIdentity: workspaceFileIdentity(file.ref),
                          ref: file.ref,
                          title: file.title,
                          subtitle: file.subtitle,
                          leafPath: [activeEditorGroupId],
                          closedAt: Date.now(),
                          location: {
                            leafId: activeEditorGroupId,
                            treeRoute: buildReopenTreeRoute(currentTree, activeEditorGroupId),
                            siblingFileKeys: (activeLeaf?.openFileKeys ?? []).filter((k) => k !== evictedKey),
                          },
                        }),
                      );
                    }
                  },
                };
                const outcome = await coordinator.executeResourceCleanup(evictedKey, cleanupHandlers);
                cleanupOutcomes.push(outcome);
                observeResourceCleanupOutcome(outcome, cleanupHandlers);
              },
              commitAtomicUpdate: ({ nextGroups, policy }) => {
                const committedGroups = Object.fromEntries(
                  Object.entries(nextGroups).map(([groupId, group]) => [groupId, {
                    id: groupId,
                    openOrder: [...group.openOrder],
                    pinnedKeys: [...group.pinnedKeys],
                    activeKey: group.activeKey,
                    previewKey: group.previewKey,
                  }]),
                ) as typeof currentUi.editorGroups;
                const nextLayoutTreeV2 = applyTabPolicyGroupImagesToLayout(
                  currentUi.layoutTreeV2,
                  committedGroups,
                );
                const nextActiveGroup = committedGroups[currentUi.activeEditorGroupId];
                useCodeWorkspaceStore.getState().patchInstance(workspaceInstanceId, {
                  editorGroups: committedGroups,
                  layoutTreeV2: nextLayoutTreeV2,
                  openOrder: nextActiveGroup?.openOrder ?? currentUi.openOrder,
                  activeKey: nextActiveGroup?.activeKey ?? currentUi.activeKey,
                  layoutRevision: currentUi.layoutRevision + 1,
                });
                setTabPolicy(policy);
                tabPolicyRef.current = policy;
                setTabPolicyRevision((r) => r + 1);

                const persistableGroups = Object.fromEntries(
                  (Object.entries(committedGroups) as Array<[EditorGroupId, typeof currentUi.editorGroups.primary]>)
                    .map(([groupId, group]) => [groupId, {
                      ...group,
                      openOrder: group.openOrder.filter((key) => !libraryBuffersRef.current[key]),
                      pinnedKeys: group.pinnedKeys.filter((key) => !libraryBuffersRef.current[key]),
                      activeKey: group.activeKey && libraryBuffersRef.current[group.activeKey] ? null : group.activeKey,
                      previewKey: group.previewKey && libraryBuffersRef.current[group.previewKey] ? null : group.previewKey,
                    }]),
                ) as typeof currentUi.editorGroups;

                let persistenceIssue: string | null = null;
                writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshotFromWorkspaceUi({
                  bottomDockOpen,
                  bottomDockTab,
                  rightPaneOpen,
                  rightPaneTab,
                  languagePanelOpen,
                  splitOrientation,
                  activeEditorGroupId,
                  expandedRootIds,
                  expandedDirKeys,
                  editorGroups: persistableGroups,
                  layoutTreeV2: nextLayoutTreeV2,
                  tabPolicy: policy,
                  shellChromeState: workspaceUi.shellChromeState,
                }), {
                  onIssue: (message) => {
                    persistenceIssue = message;
                    setStatusMessage(message);
                  },
                });
                return {
                  persisted: persistenceIssue === null,
                  persistenceIssue,
                };
              },
            });
            const liveUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
            setTabPolicyReceipt({
              status: result.status,
              layoutRevision: liveUi.layoutRevision,
              activeKey: liveUi.activeKey,
              evictedCount: result.allEvictedKeys.length,
              cleanupCount: cleanupOutcomes.length,
              cleanupCommittedCount: cleanupOutcomes.filter((outcome) => outcome.status === "committed").length,
              cleanupRecoveryCount: cleanupOutcomes.filter((outcome) => outcome.status === "committed-with-recovery").length,
              openResourceCount: Object.keys(openFilesRef.current).length,
            });
            const recoveryOutcome = cleanupOutcomes.find((outcome) => outcome.status === "committed-with-recovery");
            setStatusMessage(recoveryOutcome?.status === "committed-with-recovery"
              ? `${result.message}; ${recoveryOutcome.message}`
              : result.message);
            return result.status === "applied" || result.status === "no-op";
          }}
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
