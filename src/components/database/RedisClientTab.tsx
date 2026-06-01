import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { DbConnectInfo } from "../../types";
import { dbConnect, dbDisconnect, redisDelKey, redisExec } from "../../lib/ipc";
import { RedisKeyBrowser } from "./RedisKeyBrowser";
import { RedisValuePanel } from "./RedisValuePanel";
import { RedisCli } from "./RedisCli";
import { RedisNewKeyDialog } from "./RedisNewKeyDialog";

interface RedisClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
}

export default function RedisClientTab({ info }: RedisClientTabProps) {
  const sessionId = info.sessionId;
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dbIndex, setDbIndex] = useState<number>(info.dbIndex ?? 0);
  const [reloadToken, setReloadToken] = useState(0);
  const [showNewKey, setShowNewKey] = useState(false);
  const [cliCollapsed, setCliCollapsed] = useState(false);
  const connectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void dbConnect(info)
      .then(() => {
        if (cancelled) return;
        connectedRef.current = true;
        setConnected(true);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(sessionId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const switchDbIndex = async (idx: number) => {
    try {
      await redisExec(sessionId, `SELECT ${idx}`);
      setDbIndex(idx);
      setSelectedKey(null);
      reload();
    } catch {
      /* surfaced by the CLI on the next command */
    }
  };

  if (connError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">Connection failed</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
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

      <PanelGroup direction="vertical" className="flex-1 min-h-0">
        <Panel defaultSize={cliCollapsed ? 92 : 70} minSize={30}>
          <PanelGroup direction="horizontal" autoSaveId="redis-client" className="h-full">
            <Panel defaultSize={32} minSize={18} maxSize={55}>
              <div className="h-full" style={{ borderRight: "1px solid var(--taomni-divider)" }}>
                {connected && (
                  <RedisKeyBrowser
                    sessionId={sessionId}
                    separator=":"
                    reloadToken={reloadToken}
                    selectedKey={selectedKey}
                    onSelectKey={setSelectedKey}
                    onAddKey={() => setShowNewKey(true)}
                    onDeleteKey={async (key) => {
                      if (!window.confirm(`Delete key "${key}"?`)) return;
                      await redisDelKey(sessionId, key).catch(() => undefined);
                      if (selectedKey === key) setSelectedKey(null);
                      reload();
                    }}
                    onSetTtl={async (key) => {
                      const input = window.prompt(`Set TTL (seconds) for "${key}" (-1 = persist):`, "60");
                      if (input === null) return;
                      const secs = parseInt(input, 10);
                      if (Number.isNaN(secs)) return;
                      if (secs === -1) await redisExec(sessionId, `PERSIST ${key}`).catch(() => undefined);
                      else await redisExec(sessionId, `EXPIRE ${key} ${secs}`).catch(() => undefined);
                      reload();
                    }}
                  />
                )}
              </div>
            </Panel>
            <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
            <Panel>
              <RedisValuePanel
                sessionId={sessionId}
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
        <Panel defaultSize={cliCollapsed ? 8 : 30} minSize={cliCollapsed ? 4 : 12} maxSize={cliCollapsed ? 8 : 70}>
          <RedisCli
            sessionId={sessionId}
            collapsed={cliCollapsed}
            onToggleCollapse={() => setCliCollapsed((v) => !v)}
          />
        </Panel>
      </PanelGroup>

      {showNewKey && (
        <RedisNewKeyDialog
          sessionId={sessionId}
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
