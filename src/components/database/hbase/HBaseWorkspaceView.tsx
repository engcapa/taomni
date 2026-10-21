import {
  AlertTriangle,
  Ban,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Crosshair,
  Database,
  Files,
  HelpCircle,
  Languages,
  Loader2,
  Play,
  Plus,
  SquareDashedMousePointer,
  Star,
  X,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { MAX_DATABASE_TAB_LIMIT, MIN_DATABASE_TAB_LIMIT, clampDatabaseTabLimit } from "../../../lib/databaseTabLimit";
import { type HBaseTransport } from "../../../lib/hbaseCommands";
import { useT } from "../../../lib/i18n";
import { loadResizableLayout, saveResizableLayout } from "../../../lib/resizableLayout";
import { displaySqlShortcut } from "../../../lib/sqlExecutionPreferences";
import type { HBaseConnectInfo } from "../../../types";
import { useContextMenu } from "../../ContextMenu";
import { FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../../floating-toolbar/floatingToolbarStyles";
import { useConfirmDialog } from "../../sidebar/ConfirmDialog";
import { TabActions } from "../../tabbar/TabActionSlot";
import { HBaseSchemaTree } from "../HBaseSchemaTree";
import { QueryLibraryPanel } from "../QueryLibraryPanel";
import { SqlEditorPanel } from "../SqlEditorPanel";
import { CommandsMenu, HelpDialog, HistoryDropdown } from "./CommandMenus";
import { DEFAULT_ROW_LIMIT } from "./model";
import { ResultArea, StatusBar } from "./Results";
import { useHBaseExecution } from "./useHBaseExecution";
import { useHBaseWorkspace } from "./useHBaseWorkspace";

export interface HBaseWorkspaceViewProps {
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  chatToggle: { open: boolean; onToggle: () => void; } | undefined;
  visible: boolean;
  t: ReturnType<typeof useT>;
  connError: string | null;
  sidebarCollapsed: boolean;
  expandSidebarPanel: () => void;
  info: HBaseConnectInfo;
  initialLayout: import("react-resizable-panels").Layout | undefined;
  sidebarPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  handleSidebarResize: (size: PanelSize) => void;
  leftPanelTab: "objects" | "queries";
  setLeftPanelTab: import("react").Dispatch<import("react").SetStateAction<"objects" | "queries">>;
  connectionSessionId: string | null;
  transport: HBaseTransport;
  endpoint: string;
  refreshSignal: number;
  rowLimit: number;
  onRunCommand: (stmt: string) => undefined;
  onInsert: (stmt: string, target?: "cursor" | "newPanel") => void;
  workspace: ReturnType<typeof useHBaseWorkspace>;
  setStatusMessage: (message: string) => void;
  onTablesLoaded: (tables: string[]) => void;
  onFamiliesLoaded: (table: string, families: string[]) => void;
  execution: ReturnType<typeof useHBaseExecution>;
  queryTriggerRef: import("react").RefObject<(() => void) | null>;
  btn: "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  panelRunning: boolean;
  aiAnswerLanguage: AiAnswerLanguage;
  setLangMenuOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  langMenuOpen: boolean;
  setAiAnswerLanguage: import("react").Dispatch<import("react").SetStateAction<AiAnswerLanguage>>;
  setShowCommands: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setShowHistory: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  openQuerySave: () => void;
  setShowHelp: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setRowLimit: import("react").Dispatch<import("react").SetStateAction<number>>;
  showCommands: boolean;
  showHistory: boolean;
  openEditorContextMenu: (event: ReactMouseEvent) => void;
  editorMenu: ReturnType<typeof useContextMenu>;
  completionSources: import("@codemirror/autocomplete").CompletionSource[];
  showHelp: boolean;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
}

export function HBaseWorkspaceView(props: HBaseWorkspaceViewProps) {
  const {
    rootRef,
    chatToggle,
    visible,
    t,
    connError,
    sidebarCollapsed,
    expandSidebarPanel,
    info,
    initialLayout,
    sidebarPanelRef,
    handleSidebarResize,
    leftPanelTab,
    setLeftPanelTab,
    connectionSessionId,
    transport,
    endpoint,
    refreshSignal,
    rowLimit,
    onRunCommand,
    onInsert,
    workspace,
    setStatusMessage,
    onTablesLoaded,
    onFamiliesLoaded,
    execution,
    queryTriggerRef,
    btn,
    panelRunning,
    aiAnswerLanguage,
    setLangMenuOpen,
    langMenuOpen,
    setAiAnswerLanguage,
    setShowCommands,
    setShowHistory,
    openQuerySave,
    setShowHelp,
    setRowLimit,
    showCommands,
    showHistory,
    openEditorContextMenu,
    editorMenu,
    completionSources,
    showHelp,
    confirmDialog,
  } = props;
  return ((
    <div ref={rootRef} className="h-full w-full flex flex-col relative" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {chatToggle && (
        <TabActions active={visible}>
          <button
            type="button"
            data-testid="hbase-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        </TabActions>
      )}
      {connError && (
        <div
          className="h-7 shrink-0 px-2 flex items-center gap-2 text-[11px] border-b"
          style={{ color: "#d9534f", borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          title={connError}
          data-testid="hbase-connection-error-banner"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold">HBase connection failed.</span>
          <span className="truncate text-[var(--taomni-text-muted)]">The Query Library remains available. {connError}</span>
        </div>
      )}
      {sidebarCollapsed && (
        <button
          type="button"
          data-testid="hbase-sidebar-drawer-handle"
          className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
          style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
          title="Show database objects"
          aria-label="Show database objects"
          onClick={expandSidebarPanel}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>Objects</span>
        </button>
      )}
      <PanelGroup
        orientation="horizontal"
        id={`hbase-shell-${info.sessionId}`}
        defaultLayout={initialLayout}
        onLayoutChanged={saveResizableLayout(`hbase-shell-${info.sessionId}`)}
        className="flex-1 min-h-0"
      >
        <Panel panelRef={sidebarPanelRef} id="sidebar" defaultSize="20%" minSize="15%" maxSize="40%" collapsible collapsedSize={0} onResize={handleSidebarResize}>
          <div className="h-full flex flex-col border-r" style={{ borderColor: "var(--taomni-divider)" }}>
            <div className="h-7 shrink-0 flex border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold inline-flex items-center justify-center gap-1"
                style={{ color: leftPanelTab === "objects" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                onClick={() => setLeftPanelTab("objects")}
              >
                <Database className="w-3.5 h-3.5" /> Objects
              </button>
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold inline-flex items-center justify-center gap-1 border-l border-[var(--taomni-divider)]"
                style={{ color: leftPanelTab === "queries" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                onClick={() => setLeftPanelTab("queries")}
                data-testid="hbase-query-library-tab"
              >
                <Files className="w-3.5 h-3.5" /> Queries
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {leftPanelTab === "objects" ? (
                <HBaseSchemaTree
                  sessionId={connectionSessionId}
                  transport={transport}
                  namespace={info.namespace}
                  endpoint={endpoint}
                  refreshSignal={refreshSignal}
                  scanLimit={rowLimit}
                  onRunCommand={onRunCommand}
                  onInsert={onInsert}
                  onNewQuery={() => workspace.addPanel("")}
                  onStatus={setStatusMessage}
                  onTablesLoaded={onTablesLoaded}
                  onFamiliesLoaded={onFamiliesLoaded}
                />
              ) : (
                <QueryLibraryPanel
                  engine="HBaseShell"
                  connectionId={info.sessionId}
                  schemaName={info.namespace}
                  activeContent={workspace.editorHandles.current[workspace.activePanel.id]?.getValue() ?? workspace.activePanel.doc}
                  contentLabel="HBase command"
                  onOpenQuery={(query) => workspace.addPanel(query.content, query)}
                  onRunQuery={(query) => {
                    const panelId = workspace.addPanel(query.content, query);
                    if (panelId) setTimeout(() => void execution.runStatements(panelId, query.content), 0);
                  }}
                  onSavedQuery={(query, created) => {
                    const targetPanelId = created ? workspace.activePanel.id : null;
                    workspace.setPanels((current) => {
                      const next = current.map((panel) => {
                        if (panel.id !== targetPanelId && panel.savedQueryId !== query.id) return panel;
                        if (!created) workspace.editorHandles.current[panel.id]?.setValue(query.content);
                        return {
                          ...panel,
                          doc: created ? panel.doc : query.content,
                          savedQueryId: query.id,
                          savedQuery: query,
                        };
                      });
                      workspace.panelsRef.current = next;
                      return next;
                    });
                  }}
                  onAddTriggerRef={queryTriggerRef}
                />
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="workspace">
          <div className="h-full flex flex-col min-w-0">
            {/* query-panel tab strip */}
            <div className="h-7 shrink-0 flex items-center gap-1 px-1 overflow-hidden" style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
              {workspace.panels.map((p, i) => {
                const running = p.sheets.some((s) => s.running);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="px-2 h-5 max-w-[190px] rounded inline-flex items-center gap-1"
                    style={{
                      background: p.id === workspace.activePanelId ? "var(--taomni-selected)" : "transparent",
                      color: p.id === workspace.activePanelId ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                    }}
                    onClick={() => workspace.setActivePanelId(p.id)}
                    title={p.savedQuery?.name ?? `Query ${i + 1}`}
                  >
                    <span className="truncate">{p.savedQuery?.name ?? `Query ${i + 1}`}</span>
                    {running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {workspace.panels.length > 1 && (
                      <X className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]" onClick={(e) => { e.stopPropagation(); workspace.closePanel(p.id); }} />
                    )}
                  </button>
                );
              })}
              {workspace.panels.length < workspace.tabLimit && (
                <button type="button" title="New query panel" className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => workspace.addPanel("")}>
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            <div key={workspace.activePanel.id} className="flex-1 min-h-0 h-full flex flex-col min-w-0 relative">
              {/* editor toolbar */}
              <div className="h-8 shrink-0 flex items-center gap-1 px-2 relative" style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run (${displaySqlShortcut(execution.executionPreferences.runAll)})`}
                  onClick={() => void execution.runStatements(workspace.activePanel.id, workspace.editorHandles.current[workspace.activePanel.id]?.getValue() ?? workspace.activePanel.doc)}
                >
                  <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run selection (${displaySqlShortcut(execution.executionPreferences.runSelection)})`}
                  onClick={() => void execution.runStatements(workspace.activePanel.id, workspace.editorHandles.current[workspace.activePanel.id]?.getSelectionOrAll() ?? workspace.activePanel.doc)}
                >
                  <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run current statement (${displaySqlShortcut(execution.executionPreferences.runCurrent)})`}
                  data-testid="hbase-run-current-statement"
                  onClick={() => execution.runCurrentStatement(workspace.activePanel.id)}
                >
                  <Crosshair className="w-3.5 h-3.5" /> Current
                </button>
                <button
                  type="button"
                  className={btn}
                  title={t("dbAi.explainStatementTooltip")}
                  data-testid="hbase-explain-current-statement"
                  onClick={() => void execution.explainCurrentStatement(workspace.activePanel.id)}
                >
                  <BookOpen className="w-3.5 h-3.5" /> {t("dbAi.explainStatement")}
                </button>
                <div className="relative">
                  <button
                    type="button"
                    className={btn}
                    data-testid="hbase-ai-answer-language-toggle"
                    title={t("codeWorkspaceAi.answerLanguageTooltip", { current: t(answerLanguageLabelKey(aiAnswerLanguage)) })}
                    onClick={() => setLangMenuOpen((v) => !v)}
                  >
                    <Languages className="w-3.5 h-3.5" />
                    <span>{t(answerLanguageLabelKey(aiAnswerLanguage))}</span>
                    <ChevronDown className="w-3 h-3 opacity-60" />
                  </button>
                  {langMenuOpen && (
                    <div
                      className="absolute left-0 top-full mt-1 z-50 py-1 rounded shadow-lg border text-[11px] min-w-[120px]"
                      style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
                    >
                      {AI_ANSWER_LANGUAGES.map((lang) => (
                        <button
                          key={lang}
                          type="button"
                          data-testid={`hbase-ai-answer-language-option-${lang}`}
                          className="w-full px-2 py-1 text-left flex items-center justify-between hover:bg-[var(--taomni-hover)]"
                          onClick={() => {
                            setAiAnswerLanguage(lang);
                            setLangMenuOpen(false);
                          }}
                        >
                          <span>{t(answerLanguageLabelKey(lang))}</span>
                          {lang === aiAnswerLanguage && <Check className="w-3 h-3 text-[var(--taomni-accent)]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className={btn} disabled={!panelRunning} title="Cancel query" onClick={() => execution.cancelQuery(workspace.activePanel.id)}>
                  <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
                </button>
                <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
                <button type="button" className={btn} title="Commands" onClick={() => { setShowCommands((v) => !v); setShowHistory(false); }}>
                  Commands <ChevronDown className="w-3 h-3" />
                </button>
                <button type="button" className={btn} title="Command history" onClick={() => { setShowHistory((v) => !v); setShowCommands(false); }}>
                  <Clock className="w-3.5 h-3.5" /> History
                </button>
                <button type="button" className={btn} title="Save to query library" onClick={openQuerySave} data-testid="hbase-save-query">
                  <Star className="w-3.5 h-3.5 text-[var(--taomni-accent)]" /> Save Query
                </button>
                <button type="button" className={btn} title={t("hbaseObjects.helpTitle")} onClick={() => setShowHelp(true)}>
                  <HelpCircle className="w-3.5 h-3.5" /> {t("hbaseObjects.help")}
                </button>
                <div className="flex-1" />
                <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
                  Rows
                  <input className="taomni-input h-6 w-[68px] text-[11px]" type="number" min={1} max={10000} value={rowLimit}
                    title="Default scan row limit" onChange={(e) => setRowLimit(Math.max(1, Math.min(10000, Number(e.target.value) || DEFAULT_ROW_LIMIT)))} />
                </label>
                <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
                  Tab limit
                  <input
                    data-testid="hbase-tab-limit"
                    className="taomni-input h-6 w-[68px] text-[11px]"
                    type="number"
                    min={MIN_DATABASE_TAB_LIMIT}
                    max={MAX_DATABASE_TAB_LIMIT}
                    value={workspace.tabLimit}
                    title="Maximum query tabs per session and result tabs per query"
                    onChange={(event) => workspace.setTabLimit(clampDatabaseTabLimit(Number(event.target.value)))}
                  />
                </label>
                <span className="text-[10px] text-[var(--taomni-text-muted)]">HBase ({transport})</span>
                {showCommands && <CommandsMenu transport={transport} onPick={(ex) => onInsert(ex, "cursor")} onClose={() => setShowCommands(false)} />}
                {showHistory && <HistoryDropdown history={execution.historyRef.current[workspace.activePanel.id] ?? []} onPick={(cmd) => { workspace.editorHandles.current[workspace.activePanel.id]?.setValue(cmd); setShowHistory(false); }} onClose={() => setShowHistory(false)} />}
              </div>

              <PanelGroup
                orientation="vertical"
                id={`hbase-workspace-${info.sessionId}`}
                defaultLayout={loadResizableLayout(`hbase-workspace-${info.sessionId}`, ["editor", "results"])}
                onLayoutChanged={saveResizableLayout(`hbase-workspace-${info.sessionId}`)}
                className="flex-1 min-h-0"
              >
                <Panel id="editor" defaultSize="35%" minSize="15%">
                  <div className="h-full w-full" onContextMenu={openEditorContextMenu}>
                    {editorMenu.render}
                    <SqlEditorPanel
                      engine="HBase"
                      initialDoc={workspace.activePanel.doc}
                      completionSources={completionSources}
                      handleRef={(h) => { workspace.editorHandles.current[workspace.activePanel.id] = h; }}
                      onDocChange={(doc) => workspace.patchPanel(workspace.activePanel.id, { doc })}
                      onFocus={() => workspace.setActivePanelId(workspace.activePanel.id)}
                      onRun={(sql) => void execution.runStatements(workspace.activePanel.id, sql)}
                      onRunCurrent={() => execution.runCurrentStatement(workspace.activePanel.id)}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
                <Panel id="results" minSize="15%">
                  <ResultArea
                    panel={workspace.activePanel}
                    onSheetSelect={(sheetId) => workspace.patchPanel(workspace.activePanel.id, { activeSheetId: sheetId })}
                    onSheetClose={(sheetId) => execution.closeResultSheet(workspace.activePanel.id, sheetId)}
                    onCloseSheets={(sheetIds) => execution.closeResultSheets(workspace.activePanel.id, sheetIds)}
                    onTabChange={(sheetId, tab) => workspace.patchSheet(workspace.activePanel.id, sheetId, { resultTab: tab })}
                    onRefreshSheet={(sheetId, mode) => execution.refreshSheet(workspace.activePanel.id, sheetId, mode)}
                    onCancel={() => execution.cancelQuery(workspace.activePanel.id)}
                    onStatus={setStatusMessage}
                  />
                </Panel>
              </PanelGroup>
              <StatusBar panel={workspace.activePanel} />
            </div>
          </div>
        </Panel>

      </PanelGroup>
      {showHelp && <HelpDialog transport={transport} onClose={() => setShowHelp(false)} />}
      {confirmDialog.render}
    </div>
  ));
}
