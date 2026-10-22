import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { dbCancel, dbClearHistory, dbDeleteHistory, selectSaveFilePath, type DbSavedQuery, type DbSqlHistoryEntry } from "../../lib/ipc";
import { type SchemaTreeSelectedObject } from "./SchemaTree";
import { type SqlEditorRunContext } from "./SqlEditorPanel";
import { loadSqlExecutionPreferences, subscribeSqlExecutionPreferences } from "../../lib/sqlExecutionPreferences";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { type AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { sqlStatementRangesForExecution, type SqlStatementRange } from "../../lib/sqlStatements";
import { asSqlEngine, selectStatement as dialectSelectStatement } from "../../lib/sqlDialect";
import { type DbClientTabProps, type PanelState, type EditorStatementAction, type SqlStatementSourceRef, type ResultSubTab } from "./client/types";
import { newPanel, initialActiveSchema, newResultSheet } from "./client/queryModel";
import { basename, writeTextFile, widthKey, clampInt } from "./client/persistence";
import { createStreamQueryIntoSheet, createRunQuery, createCancelQuery, createRefreshSheet } from "./client/queryExecution";
import { createRefreshHistory, createAppendSqlHistory } from "./client/history";
import { useDatabaseTransactions } from "./client/useDatabaseTransactions";
import { useDatabaseQueryBridge } from "./client/useDatabaseQueryBridge";
import { useDatabaseGridChanges } from "./client/useDatabaseGridChanges";
import { useDatabaseSchema } from "./client/useDatabaseSchema";
import { createGeneratedSqlActions } from "./client/generatedSqlActions";
import { createStatementActions } from "./client/statementActions";
import { createDatabaseAiActions } from "./client/aiActions";
import { useQueryPanelWorkspace } from "./client/useQueryPanelWorkspace";
import { useQueryPanelInteractions } from "./client/useQueryPanelInteractions";
import { useDatabaseConnection } from "./client/useDatabaseConnection";
import { DatabaseWorkspaceView } from "./client/DatabaseWorkspaceView";

export default function DbClientTab({
  tabId,
  info,
  visible,
  onDetach,
  chatToggle,
  detachedWindowControls,
}: DbClientTabProps) {
  const t = useT();
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(() => initialActiveSchema(info));
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const [statementAction, setStatementAction] = useState<EditorStatementAction | null>(null);
  const [aiAnswerLanguage, setAiAnswerLanguage] = useState<AiAnswerLanguage>("inherit");
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  const [historyEntries, setHistoryEntries] = useState<DbSqlHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"schema" | "queries">("schema");
  const addQueryTriggerRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const schemaPanelRef = useRef<PanelImperativeHandle | null>(null);
  const lastVisibleSchemaWidthRef = useRef(24);
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const { fontSize: dbFontSize } = useDbSessionFontSize(visible, rootRef);
  const dbFontStyle = useMemo(
    () => ({
      "--taomni-db-font-size": `${dbFontSize}px`,
      "--taomni-db-font-size-sm": `${Math.max(10, dbFontSize - 2)}px`,
    }) as CSSProperties,
    [dbFontSize],
  );
  const workspaceSessionId = info.workspaceSessionId ?? info.sessionId;

  // Global keyboard shortcut to save the active editor as a query: Ctrl+Alt+B / Cmd+Alt+B
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        addQueryTriggerRef.current?.();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);
  const { connectionSessionId, metadataCache, metadataVersion, setTabDbSelectedObjects, connError } = useDatabaseConnection({
    info,
    tabId,
    get txStatusRef() { return txStatusRef; },
    setStatusMessage,
    get workspace() { return workspace; },
  });
  const { txStatusRef, refreshTxStatus, txAvailable, txStatus, toggleTxMode, endTransaction } = useDatabaseTransactions({
    setStatusMessage,
    info,
    connectionSessionId,
  });
  const workspace = useQueryPanelWorkspace({
    info,
    workspaceSessionId,
    setStatusMessage,
    setHistoryEntries,
  });

  const anyRunning = workspace.panels.some((p) => p.sheets.some((sheet) => sheet.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const streamQueryIntoSheet = useCallback(
    createStreamQueryIntoSheet({
      patchSheet: workspace.patchSheet,
      timersRef: workspace.timersRef,
      connectionSessionId,
      updateSheet: workspace.updateSheet,
      metadataCache,
      info,
      activeSchema,
    }),
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache, workspace.patchSheet, workspace.updateSheet],
  );

  const statementRangesForRun = useCallback(
    (sqlText: string, context?: SqlEditorRunContext): SqlStatementRange[] => {
      const ranges = sqlStatementRangesForExecution(info.engine, sqlText);
      const selection = context?.selectionRange;
      if (!selection) return ranges;
      const selectedText = context.doc.slice(selection.from, selection.to);
      if (selectedText !== sqlText) return ranges;
      return ranges.map((range) => ({
        ...range,
        from: range.from + selection.from,
        to: range.to + selection.from,
      }));
    },
    [info.engine],
  );

  const refreshHistory = useCallback(createRefreshHistory({
    setHistoryLoading,
    workspaceSessionId,
    info,
    setHistoryEntries,
    setStatusMessage,
  }), [info.engine, setStatusMessage, workspaceSessionId]);

  const appendSqlHistory = useCallback(
    createAppendSqlHistory({
      panelsRef: workspace.panelsRef,
      workspaceSessionId,
      info,
      activeSchema,
      historyPanelId,
      refreshHistory,
      setStatusMessage,
    }),
    [activeSchema, historyPanelId, info.catalog, info.database, info.engine, info.host, info.port, refreshHistory, setStatusMessage, workspaceSessionId],
  );

  const runQuery = useCallback(
    createRunQuery({
      panelsRef: workspace.panelsRef,
      statementRangesForRun,
      setStatusMessage,
      historyRef: workspace.historyRef,
      setPanels: workspace.setPanels,
      cancelRequestedRef: workspace.cancelRequestedRef,
      rowLimit: workspace.rowLimit,
      tabLimit: workspace.tabLimit,
      streamQueryIntoSheet,
      appendSqlHistory,
      txStatusRef,
      refreshTxStatus,
    }),
    [appendSqlHistory, refreshTxStatus, workspace.rowLimit, setStatusMessage, statementRangesForRun, streamQueryIntoSheet, workspace.tabLimit],
  );
  const { insertQueryFromOutside } = useDatabaseQueryBridge({
    panels: workspace.panels,
    tabLimit: workspace.tabLimit,
    setPanels: workspace.setPanels,
    setActivePanelId: workspace.setActivePanelId,
    runQuery,
    activePanelId: workspace.activePanelId,
    editorHandles: workspace.editorHandles,
    patchPanel: workspace.patchPanel,
    panelsRef: workspace.panelsRef,
    echoPanelIdRef: workspace.echoPanelIdRef,
    activePanelIdRef: workspace.activePanelIdRef,
    info,
    tabId,
    flushWorkspace: workspace.flushWorkspace,
  });

  const cancelQuery = useCallback(createCancelQuery({
    panelsRef: workspace.panelsRef,
    cancelRequestedRef: workspace.cancelRequestedRef,
    setPanels: workspace.setPanels,
    connectionSessionId,
  }), [connectionSessionId]);

  const refreshSheet = useCallback(
    createRefreshSheet({
      panelsRef: workspace.panelsRef,
      rowLimit: workspace.rowLimit,
      timersRef: workspace.timersRef,
      patchSheet: workspace.patchSheet,
      streamQueryIntoSheet,
    }),
    [workspace.patchSheet, workspace.rowLimit, streamQueryIntoSheet],
  );
  const { commitGridChanges, previewGridChanges } = useDatabaseGridChanges({
    panelsRef: workspace.panelsRef,
    activeSchema,
    info,
    connectionSessionId,
    metadataCache,
    txStatusRef,
    refreshTxStatus,
    setStatusMessage,
    refreshSheet,
  });
  const { switchSchema, onSchemasLoaded, onSchemaLoaded, editorSchema } = useDatabaseSchema({
    setSchemaMap,
    setSchemas,
    setActiveSchema,
    info,
    metadataCache,
    setStatusMessage,
    activeSchema,
    metadataVersion,
    schemaMap,
    activePanelId: workspace.activePanelId,
    connectionSessionId,
    panels: workspace.panels,
    rowLimit: workspace.rowLimit,
    setPanels: workspace.setPanels,
    tabLimit: workspace.tabLimit,
  });
  const insertIntoActive = useCallback(
    (text: string) => {
      workspace.editorHandles.current[workspace.activePanelId]?.insertText(text);
    },
    [workspace.activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const sql = dialectSelectStatement(
        asSqlEngine(info.engine),
        { catalog: info.catalog, schema: schema ?? activeSchema, name: table },
        [],
        workspace.rowLimit,
      );
      workspace.editorHandles.current[workspace.activePanelId]?.setValue(sql);
      void runQuery(workspace.activePanelId, sql);
    },
    [workspace.activePanelId, activeSchema, info.catalog, info.engine, workspace.rowLimit, runQuery],
  );

  const handleSchemaSelectionChange = useCallback(
    (objects: SchemaTreeSelectedObject[]) => {
      setTabDbSelectedObjects(
        tabId,
        objects.map((object) => ({
          catalog: info.catalog ?? null,
          schema: object.schema,
          name: object.name,
          kind: object.kind,
        })),
      );
    },
    [info.catalog, setTabDbSelectedObjects, tabId],
  );
  const panelActions = useQueryPanelInteractions({
    workspace,
    connectionSessionId,
    workspaceSessionId,
    setStatusMessage,
    info,
    get currentEditorStatement() { return currentEditorStatement; },
    t,
    get askAiAboutStatement() { return askAiAboutStatement; },
    aiAnswerLanguage,
    setAiAnswerLanguage,
    runQuery,
    get runCurrentStatement() { return runCurrentStatement; },
    get saveQueryFile() { return saveQueryFile; },
  });

  const closeResultSheets = (panelId: string, sheetIds: string[]) => {
    if (sheetIds.length === 0) return;
    const idSet = new Set(sheetIds);
    const panel = workspace.panels.find((p) => p.id === panelId);
    if (!panel) return;
    const closing = panel.sheets.filter((sheet) => idSet.has(sheet.id));
    if (closing.length === 0) return;
    if (closing.some((sheet) => sheet.running) && connectionSessionId) {
      void dbCancel(connectionSessionId).catch(() => undefined);
    }
    for (const sheet of closing) {
      if (workspace.timersRef.current[sheet.id]) {
        clearInterval(workspace.timersRef.current[sheet.id]);
        delete workspace.timersRef.current[sheet.id];
      }
    }
    workspace.setPanels((prev) =>
      prev.map((candidate) => {
        if (candidate.id !== panelId) return candidate;
        const sheets = candidate.sheets.filter((sheet) => !idSet.has(sheet.id));
        const activeClosed = !!candidate.activeSheetId && idSet.has(candidate.activeSheetId);
        return {
          ...candidate,
          sheets,
          activeSheetId: activeClosed ? sheets.at(-1)?.id ?? null : candidate.activeSheetId,
        };
      }),
    );
  };

  const closeResultSheet = (panelId: string, sheetId: string) => {
    closeResultSheets(panelId, [sheetId]);
  };

  const showPanelError = (panelId: string, message: string) => {
    const panel = workspace.panels.find((p) => p.id === panelId);
    const sheet = newResultSheet("", (panel?.sheets.length ?? 0) + 1, workspace.rowLimit);
    sheet.title = "Message";
    workspace.setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? {
            ...p,
            sheets: [
              ...p.sheets,
              { ...sheet, running: false, result: null, error: message, resultTab: "messages" as ResultSubTab },
            ].slice(-workspace.tabLimit),
            activeSheetId: sheet.id,
          }
          : p,
      ),
    );
  };

  const saveQueryFile = async (panel: PanelState) => {
    const sql = workspace.editorHandles.current[panel.id]?.getValue() ?? panel.doc;
    const defaultName = panel.fileName ?? `query-${Date.now()}.sql`;
    const path = await selectSaveFilePath(defaultName, panel.filePath ?? undefined);
    if (!path) return;
    try {
      await writeTextFile(path, sql);
      workspace.lastAutoSavedDocRef.current[panel.id] = sql;
      workspace.patchPanel(panel.id, {
        filePath: path,
        fileName: basename(path) || defaultName,
        dirty: false,
      });
      const nextPanels = workspace.panels.map((candidate) =>
        candidate.id === panel.id
          ? { ...candidate, filePath: path, fileName: basename(path) || defaultName, dirty: false }
          : candidate,
      );
      workspace.panelsRef.current = nextPanels;
      await workspace.persistWorkspaceSnapshot(nextPanels, workspace.activePanelId);
    } catch (err) {
      showPanelError(panel.id, String(err));
    }
  };

  const initialWidth = useMemo(() => {
    try {
      const raw = localStorage.getItem(widthKey(info.engine));
      if (raw == null || raw === "") return 24;
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 && v <= 50 ? v : 24;
    } catch {
      return 24;
    }
  }, [info.engine]);

  const activePanel = workspace.panels.find((panel) => panel.id === workspace.activePanelId) ?? workspace.panels[0];
  const { syncGeneratedSqlFromSheet, queryGeneratedSqlFromSheet } = createGeneratedSqlActions({
    setPanels: workspace.setPanels,
    panelsRef: workspace.panelsRef,
    activePanelIdRef: workspace.activePanelIdRef,
    editorHandles: workspace.editorHandles,
    setStatusMessage,
    setActivePanelId: workspace.setActivePanelId,
    tabLimit: workspace.tabLimit,
    refreshSheet,
  });

  const toggleHistoryPanel = () => {
    const opening = historyPanelId !== activePanel.id;
    setHistoryPanelId(opening ? activePanel.id : null);
    if (opening) setStatementAction(null);
    if (opening) void refreshHistory();
  };

  const selectSqlInActivePanel = (sql: string) => {
    const handle = workspace.editorHandles.current[activePanel.id];
    handle?.setValue(sql);
    handle?.selectRange(0, sql.length);
    workspace.patchPanel(activePanel.id, { doc: sql, dirty: true });
    setHistoryPanelId(null);
  };

  const openSqlInNewPanel = (
    sql: string,
    run = false,
    origin: SqlStatementSourceRef["origin"] = "history",
    savedQuery: DbSavedQuery | null = null,
  ) => {
    if (workspace.panelsRef.current.length >= workspace.tabLimit) {
      setStatusMessage(`Maximum query panels reached (${workspace.tabLimit}).`);
      return;
    }
    const panel = newPanel({ doc: sql, savedQuery, dirty: !savedQuery });
    if (savedQuery) workspace.savedQueriesRef.current[panel.id] = savedQuery;
    workspace.setPanels((prev) => {
      const next = [...prev, panel];
      workspace.panelsRef.current = next;
      return next;
    });
    workspace.setActivePanelId(panel.id);
    setHistoryPanelId(null);
    if (run) {
      setTimeout(() => {
        void runQuery(panel.id, sql, { origin });
      }, 0);
    }
  };

  const handleSavedQuery = (query: DbSavedQuery, created: boolean) => {
    const targetPanelId = created ? activePanel.id : null;
    workspace.setPanels((prev) => {
      const next = prev.map((panel) => {
        const matches = panel.id === targetPanelId || panel.savedQuery?.id === query.id;
        if (!matches) return panel;
        workspace.savedQueriesRef.current[panel.id] = query;
        if (!created && panel.doc !== query.content) {
          workspace.editorHandles.current[panel.id]?.setValue(query.content);
        }
        workspace.lastAutoSavedDocRef.current[panel.id] = query.content;
        return {
          ...panel,
          doc: created ? panel.doc : query.content,
          savedQuery: query,
          dirty: false,
        };
      });
      workspace.panelsRef.current = next;
      return next;
    });
    workspace.scheduleWorkspaceSave();
  };

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );
  const {
    currentEditorStatement,
    runCurrentStatement,
    latestResultForSql,
    explainCurrentStatement,
    toggleStatementPanel,
    copyHistoryJson,
    runEditorStatement,
    selectEditorStatement,
    openEditorStatementInNewPanel,
    copyStatementJson,
  } = createStatementActions({
    activePanel,
    panels: workspace.panels,
    editorHandles: workspace.editorHandles,
    info,
    setStatusMessage,
    runQuery,
    statementAction,
    setStatementAction,
    setHistoryPanelId,
    setActivePanelId: workspace.setActivePanelId,
    openSqlInNewPanel,
    panelsRef: workspace.panelsRef,
  });
  const { askAiAboutStatement, askAiAboutHistory } = createDatabaseAiActions({
    tabId,
    setStatusMessage,
    t,
    latestResultForSql,
    aiAnswerLanguage,
    setHistoryPanelId,
    info,
    activeSchema,
    setStatementAction,
  });

  const deleteHistoryEntry = async (entry: DbSqlHistoryEntry) => {
    try {
      await dbDeleteHistory(entry.id);
      await refreshHistory();
    } catch (err) {
      setStatusMessage(`Delete query history failed: ${String(err)}`);
    }
  };

  const clearCurrentHistory = async () => {
    try {
      await dbClearHistory(workspaceSessionId);
      await refreshHistory();
    } catch (err) {
      setStatusMessage(`Clear query history failed: ${String(err)}`);
    }
  };

  useEffect(() => {
    setSchemaCollapsed(initialWidth === 0);
    if (initialWidth > 0) {
      lastVisibleSchemaWidthRef.current = initialWidth;
    }
  }, [initialWidth]);

  const expandSchemaPanel = () => {
    const nextSize = clampInt(lastVisibleSchemaWidthRef.current || 24, 12, 50);
    schemaPanelRef.current?.resize(`${nextSize}%`);
    setSchemaCollapsed(false);
    try {
      localStorage.setItem(widthKey(info.engine), String(nextSize));
    } catch {
      /* ignore */
    }
  };

  const handleSchemaResize = (size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 0) {
      lastVisibleSchemaWidthRef.current = percentage;
    }
    setSchemaCollapsed(percentage === 0);
    try {
      localStorage.setItem(widthKey(info.engine), String(percentage));
    } catch {
      /* ignore */
    }
  };

  if (!workspace.workspaceReady) {
    return (
      <div
        ref={rootRef}
        className="h-full w-full flex items-center justify-center text-sm"
        style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
      >
        Loading query workspace...
      </div>
    );
  }

  return <DatabaseWorkspaceView
    rootRef={rootRef}
    dbFontStyle={dbFontStyle}
    panelActions={panelActions}
    connError={connError}
    visible={visible}
    chatToggle={chatToggle}
    t={t}
    onDetach={onDetach}
    detachedWindowControls={detachedWindowControls}
    schemaCollapsed={schemaCollapsed}
    expandSchemaPanel={expandSchemaPanel}
    info={info}
    schemaPanelRef={schemaPanelRef}
    initialWidth={initialWidth}
    handleSchemaResize={handleSchemaResize}
    leftPanelTab={leftPanelTab}
    setLeftPanelTab={setLeftPanelTab}
    connectionSessionId={connectionSessionId}
    activeSchema={activeSchema}
    handleSchemaSelectionChange={handleSchemaSelectionChange}
    insertIntoActive={insertIntoActive}
    quickSelect={quickSelect}
    workspace={workspace}
    insertQueryFromOutside={insertQueryFromOutside}
    switchSchema={switchSchema}
    setStatusMessage={setStatusMessage}
    onSchemasLoaded={onSchemasLoaded}
    onSchemaLoaded={onSchemaLoaded}
    metadataCache={metadataCache}
    workspaceSessionId={workspaceSessionId}
    activePanel={activePanel}
    openSqlInNewPanel={openSqlInNewPanel}
    handleSavedQuery={handleSavedQuery}
    addQueryTriggerRef={addQueryTriggerRef}
    schemas={schemas}
    executionPreferences={executionPreferences}
    aiAnswerLanguage={aiAnswerLanguage}
    setAiAnswerLanguage={setAiAnswerLanguage}
    runQuery={runQuery}
    runCurrentStatement={runCurrentStatement}
    explainCurrentStatement={explainCurrentStatement}
    cancelQuery={cancelQuery}
    txAvailable={txAvailable}
    txStatus={txStatus}
    toggleTxMode={toggleTxMode}
    endTransaction={endTransaction}
    toggleStatementPanel={toggleStatementPanel}
    toggleHistoryPanel={toggleHistoryPanel}
    saveQueryFile={saveQueryFile}
    historyPanelId={historyPanelId}
    historyEntries={historyEntries}
    historyLoading={historyLoading}
    refreshHistory={refreshHistory}
    selectSqlInActivePanel={selectSqlInActivePanel}
    copyHistoryJson={copyHistoryJson}
    askAiAboutHistory={askAiAboutHistory}
    deleteHistoryEntry={deleteHistoryEntry}
    clearCurrentHistory={clearCurrentHistory}
    setHistoryPanelId={setHistoryPanelId}
    statementAction={statementAction}
    latestResultForSql={latestResultForSql}
    runEditorStatement={runEditorStatement}
    selectEditorStatement={selectEditorStatement}
    openEditorStatementInNewPanel={openEditorStatementInNewPanel}
    copyStatementJson={copyStatementJson}
    askAiAboutStatement={askAiAboutStatement}
    setStatementAction={setStatementAction}
    editorSchema={editorSchema}
    closeResultSheet={closeResultSheet}
    closeResultSheets={closeResultSheets}
    refreshSheet={refreshSheet}
    commitGridChanges={commitGridChanges}
    previewGridChanges={previewGridChanges}
    syncGeneratedSqlFromSheet={syncGeneratedSqlFromSheet}
    queryGeneratedSqlFromSheet={queryGeneratedSqlFromSheet}
  />;
}
