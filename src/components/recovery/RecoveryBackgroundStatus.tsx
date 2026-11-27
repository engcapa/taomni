import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "../ui/Button";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "../../lib/servers";
import type { TunnelStatusInfo } from "../../lib/tunnel";
import type { SocksCapStatus } from "../../lib/sockscap";
import { boundedUtf8 } from "../../lib/runtimeRecovery";

/** Loaded only in recovery. Three existing read-only queries, on user request. */
export function RecoveryBackgroundStatus() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Array<{ key: string } | { detail: string }>>([]);
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
    const rows: typeof status = [];
    if (servers.status === "fulfilled") {
      rows.push({ key: servers.value.length ? "serversPresent" : "serversEmpty" });
      for (const item of servers.value.slice(0, 128)) rows.push({ detail: `${item.serverType}: ${item.status}${item.pid ? ` (PID ${item.pid})` : ""}` });
      if (servers.value.length > 128) rows.push({ key: "serversLimit" });
    } else rows.push({ key: "serversFailed" });
    if (tunnels.status === "fulfilled") {
      rows.push({ key: tunnels.value.length ? "tunnelsPresent" : "tunnelsEmpty" });
      for (const item of tunnels.value.slice(0, 128)) rows.push({ detail: `${boundedUtf8(item.id, 256)}: ${item.status}` });
      if (tunnels.value.length > 128) rows.push({ key: "tunnelsLimit" });
    } else rows.push({ key: "tunnelsFailed" });
    rows.push(socks.status === "fulfilled"
      ? { detail: `SocksCap: ${socks.value.phase} — ${boundedUtf8(socks.value.message, 512)}` }
      : { key: "socksFailed" });
    setStatus(rows);
    setBusy(false);
  };
  return <section aria-label={t("recovery.tools")}>
    <p>{t("recovery.toolsHint")}</p>
    <Button data-testid="recovery-background-refresh" busy={busy} onClick={() => void refresh()}>
      {t(busy ? "recovery.reading" : "recovery.refresh")}
    </Button>
    <pre data-testid="recovery-background-status" aria-live="polite" style={{ whiteSpace: "pre-wrap" }}>
      {status.length ? status.map((row) => "detail" in row ? row.detail : t(`recovery.${row.key}`)).join("\n") : t("recovery.unqueried")}
    </pre>
  </section>;
}
