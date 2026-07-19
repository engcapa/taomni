import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  BarChart3,
  Database,
  Eraser,
  EyeOff,
  Globe2,
  LockKeyhole,
  Network,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  SockscapEgressHealthPoint,
  SockscapLiveConnectionSample,
  SockscapStatsSeriesPoint,
  SockscapStatsTopEntry,
} from "../../lib/sockscap";
import {
  downsampleSockscapSeries,
  formatSockscapBytes,
  latestSockscapEgressHealth,
  SOCKSCAP_DASHBOARD_RANGES,
  sockscapActionBreakdown,
  type SockscapDashboardRange,
} from "../../lib/sockscapDashboard";
import { useT } from "../../lib/i18n";
import { useSockscapStore } from "../../stores/sockscapStore";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";

export const SOCKSCAP_DASHBOARD_POLL_INTERVAL_MS = 5_000;

export function SockscapDashboard() {
  const t = useT();
  const profiles = useSockscapStore((state) => state.profiles);
  const stats = useSockscapStore((state) => state.stats);
  const liveConnections = useSockscapStore((state) => state.liveConnections);
  const alerts = useSockscapStore((state) => state.alerts);
  const captureActive = useSockscapStore((state) => state.status?.captureActive ?? false);
  const dashboardLoading = useSockscapStore((state) => state.dashboardLoading);
  const dashboardActionPending = useSockscapStore((state) => state.dashboardActionPending);
  const dashboardError = useSockscapStore((state) => state.dashboardError);
  const refreshDashboard = useSockscapStore((state) => state.refreshDashboard);
  const clearStats = useSockscapStore((state) => state.clearStats);
  const dismissAlert = useSockscapStore((state) => state.dismissAlert);
  const setSection = useSockscapStore((state) => state.setSection);
  const confirmDialog = useConfirmDialog();
  const [range, setRange] = useState<SockscapDashboardRange>("24h");
  const [includeDomains, setIncludeDomains] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rangeSeconds = SOCKSCAP_DASHBOARD_RANGES.find((candidate) => candidate.id === range)?.seconds
    ?? 24 * 60 * 60;
  const domainAggregationAvailable = profiles.some((record) => (
    record.profile.enabled
    && record.profile.statsPrivacy.collectionMode !== "disabled"
    && record.profile.statsPrivacy.domainAggregationEnabled
  ));

  const load = useCallback(() => {
    void refreshDashboard(rangeSeconds, includeDomains && domainAggregationAvailable);
  }, [domainAggregationAvailable, includeDomains, rangeSeconds, refreshDashboard]);

  useEffect(() => {
    if (!domainAggregationAvailable && includeDomains) setIncludeDomains(false);
  }, [domainAggregationAvailable, includeDomains]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!captureActive) return undefined;
    const timer = globalThis.setInterval(load, SOCKSCAP_DASHBOARD_POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [captureActive, load]);

  const handleClear = async () => {
    const confirmed = await confirmDialog.confirm({
      title: t("sockscap.clearStatsTitle"),
      message: t("sockscap.clearStatsMessage"),
      confirmLabel: t("sockscap.clearStats"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await clearStats();
      setNotice(t("sockscap.statsCleared", {
        rows: result.removedRows,
        samples: result.removedLiveSamples,
      }));
    } catch {
      // The store exposes the authoritative command error inline.
    }
  };

  const totals = stats?.totals ?? EMPTY_TOTALS;
  const actions = sockscapActionBreakdown(totals);
  const chartSeries = useMemo(() => downsampleSockscapSeries(stats?.series ?? []), [stats?.series]);
  const latestHealth = useMemo(() => latestSockscapEgressHealth(stats?.egressHealth ?? []), [stats?.egressHealth]);
  const profileNames = useMemo(() => new Map(
    profiles.map((record) => [record.profile.id, record.profile.name]),
  ), [profiles]);
  const averageConnectMillis = totals.connections > 0
    ? Math.round(totals.connectMillisTotal / totals.connections)
    : 0;
  const privacyCounts = profiles.reduce((counts, record) => {
    counts[record.profile.statsPrivacy.collectionMode] += 1;
    return counts;
  }, { persisted: 0, session_only: 0, disabled: 0 });

  return (
    <div className="mx-auto max-w-7xl space-y-4" data-testid="sockscap-dashboard">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("sockscap.dashboardTitle")}</h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[var(--taomni-text-muted)]">
            {t("sockscap.dashboardDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-2 text-[11px]">
            <span className="text-[var(--taomni-text-muted)]">{t("sockscap.timeRange")}</span>
            <select
              data-testid="sockscap-dashboard-range"
              aria-label={t("sockscap.timeRange")}
              value={range}
              onChange={(event) => setRange(event.target.value as SockscapDashboardRange)}
              className="rounded-md border bg-transparent px-2 py-1.5"
              style={{ borderColor: "var(--taomni-input-border)" }}
            >
              {SOCKSCAP_DASHBOARD_RANGES.map((option) => (
                <option key={option.id} value={option.id}>{t(option.labelKey)}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="sockscap-dashboard-refresh"
            onClick={load}
            disabled={dashboardLoading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] disabled:opacity-50"
            style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-button-from)" }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${dashboardLoading ? "animate-spin" : ""}`} />
            {t("common.refresh")}
          </button>
          <button
            type="button"
            data-testid="sockscap-clear-stats"
            onClick={() => void handleClear()}
            disabled={dashboardActionPending !== null}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] text-red-700 disabled:opacity-50"
            style={{ borderColor: "rgba(220, 38, 38, 0.35)", background: "rgba(220, 38, 38, 0.07)" }}
          >
            <Eraser className="h-3.5 w-3.5" />
            {t("sockscap.clearStats")}
          </button>
        </div>
      </div>

      {dashboardError && <Notice tone="error">{dashboardError}</Notice>}
      {notice && (
        <Notice tone="success">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" data-testid="sockscap-dashboard-notice-dismiss" aria-label={t("common.close")} onClick={() => setNotice(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </Notice>
      )}

      <section
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3"
        style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}
      >
        <div className="flex items-center gap-2 text-[11px] font-semibold">
          <LockKeyhole className="h-4 w-4 text-[var(--taomni-accent)]" />
          {t("sockscap.privacyControls")}
        </div>
        <span className="text-[10px] text-[var(--taomni-text-muted)]">
          {t("sockscap.collectionSummary", privacyCounts)}
        </span>
        <label className={`flex items-center gap-2 text-[10px] ${domainAggregationAvailable ? "" : "opacity-55"}`}>
          <input
            type="checkbox"
            data-testid="sockscap-domain-aggregation-toggle"
            checked={includeDomains}
            disabled={!domainAggregationAvailable}
            onChange={(event) => setIncludeDomains(event.target.checked)}
          />
          {t("sockscap.showDomainAggregates")}
        </label>
        <span className="min-w-[220px] flex-1 text-[10px] text-[var(--taomni-text-muted)]">
          {domainAggregationAvailable
            ? t("sockscap.domainAggregationAvailable")
            : t("sockscap.domainAggregationUnavailable")}
        </span>
        <button
          type="button"
          data-testid="sockscap-dashboard-privacy-settings"
          onClick={() => setSection("profiles")}
          className="text-[10px] font-medium text-[var(--taomni-accent)] hover:underline"
        >
          {t("sockscap.editPrivacySettings")}
        </button>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={t("sockscap.totalTraffic")} value={formatSockscapBytes(totals.bytesUp + totals.bytesDown)} detail={`${formatSockscapBytes(totals.bytesUp)} ↑ · ${formatSockscapBytes(totals.bytesDown)} ↓`} />
        <Metric label={t("sockscap.connections")} value={totals.connections.toLocaleString()} detail={t("sockscap.unknownHostnameCount", { count: totals.unknownHostnameConnections })} />
        <Metric label={t("sockscap.averageConnectTime")} value={`${averageConnectMillis.toLocaleString()} ms`} detail={t("sockscap.boundedAggregate")} />
        <Metric label={t("sockscap.errors")} value={totals.errors.toLocaleString()} detail={t("sockscap.selectedRange")} tone={totals.errors > 0 ? "warning" : "normal"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.75fr)]">
        <DashboardPanel title={t("sockscap.bandwidthTrend")} icon={<BarChart3 className="h-4 w-4" />}>
          <BandwidthChart series={chartSeries} />
        </DashboardPanel>
        <DashboardPanel title={t("sockscap.actionDistribution")} icon={<ShieldCheck className="h-4 w-4" />}>
          <div className="space-y-3">
            <ActionBar label="DIRECT" value={actions.direct} total={actions.classifiedTotal} color="#10b981" />
            <ActionBar label="PROXY" value={actions.proxy} total={actions.classifiedTotal} color="#3b82f6" />
            <ActionBar label="BLOCK" value={actions.block} total={actions.classifiedTotal} color="#ef4444" />
            <div className="border-t pt-3 text-[10px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-card-border)" }}>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5"><EyeOff className="h-3.5 w-3.5" />{t("sockscap.unknownHostname")}</span>
                <strong className="text-[var(--taomni-text)]">{actions.unknownHostname.toLocaleString()}</strong>
              </div>
              <p className="mt-1.5 leading-4">{t("sockscap.unknownIsAttribution")}</p>
            </div>
          </div>
        </DashboardPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardPanel title={t("sockscap.topApplications")} icon={<AppWindow className="h-4 w-4" />}>
          <RankedList entries={stats?.topApplications ?? []} empty={t("sockscap.noApplicationStats")} />
        </DashboardPanel>
        <DashboardPanel title={t("sockscap.topDomains")} icon={<Globe2 className="h-4 w-4" />}>
          {!domainAggregationAvailable ? (
            <Empty>{t("sockscap.domainStatsDisabled")}</Empty>
          ) : !includeDomains ? (
            <Empty>{t("sockscap.enableDomainView")}</Empty>
          ) : (
            <RankedList entries={stats?.topDomains ?? []} empty={t("sockscap.noDomainStats")} />
          )}
        </DashboardPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardPanel title={t("sockscap.upstreamRuntimeHealth")} icon={<Activity className="h-4 w-4" />}>
          <EgressHealthList points={latestHealth} profileNames={profileNames} />
        </DashboardPanel>
        <DashboardPanel title={t("sockscap.alerts")} icon={<AlertTriangle className="h-4 w-4" />}>
          {alerts.length === 0 ? <Empty>{t("sockscap.noAlerts")}</Empty> : (
            <div className="max-h-64 space-y-2 overflow-auto">
              {alerts.map((alert) => (
                <div key={`${alert.createdAtUnix}-${alert.code}`} className="flex items-start gap-2 rounded-md border p-2.5" style={{ borderColor: "var(--taomni-card-border)" }}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold">{alert.code}</div>
                    <div className="mt-0.5 break-words text-[10px] leading-4 text-[var(--taomni-text-muted)]">{alert.message}</div>
                    <time className="mt-1 block text-[9px] text-[var(--taomni-text-muted)]">{formatTime(alert.createdAtUnix)}</time>
                  </div>
                  <button type="button" data-testid="sockscap-dashboard-alert-dismiss" aria-label={t("sockscap.dismissAlert")} onClick={() => dismissAlert(alert.createdAtUnix, alert.code)}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </DashboardPanel>
      </div>

      <DashboardPanel title={t("sockscap.liveConnectionsTitle")} icon={<Network className="h-4 w-4" />}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--taomni-text-muted)]">
          <span>{t("sockscap.liveConnectionsDescription")}</span>
          <span>
            {t("sockscap.sampleCapacity", {
              count: liveConnections?.samples.length ?? 0,
              capacity: liveConnections?.capacity ?? 256,
              dropped: liveConnections?.droppedSamples ?? 0,
            })}
          </span>
        </div>
        <LiveConnectionsTable samples={liveConnections?.samples ?? []} profileNames={profileNames} />
      </DashboardPanel>

      {confirmDialog.render}
    </div>
  );
}

const EMPTY_TOTALS = {
  bytesUp: 0,
  bytesDown: 0,
  connections: 0,
  errors: 0,
  directConnections: 0,
  proxyConnections: 0,
  blockedConnections: 0,
  unknownHostnameConnections: 0,
  connectMillisTotal: 0,
};

function DashboardPanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-card-border)" }}>
        <span className="text-[var(--taomni-accent)]">{icon}</span>
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Metric({ label, value, detail, tone = "normal" }: { label: string; value: string; detail: string; tone?: "normal" | "warning" }) {
  return (
    <div className="rounded-lg border p-3" style={{ background: "var(--taomni-card-bg)", borderColor: tone === "warning" ? "rgba(245, 158, 11, 0.5)" : "var(--taomni-card-border)" }}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</div>
      <div className="mt-1.5 truncate text-[17px] font-semibold">{value}</div>
      <div className="mt-1 truncate text-[9px] text-[var(--taomni-text-muted)]">{detail}</div>
    </div>
  );
}

function BandwidthChart({ series }: { series: SockscapStatsSeriesPoint[] }) {
  const t = useT();
  if (series.length === 0) return <Empty>{t("sockscap.noTrafficStats")}</Empty>;
  const width = 720;
  const height = 180;
  const inset = 12;
  const max = Math.max(1, ...series.flatMap((point) => [point.bytesUp, point.bytesDown]));
  const points = (key: "bytesUp" | "bytesDown") => series.map((point, index) => {
    const x = series.length === 1 ? width / 2 : inset + index * ((width - inset * 2) / (series.length - 1));
    const y = height - inset - (point[key] / max) * (height - inset * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t("sockscap.bandwidthChartLabel")}
        className="h-48 w-full"
        preserveAspectRatio="none"
      >
        <title>{t("sockscap.bandwidthChartLabel")}</title>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line key={fraction} x1={inset} x2={width - inset} y1={height * fraction} y2={height * fraction} stroke="var(--taomni-card-border)" strokeWidth="1" />
        ))}
        <polyline points={points("bytesDown")} fill="none" stroke="#3b82f6" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        <polyline points={points("bytesUp")} fill="none" stroke="#10b981" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-[var(--taomni-text-muted)]">
        <span>{formatTime(series[0].bucketStart)} — {formatTime(series.at(-1)?.bucketStart ?? series[0].bucketStart)}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-blue-500" />{t("sockscap.download")}</span>
          <span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" />{t("sockscap.upload")}</span>
          <span>{t("sockscap.chartPeak", { value: formatSockscapBytes(max) })}</span>
        </span>
      </div>
    </div>
  );
}

function ActionBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const percent = Math.min(100, Math.max(0, (value / total) * 100));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px]">
        <span className="font-semibold">{label}</span>
        <span>{value.toLocaleString()} · {percent.toFixed(1)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--taomni-hover)]">
        <div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
}

function RankedList({ entries, empty }: { entries: SockscapStatsTopEntry[]; empty: string }) {
  if (entries.length === 0) return <Empty>{empty}</Empty>;
  const max = Math.max(1, ...entries.map((entry) => entry.bytesUp + entry.bytesDown));
  return (
    <ol className="space-y-2.5">
      {entries.slice(0, 10).map((entry, index) => {
        const bytes = entry.bytesUp + entry.bytesDown;
        return (
          <li key={entry.key} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
            <span className="text-right text-[var(--taomni-text-muted)]">{index + 1}</span>
            <div className="min-w-0">
              <div className="truncate font-medium" title={entry.key}>{entry.key}</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--taomni-hover)]">
                <div className="h-full rounded-full bg-[var(--taomni-accent)]" style={{ width: `${Math.max(2, (bytes / max) * 100)}%` }} />
              </div>
            </div>
            <span className="text-right text-[var(--taomni-text-muted)]">{formatSockscapBytes(bytes)} · {entry.connections.toLocaleString()}</span>
          </li>
        );
      })}
    </ol>
  );
}

function EgressHealthList({ points, profileNames }: { points: SockscapEgressHealthPoint[]; profileNames: Map<string, string> }) {
  const t = useT();
  if (points.length === 0) return <Empty>{t("sockscap.noEgressRuntimeStats")}</Empty>;
  return (
    <div className="space-y-2">
      {points.map((point) => {
        const handshake = point.handshakeSamples > 0 ? Math.round(point.handshakeMillisTotal / point.handshakeSamples) : null;
        const degraded = point.controlState !== "healthy" || point.channelErrors > 0 || point.lastErrorCode !== null;
        return (
          <div key={point.profileId} className="rounded-md border p-3" style={{ borderColor: degraded ? "rgba(245, 158, 11, 0.5)" : "var(--taomni-card-border)" }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold">{profileNames.get(point.profileId) ?? point.profileId}</div>
                <div className="mt-0.5 text-[9px] uppercase text-[var(--taomni-text-muted)]">{point.egressKind.replaceAll("_", " ")}</div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase ${degraded ? "bg-amber-500/15 text-amber-700" : "bg-emerald-500/15 text-emerald-700"}`}>
                {point.controlState.replaceAll("_", " ")}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-[9px] sm:grid-cols-4">
              <HealthMetric label={t("sockscap.controlsChannels")} value={`${point.activeControlsMax} / ${point.activeChannelsMax}`} />
              <HealthMetric label={t("sockscap.channelErrorsReconnects")} value={`${point.channelErrors} / ${point.reconnects}`} />
              <HealthMetric label={t("sockscap.handshakeRtt")} value={handshake === null ? "—" : `${handshake} ms`} />
              <HealthMetric label={t("sockscap.hostKeyState")} value={point.hostKeyState ?? "—"} />
            </dl>
            {point.lastErrorCode && <div className="mt-2 break-words text-[9px] text-amber-700">{point.lastErrorCode}</div>}
          </div>
        );
      })}
    </div>
  );
}

function HealthMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--taomni-text-muted)]">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold" title={value}>{value}</dd>
    </div>
  );
}

function LiveConnectionsTable({ samples, profileNames }: { samples: SockscapLiveConnectionSample[]; profileNames: Map<string, string> }) {
  const t = useT();
  if (samples.length === 0) return <Empty>{t("sockscap.noLiveSamples")}</Empty>;
  return (
    <div className="max-h-80 overflow-auto rounded-md border" style={{ borderColor: "var(--taomni-card-border)" }}>
      <table className="w-full min-w-[820px] border-collapse text-left text-[10px]">
        <thead className="sticky top-0 bg-[var(--taomni-card-bg)] text-[var(--taomni-text-muted)]">
          <tr>
            <TableHead>{t("sockscap.observed")}</TableHead>
            <TableHead>{t("sockscap.routingProfile")}</TableHead>
            <TableHead>{t("sockscap.protocol")}</TableHead>
            <TableHead>{t("sockscap.hostnameSource")}</TableHead>
            <TableHead>{t("sockscap.policyEffective")}</TableHead>
            <TableHead>{t("sockscap.outcome")}</TableHead>
            <TableHead>{t("sockscap.connector")}</TableHead>
            <TableHead>{t("sockscap.latency")}</TableHead>
          </tr>
        </thead>
        <tbody>
          {samples.map((sample) => (
            <tr key={sample.sampleId} className="border-t" style={{ borderColor: "var(--taomni-card-border)" }}>
              <TableCell>{formatTime(sample.observedAtUnix)}</TableCell>
              <TableCell>{profileNames.get(sample.profileId) ?? sample.profileId}</TableCell>
              <TableCell>{sample.protocol.toUpperCase()}</TableCell>
              <TableCell>{sample.hostnameSource.replaceAll("_", " ")}</TableCell>
              <TableCell>
                <span className="font-semibold">{sample.policyAction.toUpperCase()}</span>
                {sample.effectiveAction !== sample.policyAction ? ` → ${sample.effectiveAction.toUpperCase()}` : ""}
              </TableCell>
              <TableCell>
                <span className={sample.outcome === "failed" || sample.outcome === "blocked" ? "text-red-600" : "text-emerald-600"}>
                  {sample.outcome.replaceAll("_", " ")}
                </span>
                {sample.errorCode ? <span className="ml-1 text-red-600">· {sample.errorCode}</span> : null}
              </TableCell>
              <TableCell>{sample.connector?.replaceAll("_", " ") ?? "—"}</TableCell>
              <TableCell>{sample.connectMillis.toLocaleString()} ms</TableCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableHead({ children }: { children: ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2 font-medium">{children}</th>;
}

function TableCell({ children }: { children: ReactNode }) {
  return <td className="max-w-52 truncate whitespace-nowrap px-3 py-2" title={typeof children === "string" ? children : undefined}>{children}</td>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="py-7 text-center text-[10px] text-[var(--taomni-text-muted)]">{children}</div>;
}

function Notice({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="flex items-center gap-2 rounded-md border px-3 py-2 text-[11px]"
      style={tone === "error"
        ? { background: "rgba(220, 38, 38, 0.08)", borderColor: "rgba(220, 38, 38, 0.4)", color: "#b91c1c" }
        : { background: "var(--taomni-success-bg)", borderColor: "rgba(16, 185, 129, 0.35)", color: "var(--taomni-success-text)" }}
    >
      {tone === "error" ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Database className="h-4 w-4 shrink-0" />}
      {children}
    </div>
  );
}

function formatTime(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(unix * 1000));
}
