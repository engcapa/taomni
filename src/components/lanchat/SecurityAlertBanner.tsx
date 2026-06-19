import { AlertTriangle } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";

/** Warning banner shown when a peer's presented identity was rejected — a
 *  spoofed node id or a changed pinned key (possible MITM, or the peer
 *  reinstalled). The user can re-trust (clear the pin so the next connection
 *  re-pins) or dismiss. */
export function SecurityAlertBanner() {
  const alerts = useLanChatStore((s) => s.securityAlerts);
  const retrustPeer = useLanChatStore((s) => s.retrustPeer);
  const dismiss = useLanChatStore((s) => s.dismissSecurityAlert);

  if (alerts.length === 0) return null;

  return (
    <div className="flex flex-col">
      {alerts.map((a) => (
        <div
          key={a.peerId}
          className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{
            background: "color-mix(in srgb, var(--busy,#ef4444) 14%, transparent)",
            borderBottom: "1px solid var(--busy,#ef4444)",
            color: "var(--taomni-text)",
          }}
        >
          <AlertTriangle className="h-3.5 w-3.5" style={{ color: "var(--busy,#ef4444)" }} />
          <span className="min-w-0 flex-1 truncate">
            {a.kind === "keyChanged"
              ? `身份密钥已变更:${a.peerId.slice(0, 12)}…(${a.addr})。可能是对方重装,也可能是中间人攻击,连接已阻断。`
              : `检测到身份冒用:${a.peerId.slice(0, 12)}…(${a.addr}),连接已拒绝。`}
          </span>
          {a.kind === "keyChanged" ? (
            <button
              type="button"
              onClick={() => void retrustPeer(a.peerId)}
              className="rounded-md px-2 py-0.5"
              style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)" }}
              title="清除锁定,下次连接重新信任(请先线下核实对方身份)"
            >
              重新信任
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => dismiss(a.peerId)}
            className="rounded-md px-2 py-0.5"
            style={{ color: "var(--taomni-text-muted)" }}
          >
            忽略
          </button>
        </div>
      ))}
    </div>
  );
}
