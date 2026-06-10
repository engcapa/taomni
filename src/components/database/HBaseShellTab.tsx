import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Play,
  RefreshCw,
  Table2,
  Trash2,
  Ban,
} from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import type { HBaseConnectInfo } from "../../types";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import {
  hbaseConnect,
  hbaseDisconnect,
  hbaseExecute,
  hbaseListTables,
  hbaseCancel,
  type HBaseShellResult,
  type HBaseTableInfo,
} from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";

interface HBaseShellTabProps {
  tabId: string;
  info: HBaseConnectInfo;
  visible: boolean;
}

const COMMON_COMMANDS = [
  { label: "help", cmd: "help", exec: true },
  { label: "list", cmd: "list", exec: true },
  { label: "status", cmd: "status", exec: true },
  { label: "version", cmd: "version", exec: true },
  { label: "whoami", cmd: "whoami", exec: true },
  { label: "show_filters", cmd: "show_filters", exec: true },
  { label: "describe", cmd: "describe 'table_name'", exec: false },
  { label: "scan", cmd: "scan 'table_name', {LIMIT => 10}", exec: false },
  { label: "get", cmd: "get 'table_name', 'row_id'", exec: false },
  { label: "count", cmd: "count 'table_name'", exec: false },
  { label: "exists", cmd: "exists 'table_name'", exec: false },
];

function createRuntimeHBaseSessionId(baseSessionId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${baseSessionId}::${suffix}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function defaultCommand(info: HBaseConnectInfo): string {
  return info.namespace ? `list` : "list";
}

function ResultTable({ result }: { result: HBaseShellResult | null }) {
  if (!result) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        Run an HBase shell command to see results.
      </div>
    );
  }

  if (result.columns.length === 0) {
    return (
      <div className="p-3 text-[12px]">
        <div className="font-semibold mb-1">{result.message}</div>
        <div className="text-[var(--taomni-text-muted)]">{result.durationMs} ms</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto taomni-scroll-y">
      <table className="min-w-full text-[12px] border-collapse">
        <thead>
          <tr style={{ background: "var(--taomni-quick-bg)" }}>
            {result.columns.map((column) => (
              <th
                key={column}
                className="sticky top-0 z-10 text-left px-2 py-1 border-b font-semibold"
                style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join("\u0001")}`} className="hover:bg-[var(--taomni-hover)]">
              {result.columns.map((column, columnIndex) => (
                <td
                  key={`${column}-${columnIndex}`}
                  className="px-2 py-1 border-b align-top taomni-mono max-w-[520px] break-words"
                  style={{ borderColor: "var(--taomni-divider)" }}
                >
                  {row[columnIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HBaseShellTab({ tabId, info, visible }: HBaseShellTabProps) {
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [allTables, setAllTables] = useState<HBaseTableInfo[]>([]);
  const [visibleCount, setVisibleCount] = useState(10);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [loadTimeoutTriggered, setLoadTimeoutTriggered] = useState(false);
  const [command, setCommand] = useState(() => defaultCommand(info));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HBaseShellResult | null>(null);
  const [history, setHistory] = useState<HBaseShellResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      setHasBeenVisible(true);
    }
  }, [visible]);

  const initialLayout = useMemo(() => {
    return loadResizableLayout(`hbase-shell-${info.sessionId}`, ["sidebar", "workspace"]);
  }, [info.sessionId]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (initialLayout && typeof initialLayout.sidebar === "number") {
      return initialLayout.sidebar === 0;
    }
    return false;
  });

  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);

  const lastVisibleSidebarWidthRef = useRef<number>(
    initialLayout && typeof initialLayout.sidebar === "number" && initialLayout.sidebar > 0
      ? initialLayout.sidebar
      : 20
  );

  const expandSidebarPanel = () => {
    const nextSize = Math.min(40, Math.max(15, lastVisibleSidebarWidthRef.current));
    sidebarPanelRef.current?.resize(`${nextSize}%`);
    setSidebarCollapsed(false);
  };

  const handleSidebarResize = (size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 0) {
      lastVisibleSidebarWidthRef.current = percentage;
    }
    setSidebarCollapsed(percentage === 0);
  };

  const cancelLoadTables = useCallback(async () => {
    if (connectionSessionId) {
      await hbaseCancel(connectionSessionId);
    }
  }, [connectionSessionId]);

  const handleCancelQuery = useCallback(async () => {
    if (connectionSessionId) {
      await hbaseCancel(connectionSessionId);
    }
  }, [connectionSessionId]);
  
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const commandRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeHBaseSessionId(info.sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    void hbaseConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.sessionId]);

  useEffect(() => {
    setTabHasNewOutput(tabId, running && !visible);
  }, [running, tabId, visible, setTabHasNewOutput]);

  const loadTables = useCallback(async () => {
    if (!connectionSessionId) return;
    setTablesLoading(true);
    setLoadTimeoutTriggered(false);
    setError(null);

    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error("TIMEOUT"));
      }, 60000);
    });

    try {
      const fetchPromise = hbaseListTables(connectionSessionId);
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (timeoutId) window.clearTimeout(timeoutId);
      setAllTables(res);
      setVisibleCount(10);
    } catch (err) {
      if (timeoutId) window.clearTimeout(timeoutId);
      const errStr = String(err);
      if (err instanceof Error && err.message === "TIMEOUT") {
        setLoadTimeoutTriggered(true);
        setAllTables([]);
      } else if (errStr.includes("cancelled") || errStr.includes("Cancel")) {
        setError("Load cancelled by user");
      } else {
        setError(errStr);
      }
    } finally {
      setTablesLoading(false);
    }
  }, [connectionSessionId]);

  useEffect(() => {
    if (connectionSessionId) void loadTables();
  }, [connectionSessionId, loadTables]);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  const run = useCallback(
    async (nextCommand = command) => {
      const trimmed = nextCommand.trim();
      if (!trimmed || !connectionSessionId || running) return;
      setRunning(true);
      setError(null);
      try {
        const nextResult = await hbaseExecute(connectionSessionId, trimmed);
        setResult(nextResult);
        setHistory((items) => [nextResult, ...items].slice(0, 40));
        if (/^(create|drop)\b/i.test(trimmed)) void loadTables();
      } catch (err) {
        setError(String(err));
      } finally {
        setRunning(false);
      }
    },
    [command, connectionSessionId, loadTables, running],
  );

  const quickCommand = useCallback(
    (next: string) => {
      setCommand(next);
      commandRef.current?.focus();
    },
    [],
  );

  const onCommandKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void run();
    }
  };

  const endpoint = useMemo(() => {
    if (info.connectionMode === "native") {
      const q = info.zkQuorum || `${info.host}:${info.port}`;
      const r = info.zkRoot || "/hbase";
      return `ZK: ${q} (${r})${info.namespace ? ` [${info.namespace}]` : ""}`;
    }
    const scheme = info.ssl ? "https" : "http";
    const path = info.restPath ? `/${info.restPath.replace(/^\/+|\/+$/g, "")}` : "";
    return `${scheme}://${info.host}:${info.port}${path}${info.namespace ? ` [${info.namespace}]` : ""}`;
  }, [info.connectionMode, info.host, info.namespace, info.port, info.restPath, info.ssl, info.zkQuorum, info.zkRoot]);

  if (connError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">HBase connection failed</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }

  if (!hasBeenVisible) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: "var(--taomni-bg)" }}>
        <Loader2 className="w-6 h-6 animate-spin text-[var(--taomni-text-muted)]" />
      </div>
    );
  }

  const visibleTables = allTables.slice(0, visibleCount);

  return (
    <div className="h-full w-full flex flex-col relative" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {sidebarCollapsed && (
        <button
          type="button"
          data-testid="hbase-sidebar-drawer-handle"
          className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
          style={{
            background: "var(--taomni-panel-bg)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
          title="Show database objects"
          aria-label="Show database objects"
          onClick={expandSidebarPanel}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
            Objects
          </span>
        </button>
      )}
      <PanelGroup
        orientation="horizontal"
        id={`hbase-shell-${info.sessionId}`}
        defaultLayout={loadResizableLayout(`hbase-shell-${info.sessionId}`, ["sidebar", "workspace"])}
        onLayoutChanged={saveResizableLayout(`hbase-shell-${info.sessionId}`)}
        className="flex-1 min-h-0"
      >
        <Panel
          panelRef={sidebarPanelRef}
          id="sidebar"
          defaultSize="20%"
          minSize="15%"
          maxSize="40%"
          collapsible
          collapsedSize={0}
          onResize={handleSidebarResize}
        >
          <aside className="h-full flex flex-col border-r" style={{ borderColor: "var(--taomni-divider)" }}>
            <div
              className="h-8 flex items-center gap-1.5 px-2 border-b text-[12px] font-semibold shrink-0"
              style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
            >
              <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
              <span className="truncate flex-1">HBase</span>
              <button
                type="button"
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] shrink-0"
                title="Refresh tables"
                onClick={() => void loadTables()}
                disabled={!connectionSessionId || tablesLoading}
              >
                {tablesLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </button>
            </div>
            <div
              className="px-2 py-1.5 text-[11px] text-[var(--taomni-text-muted)] border-b truncate shrink-0"
              style={{ borderColor: "var(--taomni-divider)" }}
              title={endpoint}
            >
              {endpoint}
            </div>
            <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y py-1">
              {!connectionSessionId && (
                <div className="px-2 py-2 text-[12px] text-[var(--taomni-text-muted)] flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Connecting...</span>
                </div>
              )}
              {tablesLoading && (
                <div className="px-2 py-2 text-[12px] text-[var(--taomni-text-muted)] flex items-center justify-between border-b" style={{ borderColor: "var(--taomni-divider)" }}>
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Loading tables...</span>
                  </div>
                  <button
                    type="button"
                    className="taomni-btn px-1.5 py-0.5 text-[10px] flex items-center gap-0.5 hover:bg-[var(--taomni-hover)]"
                    onClick={cancelLoadTables}
                    title="Cancel table load"
                  >
                    <Ban className="w-3 h-3" style={{ color: "#d9534f" }} />
                    Cancel
                  </button>
                </div>
              )}
              {loadTimeoutTriggered && (
                <div className="px-2 py-2 text-[11px] text-[var(--taomni-text-muted)] flex flex-col gap-1.5 border-b" style={{ borderColor: "var(--taomni-divider)" }}>
                  <span className="text-amber-500 font-medium">Load timed out (&gt;60s)</span>
                  <button
                    type="button"
                    className="taomni-btn self-start px-2 py-1 text-[10px]"
                    onClick={() => void loadTables()}
                  >
                    Retry Load
                  </button>
                </div>
              )}
              {connectionSessionId && allTables.length === 0 && !tablesLoading && !loadTimeoutTriggered && (
                <div className="px-2 py-1 text-[12px] text-[var(--taomni-text-muted)]">No tables loaded.</div>
              )}
              {!tablesLoading && visibleTables.map((table) => (
                <div key={table.name} className="group">
                  <button
                    type="button"
                    className="taomni-tree-row w-full text-left"
                    title={table.name}
                    onClick={() => quickCommand(`describe ${shellQuote(table.name)}`)}
                  >
                    <Table2 className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />
                    <span className="flex-1 truncate">{table.name}</span>
                  </button>
                  <div className="hidden group-hover:flex gap-1 px-7 pb-1">
                    <button
                      className="taomni-btn h-5 px-1 text-[10px]"
                      type="button"
                      onClick={() => quickCommand(`scan ${shellQuote(table.name)}, {LIMIT=>50}`)}
                    >
                      scan
                    </button>
                    <button
                      className="taomni-btn h-5 px-1 text-[10px]"
                      type="button"
                      onClick={() => quickCommand(`get ${shellQuote(table.name)}, 'row-key'`)}
                    >
                      get
                    </button>
                  </div>
                </div>
              ))}
              {!tablesLoading && allTables.length > visibleCount && (
                <div className="px-2 py-1.5 flex justify-center border-t mt-1" style={{ borderColor: "var(--taomni-divider)" }}>
                  <button
                    type="button"
                    className="taomni-btn w-full py-1 text-[11px] font-semibold flex items-center justify-center gap-1 hover:bg-[var(--taomni-hover)]"
                    onClick={() => setVisibleCount((c) => c + 10)}
                  >
                    More... ({allTables.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </div>
          </aside>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="workspace">
          <main className="h-full flex flex-col min-w-0">
            <div className="h-8 flex items-center gap-1.5 px-2 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
              <button
                className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
                type="button"
                onClick={() => void run()}
                disabled={!connectionSessionId || running || !command.trim()}
                title="Run (Ctrl+Enter)"
              >
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} />}
                Run
              </button>

              <button
                className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
                type="button"
                onClick={handleCancelQuery}
                disabled={!running}
                title="Cancel query"
              >
                <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} />
                Cancel
              </button>

              <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />

              <div className="relative" ref={menuRef}>
                <button
                  className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
                  type="button"
                  onClick={() => setShowMenu((prev) => !prev)}
                  disabled={!connectionSessionId || running}
                >
                  Commands <ChevronDown className="w-3 h-3" />
                </button>
                {showMenu && (
                  <div
                    className="absolute left-0 mt-1 w-52 rounded border shadow-lg z-50 py-1 text-[12px]"
                    style={{
                      background: "var(--taomni-panel-bg)",
                      borderColor: "var(--taomni-divider)",
                      color: "var(--taomni-text)",
                    }}
                  >
                    {COMMON_COMMANDS.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-[var(--taomni-hover)] flex items-center justify-between"
                        onClick={() => {
                          quickCommand(item.cmd);
                          setShowMenu(false);
                        }}
                      >
                        <span className="taomni-mono">{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
                type="button"
                onClick={() => setHistory([])}
                disabled={history.length === 0}
                title="Clear query history"
              >
                <Trash2 className="w-3 h-3" /> Clear
              </button>
              <div className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">
                {result ? `${result.rows.length} row(s) / ${result.durationMs} ms` : ""}
              </div>
            </div>

            <PanelGroup
              orientation="vertical"
              id={`hbase-workspace-${info.sessionId}`}
              defaultLayout={loadResizableLayout(`hbase-workspace-${info.sessionId}`, ["editor", "results"])}
              onLayoutChanged={saveResizableLayout(`hbase-workspace-${info.sessionId}`)}
              className="flex-1 min-h-0"
            >
              <Panel id="editor" defaultSize="30%" minSize="15%">
                <div className="h-full flex flex-col relative">
                  {sidebarCollapsed && (
                    <div
                      className="absolute left-[24px] top-0 bottom-0 w-px z-10"
                      style={{ background: "var(--taomni-divider)" }}
                    />
                  )}
                  <textarea
                    ref={commandRef}
                    className="flex-1 resize-none taomni-mono bg-[var(--taomni-bg)] text-[var(--taomni-text)] outline-none border-none"
                    style={{
                      minHeight: 0,
                      padding: 12,
                      paddingLeft: sidebarCollapsed ? 36 : 12,
                    }}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    onKeyDown={onCommandKeyDown}
                    spellCheck={false}
                    aria-label="HBase shell command"
                  />
                  {(error || (result && result.warnings && result.warnings.length > 0)) && (
                    <div
                      className="py-1.5 text-[11px] border-t shrink-0"
                      style={{
                        borderColor: "var(--taomni-divider)",
                        color: error ? "#b22222" : "var(--taomni-text-muted)",
                        paddingLeft: sidebarCollapsed ? 36 : 12,
                        paddingRight: 12,
                      }}
                    >
                      {error ?? result?.warnings.join("; ")}
                    </div>
                  )}
                </div>
              </Panel>
              <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
              <Panel id="results" minSize="20%">
                <div className="h-full flex flex-col min-h-0">
                  <div className="flex-1 min-h-0">
                    <ResultTable result={result} />
                  </div>
                  {history.length > 0 && (
                    <div className="h-[104px] border-t overflow-auto taomni-scroll-y shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
                      {history.map((entry) => (
                        <button
                          key={`${entry.durationMs}-${entry.command}-${entry.message}`}
                          type="button"
                          className="w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--taomni-hover)] flex gap-2"
                          onClick={() => {
                            setCommand(entry.command);
                            setResult(entry);
                          }}
                        >
                          <span className="taomni-mono truncate flex-1">{entry.command}</span>
                          <span className="text-[var(--taomni-text-muted)]">{entry.rows.length} row(s)</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Panel>
            </PanelGroup>
          </main>
        </Panel>
      </PanelGroup>
    </div>
  );
}
