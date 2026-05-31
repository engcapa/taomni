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
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";

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

interface PanelState {
  id: string;
  doc: string;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: "results" | "messages";
}

function widthKey(engine: string): string {
  return `newmob.db.schemaWidth.${engine}`;
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
    result: null,
    error: null,
    warnings: [],
    running: false,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
  };
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
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(info.database ?? null);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const queryRunIdsRef = useRef<Record<string, number>>({});
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);

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

  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const updatePanel = useCallback((id: string, updater: (panel: PanelState) => PanelState) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const anyRunning = panels.some((p) => p.running);
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const runQuery = useCallback(
    async (panelId: string, sqlText: string) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      // Record history (newest first, dedup consecutive).
      const panelHistory = historyRef.current[panelId] ?? [];
      if (panelHistory[0] !== trimmed) {
        historyRef.current[panelId] = [trimmed, ...panelHistory].slice(0, MAX_HISTORY);
      }
      const runId = (queryRunIdsRef.current[panelId] ?? 0) + 1;
      queryRunIdsRef.current[panelId] = runId;
      if (timersRef.current[panelId]) {
        clearInterval(timersRef.current[panelId]);
      }
      patchPanel(panelId, {
        running: true,
        cancelling: false,
        error: null,
        warnings: [],
        elapsedMs: 0,
        result: emptyQueryResult(),
        resultTab: "results",
      });
      const started = Date.now();
      const timer = setInterval(() => {
        patchPanel(panelId, { elapsedMs: Date.now() - started });
      }, 100);
      timersRef.current[panelId] = timer;
      let sawDone = false;
      try {
        await dbExecuteStream(sessionId, trimmed, (event) => {
          if (queryRunIdsRef.current[panelId] !== runId) return;
          if (event.kind === "columns") {
            updatePanel(panelId, (panel) => {
              const result = panel.result ?? emptyQueryResult();
              return { ...panel, result: { ...result, columns: event.columns } };
            });
          } else if (event.kind === "rows") {
            updatePanel(panelId, (panel) => {
              const result = panel.result ?? emptyQueryResult();
              return { ...panel, result: { ...result, rows: [...result.rows, ...event.rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            updatePanel(panelId, (panel) => {
              const result = panel.result ?? emptyQueryResult();
              return {
                ...panel,
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
        if (!sawDone && queryRunIdsRef.current[panelId] === runId) {
          patchPanel(panelId, { running: false, cancelling: false });
        }
      } catch (err) {
        if (queryRunIdsRef.current[panelId] !== runId) return;
        patchPanel(panelId, {
          running: false,
          cancelling: false,
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      } finally {
        if (timersRef.current[panelId] === timer) {
          clearInterval(timer);
          delete timersRef.current[panelId];
        }
      }
    },
    [sessionId, patchPanel, updatePanel],
  );

  const cancelQuery = useCallback(() => {
    setPanels((prev) => prev.map((p) => (p.running ? { ...p, cancelling: true } : p)));
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
      try {
        const result = await dbExecute(sessionId, schemaSwitchSql(info.engine, schema));
        setActiveSchema(schema);
        patchPanel(panelId, {
          result,
          error: null,
          warnings: result.warnings,
          resultTab: result.warnings.length > 0 ? "messages" : "results",
        });
      } catch (err) {
        patchPanel(panelId, {
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      }
    },
    [activePanelId, activeSchema, info.engine, patchPanel, sessionId],
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
      const sql = `SELECT * FROM ${qualified} LIMIT 1000`;
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, activeSchema, info.engine, runQuery],
  );

  const addPanel = () => {
    if (panels.length >= MAX_PANELS) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const closePanel = (id: string) => {
    setPanels((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((p) => p.id !== id);
      if (activePanelId === id) setActivePanelId(next[0].id);
      return next;
    });
    delete editorHandles.current[id];
    delete historyRef.current[id];
    if (timersRef.current[id]) {
      clearInterval(timersRef.current[id]);
      delete timersRef.current[id];
    }
    delete queryRunIdsRef.current[id];
  };

  const exportCsv = async (panel: PanelState) => {
    if (!panel.result || panel.result.columns.length === 0) return;
    const lines: string[] = [];
    lines.push(panel.result.columns.map((c) => csvField(c.name)).join(","));
    for (const row of panel.result.rows) {
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
        patchPanel(panel.id, { error: String(err), resultTab: "messages" });
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
    <div className="h-full w-full flex flex-col relative" style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}>
      <FloatingToolbar
        storageKey={`mob.db.toolbar.${info.engine}`}
        defaultTop={4}
        defaultRight={4}
        testId="db-floating-toolbar"
      >
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
              {panels.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className="px-2 h-5 rounded inline-flex items-center gap-1"
                  style={{
                    background: p.id === activePanelId ? "var(--moba-selected)" : "transparent",
                    color: p.id === activePanelId ? "var(--moba-accent)" : "var(--moba-text-muted)",
                  }}
                  onClick={() => setActivePanelId(p.id)}
                >
                  Query {i + 1}
                  {p.running && <Loader2 className="w-3 h-3 animate-spin" />}
                  {panels.length > 1 && (
                    <X
                      className="w-3 h-3 hover:text-[var(--moba-text)]"
                      onClick={(e) => {
                        e.stopPropagation();
                        closePanel(p.id);
                      }}
                    />
                  )}
                </button>
              ))}
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
                        running={panel.running}
                        onRun={() => runQuery(panel.id, editorHandles.current[panel.id]?.getValue() ?? "")}
                        onRunSelection={() =>
                          runQuery(panel.id, editorHandles.current[panel.id]?.getSelectionOrAll() ?? "")
                        }
                        onCancel={cancelQuery}
                        onFormat={() => {
                          const h = editorHandles.current[panel.id];
                          if (h) h.setValue(formatSql(h.getValue()));
                        }}
                        onToggleHistory={() =>
                          setHistoryPanelId((current) => (current === panel.id ? null : panel.id))
                        }
                        onSchemaChange={(schema) => void switchSchema(schema)}
                        onExport={() => void exportCsv(panel)}
                        canExport={!!panel.result && panel.result.columns.length > 0}
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
                            onDocChange={(doc) => patchPanel(panel.id, { doc })}
                            onFocus={() => setActivePanelId(panel.id)}
                            onRun={(sql) => runQuery(panel.id, sql)}
                          />
                        </Panel>
                        <PanelResizeHandle className="h-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-row-resize" />
                        <Panel minSize={15}>
                          <ResultArea panel={panel} onTabChange={(t) => patchPanel(panel.id, { resultTab: t })} />
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
  onSchemaChange,
  onExport,
  canExport,
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
  onSchemaChange: (schema: string) => void;
  onExport: () => void;
  canExport: boolean;
}) {
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--moba-hover)] disabled:opacity-40";
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
      <button type="button" className={btn} onClick={onExport} disabled={!canExport} title="Export results to CSV">
        <Download className="w-3.5 h-3.5" /> CSV
      </button>
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
  onTabChange,
}: {
  panel: PanelState;
  onTabChange: (tab: "results" | "messages") => void;
}) {
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";
  const waitingForFirstResult =
    panel.running && panel.result !== null && panel.result.columns.length === 0 && panel.result.rows.length === 0;
  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--moba-bg)" }}>
      <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--moba-divider)" }}>
        <button
          type="button"
          className={tab}
          style={{ color: panel.resultTab === "results" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
          onClick={() => onTabChange("results")}
        >
          Results
        </button>
        <button
          type="button"
          className={tab}
          style={{ color: panel.resultTab === "messages" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
          onClick={() => onTabChange("messages")}
        >
          Messages{(panel.error || panel.warnings.length > 0) ? " ●" : ""}
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {panel.resultTab === "results" ? (
          waitingForFirstResult ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {panel.cancelling ? "Cancelling…" : "Running…"}
            </div>
          ) : panel.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${panel.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid result={panel.result} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {panel.running ? "Running…" : "Run a query to see results."}
            </div>
          )
        ) : (
          <div className="flex-1 overflow-auto moba-scroll-y p-2 text-[12px] font-mono">
            {panel.error && <div style={{ color: "#d9534f" }}>{panel.error}</div>}
            {panel.warnings.map((w, i) => (
              <div key={i} style={{ color: "#e6a817" }}>
                {w}
              </div>
            ))}
            {!panel.error && panel.warnings.length === 0 && (
              <div className="text-[var(--moba-text-muted)]">No messages.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar({ panel }: { panel: PanelState }) {
  const r = panel.result;
  return (
    <div
      className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--moba-text-muted)]"
      style={{ background: "var(--moba-quick-bg)", borderTop: "1px solid var(--moba-divider)" }}
    >
      {panel.running ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> {panel.cancelling ? "Cancelling" : "Running"}{" "}
          {(panel.elapsedMs / 1000).toFixed(1)}s
        </span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          {r.rowsAffected > 0 && <span>{r.rowsAffected} affected</span>}
          <span>{r.durationMs} ms</span>
        </>
      ) : (
        <span>Ready</span>
      )}
    </div>
  );
}
