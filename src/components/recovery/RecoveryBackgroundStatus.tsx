import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "../../lib/servers";
import type { TunnelStatusInfo } from "../../lib/tunnel";
import type { SocksCapStatus } from "../../lib/sockscap";
import { boundedUtf8 } from "../../lib/runtimeRecovery";

/** Loaded only in recovery. Three existing read-only queries, on user request. */
export function RecoveryBackgroundStatus() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const results = await Promise.allSettled([
      invoke<ServerStatus[]>("list_server_statuses", {}),
      invoke<TunnelStatusInfo[]>("list_tunnel_statuses", {}),
      invoke<SocksCapStatus>("sockscap_status"),
    ]);
    pending.current = false;
    if (!alive.current) return;
    const [servers, tunnels, socks] = results;
    const rows: string[] = [];
    if (servers.status === "fulfilled") {
      rows.push("Servers：" + (servers.value.length ? "当前查询结果" : "无已登记服务"));
      for (const item of servers.value.slice(0, 128)) rows.push(`${item.serverType}: ${item.status}${item.pid ? ` (PID ${item.pid})` : ""}`);
      if (servers.value.length > 128) rows.push("服务条目超过显示上限，仅展示前128项。");
    } else rows.push("Servers：查询失败，状态未知；可手动重试。");
    if (tunnels.status === "fulfilled") {
      rows.push("隧道：" + (tunnels.value.length ? "当前查询结果" : "无已登记隧道"));
      for (const item of tunnels.value.slice(0, 128)) rows.push(`${boundedUtf8(item.id, 256)}: ${item.status}`);
      if (tunnels.value.length > 128) rows.push("隧道条目超过显示上限，仅展示前128项。");
    } else rows.push("隧道：查询失败，状态未知；可手动重试。");
    rows.push(socks.status === "fulfilled"
      ? `SocksCap: ${socks.value.phase} — ${boundedUtf8(socks.value.message, 512)}`
      : "SocksCap：查询失败，状态未知；可手动重试。");
    setStatus(rows);
    setBusy(false);
  };
  return <section aria-label="后台工具状态">
    <p>可读取 Servers、隧道和 SocksCap 当前状态。查询不会启动、停止或修复服务；结果仅代表查询时刻。</p>
    <button data-testid="recovery-background-refresh" disabled={busy} onClick={() => void refresh()}>
      {busy ? "正在读取后台状态…" : "查看 / 刷新后台状态"}
    </button>
    <pre data-testid="recovery-background-status" aria-live="polite" style={{ whiteSpace: "pre-wrap" }}>
      {status.length ? status.join("\n") : "尚未查询后台工具状态。"}
    </pre>
  </section>;
}
