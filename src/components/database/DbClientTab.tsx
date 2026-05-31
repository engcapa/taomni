import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Play,
  SquareDashedMousePointer,
  Ban,
  Sparkles,
  Clock,
  Plus,
  X,
  Download,
  Save,
  AlertTriangle,
  Loader2,
  Bot,
  ExternalLink,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { DbConnectInfo } from "../../types";
import {
  dbConnect,
  dbDisconnect,
  dbExecute,
  dbExecuteStream,
  dbCancel,
  selectSaveFilePath,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
  type DbQueryResult,
} from "../../lib/ipc";
import { SchemaTree } from "./SchemaTree";
import { SqlEditorPanel, type SqlEditorHandle } from "./SqlEditorPanel";
import { QueryResultGrid } from "./QueryResultGrid";
import { formatSql } from "./formatSql";
import { useAppStore } from "../../stores/appStore";
import FloatingToolbar from "../floating-toolbar/FloatingToolbar";
import CaptureToolbar from "../capture/CaptureToolbar";
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { captureElementPng, renderElementToCanvas, safeFilePart } from "../../lib/capture";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { registerQueryTab } from "../../lib/queryRegistry";

interface DbClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
  onDetach?: () => void;
  onToggleMaximize?: () => void;
  maximized?: boolean;
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

const MAX_HISTORY = 200;
const MAX_PANELS = 4;
const DEFAULT_MAX_RESULT_SHEETS = 50;
const MIN_RESULT_SHEETS = 1;
const MAX_RESULT_SHEETS_LIMIT = 200;
const DEFAULT_ROW_LIMIT = 1000;
const MIN_ROW_LIMIT = 1;
const MAX_ROW_LIMIT = 1_000_000;

type ResultSubTab = "results" | "messages";

interface ResultSheet {
  id: string;
  title: string;
  sql: string;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  rowLimit: number;
  createdAt: number;
}

interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
  filePath: string | null;
  fileName: string | null;
  dirty: boolean;
}

function widthKey(engine: string): string {
  return `newmob.db.schemaWidth.${engine}`;
}

function settingKey(engine: string, name: string): string {
  return `newmob.db.${engine}.${name}`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readIntSetting(engine: string, name: string, fallback: number, min: number, max: number): number {
  try {
    const raw = Number(localStorage.getItem(settingKey(engine, name)));
    return Number.isFinite(raw) ? clampInt(raw, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function writeIntSetting(engine: string, name: string, value: number): void {
  try {
    localStorage.setItem(settingKey(engine, name), String(value));
  } catch {
    /* ignore */
  }
}

function quoteIdent(engine: string, ident: string): string {
  if (engine === "PostgreSQL") return `"${ident.replace(/"/g, "\"\"")}"`;
  return `\`${ident.replace(/`/g, "``")}\``;
}

function qualifiedName(engine: string, schema: string | null, table: string): string {
  return schema
    ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`
    : quoteIdent(engine, table);
}

function schemaSwitchSql(engine: string, schema: string): string {
  if (engine === "PostgreSQL") {
    return `SET search_path TO ${quoteIdent(engine, schema)}`;
  }
  return `USE ${quoteIdent(engine, schema)}`;
}

function newPanel(): PanelState {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random()}`,
    doc: "",
    sheets: [],
    activeSheetId: null,
    filePath: null,
    fileName: null,
    dirty: false,
  };
}

function newResultSheet(sql: string, ordinal: number, rowLimit: number): ResultSheet {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `sheet-${Date.now()}-${Math.random()}`,
    title: `Result ${ordinal}`,
    sql,
    result: emptyQueryResult(),
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    rowLimit,
    createdAt: Date.now(),
  };
}

function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((sheet) => sheet.id === panel.activeSheetId) ?? panel.sheets.at(-1) ?? null;
}

function emptyQueryResult(): DbQueryResult {
  return {
    columns: [],
    rows: [],
    rowsAffected: 0,
    durationMs: 0,
    warnings: [],
  };
}

export default function DbClientTab({
  tabId,
  info,
  visible,
  onDetach,
  onToggleMaximize,
  maximized,
  chatToggle,
  detachedWindowControls,
}: DbClientTabProps) {
  const t = useT();
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [rowLimit, setRowLimit] = useState(() =>
    readIntSetting(info.engine, "rowLimit", DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT),
  );
  const [maxResultSheets, setMaxResultSheets] = useState(() =>
    readIntSetting(
      info.engine,
      "maxResultSheets",
      DEFAULT_MAX_RESULT_SHEETS,
      MIN_RESULT_SHEETS,
      MAX_RESULT_SHEETS_LIMIT,
    ),
  );
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(info.database ?? null);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  const sessionId = info.sessionId;

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let cancelled = false;
    void dbConnect(info)
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(sessionId).catch(() => undefined);
      Object.values(timersRef.current).forEach(clearInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    writeIntSetting(info.engine, "rowLimit", rowLimit);
  }, [info.engine, rowLimit]);

  useEffect(() => {
    writeIntSetting(info.engine, "maxResultSheets", maxResultSheets);
  }, [info.engine, maxResultSheets]);

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

  const anyRunning = panels.some((p) => p.sheets.some((sheet) => sheet.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const runQuery = useCallback(
    async (panelId: string, sqlText: string) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      const panel = panels.find((p) => p.id === panelId);
      if (panel?.sheets.some((sheet) => sheet.running)) return;
      // Record history (newest first, dedup consecutive).
      const panelHistory = historyRef.current[panelId] ?? [];
      if (panelHistory[0] !== trimmed) {
        historyRef.current[panelId] = [trimmed, ...panelHistory].slice(0, MAX_HISTORY);
      }
      const sheet = newResultSheet(trimmed, (panel?.sheets.length ?? 0) + 1, rowLimit);
      setPanels((prev) =>
        prev.map((p) => {
          if (p.id !== panelId) return p;
          const sheets = [...p.sheets, sheet].slice(-maxResultSheets);
          return {
            ...p,
            sheets,
            activeSheetId: sheet.id,
          };
        }),
      );
      const started = Date.now();
      const timer = setInterval(() => {
        patchSheet(panelId, sheet.id, { elapsedMs: Date.now() - started });
      }, 100);
      timersRef.current[sheet.id] = timer;
      let sawDone = false;
      try {
        await dbExecuteStream(sessionId, trimmed, rowLimit, (event) => {
          if (event.kind === "columns") {
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              return { ...current, result: { ...result, columns: event.columns } };
            });
          } else if (event.kind === "rows") {
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              const remaining = Math.max(0, current.rowLimit - result.rows.length);
              const rows = remaining > 0 ? event.rows.slice(0, remaining) : [];
              return { ...current, result: { ...result, rows: [...result.rows, ...rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  rowsAffected: event.rowsAffected,
                  durationMs: event.durationMs,
                  warnings,
                },
                warnings,
                running: false,
                cancelling: false,
                error: null,
                resultTab: warnings.length > 0 ? "messages" : "results",
              };
            });
          }
        });
        if (!sawDone) {
          patchSheet(panelId, sheet.id, { running: false, cancelling: false });
        }
      } catch (err) {
        patchSheet(panelId, sheet.id, {
          running: false,
          cancelling: false,
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      } finally {
        if (timersRef.current[sheet.id] === timer) {
          clearInterval(timer);
          delete timersRef.current[sheet.id];
        }
      }
    },
    [maxResultSheets, panels, patchSheet, rowLimit, sessionId, updateSheet],
  );

  const insertQueryFromOutside = useCallback(
    (sql: string, options?: { run?: boolean }) => {
      const text = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!text.trim()) return;
      const panelId = activePanelId;
      editorHandles.current[panelId]?.setValue(text);
      patchPanel(panelId, { doc: text, dirty: true });
      if (options?.run) {
        void runQuery(panelId, text);
      }
    },
    [activePanelId, patchPanel, runQuery],
  );

  const queryRegistryTitle = useMemo(() => {
    const database = info.database ? `/${info.database}` : "";
    return `${info.engine} ${info.host}:${info.port}${database}`;
  }, [info.database, info.engine, info.host, info.port]);

  useEffect(() => {
    return registerQueryTab({
      tabId,
      title: queryRegistryTitle,
      engine: info.engine,
      insertQuery: insertQueryFromOutside,
    });
  }, [info.engine, insertQueryFromOutside, queryRegistryTitle, tabId]);

  const captureDbFrame = useCallback(async () => {
    if (!rootRef.current) return null;
    return await renderElementToCanvas(rootRef.current);
  }, []);

  const cancelQuery = useCallback((panelId?: string) => {
    setPanels((prev) =>
      prev.map((p) =>
        panelId && p.id !== panelId
          ? p
          : {
              ...p,
              sheets: p.sheets.map((sheet) => (sheet.running ? { ...sheet, cancelling: true } : sheet)),
            },
      ),
    );
    void dbCancel(sessionId).catch(() => undefined);
  }, [sessionId]);

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
      if (info.database && names.includes(info.database)) return info.database;
      return names[0] ?? null;
    });
  }, [info.database]);

  const switchSchema = useCallback(
    async (schema: string) => {
      if (!schema || schema === activeSchema) return;
      const panelId = activePanelId;
      const sql = schemaSwitchSql(info.engine, schema);
      const panel = panels.find((p) => p.id === panelId);
      const sheet = newResultSheet(sql, (panel?.sheets.length ?? 0) + 1, rowLimit);
      sheet.title = "Schema";
      try {
        const result = await dbExecute(sessionId, sql);
        setActiveSchema(schema);
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  sheets: [
                    ...p.sheets,
                    {
                      ...sheet,
                      result,
                      warnings: result.warnings,
                      running: false,
                      resultTab: (result.warnings.length > 0 ? "messages" : "results") as ResultSubTab,
                    },
                  ].slice(-maxResultSheets),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
      } catch (err) {
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
                  ].slice(-maxResultSheets),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
      }
    },
    [activePanelId, activeSchema, info.engine, maxResultSheets, panels, rowLimit, sessionId],
  );
  const insertIntoActive = useCallback(
    (text: string) => {
      editorHandles.current[activePanelId]?.insertText(text);
    },
    [activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const qualified = qualifiedName(info.engine, schema ?? activeSchema, table);
      const sql = `SELECT * FROM ${qualified} LIMIT ${rowLimit}`;
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, activeSchema, info.engine, rowLimit, runQuery],
  );

  const addPanel = () => {
    if (panels.length >= MAX_PANELS) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const closePanel = (id: string) => {
    const closing = panels.find((p) => p.id === id);
    if (closing?.sheets.some((sheet) => sheet.running)) {
      void dbCancel(sessionId).catch(() => undefined);
    }
    closing?.sheets.forEach((sheet) => {
      if (timersRef.current[sheet.id]) {
        clearInterval(timersRef.current[sheet.id]);
        delete timersRef.current[sheet.id];
      }
    });
    setPanels((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((p) => p.id !== id);
      if (activePanelId === id) setActivePanelId(next[0].id);
      return next;
    });
    delete editorHandles.current[id];
    delete historyRef.current[id];
  };

  const closeResultSheet = (panelId: string, sheetId: string) => {
    const sheet = panels.find((p) => p.id === panelId)?.sheets.find((s) => s.id === sheetId);
    if (sheet?.running) {
      void dbCancel(sessionId).catch(() => undefined);
    }
    if (timersRef.current[sheetId]) {
      clearInterval(timersRef.current[sheetId]);
      delete timersRef.current[sheetId];
    }
    setPanels((prev) =>
      prev.map((panel) => {
        if (panel.id !== panelId) return panel;
        const sheets = panel.sheets.filter((s) => s.id !== sheetId);
        return {
          ...panel,
          sheets,
          activeSheetId:
            panel.activeSheetId === sheetId ? sheets.at(-1)?.id ?? null : panel.activeSheetId,
        };
      }),
    );
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
              ].slice(-maxResultSheets),
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
    let handleId: string | null = null;
    try {
      handleId = await writeStreamOpen(path);
      await writeStreamAppend(handleId, new TextEncoder().encode(sql));
      await writeStreamClose(handleId);
      patchPanel(panel.id, {
        filePath: path,
        fileName: path.split(/[\\/]/).pop() || defaultName,
        dirty: false,
      });
    } catch (err) {
      if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
      showPanelError(panel.id, String(err));
    }
  };

  const exportCsv = async (panel: PanelState, sheetId?: string) => {
    const sheet = sheetId
      ? panel.sheets.find((candidate) => candidate.id === sheetId) ?? null
      : activeSheet(panel);
    if (!sheet?.result || sheet.result.columns.length === 0) return;
    const lines: string[] = [];
    lines.push(sheet.result.columns.map((c) => csvField(c.name)).join(","));
    for (const row of sheet.result.rows) {
      lines.push(row.map(csvField).join(","));
    }
    const csv = lines.join("\n");
    const filename = `query-${Date.now()}.csv`;
    if (isTauriRuntime()) {
      const path = await selectSaveFilePath(filename);
      if (!path) return;
      let handleId: string | null = null;
      try {
        handleId = await writeStreamOpen(path);
        await writeStreamAppend(handleId, new TextEncoder().encode(csv));
        await writeStreamClose(handleId);
      } catch (err) {
        if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
        showPanelError(panel.id, String(err));
      }
      return;
    }

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const initialWidth = useMemo(() => {
    try {
      const v = Number(localStorage.getItem(widthKey(info.engine)));
      return Number.isFinite(v) && v >= 12 && v <= 50 ? v : 24;
    } catch {
      return 24;
    }
  }, [info.engine]);

  if (connError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6" style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}>
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">Connection failed</div>
          <div className="text-[12px] text-[var(--moba-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col relative"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      <FloatingToolbar
        storageKey={`mob.db.toolbar.${info.engine}`}
        defaultTop={4}
        defaultRight={4}
        testId="db-floating-toolbar"
      >
        <CaptureToolbar
          filenamePrefix={safeFilePart(`db-${info.engine}-${info.host}`)}
          getVisible={async () => {
            if (!rootRef.current) throw new Error("Database view not ready");
            return await captureElementPng(rootRef.current);
          }}
          getFull={async () => {
            if (!rootRef.current) throw new Error("Database view not ready");
            return await captureElementPng(rootRef.current);
          }}
          getScrollFrame={captureDbFrame}
          getGifFrame={captureDbFrame}
          onStatus={setStatusMessage}
          compact
        />
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
        {onToggleMaximize && (
          <button
            type="button"
            data-testid="db-maximize"
            onClick={onToggleMaximize}
            title={maximized ? t("rdp.restore") : t("rdp.maximize")}
            aria-label={maximized ? t("rdp.restore") : t("rdp.maximize")}
            style={FT_ICON_BUTTON_STYLE}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        {detachedWindowControls && (
          <>
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
      </FloatingToolbar>
      <PanelGroup direction="horizontal" autoSaveId={`db-client-${info.engine}`} className="flex-1 min-h-0">
        <Panel
          defaultSize={initialWidth}
          minSize={12}
          maxSize={50}
          onResize={(size) => {
            try {
              localStorage.setItem(widthKey(info.engine), String(size));
            } catch {
              /* ignore */
            }
          }}
        >
          <div className="h-full" style={{ borderRight: "1px solid var(--moba-divider)" }}>
            {connected && (
              <SchemaTree
                sessionId={sessionId}
                engine={info.engine}
                onInsertTable={insertIntoActive}
                onQuickSelect={quickSelect}
                quickSelectLimit={rowLimit}
                onSchemasLoaded={onSchemasLoaded}
                onSchemaLoaded={onSchemaLoaded}
              />
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
        <Panel>
          {/* Panel tab strip */}
          <div className="h-full flex flex-col min-w-0">
            <div
              className="h-7 shrink-0 flex items-center gap-1 px-1 text-[11px]"
              style={{ background: "var(--moba-chrome-bg)", borderBottom: "1px solid var(--moba-divider)" }}
            >
              {panels.map((p, i) => {
                const panelRunning = p.sheets.some((sheet) => sheet.running);
                const label = p.fileName ?? `Query ${i + 1}`;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="px-2 h-5 max-w-[190px] rounded inline-flex items-center gap-1"
                    style={{
                      background: p.id === activePanelId ? "var(--moba-selected)" : "transparent",
                      color: p.id === activePanelId ? "var(--moba-accent)" : "var(--moba-text-muted)",
                    }}
                    onClick={() => setActivePanelId(p.id)}
                    title={p.filePath ?? label}
                  >
                    <span className="truncate">{label}{p.dirty ? "*" : ""}</span>
                    {panelRunning && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {panels.length > 1 && (
                      <X
                        className="w-3 h-3 shrink-0 hover:text-[var(--moba-text)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          closePanel(p.id);
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {panels.length < MAX_PANELS && (
                <button
                  type="button"
                  title="New query panel"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)]"
                  onClick={addPanel}
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Query panels are visible side-by-side so multiple independent
                editors can run and compare results in the same tab. */}
            <PanelGroup direction="horizontal" className="flex-1 min-h-0">
              {panels.map((panel, index) => (
                <Fragment key={panel.id}>
                  <Panel minSize={18}>
                    <div
                      className="h-full flex flex-col min-w-0 relative"
                      data-active={panel.id === activePanelId || undefined}
                      onMouseDown={() => setActivePanelId(panel.id)}
                      style={{
                        borderLeft: panel.id === activePanelId ? "1px solid var(--moba-accent)" : undefined,
                      }}
                    >
                      <EditorToolbar
                        engine={info.engine}
                        schemas={schemas}
                        activeSchema={activeSchema}
                        running={panel.sheets.some((sheet) => sheet.running)}
                        onRun={() => runQuery(panel.id, editorHandles.current[panel.id]?.getValue() ?? "")}
                        onRunSelection={() =>
                          runQuery(panel.id, editorHandles.current[panel.id]?.getSelectionOrAll() ?? "")
                        }
                        onCancel={() => cancelQuery(panel.id)}
                        onFormat={() => {
                          const h = editorHandles.current[panel.id];
                          if (h) h.setValue(formatSql(h.getValue()));
                        }}
                        onToggleHistory={() =>
                          setHistoryPanelId((current) => (current === panel.id ? null : panel.id))
                        }
                        onSave={() => void saveQueryFile(panel)}
                        onSchemaChange={(schema) => void switchSchema(schema)}
                        rowLimit={rowLimit}
                        maxResultSheets={maxResultSheets}
                        onRowLimitChange={(value) =>
                          setRowLimit(clampInt(value, MIN_ROW_LIMIT, MAX_ROW_LIMIT))
                        }
                        onMaxResultSheetsChange={(value) =>
                          setMaxResultSheets(clampInt(value, MIN_RESULT_SHEETS, MAX_RESULT_SHEETS_LIMIT))
                        }
                      />
                      {historyPanelId === panel.id && (
                        <HistoryDropdown
                          history={historyRef.current[panel.id] ?? []}
                          onPick={(sql) => {
                            editorHandles.current[panel.id]?.setValue(sql);
                            setHistoryPanelId(null);
                          }}
                          onClose={() => setHistoryPanelId(null)}
                        />
                      )}
                      <PanelGroup direction="vertical" className="flex-1 min-h-0">
                        <Panel defaultSize={45} minSize={15}>
                          <SqlEditorPanel
                            engine={info.engine}
                            initialDoc={panel.doc}
                            schema={schemaMap}
                            handleRef={(h) => {
                              editorHandles.current[panel.id] = h;
                            }}
                            onDocChange={(doc) => patchPanel(panel.id, { doc, dirty: true })}
                            onFocus={() => setActivePanelId(panel.id)}
                            onRun={(sql) => runQuery(panel.id, sql)}
                          />
                        </Panel>
                        <PanelResizeHandle className="h-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-row-resize" />
                        <Panel minSize={15}>
                          <ResultArea
                            panel={panel}
                            onSheetSelect={(sheetId) => patchPanel(panel.id, { activeSheetId: sheetId })}
                            onSheetClose={(sheetId) => closeResultSheet(panel.id, sheetId)}
                            onTabChange={(sheetId, tab) => patchSheet(panel.id, sheetId, { resultTab: tab })}
                            onExportSheet={(sheetId) => void exportCsv(panel, sheetId)}
                          />
                        </Panel>
                      </PanelGroup>
                      <StatusBar panel={panel} />
                    </div>
                  </Panel>
                  {index < panels.length - 1 && (
                    <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
                  )}
                </Fragment>
              ))}
            </PanelGroup>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function csvField(value: string | null): string {
  if (value === null) return "";
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function EditorToolbar({
  engine,
  schemas,
  activeSchema,
  running,
  onRun,
  onRunSelection,
  onCancel,
  onFormat,
  onToggleHistory,
  onSave,
  onSchemaChange,
  rowLimit,
  maxResultSheets,
  onRowLimitChange,
  onMaxResultSheetsChange,
}: {
  engine: string;
  schemas: string[];
  activeSchema: string | null;
  running: boolean;
  onRun: () => void;
  onRunSelection: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onToggleHistory: () => void;
  onSave: () => void;
  onSchemaChange: (schema: string) => void;
  rowLimit: number;
  maxResultSheets: number;
  onRowLimitChange: (value: number) => void;
  onMaxResultSheetsChange: (value: number) => void;
}) {
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--moba-hover)] disabled:opacity-40";
  const input = "moba-input h-6 w-[68px] text-[11px]";
  return (
    <div
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{ background: "var(--moba-quick-bg)", borderBottom: "1px solid var(--moba-divider)" }}
    >
      <button type="button" className={btn} onClick={onRun} disabled={running} title="Run (F5)">
        <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
      </button>
      <button type="button" className={btn} onClick={onRunSelection} disabled={running} title="Run selection">
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
      </button>
      <button type="button" className={btn} onClick={onCancel} disabled={!running} title="Cancel query">
        <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--moba-divider)" }} />
      <button type="button" className={btn} onClick={onFormat} title="Format SQL">
        <Sparkles className="w-3.5 h-3.5" /> Format
      </button>
      <button type="button" className={btn} onClick={onToggleHistory} title="Query history">
        <Clock className="w-3.5 h-3.5" /> History
      </button>
      <button type="button" className={btn} onClick={onSave} title="Save query tab as SQL file">
        <Save className="w-3.5 h-3.5" /> Save
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--moba-divider)" }} />
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--moba-text-muted)]">
        Rows
        <input
          className={input}
          type="number"
          min={MIN_ROW_LIMIT}
          max={MAX_ROW_LIMIT}
          value={rowLimit}
          title="Maximum rows returned by each query"
          onChange={(event) => onRowLimitChange(Number(event.target.value))}
        />
      </label>
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--moba-text-muted)]">
        Sheets
        <input
          className={input}
          type="number"
          min={MIN_RESULT_SHEETS}
          max={MAX_RESULT_SHEETS_LIMIT}
          value={maxResultSheets}
          title="Maximum open result sheets in this DB tab"
          onChange={(event) => onMaxResultSheetsChange(Number(event.target.value))}
        />
      </label>
      <div className="flex-1" />
      {schemas.length > 0 && (
        <select
          className="moba-input h-6 max-w-[180px] text-[11px]"
          value={activeSchema ?? ""}
          aria-label="Schema"
          title="Schema / database"
          onChange={(event) => onSchemaChange(event.target.value)}
        >
          {schemas.map((schema) => (
            <option key={schema} value={schema}>
              {schema}
            </option>
          ))}
        </select>
      )}
      <span className="text-[10px] text-[var(--moba-text-muted)]">{engine}</span>
    </div>
  );
}

function HistoryDropdown({
  history,
  onPick,
  onClose,
}: {
  history: string[];
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute right-2 top-9 z-50 w-[420px] max-h-[300px] overflow-auto rounded shadow-lg moba-scroll-y"
        style={{ background: "var(--moba-panel-bg)", border: "1px solid var(--moba-divider)" }}
      >
        {history.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--moba-text-muted)]">No query history yet.</div>
        ) : (
          history.map((sql, i) => (
            <button
              key={i}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--moba-hover)] truncate font-mono"
              onClick={() => onPick(sql)}
              title={sql}
            >
              {sql.replace(/\s+/g, " ")}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function ResultArea({
  panel,
  onSheetSelect,
  onSheetClose,
  onTabChange,
  onExportSheet,
}: {
  panel: PanelState;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onExportSheet: (sheetId: string) => void;
}) {
  const sheet = activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";
  const actionBtn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--moba-hover)] disabled:opacity-40";
  const canExport = !!sheet?.result && sheet.result.columns.length > 0 && !sheet.running;
  const waitingForFirstResult =
    !!sheet?.running &&
    sheet.result !== null &&
    sheet.result.columns.length === 0 &&
    sheet.result.rows.length === 0;
  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--moba-bg)" }}>
      <div
        className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden"
        style={{ background: "var(--moba-chrome-bg)", borderBottom: "1px solid var(--moba-divider)" }}
      >
        {panel.sheets.length === 0 ? (
          <span className="px-2 pb-1 text-[11px] text-[var(--moba-text-muted)]">Result sheets</span>
        ) : (
          panel.sheets.map((resultSheet) => {
            const active = resultSheet.id === sheet?.id;
            return (
              <button
                key={resultSheet.id}
                type="button"
                className="h-6 max-w-[170px] px-2 inline-flex items-center gap-1 text-[11px]"
                style={{
                  background: active ? "var(--moba-tab-active)" : "var(--moba-tab-inactive)",
                  color: active ? "var(--moba-accent)" : "var(--moba-text-muted)",
                  border: "1px solid var(--moba-tab-border)",
                  borderBottom: active ? "1px solid var(--moba-tab-active)" : "1px solid var(--moba-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(resultSheet.id)}
                title={resultSheet.sql}
              >
                <span className="truncate">{resultSheet.title}</span>
                {resultSheet.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(resultSheet.error || resultSheet.warnings.length > 0) && (
                  <span className="text-[10px] shrink-0">●</span>
                )}
                <X
                  className="w-3 h-3 shrink-0 hover:text-[var(--moba-text)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSheetClose(resultSheet.id);
                  }}
                />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--moba-divider)" }}>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "results" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "results")}
          >
            Results
          </button>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "messages" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "messages")}
          >
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--moba-text-muted)] font-mono" title={sheet.sql}>
            {sheet.sql.replace(/\s+/g, " ")}
          </span>
          <span className="w-px h-4" style={{ background: "var(--moba-divider)" }} />
          <button
            type="button"
            className={actionBtn}
            disabled={!canExport}
            onClick={() => onExportSheet(sheet.id)}
            title="Export this result sheet to CSV"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {!sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
            Run a query to create a result sheet.
          </div>
        ) : sheet.resultTab === "results" ? (
          waitingForFirstResult ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {sheet.cancelling ? "Cancelling…" : "Running…"}
            </div>
          ) : sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid result={sheet.result} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {sheet.running ? "Running…" : "Run a query to see results."}
            </div>
          )
        ) : (
          <div className="flex-1 overflow-auto moba-scroll-y p-2 text-[12px] font-mono">
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (
              <div key={i} style={{ color: "#e6a817" }}>
                {w}
              </div>
            ))}
            {!sheet.error && sheet.warnings.length === 0 && (
              <div className="text-[var(--moba-text-muted)]">No messages.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar({ panel }: { panel: PanelState }) {
  const sheet = activeSheet(panel);
  const r = sheet?.result ?? null;
  return (
    <div
      className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--moba-text-muted)]"
      style={{ background: "var(--moba-quick-bg)", borderTop: "1px solid var(--moba-divider)" }}
    >
      {sheet?.running ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> {sheet.cancelling ? "Cancelling" : "Running"}{" "}
          {(sheet.elapsedMs / 1000).toFixed(1)}s
        </span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          {r.rowsAffected > 0 && <span>{r.rowsAffected} affected</span>}
          <span>{r.durationMs} ms</span>
          {sheet && <span>limit {sheet.rowLimit}</span>}
        </>
      ) : (
        <span>{panel.sheets.length} result sheet(s)</span>
      )}
    </div>
  );
}
