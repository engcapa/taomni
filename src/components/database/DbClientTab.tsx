import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { Play, SquareDashedMousePointer, Sparkles, Plus, X, Save, AlertTriangle, Loader2, Bot, ExternalLink, Maximize2, Minimize2, ChevronRight, Files, Database, Crosshair, Pencil } from "lucide-react";
import { checkFileExists, dbConnect, dbDisconnect, dbExecute, dbCancel, dbTxRollback, dbClearHistory, dbDeleteHistory, dbGetSavedQuery, dbCloseQueryWorkspaceTabs, dbLoadQueryWorkspace, dbRewriteResultSql, dbSaveQueryWorkspace, dbUpdateHistoryTabName, selectSaveFilePath, type DbQueryResult, type DbResultSqlRewriteRequest, type DbSavedQuery, type DbSqlHistoryEntry, type DbTxStatus } from "../../lib/ipc";
import { SchemaTree, type SchemaTreeSelectedObject } from "./SchemaTree";
import { QueryLibraryPanel } from "./QueryLibraryPanel";
import { SqlEditorPanel, type SqlEditorHandle, type SqlEditorRunContext } from "./SqlEditorPanel";
import { type QueryGridCommitPayload, type QueryGeneratedSqlSyncMode } from "./QueryResultGrid";
import { formatSql } from "./formatSql";
import { displaySqlShortcut, loadSqlExecutionPreferences, subscribeSqlExecutionPreferences } from "../../lib/sqlExecutionPreferences";
import { useAppStore } from "../../stores/appStore";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import { useChatStore } from "../../stores/chatStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { FT_BUTTON_STYLE, FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../lib/i18n";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { buildDbAiPrompt, truncateStatement } from "../../lib/database/dbAiPrompts";
import { registerQueryTab } from "../../lib/queryRegistry";
import { alertAppDialog } from "../../lib/appDialogs";
import { explainSqlFor } from "../../lib/sqlExplain";
import { gridChangePreview, type GridChangePreview } from "../../lib/dbGridChanges";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { splitSqlStatementRanges, sqlStatementRangesForExecution, type SqlStatementRange } from "../../lib/sqlStatements";
import { writeText } from "../../lib/clipboard";
import { createDbMetadataCache } from "../../lib/dbMetadataCache";
import { sqlNamespaceFromMetadata } from "../../lib/sqlMetadataCompletions";
import { clampDatabaseTabLimit, readDatabaseTabLimit, writeDatabaseTabLimit } from "../../lib/databaseTabLimit";
import { asSqlEngine, selectStatement as dialectSelectStatement } from "../../lib/sqlDialect";
import { type DbClientTabProps, type PanelState, type EditorStatementAction, type ResultSheet, type SqlStatementSourceRef, type ResultSubTab } from "./client/types";
import { newPanel, initialActiveSchema, supportsManualCommit, workspaceTabFromPanel, newResultSheet, engineUsesDatabaseAsSchema, schemaSwitchSql, hashSqlText, replacementEndWithExistingTerminator, resultToJsonText } from "./client/queryModel";
import { readIntSetting, DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT, createRuntimeDbSessionId, basename, readLegacyWorkspaceCache, readTextFile, writeIntSetting, writeTextFile, MAX_PANEL_NAME_LENGTH, QUERY_AUTO_SAVE_MS, widthKey, clampInt } from "./client/persistence";
import { EditorToolbar } from "./client/EditorToolbar";
import { HistoryDropdown } from "./client/HistoryDropdown";
import { StatementDropdown } from "./client/StatementDropdown";
import { ResultArea } from "./client/ResultArea";
import { StatusBar } from "./client/StatusBar";
import { createApplyTxStatus, createRefreshTxStatus, createToggleTxMode, createEndTransaction, createPrepareGridChanges, createCommitGridChanges } from "./client/transactionActions";
import { createPersistWorkspaceSnapshot, createAutoSaveWorkspace, createScheduleWorkspaceSave } from "./client/workspacePersistence";
import { createStreamQueryIntoSheet, createRunQuery, createCancelQuery, createRefreshSheet } from "./client/queryExecution";
import { createRefreshHistory, createAppendSqlHistory } from "./client/history";



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

  const [txStatus, setTxStatus] = useState<DbTxStatus | null>(null);
  const txStatusRef = useRef<DbTxStatus | null>(null);
  const applyTxStatus = useCallback(createApplyTxStatus({
    txStatusRef,
    setTxStatus,
    setStatusMessage,
  }), [setStatusMessage]);
  const txAvailable = supportsManualCommit(info.engine);

  const refreshTxStatus = useCallback(createRefreshTxStatus({
    connectionSessionId,
    txAvailable,
    applyTxStatus,
  }), [applyTxStatus, connectionSessionId, txAvailable]);

  useEffect(() => {
    applyTxStatus(null);
    void refreshTxStatus();
  }, [applyTxStatus, refreshTxStatus]);

  const toggleTxMode = useCallback(createToggleTxMode({
    txStatusRef,
    connectionSessionId,
    applyTxStatus,
    setStatusMessage,
  }), [applyTxStatus, connectionSessionId, setStatusMessage]);

  const endTransaction = useCallback(
    createEndTransaction({
    connectionSessionId,
    txStatusRef,
    applyTxStatus,
    setStatusMessage,
  }),
    [applyTxStatus, connectionSessionId, setStatusMessage],
  );

  useEffect(() => {
    let cancelled = false;
    setWorkspaceReady(false);
    void (async () => {
      const workspace = await dbLoadQueryWorkspace(workspaceSessionId);
      if (cancelled) return;
      if (workspace) {
        if (workspace.tabs.length === 0) {
          setWorkspaceReady(true);
          return;
        }
        const restored = await Promise.all(
          workspace.tabs.slice(0, tabLimitRef.current).map(async (entry) => {
            const savedQuery = entry.savedQueryId
              ? await dbGetSavedQuery(entry.savedQueryId).catch(() => null)
              : null;
            if (savedQuery) savedQueriesRef.current[entry.panelId] = savedQuery;
            return newPanel({
              id: entry.panelId,
              doc: entry.content,
              filePath: entry.filePath ?? null,
              fileName: entry.fileName ?? (entry.filePath ? basename(entry.filePath) : null),
              savedQuery,
              displayName: entry.displayName ?? null,
              dirty: entry.dirty,
              createdAt: entry.createdAt,
            });
          }),
        );
        lastAutoSavedDocRef.current = Object.fromEntries(
          restored.map((panel) => [panel.id, panel.doc]),
        );
        setPanels(restored);
        setActivePanelId(
          workspace.activePanelId && restored.some((panel) => panel.id === workspace.activePanelId)
            ? workspace.activePanelId
            : restored[0].id,
        );
        setWorkspaceReady(true);
        return;
      }

      const cache = readLegacyWorkspaceCache(workspaceSessionId);
      if (!cache || cache.panels.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const restored: PanelState[] = [];
      const restoredDocs: Record<string, string> = {};
      for (const [index, entry] of cache.panels.entries()) {
        const path = entry.filePath ?? entry.cachePath;
        if (!path) continue;
        const exists = await checkFileExists(path).catch(() => false);
        if (!exists) continue;
        const doc = await readTextFile(path).catch(() => null);
        if (doc === null) continue;
        restoredDocs[entry.id] = doc;
        restored.push(
          newPanel({
            id: entry.id,
            doc,
            filePath: entry.filePath,
            fileName: entry.filePath ? basename(entry.filePath) : entry.fileName,
            dirty: !entry.filePath,
            createdAt: Date.now() + index,
          }),
        );
        if (restored.length >= tabLimitRef.current) break;
        if (index >= tabLimitRef.current - 1) break;
      }
      if (cancelled) return;
      if (restored.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const activePanelId =
        cache.activePanelId && restored.some((panel) => panel.id === cache.activePanelId)
          ? cache.activePanelId
          : restored[0].id;
      const importedAt = Date.now();
      await dbSaveQueryWorkspace({
        workspaceId: workspaceSessionId,
        activePanelId,
        tabs: restored.map((panel, index) =>
          workspaceTabFromPanel(
            workspaceSessionId,
            panel,
            index,
            panel.doc,
            importedAt,
          ),
        ),
        updatedAt: importedAt,
      });
      if (cancelled) return;
      lastAutoSavedDocRef.current = restoredDocs;
      setPanels(restored);
      setActivePanelId(activePanelId);
      setWorkspaceReady(true);
    })().catch((err) => {
      if (!cancelled) {
        setStatusMessage(`Query workspace restore failed: ${String(err)}`);
        setWorkspaceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, workspaceSessionId]);

  useEffect(() => {
    writeIntSetting(info.engine, "rowLimit", rowLimit);
  }, [info.engine, rowLimit]);

  useEffect(() => {
    writeDatabaseTabLimit(info.engine, tabLimit);
  }, [info.engine, tabLimit]);

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

  const insertQueryFromOutside = useCallback(
    (
      sql: string,
      options?: {
        run?: boolean;
        destination?: "current" | "new";
        position?: "caret" | "first" | "last" | "replaceAll";
      },
    ) => {
      const text = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!text.trim()) return;
      if (options?.destination === "new" && panels.length < tabLimit) {
        const panel = newPanel({ doc: text, dirty: true });
        setPanels((prev) => [...prev, panel]);
        setActivePanelId(panel.id);
        if (options.run) {
          void runQuery(panel.id, text);
        }
        return;
      }
      const panelId = activePanelId;
      const editor = editorHandles.current[panelId];
      const current = editor?.getValue() ?? panels.find((p) => p.id === panelId)?.doc ?? "";
      const position = options?.position ?? "replaceAll";
      const next =
        position === "first"
          ? `${text}${current ? `\n${current}` : ""}`
          : position === "last"
            ? `${current}${current ? "\n" : ""}${text}`
            : position === "caret"
              ? null
              : text;
      if (next === null) {
        editor?.insertText(text);
        patchPanel(panelId, { doc: editor?.getValue() ?? `${current}${text}`, dirty: true });
      } else {
        editor?.setValue(next);
        patchPanel(panelId, { doc: next, dirty: true });
      }
      if (options?.run) {
        void runQuery(panelId, next ?? text);
      }
    },
    [activePanelId, panels, patchPanel, runQuery, tabLimit],
  );

  // Append a statement echoed from an AI/Claude Code SQL execution to a stable
  // "echo target" panel — never runs it. The whole chat session's SQL
  // accumulates in one editor (reusing the remembered panel, else the active
  // panel, else a fresh one when the tab has none).
  const appendEchoSqlFromOutside = useCallback((sql: string, note?: string) => {
    const cleaned = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!cleaned) return;
    // Each statement ends with exactly one semicolon; prepend the comment note.
    const stmt = `${cleaned.replace(/;+\s*$/, "")};`;
    const block = note ? `${note}\n${stmt}` : stmt;

    const livePanels = panelsRef.current;
    const remembered =
      echoPanelIdRef.current && livePanels.some((p) => p.id === echoPanelIdRef.current)
        ? echoPanelIdRef.current
        : null;
    const activeId = activePanelIdRef.current;
    const targetId =
      remembered ??
      (livePanels.some((p) => p.id === activeId) ? activeId : livePanels[0]?.id ?? null);

    if (!targetId) {
      // Tab has no panel yet → open one seeded with the statement.
      const panel = newPanel({ doc: block, dirty: true });
      echoPanelIdRef.current = panel.id;
      setPanels((prev) => {
        const next = [...prev, panel].slice(-tabLimit);
        panelsRef.current = next;
        return next;
      });
      setActivePanelId(panel.id);
      return;
    }

    echoPanelIdRef.current = targetId;
    const editor = editorHandles.current[targetId];
    const current = editor?.getValue() ?? livePanels.find((p) => p.id === targetId)?.doc ?? "";
    const joined = current.trim() ? `${current.replace(/\n+$/, "")}\n\n${block}` : block;
    // `editor` is only live for the mounted (active) panel; for others the doc
    // patch is enough — the editor picks it up when that panel mounts.
    editor?.setValue(joined);
    panelsRef.current = livePanels.map((p) =>
      p.id === targetId ? { ...p, doc: joined, dirty: true } : p
    );
    patchPanel(targetId, { doc: joined, dirty: true });
    setActivePanelId(targetId);
    editor?.focus();
  }, [patchPanel, tabLimit]);

  const queryRegistryTitle = useMemo(() => {
    const database = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    return `${info.engine} ${info.host}:${info.port}${database ? `/${database}` : ""}`;
  }, [info.catalog, info.database, info.engine, info.host, info.port]);

  useEffect(() => {
    return registerQueryTab({
      tabId,
      title: queryRegistryTitle,
      engine: info.engine,
      insertQuery: insertQueryFromOutside,
      appendEchoSql: appendEchoSqlFromOutside,
      flushWorkspace,
    });
  }, [appendEchoSqlFromOutside, flushWorkspace, info.engine, insertQueryFromOutside, queryRegistryTitle, tabId]);

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

  /** Generate the DML for grid edits so it can be previewed, then executed. */
  const prepareGridChanges = useCallback(
    createPrepareGridChanges({
    panelsRef,
    activeSchema,
    info,
    connectionSessionId,
    metadataCache,
  }),
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache],
  );

  const previewGridChanges = useCallback(
    async (panelId: string, sheetId: string, payload: QueryGridCommitPayload): Promise<GridChangePreview> =>
      gridChangePreview(await prepareGridChanges(panelId, sheetId, payload)),
    [prepareGridChanges],
  );

  const commitGridChanges = useCallback(
    createCommitGridChanges({
    prepareGridChanges,
    connectionSessionId,
    txStatusRef,
    refreshTxStatus,
    setStatusMessage,
    refreshSheet,
  }),
    [connectionSessionId, prepareGridChanges, refreshSheet, refreshTxStatus, setStatusMessage],
  );

  const onSchemaLoaded = useCallback((tables: Map<string, string[]>) => {
    setSchemaMap((prev) => {
      const next = { ...prev };
      for (const [name, cols] of tables) {
        if (!next[name] || cols.length > 0) next[name] = cols;
      }
      return next;
    });
  }, []);

  const onSchemasLoaded = useCallback((names: string[]) => {
    setSchemas(names);
    setActiveSchema((current) => {
      if (current && names.includes(current)) return current;
      if (engineUsesDatabaseAsSchema(info.engine) && info.database && names.includes(info.database)) return info.database;
      return names[0] ?? null;
    });
  }, [info.database, info.engine]);

  useEffect(() => {
    if (!metadataCache) return;
    let cancelled = false;
    void metadataCache
      .listSchemas(info.catalog)
      .then((names) => {
        if (!cancelled) onSchemasLoaded(names);
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Schema metadata failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [info.catalog, metadataCache, onSchemasLoaded, setStatusMessage]);

  const metadataSchema = useMemo(
    () =>
      metadataCache
        ? sqlNamespaceFromMetadata({
            cache: metadataCache,
            engine: info.engine,
            activeSchema,
            catalog: info.catalog,
          })
        : undefined,
    [activeSchema, info.catalog, info.engine, metadataCache, metadataVersion],
  );

  const editorSchema = metadataSchema ?? (Object.keys(schemaMap).length > 0 ? schemaMap : undefined);

  const switchSchema = useCallback(
    async (schema: string) => {
      if (!schema || schema === activeSchema) return;
      if (info.engine === "SQLServer") {
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
        return;
      }
      const panelId = activePanelId;
      const sql = schemaSwitchSql(info.engine, schema, info.catalog);
      try {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecute(connectionSessionId, sql);
        // Update UI active schema (toolbar dropdown + tree highlight) without
        // dumping a success result sheet on every click.
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
      } catch (err) {
        const panel = panels.find((p) => p.id === panelId);
        const sheet = newResultSheet(sql, (panel?.sheets.length ?? 0) + 1, rowLimit);
        sheet.title = "Schema";
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  sheets: [
                    ...p.sheets,
                    {
                      ...sheet,
                      result: null,
                      running: false,
                      error: String(err),
                      warnings: [],
                      resultTab: "messages" as ResultSubTab,
                    },
                  ].slice(-tabLimit),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
        setStatusMessage(`Schema switch failed: ${String(err)}`);
      }
    },
    [activePanelId, activeSchema, connectionSessionId, info.catalog, info.engine, panels, rowLimit, tabLimit],
  );
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

  const addPanel = () => {
    if (panels.length >= tabLimit) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const cleanupClosedPanels = (closingPanels: PanelState[]) => {
    if (closingPanels.some((panel) => panel.sheets.some((sheet) => sheet.running))) {
      if (connectionSessionId) {
        void dbCancel(connectionSessionId).catch(() => undefined);
      }
    }
    closingPanels.forEach((panel) => {
      panel.sheets.forEach((sheet) => {
        if (timersRef.current[sheet.id]) {
          clearInterval(timersRef.current[sheet.id]);
          delete timersRef.current[sheet.id];
        }
      });
      delete editorHandles.current[panel.id];
      delete historyRef.current[panel.id];
      delete lastAutoSavedDocRef.current[panel.id];
      delete savedQueriesRef.current[panel.id];
    });
  };

  const closePanel = async (id: string) => {
    if (panels.length <= 1) return;
    const closing = panels.find((p) => p.id === id);
    if (!closing) return;
    const next = panels.filter((p) => p.id !== id);
    const nextActivePanelId = activePanelId === id ? next[0].id : activePanelId;
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(workspaceSessionId, [id], Date.now());
    } catch (err) {
      setStatusMessage(`Query tab close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels([closing]);
    panelsRef.current = next;
    setPanels(next);
    if (activePanelId === id) setActivePanelId(nextActivePanelId);
    void persistWorkspaceSnapshot(next, nextActivePanelId).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeOtherPanels = async (id: string) => {
    const target = panels.find((p) => p.id === id);
    if (!target || panels.length <= 1) return;
    const closing = panels.filter((p) => p.id !== id);
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        closing.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(closing);
    panelsRef.current = [target];
    setPanels([target]);
    setActivePanelId(id);
    void persistWorkspaceSnapshot([target], id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeAllPanels = async () => {
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        panels.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(panels);
    const p = newPanel();
    panelsRef.current = [p];
    setPanels([p]);
    setActivePanelId(p.id);
    void persistWorkspaceSnapshot([p], p.id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

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

  const setPanelDocState = (panelId: string, doc: string) => {
    setPanels((prev) => {
      const next = prev.map((panel) => (panel.id === panelId ? { ...panel, doc, dirty: true } : panel));
      panelsRef.current = next;
      return next;
    });
  };

  const writePanelDocument = (panelId: string, doc: string) => {
    const editor = activePanelIdRef.current === panelId ? editorHandles.current[panelId] : null;
    editor?.setValue(doc);
    setPanelDocState(panelId, doc);
  };

  const syncGeneratedSqlPanel = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    status: string | null = "Synced generated SQL to query editor.",
    options: { activate?: boolean } = {},
  ): string | null => {
    const activate = options.activate ?? true;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    if (!resultPanel || !sheet) {
      setStatusMessage("Result sheet is no longer available.");
      return null;
    }

    const existingTargetId =
      sheet.generatedTargetPanelId && livePanels.some((panel) => panel.id === sheet.generatedTargetPanelId)
        ? sheet.generatedTargetPanelId
        : null;
    if (existingTargetId) {
      writePanelDocument(existingTargetId, generatedSql);
      if (activate) setActivePanelId(existingTargetId);
      if (status) setStatusMessage(status);
      return existingTargetId;
    }

    if (livePanels.length >= tabLimit) {
      setStatusMessage(`Maximum query panels reached (${tabLimit}).`);
      return null;
    }

    const targetPanel = newPanel({ doc: generatedSql, dirty: true, fileName: "Generated SQL" });
    setPanels((prev) => {
      const next = [
        ...prev.map((panel) =>
          panel.id === resultPanelId
            ? {
                ...panel,
                sheets: panel.sheets.map((candidate) =>
                  candidate.id === sheetId
                    ? { ...candidate, generatedTargetPanelId: targetPanel.id }
                    : candidate,
                ),
              }
            : panel,
        ),
        targetPanel,
      ];
      panelsRef.current = next;
      return next;
    });
    if (activate) setActivePanelId(targetPanel.id);
    if (status) setStatusMessage(status);
    return targetPanel.id;
  };

  const replaceGeneratedSqlSource = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    options: {
      activate?: boolean;
      focus?: boolean;
      status?: string | null;
      fallback?: boolean;
      updateSheetSql?: boolean;
    } = {},
  ): boolean => {
    const activate = options.activate ?? true;
    const focus = options.focus ?? true;
    const status = options.status ?? "Replaced source SQL with generated SQL.";
    const fallbackEnabled = options.fallback ?? true;
    const updateSheetSql = options.updateSheetSql ?? false;
    const fallback = () =>
      fallbackEnabled
        ? syncGeneratedSqlPanel(
            resultPanelId,
            sheetId,
            generatedSql,
            "Source SQL changed; synced generated SQL to a query editor instead.",
          )
        : null;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    const sourceRef = sheet?.sourceRef;
    if (!sheet || !sourceRef || sourceRef.origin !== "editor" || sourceRef.from === null || sourceRef.to === null) {
      fallback();
      return false;
    }

    const sourcePanel = livePanels.find((panel) => panel.id === sourceRef.panelId);
    if (!sourcePanel) {
      fallback();
      return false;
    }

    const from = sourceRef.from;
    const to = sourceRef.to;
    const editor = activePanelIdRef.current === sourcePanel.id ? editorHandles.current[sourcePanel.id] : null;
    const sourceDoc = editor?.getValue() ?? sourcePanel.doc;
    if (from < 0 || to < from || to > sourceDoc.length) {
      fallback();
      return false;
    }

    const currentSql = sourceDoc.slice(from, to);
    if (currentSql !== sourceRef.sql || hashSqlText(currentSql) !== sourceRef.exactHash) {
      fallback();
      return false;
    }

    const replaceTo = replacementEndWithExistingTerminator(sourceDoc, to, generatedSql);
    const nextDoc = `${sourceDoc.slice(0, from)}${generatedSql}${sourceDoc.slice(replaceTo)}`;
    const delta = generatedSql.length - (replaceTo - from);
    editor?.replaceRange(from, replaceTo, generatedSql, { focus });
    const nextPanels = livePanels.map((panel) => {
      const patchedPanel =
        panel.id === sourcePanel.id ? { ...panel, doc: nextDoc, dirty: true } : panel;
      const sheets = patchedPanel.sheets.map((candidate) => {
        const candidateRef = candidate.sourceRef;
        let nextRef = candidateRef;
        if (
          candidateRef &&
          candidateRef.panelId === sourcePanel.id &&
          candidateRef.from !== null &&
          candidateRef.to !== null
        ) {
          if (candidateRef.id === sourceRef.id) {
            nextRef = {
              ...candidateRef,
              sql: generatedSql,
              to: from + generatedSql.length,
              exactHash: hashSqlText(generatedSql),
              parentSheetId: sheetId,
            };
          } else if (candidateRef.from >= replaceTo) {
            nextRef = {
              ...candidateRef,
              from: candidateRef.from + delta,
              to: candidateRef.to + delta,
            };
          }
        }
        return {
          ...candidate,
          baseSql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.baseSql,
          sql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.sql,
          sourceRef: nextRef,
        };
      });
      return { ...patchedPanel, sheets };
    });
    panelsRef.current = nextPanels;
    setPanels(nextPanels);
    if (activate) setActivePanelId(sourcePanel.id);
    if (status) setStatusMessage(status);
    return true;
  };

  const queryGeneratedSqlFromSheet = async (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    rewriteRequest?: DbResultSqlRewriteRequest,
  ) => {
    let sql = generatedSql;
    if (rewriteRequest) {
      try {
        const rewritten = await dbRewriteResultSql(rewriteRequest);
        if (rewritten.mode !== "inline" || !rewritten.sql) {
          setStatusMessage(rewritten.reason ?? "SQL rewrite is not available for this result.");
          return;
        }
        sql = rewritten.sql;
      } catch (err) {
        setStatusMessage(`SQL rewrite failed: ${String(err)}`);
        return;
      }
    }

    const replaced = replaceGeneratedSqlSource(resultPanelId, sheetId, sql, {
      activate: false,
      focus: false,
      status: null,
      updateSheetSql: true,
    });
    if (!replaced) return;
    setStatusMessage("Applied result filters to SQL; refreshing result.");
    await refreshSheet(resultPanelId, sheetId, "clearView", sql);
  };

  const syncGeneratedSqlFromSheet = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    mode: QueryGeneratedSqlSyncMode,
  ) => {
    if (mode === "replaceSource") {
      replaceGeneratedSqlSource(resultPanelId, sheetId, generatedSql, { updateSheetSql: true });
      return;
    }
    syncGeneratedSqlPanel(resultPanelId, sheetId, generatedSql);
  };

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

  const currentEditorStatement = (panelId: string = activePanel.id): EditorStatementAction | null => {
    const panel = panels.find((p) => p.id === panelId) ?? activePanel;
    const handle = editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selection = handle?.getSelectionRange() ?? null;
    const position = selection && selection.from !== selection.to
      ? selection.from
      : handle?.getCursorPosition() ?? doc.length;
    const ranges = splitSqlStatementRanges(doc, { splitGo: info.engine === "SQLServer" });
    const range =
      ranges.find((candidate) => candidate.from <= position && position <= candidate.to) ??
      (ranges.length === 1 ? ranges[0] : null);
    if (!range) {
      setStatusMessage("No SQL statement at the current cursor.");
      return null;
    }
    return { panelId: panel.id, doc, range };
  };

  const explainCurrentStatement = async (panelId: string = activePanel.id) => {
    const action = currentEditorStatement(panelId);
    if (!action) return;
    const plan = explainSqlFor(info.engine, action.range.sql);
    if (!plan.ok) {
      setStatusMessage(plan.reason);
      await alertAppDialog({ title: "Explain not available", message: plan.reason });
      return;
    }
    await runQuery(action.panelId, plan.sql, { sheetTitle: "Explain" });
  };

  const toggleStatementPanel = () => {
    if (statementAction?.panelId === activePanel.id) {
      setStatementAction(null);
      return;
    }
    const action = currentEditorStatement();
    if (!action) return;
    setHistoryPanelId(null);
    setStatementAction(action);
  };

  const runEditorStatement = (action: EditorStatementAction) => {
    void runQuery(action.panelId, action.range.sql, {
      context: {
        doc: action.doc,
        cursorPosition: action.range.from,
        selectionRange: { from: action.range.from, to: action.range.to },
      },
    });
    setStatementAction(null);
  };

  const runCurrentStatement = (panelId: string = activePanel.id) => {
    const action = currentEditorStatement(panelId);
    if (!action) return;
    runEditorStatement(action);
  };

  const selectEditorStatement = (action: EditorStatementAction) => {
    setActivePanelId(action.panelId);
    editorHandles.current[action.panelId]?.selectRange(action.range.from, action.range.to);
    setStatementAction(null);
  };

  const openEditorStatementInNewPanel = (action: EditorStatementAction) => {
    openSqlInNewPanel(action.range.sql, true, "editor");
    setStatementAction(null);
  };

  const latestResultForSql = (sql: string): DbQueryResult | null => {
    const target = sql.trim();
    for (const panel of [...panelsRef.current].reverse()) {
      for (const sheet of [...panel.sheets].reverse()) {
        if (sheet.sql.trim() === target && sheet.result && sheet.result.columns.length > 0) {
          return sheet.result;
        }
      }
    }
    return null;
  };

  const copyHistoryJson = async (entry: DbSqlHistoryEntry) => {
    const result = latestResultForSql(entry.sqlContent);
    if (!result) {
      setStatusMessage("No in-memory result is available for this SQL. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied query result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };

  const copyStatementJson = async (action: EditorStatementAction) => {
    const result = latestResultForSql(action.range.sql);
    if (!result) {
      setStatusMessage("No in-memory result is available for this statement. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied statement result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };

  /** Row/column shape of an in-memory result, for the prompt's context block. */
  const resultShape = (result: DbQueryResult | null): string | null => (
    result ? `${result.rows.length} row(s), ${result.columns.length} column(s)` : null
  );

  /**
   * Hand a built prompt to the tab's chat thread and report what happened. The
   * queue can refuse when it is full, and silently dropping the prompt would
   * look like the button did nothing.
   */
  const sendDbAiPrompt = async (prompt: string) => {
    await useChatStore.getState().openTabChat(tabId);
    // A complete prompt, not a quoted selection — attachToComposer's blockquote
    // prefix would fold the instructions and the SQL fence together.
    const outcome = await useChatStore.getState().sendPromptToTabChat(prompt);
    if (outcome.status === "rejected") {
      setStatusMessage(t("dbAi.queueFull", { limit: outcome.limit }));
    } else if (outcome.status === "queued") {
      setStatusMessage(t("dbAi.queued", { position: outcome.position }));
    } else {
      setStatusMessage(t("dbAi.sent"));
    }
  };

  const askAiAboutHistory = async (entry: DbSqlHistoryEntry) => {
    const { text, truncated } = truncateStatement(entry.sqlContent);
    const prompt = buildDbAiPrompt(
      {
        action: "explain",
        dialect: "sql",
        engine: entry.engine,
        statement: text,
        truncated,
        database: entry.databaseName,
        schema: entry.schemaName,
        durationMs: entry.durationMs,
        rowCount: entry.rowCount,
        error: entry.error,
        resultSummary: resultShape(latestResultForSql(entry.sqlContent)),
      },
      aiAnswerLanguage,
    );
    await sendDbAiPrompt(prompt);
    setHistoryPanelId(null);
  };

  const askAiAboutStatement = async (action: EditorStatementAction) => {
    const { text, truncated } = truncateStatement(action.range.sql);
    const prompt = buildDbAiPrompt(
      {
        action: "explain",
        dialect: "sql",
        engine: info.engine,
        statement: text,
        truncated,
        database: info.database,
        schema: activeSchema,
        resultSummary: resultShape(latestResultForSql(action.range.sql)),
      },
      aiAnswerLanguage,
    );
    await sendDbAiPrompt(prompt);
    setStatementAction(null);
  };

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
