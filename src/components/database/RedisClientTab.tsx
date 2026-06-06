import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { DbConnectInfo } from "../../types";
import { dbConnect, dbDisconnect, redisDelKey, redisExec } from "../../lib/ipc";
import { RedisKeyBrowser } from "./RedisKeyBrowser";
import { RedisValuePanel } from "./RedisValuePanel";
import { RedisCli } from "./RedisCli";
import { RedisNewKeyDialog } from "./RedisNewKeyDialog";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";

function createRuntimeDbSessionId(baseSessionId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${baseSessionId}::${suffix}`;
}

interface RedisClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
}

export default function RedisClientTab({ info, visible }: RedisClientTabProps) {
  const sessionId = info.sessionId;
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dbIndex, setDbIndex] = useState<number>(info.dbIndex ?? 0);
  const [reloadToken, setReloadToken] = useState(0);
  const [showNewKey, setShowNewKey] = useState(false);
  const [cliCollapsed, setCliCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { fontSize: dbFontSize } = useDbSessionFontSize(visible, rootRef);
  const dbFontStyle = useMemo(
    () => ({
      "--taomni-db-font-size": `${dbFontSize}px`,
      "--taomni-db-font-size-sm": `${Math.max(10, dbFontSize - 2)}px`,
    }) as CSSProperties,
    [dbFontSize],
  );

  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeDbSessionId(sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    void dbConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void dbDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(runtimeSessionId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const switchDbIndex = async (idx: number) => {
    if (!connectionSessionId) return;
    try {
      await redisExec(connectionSessionId, `SELECT ${idx}`);
      setDbIndex(idx);
      setSelectedKey(null);
      reload();
    } catch {
      /* surfaced by the CLI on the next command */
    }
  };

  if (connError) {
    return (
      <div
        ref={rootRef}
        className="h-full w-full flex items-center justify-center p-6"
        style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
      >
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">Connection failed</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full w-full flex flex-col" style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {/* Toolbar: DB index switcher */}
      <div
        className="h-7 shrink-0 flex items-center gap-2 px-2 text-[11px]"
        style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        <span className="font-semibold" style={{ color: "var(--taomni-accent)" }}>
          {info.host}:{info.port}
        </span>
        <span className="text-[var(--taomni-text-muted)]">DB</span>
        <div className="relative inline-flex items-center">
          <select
            className="taomni-input pr-5 appearance-none"
            style={{ height: 20, paddingTop: 0, paddingBottom: 0 }}
            value={dbIndex}
            aria-label="Redis DB index"
            onChange={(e) => void switchDbIndex(Number(e.target.value))}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
          <ChevronDown className="w-3 h-3 absolute right-1 pointer-events-none text-[var(--taomni-text-muted)]" />
        </div>
      </div>

      <PanelGroup orientation="vertical" className="flex-1 min-h-0">
        <Panel defaultSize={`${cliCollapsed ? 92 : 70}%`} minSize="30%">
          <PanelGroup
            orientation="horizontal"
            id="redis-client"
            defaultLayout={loadResizableLayout("redis-client", ["keys", "value"])}
            onLayoutChanged={saveResizableLayout("redis-client")}
            className="h-full"
          >
            <Panel id="keys" defaultSize="32%" minSize="18%" maxSize="55%">
              <div className="h-full" style={{ borderRight: "1px solid var(--taomni-divider)" }}>
                {connectionSessionId && (
                  <RedisKeyBrowser
                    sessionId={connectionSessionId}
                    separator=":"
                    reloadToken={reloadToken}
                    selectedKey={selectedKey}
                    onSelectKey={setSelectedKey}
                    onAddKey={() => setShowNewKey(true)}
                    onDeleteKey={async (key) => {
                      const confirmed = await confirmAppDialog({
                        message: `Delete key "${key}"?`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!confirmed) return;
                      if (!connectionSessionId) return;
                      await redisDelKey(connectionSessionId, key).catch(() => undefined);
                      if (selectedKey === key) setSelectedKey(null);
                      reload();
                    }}
                    onSetTtl={async (key) => {
                      const input = await promptAppDialog({
                        title: "Set TTL",
                        label: `Set TTL (seconds) for "${key}" (-1 = persist):`,
                        initialValue: "60",
                        allowEmpty: true,
                      });
                      if (input === null) return;
                      const secs = parseInt(input, 10);
                      if (Number.isNaN(secs)) return;
                      if (!connectionSessionId) return;
                      if (secs === -1) await redisExec(connectionSessionId, `PERSIST ${key}`).catch(() => undefined);
                      else await redisExec(connectionSessionId, `EXPIRE ${key} ${secs}`).catch(() => undefined);
                      reload();
                    }}
                  />
                )}
              </div>
            </Panel>
            <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
            <Panel id="value">
              <RedisValuePanel
                sessionId={connectionSessionId ?? ""}
                redisKey={selectedKey}
                onDeleted={() => {
                  setSelectedKey(null);
                  reload();
                }}
                onChanged={reload}
              />
            </Panel>
          </PanelGroup>
        </Panel>
        {!cliCollapsed && (
          <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
        )}
        <Panel
          defaultSize={`${cliCollapsed ? 8 : 30}%`}
          minSize={`${cliCollapsed ? 4 : 12}%`}
          maxSize={`${cliCollapsed ? 8 : 70}%`}
        >
          <RedisCli
            sessionId={connectionSessionId ?? ""}
            collapsed={cliCollapsed}
            onToggleCollapse={() => setCliCollapsed((v) => !v)}
          />
        </Panel>
      </PanelGroup>

      {showNewKey && (
        <RedisNewKeyDialog
          sessionId={connectionSessionId ?? ""}
          onClose={() => setShowNewKey(false)}
          onCreated={(key) => {
            setShowNewKey(false);
            setSelectedKey(key);
            reload();
          }}
        />
      )}
    </div>
  );
}
