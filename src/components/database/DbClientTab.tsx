import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import type { DbConnectInfo } from "../../types";
import {
  dbConnect,
  dbDisconnect,
  dbExecute,
  dbCancel,
  type DbQueryResult,
} from "../../lib/ipc";
import { SchemaTree } from "./SchemaTree";
import { SqlEditorPanel, type SqlEditorHandle } from "./SqlEditorPanel";
import { QueryResultGrid } from "./QueryResultGrid";
import { formatSql } from "./formatSql";
import { useAppStore } from "../../stores/appStore";

interface DbClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
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
  elapsedMs: number;
  resultTab: "results" | "messages";
}

function widthKey(engine: string): string {
  return `newmob.db.schemaWidth.${engine}`;
}

function newPanel(): PanelState {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random()}`,
    doc: "",
    result: null,
    error: null,
    warnings: [],
    running: false,
    elapsedMs: 0,
    resultTab: "results",
  };
}

export default function DbClientTab({ tabId, info, visible }: DbClientTabProps) {
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [showHistory, setShowHistory] = useState(false);
  const historyRef = useRef<string[]>([]);
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
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

  const anyRunning = panels.some((p) => p.running);
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const runQuery = useCallback(
    async (panelId: string, sqlText: string) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      // Record history (newest first, dedup consecutive).
      if (historyRef.current[0] !== trimmed) {
        historyRef.current = [trimmed, ...historyRef.current].slice(0, MAX_HISTORY);
      }
      patchPanel(panelId, { running: true, error: null, elapsedMs: 0, resultTab: "results" });
      const started = Date.now();
      timersRef.current[panelId] = setInterval(() => {
        patchPanel(panelId, { elapsedMs: Date.now() - started });
      }, 100);
      try {
        const result = await dbExecute(sessionId, trimmed);
        patchPanel(panelId, {
          result,
          warnings: result.warnings,
          running: false,
          error: null,
          resultTab: result.warnings.length > 0 ? "messages" : "results",
        });
      } catch (err) {
        patchPanel(panelId, {
          running: false,
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      } finally {
        clearInterval(timersRef.current[panelId]);
        delete timersRef.current[panelId];
      }
    },
    [sessionId, patchPanel],
  );

  const cancelQuery = useCallback(() => {
    void dbCancel(sessionId).catch(() => undefined);
  }, [sessionId]);

  const onSchemaLoaded = useCallback((tables: Map<string, string[]>) => {
    setSchemaMap((prev) => {
      const next = { ...prev };
      for (const [name, cols] of tables) {
        if (!next[name]) next[name] = cols;
      }
      return next;
    });
  }, []);

  const insertIntoActive = useCallback(
    (text: string) => {
      editorHandles.current[activePanelId]?.insertText(text);
    },
    [activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const qualified = schema ? `${schema}.${table}` : table;
      const sql = `SELECT * FROM ${qualified} LIMIT 1000`;
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, runQuery],
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
  };

  const exportCsv = (panel: PanelState) => {
    if (!panel.result || panel.result.columns.length === 0) return;
    const lines: string[] = [];
    lines.push(panel.result.columns.map((c) => csvField(c.name)).join(","));
    for (const row of panel.result.rows) {
      lines.push(row.map(csvField).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-${Date.now()}.csv`;
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
    <div className="h-full w-full flex flex-col" style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}>
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

            {/* Active panel body */}
            <div className="flex-1 min-h-0 relative">
              {panels.map((panel) => (
                <div
                  key={panel.id}
                  className="absolute inset-0 flex flex-col"
                  style={{ display: panel.id === activePanelId ? "flex" : "none" }}
                >
                  <EditorToolbar
                    engine={info.engine}
                    running={panel.running}
                    showHistory={showHistory}
                    onRun={() => runQuery(panel.id, editorHandles.current[panel.id]?.getValue() ?? "")}
                    onRunSelection={() =>
                      runQuery(panel.id, editorHandles.current[panel.id]?.getSelectionOrAll() ?? "")
                    }
                    onCancel={cancelQuery}
                    onFormat={() => {
                      const h = editorHandles.current[panel.id];
                      if (h) h.setValue(formatSql(h.getValue()));
                    }}
                    onToggleHistory={() => setShowHistory((v) => !v)}
                    onExport={() => exportCsv(panel)}
                    canExport={!!panel.result && panel.result.columns.length > 0}
                  />
                  {showHistory && (
                    <HistoryDropdown
                      history={historyRef.current}
                      onPick={(sql) => {
                        editorHandles.current[panel.id]?.setValue(sql);
                        setShowHistory(false);
                      }}
                      onClose={() => setShowHistory(false)}
                    />
                  )}
                  <PanelGroup direction="vertical" className="flex-1 min-h-0">
                    <Panel defaultSize={45} minSize={15}>
                      <SqlEditorPanel
                        engine={info.engine}
                        schema={schemaMap}
                        handleRef={(h) => {
                          editorHandles.current[panel.id] = h;
                        }}
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
              ))}
            </div>
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
  running,
  onRun,
  onRunSelection,
  onCancel,
  onFormat,
  onToggleHistory,
  onExport,
  canExport,
}: {
  engine: string;
  running: boolean;
  showHistory: boolean;
  onRun: () => void;
  onRunSelection: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onToggleHistory: () => void;
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
          panel.result ? (
            <QueryResultGrid result={panel.result} />
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
          <Loader2 className="w-3 h-3 animate-spin" /> {(panel.elapsedMs / 1000).toFixed(1)}s
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
