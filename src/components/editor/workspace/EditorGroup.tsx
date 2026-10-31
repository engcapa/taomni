import { EditorView } from "@codemirror/view";
import { AlertTriangle, Columns2, Download, Eye, File, Loader2 } from "./icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { writeText } from "../../../lib/clipboard";
import type { LspRange } from "../../../lib/editor/lsp";
import { CodeMirrorHost, type EditorCommandPort, type EditorCommandPortRegistration } from "./CodeMirrorHost";
import { EditorBanner } from "./EditorBanner";
import { GitDiffPeek } from "./GitDiffPeek";
import type { GitLineChange } from "./gitEditorChrome";
import { rollbackGitLineChange } from "./gitEditorChrome";
import { EditorGroupTabs } from "./group/EditorGroupTabs";
import { EditorMountBoundary } from "./group/EditorMountBoundary";
import { ModeButton } from "./group/ModeButton";
import { type EditorGroupProps } from "./group/types";
import { useEditorGroupTabs } from "./group/useEditorGroupTabs";
import { useEditorGroupBreadcrumbs } from "./group/useEditorGroupBreadcrumbs";
import { mergeCompletionTriggers } from "./lspCompletion";
import { computeStickyLines, StickyLinesOverlay } from "./stickyLines";
import type { RegionFoldingProvenance } from "./workspaceEditorCommands";
import { useWorkspaceHost } from "./workspaceHostIntegration";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { fileKey, lspPresetIdForPath } from "./codeWorkspaceModel";

/**
 * Single editor group: tab strip + active buffer chrome + CodeMirror/markdown.
 * File buffers and LSP sessions stay owned by the shell/store; this is the
 * presentation boundary for the center pane (M3 will grow this into multi-group).
 */
export function EditorGroup({
  emptyHints,
  groupId,
  workspaceInstanceId,
  visible,
  isActiveGroup = true,
  onClipboardUnavailable,
  onClipboardObservation,
  readOnly = false,
  tabPolicy,
  lastUsedByKey,
  openOrder,
  openFiles,
  activeKey,
  previewKey,
  pinnedKeys,
  activeFile,
  activeMarkdownMode,
  activeDiagnostics,
  activeHighlights,
  activeInlayHints,
  activeSemanticTokens = [],
  activeGitChanges,
  activeGitBlame,
  onShowGitDiff,
  activeRunGutterTargets,
  onRunGutterClick,
  activeCoverage,
  coverageEnabled = true,
  activeCodeStyle,
  activeDebugBreakpoints,
  activeDebugCurrentLine,
  activeDebugInlineValues,
  onToggleBreakpoint,
  onEditBreakpoint,
  breakpointGutterActions,
  debugStep,
  debugRunToCursor,
  debugStop,
  debugEvaluate,
  activeCapabilities,
  activeLspSyncing,
  lspStatusPill,
  highlightingWidget,
  breadcrumbs: breadcrumbContent,
  breadcrumbsPlacement = "top",
  editorBanners = [],
  filesWithErrors,
  onGoToLineRequest,
  onCompletionUnavailable,
  onDismissBanner,
  activeSymbols,
  stickyLinesEnabled = true,
  onRevealTargetLine,
  revealTarget,
  editorPaneRef,
  editorPaneStyle,
  softWrap = false,
  appearance,
  renderedDocEnabled = false,
  renderedDocLanguageId,
  onToggleRenderedDocRaw,
  columnSelectionMode = false,
  showHoverDocumentation = true,
  hoverDocumentationDelayMs = 300,
  parameterInfoRequestNonce = 0,
  parameterInfoShowFullSignatures = false,
  onActivate,
  onActivateGroup,
  onClose,
  onPin,
  onPromotePreview,
  onCloseOthers,
  onCloseRight,
  onCloseUnmodified,
  onCloseAll,
  onSplitRight,
  onSplitDown,
  onMoveTabToNextSplit,
  onMoveTabToPreviousSplit,
  onCopyPath,
  onRevealInTree,
  onRevealInSystem,
  onOpenInTerminal,
  onLocalHistory,
  onDownloadSources,
  downloadingSourcesKeys,
  onMarkdownModeChange,
  onChangeText,
  onSave,
  workspaceActionHost = null,
  onHover,
  onPinHoverDoc,
  onDefinition,
  onReferences,
  onComplete,
  onCompleteResolve,
  onCompletionIdentity,
  onCompletionDiagnostic,
  onScopeFallback,
  completionController,
  onParameterTrigger,
  onParameterInvalidate,
  onParameterEscape,
  transactionOwner = null,
  onWorkspaceHistoryClaim,
  documentRevision = 0,
  parameterPopup = null,
  onSelectionChange,
  onViewportChange,
  initialViewState = null,
  onViewStateChange,
  onExpandSelection,
  onLightbulb,
  onEditorContextMenu,
  onEditorCommandPortChange,
  onOpenMarkdownHref,
  formatBytes,
  formatMtime,
  isMarkdownPath,
  renderMarkdownPreview,
}: EditorGroupProps) {
  const workbenchHost = useWorkspaceHost();
  const showLanguageTools = !workbenchHost || !activeFile
    || !!lspPresetIdForPath(activeFile.languagePath) || !!activeCapabilities;
  const visibleBanners = showLanguageTools ? editorBanners
    : editorBanners.filter((banner) => banner.category !== "indexing-degraded");
  const split = useCodeWorkspaceStore((state) => selectCodeWorkspaceUi(state, workspaceInstanceId).layoutTreeV2.type === "split");
  // ED-PARITY-011 DEC-011-02: the active group's breadcrumbs become the IDEA
  // status-bar navigation bar; without a status bar they stay at the top.
  // ED-PARITY-011 DEC-011-03: language-service notices are IDEA balloons;
  // file-level conditions (read-only, encoding) keep the inline editor bar.
  const floatingBanners = visibleBanners.length > 0
    && visibleBanners.every((banner) => banner.category === "indexing-degraded" || banner.category === "sdk-import");
  const { breadcrumbs, statusBarNavigation } = useEditorGroupBreadcrumbs({
    content: breadcrumbContent, placement: breadcrumbsPlacement, visible, active: isActiveGroup,
    ownerId: `${workspaceInstanceId}:${groupId}`,
  });
  const tabs = useEditorGroupTabs({
    openOrder,
    openFiles,
    pinnedKeys,
    previewKey,
    lastUsedByKey,
    tabPolicy,
    activeKey,
    onClose,
    onCloseOthers,
    onCloseAll,
    onCloseUnmodified,
    onCloseRight,
    onCopyPath,
    onSplitRight,
    onSplitDown,
    onMoveTabToNextSplit,
    onMoveTabToPreviousSplit,
    onPin,
    onRevealInTree,
    onRevealInSystem,
    onOpenInTerminal,
    onLocalHistory,
  });
  const [gitDiffPeek, setGitDiffPeek] = useState<GitLineChange | null>(null);
  const menuState = useRef({ tabs, openOrder });
  menuState.current = { tabs, openOrder };
  useEffect(() => {
    if (!workbenchHost) return;
    workbenchHost.registerFileMenu(groupId, (ref) => {
      const key = fileKey(ref);
      const current = menuState.current;
      return current.openOrder.includes(key) ? current.tabs.getTabMenuItems(key) : null;
    });
    return () => workbenchHost.registerFileMenu(groupId, null);
  }, [workbenchHost?.registerFileMenu, groupId]);
  const [topLine, setTopLine] = useState(0);

  const handleViewportChange = useCallback((range: LspRange) => {
    setTopLine(range.start.line);
    onViewportChange?.(range);
  }, [onViewportChange]);
  const handleEditorCommandPortChange = useCallback((
    registration: EditorCommandPortRegistration,
  ) => {
    onEditorCommandPortChange?.(groupId, registration);
  }, [groupId, onEditorCommandPortChange]);

  useEffect(() => {
    if (
      activeFile
      && !activeFile.loading
      && isMarkdownPath(activeFile.languagePath)
      && activeMarkdownMode === "preview"
    ) {
      const token = {};
      const fileKey = activeFile.key;
      const port: EditorCommandPort = {
        execute: () => false,
        state: () => ({
          canUndo: false,
          canRedo: false,
          hasSelection: false,
          lineCount: 1,
          currentLine: 1,
          currentColumn: 1,
          selectedCharCount: 0,
          encoding: "UTF-8",
          eol: "\n",
          languageId: "markdown",
          readOnly: true,
          composing: false,
          caretCount: 1,
          occurrenceSessionActive: false,
          completionActive: false,
        }),
        focus: (options) => {
          const el = editorPaneRef.current?.querySelector<HTMLElement>("[data-testid='code-workspace-markdown-preview']");
          if (!el) return false;
          el.focus(options);
          return document.activeElement === el;
        },
      };
      handleEditorCommandPortChange({ fileKey, token, port });
      return () => handleEditorCommandPortChange({ fileKey, token, port: null });
    }
  }, [
    activeFile?.key,
    activeFile?.loading,
    activeFile?.languagePath,
    activeMarkdownMode,
    handleEditorCommandPortChange,
    isMarkdownPath,
    editorPaneRef,
  ]);

  const stickyLines = useMemo(() => {
    if (stickyLinesEnabled === false || !activeSymbols || !activeFile) return [];
    const lines = activeFile.text.split("\n");
    return computeStickyLines(activeSymbols, lines, topLine);
  }, [stickyLinesEnabled, activeSymbols, activeFile, topLine]);

  const completionTriggers = useMemo(
    () => mergeCompletionTriggers(activeCapabilities?.completionTriggerCharacters),
    [activeCapabilities?.completionTriggerCharacters],
  );
  const signatureTriggers = useMemo(
    () => activeCapabilities?.signatureTriggerCharacters ?? [],
    [activeCapabilities?.signatureTriggerCharacters],
  );
  useEffect(() => setGitDiffPeek(null), [activeKey]);
  const [activeFoldProvenance, setActiveFoldProvenance] = useState<RegionFoldingProvenance | null>(null);
  useEffect(() => setActiveFoldProvenance(null), [activeKey]);
  return (
    <main
      ref={editorPaneRef}
      data-testid="code-workspace-editor-pane"
      data-editor-group-id={groupId}
      onMouseDown={onActivateGroup}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)]"
      style={editorPaneStyle}
    >
      {(!workbenchHost || workbenchHost.showEditorTabs || split) && <EditorGroupTabs
        openOrder={openOrder}
        tabs={tabs}
        openFiles={openFiles}
        activeKey={activeKey}
        previewKey={previewKey}
        onActivate={onActivate}
        onPromotePreview={onPromotePreview}
        onClose={onClose}
        filesWithErrors={filesWithErrors}
      />}<div
        id={`code-workspace-editor-stack-${workspaceInstanceId}`}
        className="flex-1 min-h-0"
      >
        <div className="h-full min-h-0 relative">
          {activeFile ? (
            <div className="absolute inset-0 flex flex-col">
              {breadcrumbsPlacement === "top" || (breadcrumbsPlacement === "status-bar" && !statusBarNavigation)
                ? breadcrumbs
                : null}
              {!floatingBanners && (
                <EditorBanner banners={visibleBanners} onDismiss={onDismissBanner ?? (() => { })} />
              )}
              {activeFile.error && (
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-[12px] text-red-500">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="min-w-0 truncate">{activeFile.error}</span>
                </div>
              )}
              {activeFile.library?.decompiled && (
                <div
                  data-testid="code-workspace-decompiled-banner"
                  className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px] text-[var(--taomni-code-fg)]"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate">
                    Decompiled from bytecode — source not attached.
                  </span>
                  {onDownloadSources && (() => {
                    const downloading = downloadingSourcesKeys?.includes(activeFile.key) ?? false;
                    return (
                      <button
                        type="button"
                        data-testid="code-workspace-download-sources"
                        disabled={downloading}
                        onClick={() => onDownloadSources(activeFile.key)}
                        className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium border border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-60"
                      >
                        {downloading
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Download className="w-3.5 h-3.5" />}
                        {downloading ? "Downloading…" : "Download sources"}
                      </button>
                    );
                  })()}
                </div>
              )}
              <div data-testid="code-workspace-editor" className="relative flex-1 min-h-0">
                {floatingBanners && (
                  <EditorBanner floating banners={visibleBanners} onDismiss={onDismissBanner ?? (() => { })} />
                )}
                {/* ED-PARITY-011 DEC-011-01: IDEA inspection widget floats at the
                    editor's top-right instead of a permanent status row. */}
                <div
                  data-testid="code-workspace-file-status"
                  data-role="inspection-widget"
                  title={[formatBytes(activeFile.size), formatMtime(activeFile.mtime)].filter(Boolean).join(" · ")}
                  className="absolute right-4 top-1 z-10 flex max-w-[70%] items-center gap-1.5 rounded border border-[var(--taomni-code-border)]/60 bg-[var(--taomni-code-gutter-bg)]/90 px-1.5 py-0.5 text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-text)] shadow-sm"
                >
                  {activeFoldProvenance && (
                    <span
                      data-testid="code-workspace-fold-provenance"
                      data-provenance={activeFoldProvenance}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)]"
                      title={`Region fold source: ${activeFoldProvenance}`}
                    >
                      Region: {activeFoldProvenance}
                    </span>
                  )}
                  <div className="flex min-w-0 items-center gap-1.5">
                    {activeFile.loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-code-muted)]" />}
                    {activeLspSyncing && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-code-muted)]" />}
                    {showLanguageTools && lspStatusPill}
                    {highlightingWidget}
                  </div>
                  {isMarkdownPath(activeFile.languagePath) && (
                    <div className="flex items-center gap-0.5">
                      <ModeButton
                        label="Edit"
                        active={activeMarkdownMode === "edit"}
                        icon={<File className="w-3 h-3" />}
                        onClick={() => onMarkdownModeChange("edit")}
                      />
                      <ModeButton
                        label="Preview"
                        active={activeMarkdownMode === "preview"}
                        icon={<Eye className="w-3 h-3" />}
                        onClick={() => onMarkdownModeChange("preview")}
                      />
                      <ModeButton
                        label="Split"
                        active={activeMarkdownMode === "split"}
                        icon={<Columns2 className="w-3 h-3" />}
                        onClick={() => onMarkdownModeChange("split")}
                      />
                    </div>
                  )}
                </div>
                {gitDiffPeek && (() => {
                  const peekIndex = Math.max(0, activeGitChanges.findIndex((change) => (
                    change.startLine === gitDiffPeek.startLine && change.kind === gitDiffPeek.kind
                  )));
                  const step = (delta: number) => {
                    const count = activeGitChanges.length;
                    if (count < 2) return;
                    const next = activeGitChanges[(peekIndex + delta + count) % count];
                    if (next) setGitDiffPeek(next);
                  };
                  return (
                    <GitDiffPeek
                      change={gitDiffPeek}
                      index={peekIndex}
                      total={activeGitChanges.length}
                      onClose={() => setGitDiffPeek(null)}
                      onPrevious={() => step(-1)}
                      onNext={() => step(1)}
                      onShowDiff={onShowGitDiff ? () => onShowGitDiff(activeFile.key) : undefined}
                      onCopy={(change) => { void writeText(change.oldText); }}
                      onRollback={(change) => {
                        const newDoc = rollbackGitLineChange(activeFile.text, change);
                        if (previewKey === activeFile.key) onPromotePreview(activeFile.key);
                        // DEC-022-02: Rollback is one ordinary, undoable editor
                        // edit (Ctrl+Z restores the lines) instead of a buffer
                        // snapshot outside the editor history.
                        const host = editorPaneRef.current?.querySelector<HTMLElement>(
                          '[data-testid="code-workspace-editor"] .cm-editor',
                        );
                        const view = host ? EditorView.findFromDOM(host) : null;
                        const current = view?.state.doc.toString();
                        if (view && current === activeFile.text) {
                          let from = 0;
                          while (from < current.length && from < newDoc.length && current[from] === newDoc[from]) from += 1;
                          let endOld = current.length;
                          let endNew = newDoc.length;
                          while (endOld > from && endNew > from && current[endOld - 1] === newDoc[endNew - 1]) {
                            endOld -= 1;
                            endNew -= 1;
                          }
                          view.dispatch({
                            changes: { from, to: endOld, insert: newDoc.slice(from, endNew) },
                            userEvent: "input.rollback",
                            scrollIntoView: true,
                          });
                          view.focus();
                          return;
                        }
                        onChangeText(activeFile.key, newDoc);
                      }}
                    />
                  );
                })()}
                {activeFile.loading && (
                  <div
                    role="status"
                    aria-label="Loading file"
                    className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--taomni-code-bg)]/80 text-[var(--taomni-code-muted)]"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                )}
                {isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "preview" ? (
                  renderMarkdownPreview(activeFile, onOpenMarkdownHref, { actionHost: workspaceActionHost, groupId, standalone: true })
                ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "split" ? (
                  <div className="h-full min-h-0 grid grid-cols-2 relative">
                    <StickyLinesOverlay
                      stickyLines={stickyLines}
                      onSelectLine={(line) => onRevealTargetLine?.(line + 1)}
                    />
                    <div className="min-w-0 min-h-0 border-r border-[var(--taomni-code-border)]">
                      <EditorMountBoundary>
                        <CodeMirrorHost
                          fileKey={activeFile.key}
                          retainedFileKeys={openOrder}
                          viewId={groupId}
                          initialViewState={initialViewState}
                          onViewStateChange={onViewStateChange
                            ? (state) => onViewStateChange(groupId, activeFile.key, state)
                            : undefined}
                          transactionOwner={transactionOwner}
                          onWorkspaceHistoryClaim={onWorkspaceHistoryClaim}
                          historyReplay={activeFile.historyReplay ?? false}
                          documentRevision={activeFile.documentRevision ?? documentRevision}
                          clipboardWorkspaceId={workspaceInstanceId}
                          onClipboardUnavailable={onClipboardUnavailable}
                          onClipboardObservation={onClipboardObservation}
                          workspaceActionHost={workspaceActionHost}
                          path={activeFile.languagePath}
                          doc={activeFile.text}
                          documentReady={!activeFile.loading}
                          visible={visible}
                          active={isActiveGroup}
                          diagnostics={activeDiagnostics}
                          highlights={activeHighlights}
                          inlayHints={activeInlayHints}
                          semanticTokens={activeSemanticTokens}
                          gitChanges={activeGitChanges}
                          gitBlame={activeGitBlame}
                          runGutterTargets={activeRunGutterTargets}
                          onRunGutterClick={onRunGutterClick}
                          fileCoverage={activeCoverage}
                          coverageEnabled={coverageEnabled}
                          reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                          // Library sources (JDK / dependency classes) cannot be written back.
                          readOnly={readOnly || activeFile.loading || !!activeFile.library}
                          onChange={(doc, caret, caretOffset) => {
                            if (previewKey === activeFile.key) onPromotePreview(activeFile.key);
                            onChangeText(activeFile.key, doc, caret, caretOffset);
                          }}
                          onSave={() => onSave(activeFile.key)}
                          onHover={(position) => onHover(activeFile, position)}
                          onPinHoverDoc={onPinHoverDoc}
                          onDefinition={(position) => onDefinition(activeFile, position)}
                          onReferences={(position) => onReferences(activeFile, position)}
                          onComplete={(position, trigger, token, invocation) => onComplete(activeFile, position, trigger, token, invocation)}
                          onCompleteResolve={(raw, token) => onCompleteResolve(activeFile, raw, token)}
                          getCompletionIdentity={() => onCompletionIdentity(activeFile)}
                          onCompletionDiagnostic={onCompletionDiagnostic}
                          onScopeFallback={onScopeFallback}
                          onParameterTrigger={(event) => onParameterTrigger?.(activeFile, event)}
                          onParameterInvalidate={onParameterInvalidate}
                          onParameterEscape={onParameterEscape}
                          parameterPopup={parameterPopup}
                          onSelectionChange={onSelectionChange}
                          onViewportChange={handleViewportChange}
                          onExpandSelection={(selection) => onExpandSelection(activeFile, selection)}
                          onLightbulb={onLightbulb}
                          onGitChangeClick={setGitDiffPeek}
                          onContextMenu={(request) => onEditorContextMenu(activeFile, { ...request, groupId })}
                          onCommandPortChange={handleEditorCommandPortChange}
                          completionTriggers={completionTriggers}
                          completionController={completionController}
                          signatureTriggers={signatureTriggers}
                          softWrap={softWrap}
                          appearance={appearance}
                          renderedDocEnabled={renderedDocEnabled}
                          renderedDocLanguageId={renderedDocLanguageId}
                          onToggleRenderedDocRaw={onToggleRenderedDocRaw}
                          columnSelectionMode={columnSelectionMode}
                          showHoverDocumentation={showHoverDocumentation}
                          hoverDocumentationDelayMs={hoverDocumentationDelayMs}
                          parameterInfoRequestNonce={parameterInfoRequestNonce}
                          parameterInfoShowFullSignatures={parameterInfoShowFullSignatures}
                          onFoldProvenanceChange={setActiveFoldProvenance}
                          onGoToLineRequest={onGoToLineRequest}
                          onCompletionUnavailable={onCompletionUnavailable}
                          codeStyle={activeCodeStyle}
                        />
                      </EditorMountBoundary>
                    </div>
                    {renderMarkdownPreview(activeFile, onOpenMarkdownHref, { actionHost: workspaceActionHost, groupId, standalone: false })}
                  </div>
                ) : (
                  <div className="h-full min-h-0 relative">
                    <StickyLinesOverlay
                      stickyLines={stickyLines}
                      onSelectLine={(line) => onRevealTargetLine?.(line + 1)}
                    />
                    <EditorMountBoundary>
                      <CodeMirrorHost
                        fileKey={activeFile.key}
                        retainedFileKeys={openOrder}
                        viewId={groupId}
                        initialViewState={initialViewState}
                        onViewStateChange={onViewStateChange
                          ? (state) => onViewStateChange(groupId, activeFile.key, state)
                          : undefined}
                        transactionOwner={transactionOwner}
                        onWorkspaceHistoryClaim={onWorkspaceHistoryClaim}
                        historyReplay={activeFile.historyReplay ?? false}
                        documentRevision={activeFile.documentRevision ?? documentRevision}
                        clipboardWorkspaceId={workspaceInstanceId}
                        onClipboardUnavailable={onClipboardUnavailable}
                        onClipboardObservation={onClipboardObservation}
                        workspaceActionHost={workspaceActionHost}
                        path={activeFile.languagePath}
                        doc={activeFile.text}
                        documentReady={!activeFile.loading}
                        visible={visible}
                        active={isActiveGroup}
                        diagnostics={activeDiagnostics}
                        highlights={activeHighlights}
                        inlayHints={activeInlayHints}
                        semanticTokens={activeSemanticTokens}
                        gitChanges={activeGitChanges}
                        gitBlame={activeGitBlame}
                        runGutterTargets={activeRunGutterTargets}
                        onRunGutterClick={onRunGutterClick}
                        fileCoverage={activeCoverage}
                        coverageEnabled={coverageEnabled}
                        debugBreakpoints={activeDebugBreakpoints}
                        debugCurrentLine={activeDebugCurrentLine}
                        debugInlineValues={activeDebugInlineValues}
                        debugStep={debugStep}
                        debugRunToCursor={debugRunToCursor}
                        debugStop={debugStop}
                        debugEvaluate={debugEvaluate}
                        onToggleBreakpoint={onToggleBreakpoint}
                        onEditBreakpoint={onEditBreakpoint}
                        breakpointGutterActions={breakpointGutterActions}
                        reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                        readOnly={readOnly || activeFile.loading || !!activeFile.library}
                        onChange={(doc, caret, caretOffset) => {
                          if (previewKey === activeFile.key) onPromotePreview(activeFile.key);
                          onChangeText(activeFile.key, doc, caret, caretOffset);
                        }}
                        onSave={() => onSave(activeFile.key)}
                        onHover={(position) => onHover(activeFile, position)}
                        onPinHoverDoc={onPinHoverDoc}
                        onDefinition={(position) => onDefinition(activeFile, position)}
                        onReferences={(position) => onReferences(activeFile, position)}
                        onComplete={(position, trigger, token, invocation) => onComplete(activeFile, position, trigger, token, invocation)}
                        onCompleteResolve={(raw, token) => onCompleteResolve(activeFile, raw, token)}
                        getCompletionIdentity={() => onCompletionIdentity(activeFile)}
                        onCompletionDiagnostic={onCompletionDiagnostic}
                        onScopeFallback={onScopeFallback}
                        onParameterTrigger={(event) => onParameterTrigger?.(activeFile, event)}
                        onParameterInvalidate={onParameterInvalidate}
                        onParameterEscape={onParameterEscape}
                        parameterPopup={parameterPopup}
                        onSelectionChange={onSelectionChange}
                        onViewportChange={handleViewportChange}
                        onExpandSelection={(selection) => onExpandSelection(activeFile, selection)}
                        onLightbulb={onLightbulb}
                        onGitChangeClick={setGitDiffPeek}
                        onContextMenu={(request) => onEditorContextMenu(activeFile, { ...request, groupId })}
                        onCommandPortChange={handleEditorCommandPortChange}
                        completionTriggers={completionTriggers}
                        completionController={completionController}
                        signatureTriggers={signatureTriggers}
                        softWrap={softWrap}
                        appearance={appearance}
                        renderedDocEnabled={renderedDocEnabled}
                        renderedDocLanguageId={renderedDocLanguageId}
                        onToggleRenderedDocRaw={onToggleRenderedDocRaw}
                        columnSelectionMode={columnSelectionMode}
                        showHoverDocumentation={showHoverDocumentation}
                        hoverDocumentationDelayMs={hoverDocumentationDelayMs}
                        parameterInfoRequestNonce={parameterInfoRequestNonce}
                        parameterInfoShowFullSignatures={parameterInfoShowFullSignatures}
                        onFoldProvenanceChange={setActiveFoldProvenance}
                        onGoToLineRequest={onGoToLineRequest}
                        onCompletionUnavailable={onCompletionUnavailable}
                        codeStyle={activeCodeStyle}
                      />
                    </EditorMountBoundary>
                  </div>
                )}
              </div>
              {breadcrumbsPlacement === "bottom" ? breadcrumbs : null}
              {statusBarNavigation && breadcrumbs ? createPortal(breadcrumbs, statusBarNavigation) : null}
            </div>
          ) : (
            <div
              data-testid="code-workspace-empty-editor"
              className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]"
            >
              {emptyHints && emptyHints.length > 0 ? (
                <ul aria-label="Editor tips" className="flex flex-col gap-2">
                  {emptyHints.map((hint) => (
                    <li key={hint.label} data-testid="code-workspace-empty-editor-hint" className="flex items-center justify-between gap-6">
                      <span>{hint.label}</span>
                      {hint.shortcut && (
                        <kbd className="rounded border border-[var(--taomni-code-border)] px-1.5 text-[11px] text-[var(--taomni-accent)]">
                          {hint.shortcut}
                        </kbd>
                      )}
                    </li>
                  ))}
                </ul>
              ) : "No file open"}
            </div>
          )}
        </div>
      </div>
      {tabs.tabMenu.render}
    </main>
  );
}

export { type EditorRevealTarget, type EmptyEditorHint, type MarkdownViewMode } from "./group/types";
