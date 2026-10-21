import { type CSSProperties } from "react";
import { type GitBlameLine } from "../../../../lib/git";
import { type LspCompletionResolveResult, type LspCompletionResult, type LspDiagnostic, type LspDocumentSymbol, type LspDocumentHighlight, type LspInlayHint, type LspSemanticToken, type LspLocation, type LspPosition, type LspRange } from "../../../../lib/editor/lsp";
import { createEditorGroup, selectCodeWorkspaceUi, useCodeWorkspaceStore, type CodeWorkspaceEditorGroupState, type EditorGroupId, type EditorSplitOrientation } from "../../../../stores/codeWorkspaceStore";
import { type EffectiveCodeStyle } from "../codeStyleModel";
import type { CompletionAcceptanceDiagnostic, CompletionInvocationRequest, CompletionRequestIdentity, CompletionRequestToken } from "../lspCompletion";
import { type CompletionScopeFactsState } from "../completionScopeAdapter";
import { type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { getAllLeafNodes } from "../recursiveLayoutTree";
import { type PersistedEditorViewState, type WorkspaceViewStates } from "../workspaceLayoutPersistence";
import { type EditorCommandPortRegistration, type EditorCommandState, type EditorContextMenuRequest, type EditorSelectionRange } from "../CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "../workspaceDocumentTransactionOwner";
import type { ClipboardObservationRecord } from "../clipboardObservationContract";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { WorkspaceLspSessionManager } from "../workspaceLspSessionManager";
import { type RunGutterTarget } from "../runGutter";
import { languageServiceReadiness } from "../languageServiceReadiness";
import type { GoToLineRequest } from "../CodeMirrorHost";
import { findFileCoverage, type WorkspaceCoverageReport } from "../coverageModel";
import { selectActiveBanners, type EditorBannerItem } from "../editorBannerModel";
import { type HighlightingLevel } from "../highlightingLevelModel";
import { HighlightingWidget } from "../HighlightingWidget";
import { readReaderModePreference } from "../renderedDocCommentsModel";
import { type QuickDocContent } from "../referenceDocumentation";
import { type ParameterDisplayState, type ParameterInvalidateReason } from "../referenceInfoSession";
import { EditorGroup } from "../EditorGroup";
import { matchesBreadcrumbLanguage, matchesSoftWrapPath, type EditorAppearanceProfile } from "../editorAppearanceProfile";
import { MarkdownPreview } from "../MarkdownPreview";
import { LspStatusPill } from "../workspaceChrome";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type MarkdownViewMode, type OpenFileState, type TreeSelection, formatBytes, formatMtime, isMarkdownPath, normalizeFsPath, rootDirKey } from "../codeWorkspaceModel";
import { Breadcrumbs, type BreadcrumbPathAction, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "../Breadcrumbs";
import { effectiveSuspend } from "../dapDebugModel";
import { breakpointMasterKeys, breakpointRefKey, breakpointTooltipLines, masterOf } from "../debugBreakpointProperties";
import type { EditorRevealTarget } from "../EditorGroup";
import { breadcrumbSegmentsForFile, debugCurrentLineForFile, EMPTY_RUN_GUTTER } from "../controller/model";


export interface RenderEditorGroupContext {
  editorGroups: Record<string, CodeWorkspaceEditorGroupState>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  lspFiles: Record<string, LspFileState>;
  inspectionPathForFileKey: (fileKeyValue: string) => string;
  getFileHighlightingLevel: (fileKey: string) => HighlightingLevel;
  currentDiagnosticsForFile: (file: OpenFileState, state: LspFileState | null | undefined) => LspDiagnostic[] | null;
  displayDiagnosticsFor: (source: LspDiagnostic[] | null | undefined, path: string | undefined) => LspDiagnostic[];
  markdownModes: Record<string, "edit" | "preview" | "split">;
  readerModeByFile: Record<string, boolean>;
  workspaceInstanceId: string;
  editorAppearanceProfile: EditorAppearanceProfile;
  activeEditorFontSizes: Record<string, number>;
  navigationBarActiveByGroup: Record<string, boolean>;
  activeEditorGroupId: string;
  breadcrumbPathSegments: BreadcrumbPathSegment[];
  roots: CodeWorkspaceRootInfo[];
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  debugSessionActive: boolean;
  workspaceResourceOperationLocked: boolean;
  lspSessionGeneration: () => number;
  openLanguageServersSettings: (presetId?: string | null) => void;
  dismissedBannerKeys: Set<string>;
  emptyEditorHints: ({ label: string; shortcut: string; } | { label: string; shortcut?: undefined; })[];
  filesWithErrors: Set<string>;
  setGoToLineRequest: import("react").Dispatch<import("react").SetStateAction<GoToLineRequest | null>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  setStatusMessage: (message: string) => void;
  setLatestClipboardObservation: import("react").Dispatch<import("react").SetStateAction<ClipboardObservationRecord | null>>;
  visible: boolean;
  setDismissedBannerKeys: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
  actionsController: import("../useWorkspaceActionsController").WorkspaceActionsController;
  documentTransactionOwnerRef: import("react").RefObject<WorkspaceDocumentTransactionOwner>;
  claimWorkspaceHistory: (action: "undo" | "redo") => boolean | undefined;
  viewStatesRef: import("react").RefObject<WorkspaceViewStates>;
  handleViewStateChange: (groupId: EditorGroupId, fileKey: string, state: PersistedEditorViewState) => void;
  revealRenderedDocSource: (fileKey: string) => void;
  columnSelectionMode: boolean;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  parameterInfoRequestNonce: number;
  workspaceLspSessionManagerRef: import("react").RefObject<WorkspaceLspSessionManager | null>;
  handleParameterTrigger: (file: OpenFileState, event: { position: LspPosition; anchorOffset: number; triggerCharacter: string | null; origin: "explicit" | "typing"; }) => void;
  handleParameterInvalidate: (reason: ParameterInvalidateReason) => void;
  handleParameterEscape: () => boolean;
  parameterPopup: ParameterDisplayState;
  tabPolicy: WorkspaceTabPolicyV3;
  mruFileKeysRef: import("react").RefObject<string[]>;
  highlightsByGroup: Record<string, LspDocumentHighlight[]>;
  inlayHintsByGroup: Record<string, LspInlayHint[]>;
  semanticTokensByGroup: Record<string, LspSemanticToken[]>;
  gitLineChangesByFile: Record<string, import("../gitEditorChrome").GitLineChange[]>;
  showGitHeadDiff: (key: string) => void;
  activeKey: string | null;
  activeRunGutterTargets: RunGutterTarget[];
  handleRunGutterClick: (target: RunGutterTarget, anchor: { x: number; y: number; }) => void;
  gitBlameByGroup: Record<string, GitBlameLine | null>;
  coverageReport: WorkspaceCoverageReport | null;
  coverageOverlayEnabled: boolean;
  getEffectiveCodeStyleForFile: (file: { key: string; languagePath: string; text: string; } | null) => EffectiveCodeStyle | undefined;
  openBreakpointPopup: (path: string, line: number, anchor?: { x: number; y: number; }, expanded?: boolean) => void;
  setBreakpointPopup: import("react").Dispatch<import("react").SetStateAction<{ path: string; line: number; anchor: { x: number; y: number; }; expanded: boolean; } | null>>;
  setGutterMenu: import("react").Dispatch<import("react").SetStateAction<{ path: string; line: number; x: number; y: number; } | null>>;
  debugRunToCursorLine: (line: number) => void;
  debugStoppedHere: boolean;
  setFileHighlightingLevel: (fileKey: string, level: HighlightingLevel) => void;
  navigateDiagnostic: (direction: 1 | -1) => void;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  inactiveEditorPaneRef: import("react").RefObject<HTMLElement | null>;
  statusNavigationHost: HTMLElement | null;
  breadcrumbSymbolsByGroup: Record<string, LspDocumentSymbol[]>;
  cursorPositions: Record<string, LspPosition>;
  loadBreadcrumbPathChildren: (segment: BreadcrumbPathSegment, file: OpenFileState, trail: BreadcrumbPathSegment[]) => Promise<BreadcrumbPathChild[]>;
  navigateBreadcrumbPathChild: (child: BreadcrumbPathChild, file: OpenFileState) => void;
  breadcrumbPathActions: (segment: BreadcrumbPathSegment, file: OpenFileState) => BreadcrumbPathAction[];
  setSelected: (selection: TreeSelection | null) => void;
  setExpandedDirs: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  loadDir: (rootId: string, path: string) => Promise<void>;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
  recordNavigationLocation: (ref: CodeWorkspaceFileRef, position: import("../useWorkspaceNavigation").WorkspaceNavPosition, options?: { replaceSameFile?: boolean; }) => void;
  setNavigationBarActiveByGroup: import("react").Dispatch<import("react").SetStateAction<Record<string, boolean>>>;
  setRevealTarget: import("react").Dispatch<import("react").SetStateAction<EditorRevealTarget | null>>;
  revealTarget: EditorRevealTarget | null;
  editorPaneStyle: CSSProperties;
  flushPendingEditorText: () => void;
  setLeafActiveTab: (instanceId: string, leafId: string, fileKey: string | null) => void;
  updateEditorGroup: (groupId: EditorGroupId, updater: CodeWorkspaceEditorGroupState | ((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  activateEditorGroup: (groupId: EditorGroupId) => void;
  ensureLspDocumentSynced: (fileKey: string, requireSynchronized?: boolean) => Promise<OpenFileState | null>;
  closeFile: (key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>;
  setTabPinned: (groupId: EditorGroupId, key: string, pinned: boolean) => void;
  promotePreviewTab: (groupId: EditorGroupId, key: string) => void;
  closeGroupFiles: (groupId: EditorGroupId, keys: string[]) => Promise<void>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  splitEditor: (orientation: EditorSplitOrientation, key?: string | null, sourceGroupId?: string) => void;
  leafCountForMenu: number;
  moveTabToAdjacentSplitFrom: (sourceLeafId: EditorGroupId, key: string, direction: 1 | -1) => boolean;
  copyEditorTabPath: (key: string, absolute: boolean) => Promise<void>;
  revealEditorTabInTree: (key: string) => void;
  revealEditorTabInExplorer: (key: string) => void;
  openEditorTabInTerminal: (key: string) => void;
  openLocalHistoryForKey: (key: string) => void;
  downloadLibrarySources: (key: string) => Promise<void>;
  downloadingSourcesKeys: string[];
  setMarkdownModes: (updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>)) => void;
  queueEditorTextUpdate: (key: string, text: string, caret?: LspPosition, caretOffset?: number) => void;
  saveFile: (key?: string | null) => Promise<void>;
  getLspHover: (file: OpenFileState, position: LspPosition) => Promise<QuickDocContent | null>;
  pinQuickDocumentation: (content: QuickDocContent) => void;
  goToDefinition: (file: OpenFileState, position: LspPosition) => Promise<boolean>;
  findReferences: (file: OpenFileState, position: LspPosition) => Promise<void>;
  getLspCompletions: (file: OpenFileState, position: LspPosition, triggerCharacter: string | null, token: CompletionRequestToken, invocation?: CompletionInvocationRequest) => Promise<LspCompletionResult | null>;
  completionIdentityForFile: (file: OpenFileState) => CompletionRequestIdentity | null;
  reportCompletionDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  reportCompletionScopeFallback: (state: CompletionScopeFactsState) => void;
  resolveLspCompletion: (file: OpenFileState, raw: unknown, token: CompletionRequestToken) => Promise<LspCompletionResolveResult>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  setActiveSelectionStats: import("react").Dispatch<import("react").SetStateAction<{ chars: number; lineBreaks: number; }>>;
  activeEditorCommandState: () => EditorCommandState | null;
  editorCommandSignatureRef: import("react").RefObject<string | null>;
  setEditorCommandContextRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  setEditorAiSelection: import("react").Dispatch<import("react").SetStateAction<EditorSelectionRange | null>>;
  noteCaretPosition: (key: string, position: import("../useWorkspaceNavigation").WorkspaceNavPosition) => void;
  cursorPositionsRef: import("react").RefObject<Record<string, LspPosition>>;
  setCursorPositions: (update: Parameters<import("react").Dispatch<import("react").SetStateAction<Record<string, LspPosition>>>>[0]) => void;
  setViewportRanges: (update: Parameters<import("react").Dispatch<import("react").SetStateAction<Record<string, LspRange | null>>>>[0]) => void;
  syncSplitScroll: boolean;
  splitOrientation: EditorSplitOrientation | null;
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  syncScrollOriginGroupIdRef: import("react").RefObject<string | null>;
  getLspSelectionRanges: (file: OpenFileState, selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  openCodeActionsForLine: (line: number) => Promise<void>;
  showEditorContextMenu: (file: OpenFileState, request: EditorContextMenuRequest & { groupId?: string; }) => void;
  registerEditorCommandPort: (groupId: EditorGroupId, registration: EditorCommandPortRegistration) => void;
  openMarkdownHref: (href: string) => boolean;
}


export function createRenderEditorGroup(controllerContext: RenderEditorGroupContext): (groupId: EditorGroupId) => import("react").JSX.Element {
  return (groupId: EditorGroupId) => {
    const group = controllerContext.editorGroups[groupId] ?? createEditorGroup(groupId);
    const groupFile = group.activeKey ? controllerContext.openFiles[group.activeKey] ?? null : null;
    const groupLspState = group.activeKey ? controllerContext.lspFiles[group.activeKey] ?? null : null;
    const groupPath = groupFile ? controllerContext.inspectionPathForFileKey(groupFile.key) : undefined;
    const groupHighlightingLevel = groupFile ? controllerContext.getFileHighlightingLevel(groupFile.key) : "all";
    const groupDiagnosticsCurrent = groupFile
      ? controllerContext.currentDiagnosticsForFile(groupFile, groupLspState)
      : null;
    const groupDiagnosticsReady = groupDiagnosticsCurrent !== null;
    const groupDiagnosticsRaw = controllerContext.displayDiagnosticsFor(groupDiagnosticsCurrent, groupPath);
    const groupDiagnostics = groupHighlightingLevel === "none" || groupHighlightingLevel === "syntax"
      ? []
      : groupDiagnosticsRaw;
    const groupCapabilities = groupLspState?.status?.capabilities ?? null;
    const groupMarkdownMode = groupFile && isMarkdownPath(groupFile.languagePath)
      ? controllerContext.markdownModes[groupFile.key] ?? "edit"
      : "edit";
    const groupLanguageId = groupLspState?.status?.languageId
      ?? groupFile?.languagePath.split(".").pop()?.toLowerCase()
      ?? "plain-text";
    const groupReaderMode = groupFile
      ? controllerContext.readerModeByFile[groupFile.key] ?? readReaderModePreference(controllerContext.workspaceInstanceId, groupFile.key)
      : false;
    const groupSoftWrap = !!groupFile && matchesSoftWrapPath(
      groupFile.languagePath,
      controllerContext.editorAppearanceProfile.softWrap.patterns,
    );
    const groupAppearance = {
      fontFamily: controllerContext.editorAppearanceProfile.fontFamily,
      fontSizePx: controllerContext.editorAppearanceProfile.zoomScope === "active-editor"
        ? controllerContext.activeEditorFontSizes[groupId] ?? controllerContext.editorAppearanceProfile.fontSizePx
        : controllerContext.editorAppearanceProfile.fontSizePx,
      lineHeight: controllerContext.editorAppearanceProfile.lineHeight,
      ligatures: controllerContext.editorAppearanceProfile.ligatures,
      colorSchemeId: controllerContext.editorAppearanceProfile.colorSchemeId,
      highContrast: controllerContext.editorAppearanceProfile.highContrast,
      virtualSpace: controllerContext.editorAppearanceProfile.virtualSpace,
    };
    const showGroupBreadcrumbs = (
      controllerContext.editorAppearanceProfile.breadcrumbs.visible
      && matchesBreadcrumbLanguage(
        groupLanguageId,
        controllerContext.editorAppearanceProfile.breadcrumbs.languages,
      )
    ) || controllerContext.navigationBarActiveByGroup[groupId];
    const groupBreadcrumbSegments = groupId === controllerContext.activeEditorGroupId
      ? controllerContext.breadcrumbPathSegments
      : groupFile ? breadcrumbSegmentsForFile(groupFile, controllerContext.roots) : [];

    const groupFileAbsPath = groupFile ? controllerContext.absolutePathForOpenFile(groupFile) : null;
    const groupDebugBreakpoints = (() => {
      if (!groupFileAbsPath) return undefined;
      const key = normalizeFsPath(groupFileAbsPath);
      const list = controllerContext.debug.breakpoints[key] ?? controllerContext.debug.breakpoints[groupFileAbsPath] ?? [];
      const runtime = controllerContext.debug.breakpointRuntime[key] ?? controllerContext.debug.breakpointRuntime[groupFileAbsPath] ?? {};
      const muted = controllerContext.debug.breakpointsMuted;
      const masters = breakpointMasterKeys(controllerContext.debug.breakpoints);
      return list.map((bp) => {
        const enabled = bp.enabled !== false && !muted;
        const state = runtime[bp.line];
        const verified = !controllerContext.debugSessionActive || state?.status === "verified";
        return {
          line: bp.line,
          conditional: !!(bp.condition || bp.hitCondition),
          suspend: effectiveSuspend(bp),
          enabled,
          muted,
          verified,
          bound: controllerContext.debugSessionActive && state?.status === "verified",
          temporary: !!bp.temporary,
          dependent: !!masterOf(bp, controllerContext.debug.breakpoints) || masters.has(breakpointRefKey(key, bp.line)),
          tooltip: breakpointTooltipLines(bp, key, { muted, map: controllerContext.debug.breakpoints }).join("\n"),
        };
      });
    })();
    const groupDebugCurrentLine = (() => {
      return debugCurrentLineForFile(
        controllerContext.debug.currentLocation,
        controllerContext.debug.state?.frames ?? [],
        controllerContext.debug.state?.selectedFrameId,
        groupFileAbsPath,
        controllerContext.debug.state?.status === "stopped",
      );
    })();
    const groupDebugStoppedHere = controllerContext.debug.state?.status === "stopped" && groupDebugCurrentLine != null;
    const groupDebugInlineValues = groupDebugStoppedHere ? controllerContext.debug.frameVariables : undefined;

    const groupBanners = (() => {
      const list: EditorBannerItem[] = [];
      if (controllerContext.workspaceResourceOperationLocked || !!groupFile?.library) {
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
          conditionGeneration: `session-${controllerContext.lspSessionGeneration()}-error-${groupLspState?.errorGeneration ?? 0}`,
          actions: [
            {
              id: "open-settings",
              label: "Configure",
              primary: true,
              run: () => controllerContext.openLanguageServersSettings(groupLspState?.status?.presetId),
            },
          ],
          createdAt: 0,
        });
      }
      return selectActiveBanners(list, groupFile?.key, controllerContext.dismissedBannerKeys);
    })();

    return (
      <EditorGroup
        emptyHints={controllerContext.emptyEditorHints}
        filesWithErrors={controllerContext.filesWithErrors}
        onGoToLineRequest={controllerContext.setGoToLineRequest}
        onCompletionUnavailable={() => {
          const readiness = languageServiceReadiness(groupFile ? controllerContext.lspFilesRef.current[groupFile.key] ?? null : null);
          const reason = readiness.kind === "ready" || readiness.kind === "idle"
            ? "the language server returned no result"
            : readiness.message;
          controllerContext.showCodeInsightNotice(`Member completion unavailable: ${reason}`, readiness.action === "configure" ? "configure" : null);
        }}
        onClipboardUnavailable={controllerContext.setStatusMessage}
        onClipboardObservation={controllerContext.setLatestClipboardObservation}
        groupId={groupId}
        workspaceInstanceId={controllerContext.workspaceInstanceId}
        visible={controllerContext.visible}
        isActiveGroup={groupId === controllerContext.activeEditorGroupId}
        editorBanners={groupBanners}
        onDismissBanner={(key) => controllerContext.setDismissedBannerKeys((prev) => new Set(prev).add(key))}
        workspaceActionHost={controllerContext.actionsController.host}
        transactionOwner={controllerContext.documentTransactionOwnerRef.current}
        onWorkspaceHistoryClaim={controllerContext.claimWorkspaceHistory}
        readOnly={controllerContext.workspaceResourceOperationLocked}
        initialViewState={groupFile ? controllerContext.viewStatesRef.current[groupId]?.[groupFile.key] ?? null : null}
        onViewStateChange={controllerContext.handleViewStateChange}
        softWrap={groupSoftWrap}
        appearance={groupAppearance}
        renderedDocEnabled={groupReaderMode}
        renderedDocLanguageId={groupLanguageId}
        onToggleRenderedDocRaw={() => {
          if (groupFile) controllerContext.revealRenderedDocSource(groupFile.key);
        }}
        columnSelectionMode={controllerContext.columnSelectionMode}
        showHoverDocumentation={
          controllerContext.intelligencePreferences.quickDoc.showOnHover
          && groupCapabilities?.hover === true
        }
        hoverDocumentationDelayMs={controllerContext.intelligencePreferences.quickDoc.hoverDelayMs}
        parameterInfoRequestNonce={groupId === controllerContext.activeEditorGroupId ? controllerContext.parameterInfoRequestNonce : 0}
        parameterInfoShowFullSignatures={controllerContext.intelligencePreferences.parameterInfo.showFullSignatures}
        completionController={controllerContext.workspaceLspSessionManagerRef.current?.getCompletionController()}
        onParameterTrigger={controllerContext.handleParameterTrigger}
        onParameterInvalidate={controllerContext.handleParameterInvalidate}
        onParameterEscape={controllerContext.handleParameterEscape}
        // Only the active leaf renders the session-published tooltip; an
        // inactive split must never show another document's anchor.
        parameterPopup={groupId === controllerContext.activeEditorGroupId && controllerContext.parameterPopup.phase === "shown"
          ? controllerContext.parameterPopup.view
          : null}
        tabPolicy={controllerContext.tabPolicy}
        lastUsedByKey={new Map(controllerContext.mruFileKeysRef.current.map((k, idx) => [k, 1_000_000 - idx]))}
        openOrder={group.openOrder}
        openFiles={controllerContext.openFiles}
        activeKey={group.activeKey}
        previewKey={group.previewKey}
        pinnedKeys={group.pinnedKeys}
        activeFile={groupFile}
        activeMarkdownMode={groupMarkdownMode}
        activeDiagnostics={groupDiagnostics}
        activeHighlights={controllerContext.highlightsByGroup[groupId] ?? []}
        activeInlayHints={controllerContext.inlayHintsByGroup[groupId] ?? []}
        activeSemanticTokens={controllerContext.semanticTokensByGroup[groupId] ?? []}
        activeGitChanges={groupFile ? controllerContext.gitLineChangesByFile[groupFile.key] ?? [] : []}
        onShowGitDiff={controllerContext.showGitHeadDiff}
        activeRunGutterTargets={groupFile && groupFile.key === controllerContext.activeKey ? controllerContext.activeRunGutterTargets : EMPTY_RUN_GUTTER}
        onRunGutterClick={controllerContext.handleRunGutterClick}
        activeGitBlame={controllerContext.gitBlameByGroup[groupId] ?? null}
        activeCoverage={groupFile && controllerContext.coverageReport ? findFileCoverage(controllerContext.coverageReport, controllerContext.absolutePathForOpenFile(groupFile) ?? groupFile.languagePath) : null}
        coverageEnabled={controllerContext.coverageOverlayEnabled}
        activeCodeStyle={controllerContext.getEffectiveCodeStyleForFile(groupFile)}
        activeDebugBreakpoints={groupDebugBreakpoints}
        activeDebugCurrentLine={groupDebugCurrentLine}
        activeDebugInlineValues={groupDebugInlineValues}
        onToggleBreakpoint={(line) => {
          if (groupFileAbsPath) controllerContext.debug.toggleBreakpoint(normalizeFsPath(groupFileAbsPath), line);
        }}
        onEditBreakpoint={(line, anchor) => {
          if (!groupFileAbsPath) return;
          const key = normalizeFsPath(groupFileAbsPath);
          if (!(controllerContext.debug.breakpoints[key] ?? []).some((bp) => bp.line === line)) {
            controllerContext.debug.toggleBreakpoint(key, line);
          }
          controllerContext.openBreakpointPopup(key, line, anchor);
        }}
        breakpointGutterActions={groupFileAbsPath ? {
          toggleEnabled: (line) => controllerContext.debug.toggleBreakpointEnabled(normalizeFsPath(groupFileAbsPath), line),
          add: (line, kind, anchor) => {
            const key = normalizeFsPath(groupFileAbsPath);
            if (kind === "temporary") {
              controllerContext.debug.addBreakpoint(key, line, { temporary: true });
              return;
            }
            // IDEA Shift+click: a non-suspending breakpoint that logs its hit,
            // with the full property popup open.
            controllerContext.debug.addBreakpoint(key, line, { suspend: false, logHitMessage: true });
            controllerContext.openBreakpointPopup(key, line, anchor, true);
          },
          openMenu: (line, anchor) => {
            controllerContext.setBreakpointPopup(null);
            controllerContext.setGutterMenu({ path: normalizeFsPath(groupFileAbsPath), line, x: anchor.x, y: anchor.y });
          },
        } : undefined}
        debugStep={groupId === controllerContext.activeEditorGroupId && controllerContext.debugSessionActive ? controllerContext.debug.step : null}
        debugRunToCursor={groupId === controllerContext.activeEditorGroupId && controllerContext.debugSessionActive ? controllerContext.debugRunToCursorLine : null}
        debugStop={groupId === controllerContext.activeEditorGroupId && controllerContext.debugSessionActive ? controllerContext.debug.terminate : null}
        debugEvaluate={groupId === controllerContext.activeEditorGroupId && controllerContext.debugStoppedHere ? controllerContext.debug.hoverEvaluate : null}
        activeCapabilities={groupCapabilities}
        activeLspSyncing={!!groupLspState?.syncing}
        lspStatusPill={(
          <LspStatusPill
            state={groupLspState}
            diagnostics={groupDiagnostics}
            onOpenSettings={() => controllerContext.openLanguageServersSettings(groupLspState?.status?.presetId)}
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
            onChangeLevel={(lvl) => controllerContext.setFileHighlightingLevel(groupFile.key, lvl)}
            providerName={groupLspState?.status?.displayName}
            providerActive={!!groupLspState?.status?.active}
            onNavigateNextError={() => controllerContext.navigateDiagnostic(1)}
            onNavigatePrevError={() => controllerContext.navigateDiagnostic(-1)}
            onOpenSettings={() => controllerContext.openLanguageServersSettings(groupLspState?.status?.presetId)}
            onRestoreEditorFocus={() => {
              const pane = groupId === controllerContext.activeEditorGroupId
                ? controllerContext.editorPaneRef.current
                : controllerContext.inactiveEditorPaneRef.current;
              pane?.querySelector<HTMLElement>(".cm-content")?.focus();
            }}
          />
        ) : null}
        breadcrumbs={showGroupBreadcrumbs && groupFile ? (
          <Breadcrumbs
            variant={controllerContext.editorAppearanceProfile.breadcrumbs.placement === "status-bar" && controllerContext.statusNavigationHost ? "statusbar" : "bar"}
            pathSegments={groupBreadcrumbSegments}
            symbols={controllerContext.breadcrumbSymbolsByGroup[groupId] ?? []}
            position={controllerContext.cursorPositions[groupId] ?? { line: 0, character: 0 }}
            loadPathChildren={(segment) =>
              controllerContext.loadBreadcrumbPathChildren(segment, groupFile, groupBreadcrumbSegments)
            }
            onPathNavigate={(child) => controllerContext.navigateBreadcrumbPathChild(child, groupFile)}
            pathActionsForSegment={(segment) => controllerContext.breadcrumbPathActions(segment, groupFile)}
            onPathClick={(segment) => {
              // Fallback when listing is unavailable: reveal the segment in the tree.
              if (groupFile.ref.kind !== "root") return;
              const rootId = groupFile.ref.rootId;
              if (segment.kind === "root") {
                controllerContext.setSelected({ kind: "root", rootId });
              } else if (segment.kind === "directory") {
                controllerContext.setSelected({ kind: "dir", rootId, path: segment.path });
                controllerContext.setExpandedDirs((current) => new Set(current).add(rootDirKey(rootId, segment.path)));
                void controllerContext.loadDir(rootId, segment.path);
              } else {
                controllerContext.setSelected({ kind: "file", ref: groupFile.ref });
              }
            }}
            onSymbolClick={(symbol) => {
              controllerContext.revealEditorLocation(groupFile.key, symbol.selectionRange);
              controllerContext.recordNavigationLocation(groupFile.ref, {
                line: symbol.selectionRange.start.line,
                character: symbol.selectionRange.start.character,
              }, { replaceSameFile: false });
            }}
            activeNavigationBar={controllerContext.navigationBarActiveByGroup[groupId]}
            onCloseNavigationBar={() => controllerContext.setNavigationBarActiveByGroup((prev) => ({ ...prev, [groupId]: false }))}
          />
        ) : null}
        breadcrumbsPlacement={controllerContext.editorAppearanceProfile.breadcrumbs.placement}
        activeSymbols={controllerContext.breadcrumbSymbolsByGroup[groupId] ?? []}
        stickyLinesEnabled={controllerContext.intelligencePreferences.stickyLinesEnabled !== false}
        onRevealTargetLine={(line) => groupFile && controllerContext.setRevealTarget({ key: groupFile.key, line, character: 0, nonce: Date.now() })}
        revealTarget={controllerContext.revealTarget}
        editorPaneRef={groupId === controllerContext.activeEditorGroupId ? controllerContext.editorPaneRef : controllerContext.inactiveEditorPaneRef}
        editorPaneStyle={controllerContext.editorPaneStyle}
        onActivate={(key) => {
          controllerContext.flushPendingEditorText();
          controllerContext.setLeafActiveTab(controllerContext.workspaceInstanceId, groupId, key);
          controllerContext.updateEditorGroup(groupId, (current) => ({ ...current, activeKey: key }));
          controllerContext.activateEditorGroup(groupId);
          if (key) {
            void controllerContext.ensureLspDocumentSynced(key);
          }
        }}
        onActivateGroup={() => controllerContext.activateEditorGroup(groupId)}
        onClose={(key) => void controllerContext.closeFile(key, groupId)}
        onPin={(key, pinned) => controllerContext.setTabPinned(groupId, key, pinned)}
        onPromotePreview={(key) => controllerContext.promotePreviewTab(groupId, key)}
        onCloseOthers={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).editorGroups[groupId];
          void controllerContext.closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => entry !== key && !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseRight={(key) => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).editorGroups[groupId];
          const index = latest.openOrder.indexOf(key);
          void controllerContext.closeGroupFiles(groupId, latest.openOrder.slice(index + 1).filter(
            (entry) => !latest.pinnedKeys.includes(entry),
          ));
        }}
        onCloseUnmodified={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).editorGroups[groupId];
          void controllerContext.closeGroupFiles(groupId, latest.openOrder.filter(
            (entry) => !controllerContext.openFilesRef.current[entry]?.dirty,
          ));
        }}
        onCloseAll={() => {
          const latest = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).editorGroups[groupId];
          void controllerContext.closeGroupFiles(groupId, latest.openOrder);
        }}
        onSplitRight={(key) => controllerContext.splitEditor("vertical", key, groupId)}
        onSplitDown={(key) => controllerContext.splitEditor("horizontal", key, groupId)}
        onMoveTabToNextSplit={controllerContext.leafCountForMenu > 1 ? (key) => controllerContext.moveTabToAdjacentSplitFrom(groupId, key, 1) : undefined}
        onMoveTabToPreviousSplit={controllerContext.leafCountForMenu > 1 ? (key) => controllerContext.moveTabToAdjacentSplitFrom(groupId, key, -1) : undefined}
        onCopyPath={(key, absolute) => void controllerContext.copyEditorTabPath(key, absolute)}
        onRevealInTree={controllerContext.revealEditorTabInTree}
        onRevealInSystem={controllerContext.revealEditorTabInExplorer}
        onOpenInTerminal={controllerContext.openEditorTabInTerminal}
        onLocalHistory={controllerContext.openLocalHistoryForKey}
        onDownloadSources={(key) => void controllerContext.downloadLibrarySources(key)}
        downloadingSourcesKeys={controllerContext.downloadingSourcesKeys}
        onMarkdownModeChange={(mode) => {
          if (!groupFile) return;
          controllerContext.setMarkdownModes((current) => ({ ...current, [groupFile.key]: mode }));
        }}
        onChangeText={controllerContext.queueEditorTextUpdate}
        onSave={(key) => void controllerContext.saveFile(key)}
        onHover={controllerContext.getLspHover}
        onPinHoverDoc={controllerContext.pinQuickDocumentation}
        onDefinition={controllerContext.goToDefinition}
        onReferences={controllerContext.findReferences}
        onComplete={controllerContext.getLspCompletions}
        onCompletionIdentity={controllerContext.completionIdentityForFile}
        onCompletionDiagnostic={controllerContext.reportCompletionDiagnostic}
        onScopeFallback={controllerContext.reportCompletionScopeFallback}
        onCompleteResolve={controllerContext.resolveLspCompletion}
        onSelectionChange={(selection) => {
          if (groupId === controllerContext.activeEditorGroupId) {
            controllerContext.editorSelectionRef.current = selection;
            const chars = selection.empty ? 0 : selection.text.length;
            const lineBreaks = selection.empty ? 0 : (selection.text.match(/\n/g)?.length ?? 0);
            controllerContext.setActiveSelectionStats((current) => (
              current.chars === chars && current.lineBreaks === lineBreaks ? current : { chars, lineBreaks }
            ));
            // The action context only reads selection-derived flags; bump its
            // revision when one of them changed instead of re-rendering the
            // whole workspace for every caret move.
            const commandState = controllerContext.activeEditorCommandState();
            const commandSignature = commandState
              ? `${commandState.hasSelection}|${commandState.caretCount}|${commandState.readOnly}|${commandState.composing}|${commandState.occurrenceSessionActive}`
              : "none";
            if (commandSignature !== controllerContext.editorCommandSignatureRef.current) {
              controllerContext.editorCommandSignatureRef.current = commandSignature;
              controllerContext.setEditorCommandContextRevision((revision) => revision + 1);
            }
            // ED-PARITY-011 DEC-011-07: only user-made drag/Shift selections
            // raise the AI toolbar; Find, navigation, double-click and Select
            // All selections do not.
            controllerContext.setEditorAiSelection(!selection.empty && selection.userSelected !== false && selection.text.trim().length >= 2 ? selection : null);
          }
          if (groupFile) {
            controllerContext.noteCaretPosition(groupFile.key, selection.end);
          }
          const syncCursor = controllerContext.cursorPositionsRef.current[groupId];
          if (!syncCursor || syncCursor.line !== selection.end.line || syncCursor.character !== selection.end.character) {
            controllerContext.cursorPositionsRef.current = { ...controllerContext.cursorPositionsRef.current, [groupId]: selection.end };
          }
          controllerContext.setCursorPositions((current) => {
            const prev = current[groupId];
            if (prev && prev.line === selection.end.line && prev.character === selection.end.character) {
              return current;
            }
            return { ...current, [groupId]: selection.end };
          });
        }}
        onViewportChange={(range) => {
          controllerContext.setViewportRanges((current) => {
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
          if (controllerContext.syncSplitScroll && controllerContext.splitOrientation) {
            // §8.17.4: sync to every OTHER tree leaf (any depth/count), not a
            // hardcoded primary<->secondary swap.
            const siblingLeaves = getAllLeafNodes(controllerContext.workspaceUi.layoutTreeV2)
              .map((leaf) => leaf.id as EditorGroupId)
              .filter((leafId) => leafId !== groupId);
            for (const siblingId of siblingLeaves) {
              const siblingActiveKey = controllerContext.editorGroups[siblingId]?.activeKey;
              const siblingFile = siblingActiveKey ? controllerContext.openFiles[siblingActiveKey] : null;
              if (!siblingFile || controllerContext.syncScrollOriginGroupIdRef.current === siblingId) continue;
              controllerContext.syncScrollOriginGroupIdRef.current = groupId;
              controllerContext.revealEditorLocation(siblingFile.key, {
                start: { line: range.start.line, character: 0 },
                end: { line: range.start.line, character: 0 },
              });
              setTimeout(() => {
                if (controllerContext.syncScrollOriginGroupIdRef.current === groupId) {
                  controllerContext.syncScrollOriginGroupIdRef.current = null;
                }
              }, 50);
              break;
            }
          }
        }}
        onExpandSelection={controllerContext.getLspSelectionRanges}
        onLightbulb={(line) => void controllerContext.openCodeActionsForLine(line)}
        onEditorContextMenu={controllerContext.showEditorContextMenu}
        onEditorCommandPortChange={controllerContext.registerEditorCommandPort}
        onOpenMarkdownHref={controllerContext.openMarkdownHref}
        formatBytes={formatBytes}
        formatMtime={formatMtime}
        isMarkdownPath={isMarkdownPath}
        renderMarkdownPreview={(file, onOpenHref) => (
          <MarkdownPreview file={file} onOpenHref={onOpenHref} />
        )}
      />
    );
  };
}
