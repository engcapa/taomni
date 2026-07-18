import { useEffect, useMemo, useState } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import {
  sockscap,
  type AppStatRow,
  type DomainStatRow,
  type EgressHealthSnapshot,
  type TrafficMinutePoint,
} from "../../lib/sockscap";
import { isTauriRuntime } from "../../lib/runtime";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Fill a 30-minute window with zeros for missing minutes (plan §11 chart). */
function fillSeries(points: TrafficMinutePoint[], minutes: number): TrafficMinutePoint[] {
  const nowMin = Math.floor(Date.now() / 1000 / 60) * 60;
  const byTs = new Map(points.map((p) => [p.minuteTs, p]));
  const out: TrafficMinutePoint[] = [];
  for (let i = minutes - 1; i >= 0; i -= 1) {
    const ts = nowMin - i * 60;
    out.push(
      byTs.get(ts) ?? {
        minuteTs: ts,
        bytesUp: 0,
        bytesDown: 0,
        connections: 0,
        direct: 0,
        proxy: 0,
        block: 0,
        errors: 0,
      },
    );
  }
  return out;
}

/**
 * Dashboard (plan §11): KPIs, 30-minute trend, DIRECT/PROXY/BLOCK distribution,
 * profile status list, optional top domains, hide-to-tray. Numbers come from
 * persisted aggregates + live process counters; no payload or URLs (plan §10).
 */
export function SockscapDashboard() {
  const stats = useSockscapStore((s) => s.stats);
  const profiles = useSockscapStore((s) => s.profiles);
  const captureMode = useSockscapStore((s) => s.captureMode);
  const capturePort = useSockscapStore((s) => s.capturePort);
  const clearStats = useSockscapStore((s) => s.clearStats);
  const refreshStats = useSockscapStore((s) => s.refreshStats);
  const refreshProfiles = useSockscapStore((s) => s.refreshProfiles);

  const [series, setSeries] = useState<TrafficMinutePoint[]>([]);
  const [domains, setDomains] = useState<DomainStatRow[]>([]);
  const [apps, setApps] = useState<AppStatRow[]>([]);
  const [egressHealth, setEgressHealth] = useState<EgressHealthSnapshot | null>(null);
  const [liveConns, setLiveConns] = useState<number | null>(null);
  const [unknownHost, setUnknownHost] = useState(0);

  const loadCharts = async () => {
    try {
      const [raw, top, topApps, health] = await Promise.all([
        sockscap.statsSeries(30),
        sockscap.topDomains(8),
        sockscap.topApps(8),
        sockscap.egressHealth(),
      ]);
      setSeries(fillSeries(raw, 30));
      setDomains(top);
      setApps(topApps);
      setEgressHealth(health);
    } catch {
      setSeries(fillSeries([], 30));
      setDomains([]);
      setApps([]);
    }
  };

  useEffect(() => {
    void refreshProfiles();
    void loadCharts();
  }, [refreshProfiles]);

  // Bounded live refresh while the window is open (plan §11 — ≤1–2 Hz IPC).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const live = await sockscap.liveStats();
        if (!cancelled) {
          setLiveConns(live.connections);
          setUnknownHost(live.unknownHost ?? 0);
        }
        await refreshStats();
        if (!cancelled) await loadCharts();
      } catch {
        /* engine may be disabled */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshStats]);

  const total = stats ? stats.direct + stats.proxy + stats.block : 0;
  const proxyRatio = total > 0 ? Math.round(((stats?.proxy ?? 0) / total) * 100) : 0;
  const unknownRatio =
    total > 0 ? Math.round((unknownHost / Math.max(total, unknownHost, 1)) * 100) : 0;
  const seg = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

  const maxBytes = useMemo(
    () => Math.max(1, ...series.map((p) => p.bytesUp + p.bytesDown)),
    [series],
  );

  const hideToTray = async () => {
    if (!isTauriRuntime()) {
      window.close();
      return;
    }
    try {
      await sockscap.hideWindow();
    } catch (e) {
      console.warn("sockscap hide failed", e);
    }
  };

  return (
    <div className="space-y-5" data-testid="sockscap-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500" data-testid="sockscap-capture-mode">
          Capture: <span className="text-neutral-300">{captureMode ?? "—"}</span>
          {capturePort != null ? (
            <span className="ml-2 font-mono text-neutral-400">127.0.0.1:{capturePort}</span>
          ) : null}
          {" · "}
          Live counters are process-local; charts use minute aggregates (no payloads).
        </p>
        <button
          type="button"
          onClick={() => void hideToTray()}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          data-testid="sockscap-hide-to-tray"
        >
          Hide to tray
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Upload" value={fmtBytes(stats?.bytesUp ?? 0)} />
        <Kpi label="Download" value={fmtBytes(stats?.bytesDown ?? 0)} />
        <Kpi
          label="Connections"
          value={String(liveConns ?? stats?.connections ?? 0)}
        />
        <Kpi label="Proxy ratio" value={`${proxyRatio}%`} />
        <Kpi label="Unknown host %" value={`${unknownRatio}%`} />
        <Kpi label="Errors" value={String(stats?.errors ?? 0)} />
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-300">30-minute bandwidth</h3>
          <span className="text-xs text-neutral-500">up + down per minute</span>
        </div>
        <div className="flex h-24 items-end gap-px" data-testid="sockscap-bandwidth-chart">
          {series.map((p) => {
            const totalB = p.bytesUp + p.bytesDown;
            const h = Math.max(2, Math.round((totalB / maxBytes) * 100));
            return (
              <div
                key={p.minuteTs}
                title={`${new Date(p.minuteTs * 1000).toLocaleTimeString()} · ${fmtBytes(totalB)}`}
                className="flex-1 rounded-t bg-blue-600/80 hover:bg-blue-500"
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-300">Decision distribution</h3>
          <span className="text-xs text-neutral-500">{total} routed</span>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-neutral-800">
          <div className="bg-neutral-500" style={{ width: seg(stats?.direct ?? 0) }} />
          <div className="bg-blue-500" style={{ width: seg(stats?.proxy ?? 0) }} />
          <div className="bg-red-500" style={{ width: seg(stats?.block ?? 0) }} />
        </div>
        <div className="mt-2 flex gap-4 text-xs text-neutral-400">
          <span>DIRECT {stats?.direct ?? 0}</span>
          <span className="text-blue-400">PROXY {stats?.proxy ?? 0}</span>
          <span className="text-red-400">BLOCK {stats?.block ?? 0}</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Profiles</h3>
          <ul className="space-y-1 text-sm" data-testid="sockscap-profile-status">
            {profiles.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-neutral-900"
              >
                <span className="truncate">
                  <span className={p.enabled ? "text-neutral-100" : "text-neutral-500 line-through"}>
                    {p.name}
                  </span>
                  <span className="ml-2 text-xs text-neutral-500">{p.scope}</span>
                </span>
                <span className="text-xs text-neutral-600">
                  #{p.priority}
                  {p.enabled ? " · on" : " · off"}
                </span>
              </li>
            ))}
            {profiles.length === 0 ? (
              <li className="text-neutral-500">No profiles configured.</li>
            ) : null}
          </ul>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Top applications</h3>
          <ul className="space-y-1 text-sm" data-testid="sockscap-top-apps">
            {apps.map((a) => (
              <li key={a.app} className="flex justify-between gap-2 font-mono text-xs">
                <span className="truncate text-neutral-200">{a.app}</span>
                <span className="shrink-0 text-neutral-500">{a.connections}</span>
              </li>
            ))}
            {apps.length === 0 ? (
              <li className="text-neutral-500">No app-attributed flows yet.</li>
            ) : null}
          </ul>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Top domains</h3>
          <p className="mb-2 text-xs text-neutral-500">
            Empty unless a profile enables domain aggregates (privacy off by default).
          </p>
          <ul className="space-y-1 text-sm" data-testid="sockscap-top-domains">
            {domains.map((d) => (
              <li key={d.domain} className="flex justify-between gap-2 font-mono text-xs">
                <span className="truncate text-neutral-200">{d.domain}</span>
                <span className="shrink-0 text-neutral-500">
                  {d.connections} · {fmtBytes(d.bytes)}
                </span>
              </li>
            ))}
            {domains.length === 0 ? (
              <li className="text-neutral-500">No domain aggregates retained.</li>
            ) : null}
          </ul>
        </div>
      </div>

      <div
        className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4"
        data-testid="sockscap-ssh-card"
      >
        <h3 className="mb-2 text-sm font-medium text-neutral-300">Egress / SSH health</h3>
        {egressHealth ? (
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <div className="text-xs text-neutral-500">SSH profiles</div>
              <div className="tabular-nums text-neutral-100">{egressHealth.sshProfiles}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Proxy profiles</div>
              <div className="tabular-nums text-neutral-100">{egressHealth.proxyProfiles}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Known hosts</div>
              <div className="tabular-nums text-neutral-100">{egressHealth.knownHosts}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Host-key changes</div>
              <div className="tabular-nums text-neutral-100">{egressHealth.hostKeyChanges}</div>
            </div>
            <p className="col-span-full text-xs text-neutral-500">{egressHealth.note}</p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Loading egress health…</p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => void clearStats().then(() => loadCharts())}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          data-testid="sockscap-clear-stats"
        >
          Clear statistics
        </button>
      </div>
    </div>
  );
}
