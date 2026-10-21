import { useDatabaseWorkspaceHydration } from "./client/useDatabaseWorkspaceHydration";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { Play, SquareDashedMousePointer, Sparkles, Plus, X, Save, AlertTriangle, Loader2, Bot, ExternalLink, Maximize2, Minimize2, ChevronRight, Files, Database, Crosshair, Pencil } from "lucide-react";
import { dbConnect, dbDisconnect, dbCancel, dbTxRollback, dbClearHistory, dbDeleteHistory, dbUpdateHistoryTabName, selectSaveFilePath, type DbSavedQuery, type DbSqlHistoryEntry } from "../../lib/ipc";
import { SchemaTree, type SchemaTreeSelectedObject } from "./SchemaTree";
import { QueryLibraryPanel } from "./QueryLibraryPanel";
import { SqlEditorPanel, type SqlEditorHandle, type SqlEditorRunContext } from "./SqlEditorPanel";
import { formatSql } from "./formatSql";
import { displaySqlShortcut, loadSqlExecutionPreferences, subscribeSqlExecutionPreferences } from "../../lib/sqlExecutionPreferences";
import { useAppStore } from "../../stores/appStore";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { FT_BUTTON_STYLE, FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../lib/i18n";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { sqlStatementRangesForExecution, type SqlStatementRange } from "../../lib/sqlStatements";
import { createDbMetadataCache } from "../../lib/dbMetadataCache";
import { clampDatabaseTabLimit, readDatabaseTabLimit } from "../../lib/databaseTabLimit";
import { asSqlEngine, selectStatement as dialectSelectStatement } from "../../lib/sqlDialect";
import { type DbClientTabProps, type PanelState, type EditorStatementAction, type ResultSheet, type SqlStatementSourceRef, type ResultSubTab } from "./client/types";
import { newPanel, initialActiveSchema, newResultSheet } from "./client/queryModel";
import { readIntSetting, DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT, createRuntimeDbSessionId, basename, writeTextFile, MAX_PANEL_NAME_LENGTH, QUERY_AUTO_SAVE_MS, widthKey, clampInt } from "./client/persistence";
import { EditorToolbar } from "./client/EditorToolbar";
import { HistoryDropdown } from "./client/HistoryDropdown";
import { StatementDropdown } from "./client/StatementDropdown";
import { ResultArea } from "./client/ResultArea";
import { StatusBar } from "./client/StatusBar";
import { createPersistWorkspaceSnapshot, createAutoSaveWorkspace, createScheduleWorkspaceSave } from "./client/workspacePersistence";
import { createStreamQueryIntoSheet, createRunQuery, createCancelQuery, createRefreshSheet } from "./client/queryExecution";
import { createRefreshHistory, createAppendSqlHistory } from "./client/history";
import { useDatabaseTransactions } from "./client/useDatabaseTransactions";
import { useDatabaseQueryBridge } from "./client/useDatabaseQueryBridge";
import { useDatabaseGridChanges } from "./client/useDatabaseGridChanges";
import { useDatabaseSchema } from "./client/useDatabaseSchema";
import { createQueryPanelActions } from "./client/createQueryPanelActions";
import { createGeneratedSqlActions } from "./client/generatedSqlActions";
import { createStatementActions } from "./client/statementActions";
import { createDatabaseAiActions } from "./client/aiActions";











export default function DbClientTab({
  tabId,
  info,
  visible,
  onDetach,
  chatToggle,
  detachedWindowControls,
}: DbClientTabProps) {
  const t = useT();
  const queryTabMenu = useContextMenu();
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
  const [panelDraftTitle, setPanelDraftTitle] = useState("");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [rowLimit, setRowLimit] = useState(() =>
    readIntSetting(info.engine, "rowLimit", DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT),
  );
  const [tabLimit, setTabLimit] = useState(() => readDatabaseTabLimit(info.engine));
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(() => initialActiveSchema(info));
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const [statementAction, setStatementAction] = useState<EditorStatementAction | null>(null);
  const [aiAnswerLanguage, setAiAnswerLanguage] = useState<AiAnswerLanguage>("inherit");
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  const [historyEntries, setHistoryEntries] = useState<DbSqlHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"schema" | "queries">("schema");
  const addQueryTriggerRef = useRef<(() => void) | null>(null);
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  // Stable "echo target" panel for AI/Claude Code SQL echo (queryRegistry
  // `appendEchoSql`): once chosen it's reused so a whole chat session's SQL
  // accumulates in one editor, instead of scattering across panels.
  const echoPanelIdRef = useRef<string | null>(null);
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  /** Set when the user cancels, so the failing statement is logged as cancelled. */
  const cancelRequestedRef = useRef<Record<string, boolean>>({});
  const panelsRef = useRef<PanelState[]>(panels);
  const tabLimitRef = useRef(tabLimit);
  const activePanelIdRef = useRef(activePanelId);
  const autoSaveInFlightRef = useRef<Promise<void> | null>(null);
  const autoSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRenameCancelRef = useRef(false);
  const lastAutoSavedDocRef = useRef<Record<string, string>>({});
  const savedQueriesRef = useRef<Record<string, DbSavedQuery>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const schemaPanelRef = useRef<PanelImperativeHandle | null>(null);
  const lastVisibleSchemaWidthRef = useRef(24);
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabDbConn = useAppStore((s) => s.setTabDbConn);
  const setTabDbSelectedObjects = useAppStore((s) => s.setTabDbSelectedObjects);
  const { fontSize: dbFontSize } = useDbSessionFontSize(visible, rootRef);
  const dbFontStyle = useMemo(
    () => ({
      "--taomni-db-font-size": `${dbFontSize}px`,
      "--taomni-db-font-size-sm": `${Math.max(10, dbFontSize - 2)}px`,
    }) as CSSProperties,
    [dbFontSize],
  );

  const sessionId = info.sessionId;
  const workspaceSessionId = info.workspaceSessionId ?? info.sessionId;
  const metadataCache = useMemo(
    () =>
      connectionSessionId
        ? createDbMetadataCache({
            sessionId: connectionSessionId,
            defaultCatalog: info.catalog,
          })
        : null,
    [connectionSessionId, info.catalog],
  );

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    tabLimitRef.current = tabLimit;
  }, [tabLimit]);

  useEffect(() => {
    activePanelIdRef.current = activePanelId;
  }, [activePanelId]);

  useEffect(() => {
    if (!metadataCache) return;
    setMetadataVersion((version) => version + 1);
    return metadataCache.subscribe(() => {
      setMetadataVersion((version) => version + 1);
    });
  }, [metadataCache]);

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

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeDbSessionId(sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    setTabDbSelectedObjects(tabId, null);
    void dbConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void dbDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
        // Phase 6 — publish the live connection id so the CC DB MCP (when a
        // chat thread is bound to this tab) can target it each turn.
        setTabDbConn(tabId, runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      // DB-TX-002: roll back uncommitted manual-commit work before closing.
      const tx = txStatusRef.current;
      const pending = tx?.manual ? tx.pending : 0;
      const disconnect = () => dbDisconnect(runtimeSessionId).catch(() => undefined);
      if (pending > 0) {
        void dbTxRollback(runtimeSessionId).catch(() => undefined).then(disconnect);
        setStatusMessage(`Rolled back ${pending} uncommitted statement(s) when the database tab closed.`);
      } else {
        void disconnect();
      }
      setTabDbConn(tabId, null);
      setTabDbSelectedObjects(tabId, null);
      Object.values(timersRef.current).forEach(clearInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const { txStatusRef, refreshTxStatus, txAvailable, txStatus, toggleTxMode, endTransaction } = useDatabaseTransactions({
    setStatusMessage,
    info,
    connectionSessionId,
  });
  useDatabaseWorkspaceHydration({
    setWorkspaceReady,
    workspaceSessionId,
    tabLimitRef,
    savedQueriesRef,
    lastAutoSavedDocRef,
    setPanels,
    setActivePanelId,
    setStatusMessage,
    info,
    rowLimit,
    tabLimit,
  });

  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const updatePanel = useCallback((id: string, updater: (panel: PanelState) => PanelState) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    updatePanel(panelId, (panel) => ({
      ...panel,
      sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, ...patch } : sheet)),
    }));
  }, [updatePanel]);

  const updateSheet = useCallback(
    (panelId: string, sheetId: string, updater: (sheet: ResultSheet) => ResultSheet) => {
      updatePanel(panelId, (panel) => ({
        ...panel,
        sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? updater(sheet) : sheet)),
      }));
    },
    [updatePanel],
  );

  const persistWorkspaceSnapshot = useCallback(
    createPersistWorkspaceSnapshot({
    editorHandles,
    savedQueriesRef,
    lastAutoSavedDocRef,
    workspaceSessionId,
  }),
    [workspaceSessionId],
  );

  const autoSaveWorkspace = useCallback(createAutoSaveWorkspace({
    workspaceReady,
    autoSaveInFlightRef,
    panelsRef,
    persistWorkspaceSnapshot,
    activePanelIdRef,
    setPanels,
    setStatusMessage,
  }), [persistWorkspaceSnapshot, setStatusMessage, workspaceReady]);

  const flushWorkspace = useCallback(async () => {
    await autoSaveWorkspace();
    await autoSaveWorkspace();
  }, [autoSaveWorkspace]);

  const scheduleWorkspaceSave = useCallback(createScheduleWorkspaceSave({
    autoSaveDebounceRef,
    autoSaveWorkspace,
  }), [autoSaveWorkspace]);

  const panelDerivedLabel = useCallback((panel: PanelState) => {
    const index = panelsRef.current.findIndex((candidate) => candidate.id === panel.id);
    return panel.fileName ?? panel.savedQuery?.name ?? `Query ${(index < 0 ? 0 : index) + 1}`;
  }, []);

  const startPanelRename = (panel: PanelState) => {
    panelRenameCancelRef.current = false;
    setActivePanelId(panel.id);
    setPanelDraftTitle(panel.displayName ?? panelDerivedLabel(panel));
    setEditingPanelId(panel.id);
  };

  const cancelPanelRename = () => {
    panelRenameCancelRef.current = true;
    setEditingPanelId(null);
    setPanelDraftTitle("");
  };

  const commitPanelRename = (panelId: string, value?: string) => {
    if (panelRenameCancelRef.current) {
      panelRenameCancelRef.current = false;
      setEditingPanelId(null);
      setPanelDraftTitle("");
      return;
    }
    const draft = value ?? panelDraftTitle;
    setEditingPanelId(null);
    setPanelDraftTitle("");
    const panel = panelsRef.current.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    const normalized = draft.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_PANEL_NAME_LENGTH);
    const nextName = !normalized || normalized === panelDerivedLabel(panel) ? null : normalized;
    const previous = panel.displayName ?? null;
    if (nextName === previous) return;
    patchPanel(panelId, { displayName: nextName });
    setHistoryEntries((prev) =>
      prev.map((entry) =>
        entry.panelId === panelId && entry.savedSessionId === workspaceSessionId
          ? { ...entry, tabName: nextName }
          : entry,
      ),
    );
    scheduleWorkspaceSave();
    void dbUpdateHistoryTabName(workspaceSessionId, panelId, nextName).catch((err) => {
      setStatusMessage(`History tab name update failed: ${String(err)}`);
    });
  };

  useEffect(() => {
    const timer = setInterval(() => {
      void autoSaveWorkspace();
    }, QUERY_AUTO_SAVE_MS);
    return () => {
      clearInterval(timer);
      if (autoSaveDebounceRef.current) {
        clearTimeout(autoSaveDebounceRef.current);
        autoSaveDebounceRef.current = null;
      }
      void flushWorkspace();
    };
  }, [autoSaveWorkspace, flushWorkspace]);

  const anyRunning = panels.some((p) => p.sheets.some((sheet) => sheet.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const streamQueryIntoSheet = useCallback(
    createStreamQueryIntoSheet({
    patchSheet,
    timersRef,
    connectionSessionId,
    updateSheet,
    metadataCache,
    info,
    activeSchema,
  }),
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache, patchSheet, updateSheet],
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
    panelsRef,
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
    panelsRef,
    statementRangesForRun,
    setStatusMessage,
    historyRef,
    setPanels,
    cancelRequestedRef,
    rowLimit,
    tabLimit,
    streamQueryIntoSheet,
    appendSqlHistory,
    txStatusRef,
    refreshTxStatus,
  }),
    [appendSqlHistory, refreshTxStatus, rowLimit, setStatusMessage, statementRangesForRun, streamQueryIntoSheet, tabLimit],
  );
  const { insertQueryFromOutside } = useDatabaseQueryBridge({
    panels,
    tabLimit,
    setPanels,
    setActivePanelId,
    runQuery,
    activePanelId,
    editorHandles,
    patchPanel,
    panelsRef,
    echoPanelIdRef,
    activePanelIdRef,
    info,
    tabId,
    flushWorkspace,
  });

  const cancelQuery = useCallback(createCancelQuery({
    panelsRef,
    cancelRequestedRef,
    setPanels,
    connectionSessionId,
  }), [connectionSessionId]);

  const refreshSheet = useCallback(
    createRefreshSheet({
    panelsRef,
    rowLimit,
    timersRef,
    patchSheet,
    streamQueryIntoSheet,
  }),
    [patchSheet, rowLimit, streamQueryIntoSheet],
  );
  const { commitGridChanges, previewGridChanges } = useDatabaseGridChanges({
    panelsRef,
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
    activePanelId,
    connectionSessionId,
    panels,
    rowLimit,
    setPanels,
    tabLimit,
  });
  const insertIntoActive = useCallback(
    (text: string) => {
      editorHandles.current[activePanelId]?.insertText(text);
    },
    [activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const sql = dialectSelectStatement(
        asSqlEngine(info.engine),
        { catalog: info.catalog, schema: schema ?? activeSchema, name: table },
        [],
        rowLimit,
      );
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, activeSchema, info.catalog, info.engine, rowLimit, runQuery],
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
  const { addPanel, closePanel, closeOtherPanels, closeAllPanels } = createQueryPanelActions({
    panels,
    tabLimit,
    setPanels,
    setActivePanelId,
    connectionSessionId,
    timersRef,
    editorHandles,
    historyRef,
    lastAutoSavedDocRef,
    savedQueriesRef,
    activePanelId,
    persistWorkspaceSnapshot,
    workspaceSessionId,
    setStatusMessage,
    panelsRef,
  });

  const panelSql = (panel: PanelState) => editorHandles.current[panel.id]?.getValue() ?? panel.doc;

  const editorRunPayload = (panel: PanelState, selectionOnly: boolean) => {
    const handle = editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selectionRange = selectionOnly ? handle?.getSelectionRange() ?? null : null;
    const cursorPosition = handle?.getCursorPosition() ?? doc.length;
    return {
      sql: selectionRange ? doc.slice(selectionRange.from, selectionRange.to) : doc,
      context: {
        doc,
        cursorPosition,
        selectionRange,
      } satisfies SqlEditorRunContext,
    };
  };

  const formatPanel = (panel: PanelState) => {
    const handle = editorHandles.current[panel.id];
    const formatted = formatSql(handle?.getValue() ?? panel.doc, info.engine);
    if (handle) {
      handle.setValue(formatted);
    } else {
      patchPanel(panel.id, { doc: formatted, dirty: true });
    }
  };

  const openPanelMenu = (event: ReactMouseEvent, panel: PanelState) => {
    setActivePanelId(panel.id);
    const running = panel.sheets.some((sheet) => sheet.running);
    const sqlText = panelSql(panel);
    const hasEditor = !!editorHandles.current[panel.id];
    const currentStmt = currentEditorStatement(panel.id);
    const items: MenuItem[] = [
      {
        label: t("tabs.rename"),
        icon: <Pencil className="w-3.5 h-3.5" />,
        testId: "db-context-rename-tab",
        onClick: () => startPanelRename(panel),
      },
      { separator: true, label: "" },
      {
        label: t("dbAi.askAiExplainSyntax"),
        icon: <Sparkles className="w-3.5 h-3.5" />,
        testId: "db-context-ai-explain-syntax",
        disabled: !currentStmt,
        onClick: () => {
          if (currentStmt) void askAiAboutStatement(currentStmt);
        },
      },
      {
        label: t("codeWorkspaceAi.answerLanguageMenu"),
        testId: "db-context-ai-answer-language",
        children: AI_ANSWER_LANGUAGES.map((lang) => ({
          label: t(answerLanguageLabelKey(lang)),
          testId: `db-context-ai-answer-language-${lang}`,
          checked: lang === aiAnswerLanguage,
          onClick: () => setAiAnswerLanguage(lang),
        })),
      },
      { separator: true, label: "" },
      {
        label: "Run query",
        icon: <Play className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, false);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !sqlText.trim(),
      },
      {
        label: "Run selection",
        icon: <SquareDashedMousePointer className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, true);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Run current statement",
        icon: <Crosshair className="w-3 h-3" />,
        onClick: () => {
          setActivePanelId(panel.id);
          runCurrentStatement(panel.id);
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Format SQL",
        icon: <Sparkles className="w-3 h-3" />,
        onClick: () => formatPanel(panel),
        disabled: !sqlText.trim(),
      },
      {
        label: "Save query tab",
        icon: <Save className="w-3 h-3" />,
        onClick: () => void saveQueryFile(panel),
      },
      { label: "", separator: true, onClick: () => {} },
      {
        label: "New query tab",
        icon: <Plus className="w-3 h-3" />,
        onClick: addPanel,
        disabled: panels.length >= tabLimit,
      },
      {
        label: "Close",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closePanel(panel.id),
        disabled: panels.length <= 1,
      },
      {
        label: "Close others",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeOtherPanels(panel.id),
        disabled: panels.length <= 1,
      },
      {
        label: "Close all",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeAllPanels(),
      },
    ];
    queryTabMenu.show(event, items);
  };

  const closeResultSheets = (panelId: string, sheetIds: string[]) => {
    if (sheetIds.length === 0) return;
    const idSet = new Set(sheetIds);
    const panel = panels.find((p) => p.id === panelId);
    if (!panel) return;
    const closing = panel.sheets.filter((sheet) => idSet.has(sheet.id));
    if (closing.length === 0) return;
    if (closing.some((sheet) => sheet.running) && connectionSessionId) {
      void dbCancel(connectionSessionId).catch(() => undefined);
    }
    for (const sheet of closing) {
      if (timersRef.current[sheet.id]) {
        clearInterval(timersRef.current[sheet.id]);
        delete timersRef.current[sheet.id];
      }
    }
    setPanels((prev) =>
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
    const panel = panels.find((p) => p.id === panelId);
    const sheet = newResultSheet("", (panel?.sheets.length ?? 0) + 1, rowLimit);
    sheet.title = "Message";
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? {
              ...p,
              sheets: [
                ...p.sheets,
                { ...sheet, running: false, result: null, error: message, resultTab: "messages" as ResultSubTab },
              ].slice(-tabLimit),
              activeSheetId: sheet.id,
            }
          : p,
      ),
    );
  };

  const saveQueryFile = async (panel: PanelState) => {
    const sql = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
    const defaultName = panel.fileName ?? `query-${Date.now()}.sql`;
    const path = await selectSaveFilePath(defaultName, panel.filePath ?? undefined);
    if (!path) return;
    try {
      await writeTextFile(path, sql);
      lastAutoSavedDocRef.current[panel.id] = sql;
      patchPanel(panel.id, {
        filePath: path,
        fileName: basename(path) || defaultName,
        dirty: false,
      });
      const nextPanels = panels.map((candidate) =>
        candidate.id === panel.id
          ? { ...candidate, filePath: path, fileName: basename(path) || defaultName, dirty: false }
          : candidate,
      );
      panelsRef.current = nextPanels;
      await persistWorkspaceSnapshot(nextPanels, activePanelId);
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

  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? panels[0];
  const { syncGeneratedSqlFromSheet, queryGeneratedSqlFromSheet } = createGeneratedSqlActions({
    setPanels,
    panelsRef,
    activePanelIdRef,
    editorHandles,
    setStatusMessage,
    setActivePanelId,
    tabLimit,
    refreshSheet,
  });

  const toggleHistoryPanel = () => {
    const opening = historyPanelId !== activePanel.id;
    setHistoryPanelId(opening ? activePanel.id : null);
    if (opening) setStatementAction(null);
    if (opening) void refreshHistory();
  };

  const selectSqlInActivePanel = (sql: string) => {
    const handle = editorHandles.current[activePanel.id];
    handle?.setValue(sql);
    handle?.selectRange(0, sql.length);
    patchPanel(activePanel.id, { doc: sql, dirty: true });
    setHistoryPanelId(null);
  };

  const openSqlInNewPanel = (
    sql: string,
    run = false,
    origin: SqlStatementSourceRef["origin"] = "history",
    savedQuery: DbSavedQuery | null = null,
  ) => {
    if (panelsRef.current.length >= tabLimit) {
      setStatusMessage(`Maximum query panels reached (${tabLimit}).`);
      return;
    }
    const panel = newPanel({ doc: sql, savedQuery, dirty: !savedQuery });
    if (savedQuery) savedQueriesRef.current[panel.id] = savedQuery;
    setPanels((prev) => {
      const next = [...prev, panel];
      panelsRef.current = next;
      return next;
    });
    setActivePanelId(panel.id);
    setHistoryPanelId(null);
    if (run) {
      setTimeout(() => {
        void runQuery(panel.id, sql, { origin });
      }, 0);
    }
  };

  const handleSavedQuery = (query: DbSavedQuery, created: boolean) => {
    const targetPanelId = created ? activePanel.id : null;
    setPanels((prev) => {
      const next = prev.map((panel) => {
        const matches = panel.id === targetPanelId || panel.savedQuery?.id === query.id;
        if (!matches) return panel;
        savedQueriesRef.current[panel.id] = query;
        if (!created && panel.doc !== query.content) {
          editorHandles.current[panel.id]?.setValue(query.content);
        }
        lastAutoSavedDocRef.current[panel.id] = query.content;
        return {
          ...panel,
          doc: created ? panel.doc : query.content,
          savedQuery: query,
          dirty: false,
        };
      });
      panelsRef.current = next;
      return next;
    });
    scheduleWorkspaceSave();
  };

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );
  const { currentEditorStatement, runCurrentStatement, latestResultForSql, explainCurrentStatement, toggleStatementPanel, copyHistoryJson, runEditorStatement, selectEditorStatement, openEditorStatementInNewPanel, copyStatementJson } = createStatementActions({
    activePanel,
    panels,
    editorHandles,
    info,
    setStatusMessage,
    runQuery,
    statementAction,
    setStatementAction,
    setHistoryPanelId,
    setActivePanelId,
    openSqlInNewPanel,
    panelsRef,
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

  if (!workspaceReady) {
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

  return (
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col relative"
      style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      {queryTabMenu.render}
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
                    quickSelectLimit={rowLimit}
                    onInsertSql={(sql) => insertQueryFromOutside(sql, { destination: "new" })}
                    onNewQuery={addPanel}
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
                  activeContent={editorHandles.current[activePanel.id]?.getValue() ?? activePanel.doc}
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
              {panels.map((p, i) => {
                const panelRunning = p.sheets.some((sheet) => sheet.running);
                const label = p.displayName ?? p.fileName ?? p.savedQuery?.name ?? `Query ${i + 1}`;
                if (editingPanelId === p.id) {
                  return (
                    <input
                      key={p.id}
                      type="text"
                      data-testid="db-query-tab-input"
                      autoFocus
                      value={panelDraftTitle}
                      maxLength={MAX_PANEL_NAME_LENGTH}
                      aria-label={t("tabs.rename")}
                      className="px-2 h-5 w-[160px] rounded text-[11px] outline-none"
                      style={{
                        background: "var(--taomni-selected)",
                        color: "var(--taomni-accent)",
                        border: "1px solid var(--taomni-selected-border)",
                      }}
                      onChange={(event) => setPanelDraftTitle(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitPanelRename(p.id);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelPanelRename();
                        }
                        event.stopPropagation();
                      }}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => commitPanelRename(p.id)}
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
                      background: p.id === activePanelId ? "var(--taomni-selected)" : "transparent",
                      color: p.id === activePanelId ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                    }}
                    onClick={() => setActivePanelId(p.id)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      startPanelRename(p);
                    }}
                    onContextMenu={(event) => openPanelMenu(event, p)}
                    title={p.filePath ?? label}
                  >
                    <span className="truncate">
                      {label}{p.dirty ? "*" : ""}
                    </span>
                    {panelRunning && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {panels.length > 1 && (
                      <X
                        className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          void closePanel(p.id);
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {panels.length < tabLimit && (
                <button
                  type="button"
                  title="New query panel"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                  onClick={addPanel}
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
                  const payload = editorRunPayload(activePanel, false);
                  void runQuery(activePanel.id, payload.sql, { context: payload.context });
                }}
                onRunSelection={() => {
                  const payload = editorRunPayload(activePanel, true);
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
                onFormat={() => formatPanel(activePanel)}
                onToggleStatement={toggleStatementPanel}
                onToggleHistory={toggleHistoryPanel}
                onSave={() => void saveQueryFile(activePanel)}
                onSaveQuery={() => addQueryTriggerRef.current?.()}
                onSchemaChange={(schema) => void switchSchema(schema)}
                rowLimit={rowLimit}
                tabLimit={tabLimit}
                onRowLimitChange={(value) =>
                  setRowLimit(clampInt(value, MIN_ROW_LIMIT, MAX_ROW_LIMIT))
                }
                onTabLimitChange={(value) =>
                  setTabLimit(clampDatabaseTabLimit(value))
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
                    onContextMenu={(event) => openPanelMenu(event, activePanel)}
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
                        editorHandles.current[activePanel.id] = h;
                      }}
                      onDocChange={(doc) => {
                        patchPanel(activePanel.id, { doc, dirty: true });
                        scheduleWorkspaceSave();
                      }}
                      onFocus={() => setActivePanelId(activePanel.id)}
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
                    onSheetSelect={(sheetId) => patchPanel(activePanel.id, { activeSheetId: sheetId, logActive: false })}
                    onShowLog={() => patchPanel(activePanel.id, { logActive: true })}
                    onSheetClose={(sheetId) => closeResultSheet(activePanel.id, sheetId)}
                    onCloseSheets={(sheetIds) => closeResultSheets(activePanel.id, sheetIds)}
                    onTabChange={(sheetId, tab) => patchSheet(activePanel.id, sheetId, { resultTab: tab })}
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
  );
}
