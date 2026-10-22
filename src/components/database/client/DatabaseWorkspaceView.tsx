import { type CSSProperties } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { Plus, X, AlertTriangle, Loader2, Bot, ExternalLink, Maximize2, Minimize2, ChevronRight, Files, Database } from "lucide-react";
import { type DbSavedQuery, type DbSqlHistoryEntry } from "../../../lib/ipc";
import { SchemaTree, type SchemaTreeSelectedObject } from "../SchemaTree";
import { QueryLibraryPanel } from "../QueryLibraryPanel";
import { SqlEditorPanel, type SqlEditorRunContext } from "../SqlEditorPanel";
import { displaySqlShortcut } from "../../../lib/sqlExecutionPreferences";
import { ScreenshotMenuButton } from "../../screenshot/ScreenshotMenuButton";
import { TabActions } from "../../tabbar/TabActionSlot";
import { FT_BUTTON_STYLE, FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../../lib/i18n";
import { type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { clampDatabaseTabLimit } from "../../../lib/databaseTabLimit";
import { type PanelState, type EditorStatementAction, type SqlStatementSourceRef } from "./types";
import { MIN_ROW_LIMIT, MAX_ROW_LIMIT, MAX_PANEL_NAME_LENGTH, clampInt } from "./persistence";
import { EditorToolbar } from "./EditorToolbar";
import { HistoryDropdown } from "./HistoryDropdown";
import { StatementDropdown } from "./StatementDropdown";
import { ResultArea } from "./ResultArea";
import { StatusBar } from "./StatusBar";
import { useQueryPanelWorkspace } from "./useQueryPanelWorkspace";
import { useQueryPanelInteractions } from "./useQueryPanelInteractions";

export interface DatabaseWorkspaceViewProps {
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  dbFontStyle: CSSProperties;
  panelActions: ReturnType<typeof useQueryPanelInteractions>;
  connError: string | null;
  visible: boolean;
  chatToggle: { open: boolean; onToggle: () => void; } | undefined;
  t: ReturnType<typeof useT>;
  onDetach: (() => void) | undefined;
  detachedWindowControls: { onReattach: () => void; onToggleOsFullscreen: () => void; osFullscreen: boolean; } | undefined;
  schemaCollapsed: boolean;
  expandSchemaPanel: () => void;
  info: import("../../../types").DbConnectInfo;
  schemaPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  initialWidth: number;
  handleSchemaResize: (size: PanelSize) => void;
  leftPanelTab: "schema" | "queries";
  setLeftPanelTab: import("react").Dispatch<import("react").SetStateAction<"schema" | "queries">>;
  connectionSessionId: string | null;
  activeSchema: string | null;
  handleSchemaSelectionChange: (objects: SchemaTreeSelectedObject[]) => void;
  insertIntoActive: (text: string) => void;
  quickSelect: (schema: string | null, table: string) => void;
  workspace: ReturnType<typeof useQueryPanelWorkspace>;
  insertQueryFromOutside: (sql: string, options?: { run?: boolean; destination?: "current" | "new"; position?: "caret" | "first" | "last" | "replaceAll"; }) => void;
  switchSchema: (schema: string) => Promise<void>;
  setStatusMessage: (message: string) => void;
  onSchemasLoaded: (names: string[]) => void;
  onSchemaLoaded: (tables: Map<string, string[]>) => void;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | null;
  workspaceSessionId: string;
  activePanel: PanelState;
  openSqlInNewPanel: (sql: string, run?: boolean, origin?: SqlStatementSourceRef["origin"], savedQuery?: DbSavedQuery | null) => void;
  handleSavedQuery: (query: DbSavedQuery, created: boolean) => void;
  addQueryTriggerRef: import("react").RefObject<(() => void) | null>;
  schemas: string[];
  executionPreferences: import("../../../lib/sqlExecutionPreferences").SqlExecutionPreferences;
  aiAnswerLanguage: AiAnswerLanguage;
  setAiAnswerLanguage: import("react").Dispatch<import("react").SetStateAction<AiAnswerLanguage>>;
  runQuery: (panelId: string, sqlText: string, options?: { context?: SqlEditorRunContext; origin?: SqlStatementSourceRef["origin"]; historyId?: string; parentSheetId?: string; sheetTitle?: string; }) => Promise<void>;
  runCurrentStatement: (panelId?: string) => void;
  explainCurrentStatement: (panelId?: string) => Promise<void>;
  cancelQuery: (panelId?: string) => void;
  txAvailable: boolean;
  txStatus: import("../../../lib/ipc").DbTxStatus | null;
  toggleTxMode: () => Promise<void>;
  endTransaction: (commit: boolean) => Promise<void>;
  toggleStatementPanel: () => void;
  toggleHistoryPanel: () => void;
  saveQueryFile: (panel: PanelState) => Promise<void>;
  historyPanelId: string | null;
  historyEntries: DbSqlHistoryEntry[];
  historyLoading: boolean;
  refreshHistory: () => Promise<void>;
  selectSqlInActivePanel: (sql: string) => void;
  copyHistoryJson: (entry: DbSqlHistoryEntry) => Promise<void>;
  askAiAboutHistory: (entry: DbSqlHistoryEntry) => Promise<void>;
  deleteHistoryEntry: (entry: DbSqlHistoryEntry) => Promise<void>;
  clearCurrentHistory: () => Promise<void>;
  setHistoryPanelId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  statementAction: EditorStatementAction | null;
  latestResultForSql: (sql: string) => import("../../../lib/ipc").DbQueryResult | null;
  runEditorStatement: (action: EditorStatementAction) => void;
  selectEditorStatement: (action: EditorStatementAction) => void;
  openEditorStatementInNewPanel: (action: EditorStatementAction) => void;
  copyStatementJson: (action: EditorStatementAction) => Promise<void>;
  askAiAboutStatement: (action: EditorStatementAction) => Promise<void>;
  setStatementAction: import("react").Dispatch<import("react").SetStateAction<EditorStatementAction | null>>;
  editorSchema: import("@codemirror/lang-sql").SQLNamespace | undefined;
  closeResultSheet: (panelId: string, sheetId: string) => void;
  closeResultSheets: (panelId: string, sheetIds: string[]) => void;
  refreshSheet: (panelId: string, sheetId: string, mode: import("../QueryResultGrid").QueryRefreshMode, sqlOverride?: string) => Promise<void>;
  commitGridChanges: (panelId: string, sheetId: string, payload: import("../QueryResultGrid").QueryGridCommitPayload) => Promise<void>;
  previewGridChanges: (panelId: string, sheetId: string, payload: import("../QueryResultGrid").QueryGridCommitPayload) => Promise<import("../../../lib/dbGridChanges").GridChangePreview>;
  syncGeneratedSqlFromSheet: (resultPanelId: string, sheetId: string, generatedSql: string, mode: import("../QueryResultGrid").QueryGeneratedSqlSyncMode) => void;
  queryGeneratedSqlFromSheet: (resultPanelId: string, sheetId: string, generatedSql: string, rewriteRequest?: import("../../../lib/ipc").DbResultSqlRewriteRequest) => Promise<void>;
}

export function DatabaseWorkspaceView(props: DatabaseWorkspaceViewProps) {
  const {
    rootRef,
    dbFontStyle,
    panelActions,
    connError,
    visible,
    chatToggle,
    t,
    onDetach,
    detachedWindowControls,
    schemaCollapsed,
    expandSchemaPanel,
    info,
    schemaPanelRef,
    initialWidth,
    handleSchemaResize,
    leftPanelTab,
    setLeftPanelTab,
    connectionSessionId,
    activeSchema,
    handleSchemaSelectionChange,
    insertIntoActive,
    quickSelect,
    workspace,
    insertQueryFromOutside,
    switchSchema,
    setStatusMessage,
    onSchemasLoaded,
    onSchemaLoaded,
    metadataCache,
    workspaceSessionId,
    activePanel,
    openSqlInNewPanel,
    handleSavedQuery,
    addQueryTriggerRef,
    schemas,
    executionPreferences,
    aiAnswerLanguage,
    setAiAnswerLanguage,
    runQuery,
    runCurrentStatement,
    explainCurrentStatement,
    cancelQuery,
    txAvailable,
    txStatus,
    toggleTxMode,
    endTransaction,
    toggleStatementPanel,
    toggleHistoryPanel,
    saveQueryFile,
    historyPanelId,
    historyEntries,
    historyLoading,
    refreshHistory,
    selectSqlInActivePanel,
    copyHistoryJson,
    askAiAboutHistory,
    deleteHistoryEntry,
    clearCurrentHistory,
    setHistoryPanelId,
    statementAction,
    latestResultForSql,
    runEditorStatement,
    selectEditorStatement,
    openEditorStatementInNewPanel,
    copyStatementJson,
    askAiAboutStatement,
    setStatementAction,
    editorSchema,
    closeResultSheet,
    closeResultSheets,
    refreshSheet,
    commitGridChanges,
    previewGridChanges,
    syncGeneratedSqlFromSheet,
    queryGeneratedSqlFromSheet,
  } = props;
  return ((
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col relative"
      style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      {panelActions.queryTabMenu.render}
      {connError && (
        <div
          className="h-7 shrink-0 px-2 flex items-center gap-2 text-[11px] border-b"
          style={{ color: "#d9534f", borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          title={connError}
          data-testid="db-connection-error-banner"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold">Connection failed.</span>
          <span className="truncate text-[var(--taomni-text-muted)]">Query drafts and the Query Library remain available. {connError}</span>
        </div>
      )}
      <TabActions active={visible}>
        {chatToggle && (
          <button
            type="button"
            data-testid="db-chat-toggle"
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
        )}
        {onDetach && (
          <button
            type="button"
            data-testid="db-detach"
            onClick={onDetach}
            title={t("rdp.detach")}
            aria-label={t("rdp.detach")}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {detachedWindowControls && (
          <>
            <ScreenshotMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              onClick={detachedWindowControls.onReattach}
              title={t("rdp.reattach")}
              aria-label={t("rdp.reattach")}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              onClick={detachedWindowControls.onToggleOsFullscreen}
              title={t("rdp.osFullscreen")}
              aria-label={t("rdp.osFullscreen")}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </TabActions>
      {schemaCollapsed && (
        <button
          type="button"
          data-testid="db-schema-drawer-handle"
          className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
          style={{
            background: "var(--taomni-panel-bg)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
          title="Show database objects"
          aria-label="Show database objects"
          onClick={expandSchemaPanel}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
            Objects
          </span>
        </button>
      )}
      <PanelGroup orientation="horizontal" id={`db-client-${info.engine}`} className="flex-1 min-h-0">
        <Panel
          panelRef={schemaPanelRef}
          id="schema"
          defaultSize={`${initialWidth}%`}
          minSize="12%"
          collapsedSize={0}
          collapsible
          maxSize="50%"
          onResize={handleSchemaResize}
        >
          <div className="h-full flex flex-col min-h-0 bg-[var(--taomni-bg)]" style={{ borderRight: "1px solid var(--taomni-divider)" }}>
            {/* Tab Headers */}
            <div className="h-7 shrink-0 flex border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold flex items-center justify-center gap-1.5 h-full transition-colors"
                style={{
                  color: leftPanelTab === "schema" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  background: leftPanelTab === "schema" ? "var(--taomni-bg)" : "transparent",
                  borderRight: "1px solid var(--taomni-divider)",
                }}
                onClick={() => setLeftPanelTab("schema")}
              >
                <Database className="w-3.5 h-3.5" />
                Schema
              </button>
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold flex items-center justify-center gap-1.5 h-full transition-colors"
                style={{
                  color: leftPanelTab === "queries" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  background: leftPanelTab === "queries" ? "var(--taomni-bg)" : "transparent",
                }}
                onClick={() => setLeftPanelTab("queries")}
                data-testid="db-query-library-tab"
              >
                <Files className="w-3.5 h-3.5" />
                Queries
              </button>
            </div>
            {/* Tab Body */}
            <div className="flex-1 min-h-0">
              {leftPanelTab === "schema" ? (
                connectionSessionId && (
                  <SchemaTree
                    sessionId={connectionSessionId}
                    engine={info.engine}
                    catalog={info.catalog}
                    databaseName={info.database}
                    activeSchema={activeSchema}
                    onSelectionChange={handleSchemaSelectionChange}
                    onInsertTable={insertIntoActive}
                    onQuickSelect={quickSelect}
                    quickSelectLimit={workspace.rowLimit}
                    onInsertSql={(sql) => insertQueryFromOutside(sql, { destination: "new" })}
                    onNewQuery={panelActions.addPanel}
                    onSetDefaultSchema={(schema) => void switchSchema(schema)}
                    onStatus={setStatusMessage}
                    onSchemasLoaded={onSchemasLoaded}
                    onSchemaLoaded={onSchemaLoaded}
                    metadataCache={metadataCache ?? undefined}
                  />
                )
              ) : (
                <QueryLibraryPanel
                  engine={info.engine}
                  connectionId={workspaceSessionId}
                  activeContent={workspace.editorHandles.current[activePanel.id]?.getValue() ?? activePanel.doc}
                  catalogName={info.catalog}
                  databaseName={info.database}
                  schemaName={activeSchema}
                  onOpenQuery={(query) => openSqlInNewPanel(query.content, false, "generated", query)}
                  onRunQuery={(query) => openSqlInNewPanel(query.content, true, "generated", query)}
                  onSavedQuery={handleSavedQuery}
                  onAddTriggerRef={addQueryTriggerRef}
                />
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="workspace">
          {/* Panel tab strip */}
          <div className="h-full flex flex-col min-w-0">
            <div
              className="h-7 shrink-0 flex items-center gap-1 px-1 text-[11px]"
              style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
            >
              {workspace.panels.map((p, i) => {
                const panelRunning = p.sheets.some((sheet) => sheet.running);
                const label = p.displayName ?? p.fileName ?? p.savedQuery?.name ?? `Query ${i + 1}`;
                if (workspace.editingPanelId === p.id) {
                  return (
                    <input
                      key={p.id}
                      type="text"
                      data-testid="db-query-tab-input"
                      autoFocus
                      value={workspace.panelDraftTitle}
                      maxLength={MAX_PANEL_NAME_LENGTH}
                      aria-label={t("tabs.rename")}
                      className="px-2 h-5 w-[160px] rounded text-[11px] outline-none"
                      style={{
                        background: "var(--taomni-selected)",
                        color: "var(--taomni-accent)",
                        border: "1px solid var(--taomni-selected-border)",
                      }}
                      onChange={(event) => workspace.setPanelDraftTitle(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          workspace.commitPanelRename(p.id);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          workspace.cancelPanelRename();
                        }
                        event.stopPropagation();
                      }}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => workspace.commitPanelRename(p.id)}
                    />
                  );
                }
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid="db-query-tab"
                    className="px-2 h-5 max-w-[190px] rounded inline-flex items-center gap-1"
                    style={{
                      background: p.id === workspace.activePanelId ? "var(--taomni-selected)" : "transparent",
                      color: p.id === workspace.activePanelId ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                    }}
                    onClick={() => workspace.setActivePanelId(p.id)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      workspace.startPanelRename(p);
                    }}
                    onContextMenu={(event) => panelActions.openPanelMenu(event, p)}
                    title={p.filePath ?? label}
                  >
                    <span className="truncate">
                      {label}{p.dirty ? "*" : ""}
                    </span>
                    {panelRunning && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {workspace.panels.length > 1 && (
                      <X
                        className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          void panelActions.closePanel(p.id);
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {workspace.panels.length < workspace.tabLimit && (
                <button
                  type="button"
                  title="New query panel"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                  onClick={panelActions.addPanel}
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            <div
              key={activePanel.id}
              className="flex-1 min-h-0 h-full flex flex-col min-w-0 relative"
              data-active
            >
              <EditorToolbar
                engine={info.engine}
                schemas={schemas}
                activeSchema={activeSchema}
                running={activePanel.sheets.some((sheet) => sheet.running)}
                runAllTitle={`Run (${displaySqlShortcut(executionPreferences.runAll)})`}
                runSelectionTitle={`Run selection (${displaySqlShortcut(executionPreferences.runSelection)})`}
                runCurrentTitle={`Run current statement (${displaySqlShortcut(executionPreferences.runCurrent)})`}
                aiAnswerLanguage={aiAnswerLanguage}
                onSetAiAnswerLanguage={setAiAnswerLanguage}
                onRun={() => {
                  const payload = panelActions.editorRunPayload(activePanel, false);
                  void runQuery(activePanel.id, payload.sql, { context: payload.context });
                }}
                onRunSelection={() => {
                  const payload = panelActions.editorRunPayload(activePanel, true);
                  void runQuery(activePanel.id, payload.sql, { context: payload.context });
                }}
                onRunCurrent={runCurrentStatement}
                onExplain={() => void explainCurrentStatement()}
                onCancel={() => cancelQuery(activePanel.id)}
                txAvailable={txAvailable}
                txStatus={txStatus}
                onToggleTx={() => void toggleTxMode()}
                onCommitTx={() => void endTransaction(true)}
                onRollbackTx={() => void endTransaction(false)}
                onFormat={() => panelActions.formatPanel(activePanel)}
                onToggleStatement={toggleStatementPanel}
                onToggleHistory={toggleHistoryPanel}
                onSave={() => void saveQueryFile(activePanel)}
                onSaveQuery={() => addQueryTriggerRef.current?.()}
                onSchemaChange={(schema) => void switchSchema(schema)}
                rowLimit={workspace.rowLimit}
                tabLimit={workspace.tabLimit}
                onRowLimitChange={(value) =>
                  workspace.setRowLimit(clampInt(value, MIN_ROW_LIMIT, MAX_ROW_LIMIT))
                }
                onTabLimitChange={(value) =>
                  workspace.setTabLimit(clampDatabaseTabLimit(value))
                }
              />
              {historyPanelId === activePanel.id && (
                <HistoryDropdown
                  entries={historyEntries}
                  loading={historyLoading}
                  onRefresh={() => void refreshHistory()}
                  onRun={(entry) => void runQuery(activePanel.id, entry.sqlContent, { origin: "history", historyId: entry.id })}
                  onSelect={(entry) => selectSqlInActivePanel(entry.sqlContent)}
                  onOpenTab={(entry) => openSqlInNewPanel(entry.sqlContent, true, "history")}
                  onJson={(entry) => void copyHistoryJson(entry)}
                  onAskAi={(entry) => void askAiAboutHistory(entry)}
                  onDelete={(entry) => void deleteHistoryEntry(entry)}
                  onClear={() => void clearCurrentHistory()}
                  onClose={() => setHistoryPanelId(null)}
                />
              )}
              {statementAction?.panelId === activePanel.id && (
                <StatementDropdown
                  action={statementAction}
                  hasJson={latestResultForSql(statementAction.range.sql) !== null}
                  onRun={runEditorStatement}
                  onSelect={selectEditorStatement}
                  onOpenTab={openEditorStatementInNewPanel}
                  onJson={(action) => void copyStatementJson(action)}
                  onAskAi={(action) => void askAiAboutStatement(action)}
                  onClose={() => setStatementAction(null)}
                />
              )}
              <PanelGroup orientation="vertical" className="flex-1 min-h-0">
                <Panel defaultSize="45%" minSize="15%">
                  <div
                    className="h-full w-full"
                    onContextMenu={(event) => panelActions.openPanelMenu(event, activePanel)}
                  >
                    <SqlEditorPanel
                      engine={info.engine}
                      initialDoc={activePanel.doc}
                      schema={editorSchema}
                      metadataCache={metadataCache}
                      activeSchema={activeSchema}
                      catalog={info.catalog}
                      onMetadataStatus={setStatusMessage}
                      handleRef={(h) => {
                        workspace.editorHandles.current[activePanel.id] = h;
                      }}
                      onDocChange={(doc) => {
                        workspace.patchPanel(activePanel.id, { doc, dirty: true });
                        workspace.scheduleWorkspaceSave();
                      }}
                      onFocus={() => workspace.setActivePanelId(activePanel.id)}
                      onRun={(sql, context) => void runQuery(activePanel.id, sql, { context })}
                      onRunCurrent={() => runCurrentStatement()}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
                <Panel minSize="15%">
                  <ResultArea
                    panel={activePanel}
                    sqlEngine={info.engine}
                    onSheetSelect={(sheetId) => workspace.patchPanel(activePanel.id, { activeSheetId: sheetId, logActive: false })}
                    onShowLog={() => workspace.patchPanel(activePanel.id, { logActive: true })}
                    onSheetClose={(sheetId) => closeResultSheet(activePanel.id, sheetId)}
                    onCloseSheets={(sheetIds) => closeResultSheets(activePanel.id, sheetIds)}
                    onTabChange={(sheetId, tab) => workspace.patchSheet(activePanel.id, sheetId, { resultTab: tab })}
                    onRefreshSheet={(sheetId, mode) => void refreshSheet(activePanel.id, sheetId, mode)}
                    onCommitGridChanges={(sheetId, payload) => commitGridChanges(activePanel.id, sheetId, payload)}
                    onPreviewGridChanges={(sheetId, payload) => previewGridChanges(activePanel.id, sheetId, payload)}
                    onGeneratedSqlSync={(sheetId, sql, mode) =>
                      syncGeneratedSqlFromSheet(activePanel.id, sheetId, sql, mode)
                    }
                    onGeneratedSqlQuery={(sheetId, sql, rewriteRequest) =>
                      queryGeneratedSqlFromSheet(activePanel.id, sheetId, sql, rewriteRequest)
                    }
                    onCancel={() => cancelQuery(activePanel.id)}
                    onStatus={setStatusMessage}
                  />
                </Panel>
              </PanelGroup>
              <StatusBar panel={activePanel} />
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  ));
}
