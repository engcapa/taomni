import type {
  SockscapEgressHealthPoint,
  SockscapStatsSeriesPoint,
  SockscapStatsTotals,
} from "./sockscap";

export type SockscapDashboardRange = "30m" | "6h" | "24h" | "7d";

export const SOCKSCAP_DASHBOARD_RANGES: ReadonlyArray<{
  id: SockscapDashboardRange;
  seconds: number;
  labelKey: "sockscap.range30m" | "sockscap.range6h" | "sockscap.range24h" | "sockscap.range7d";
}> = [
  { id: "30m", seconds: 30 * 60, labelKey: "sockscap.range30m" },
  { id: "6h", seconds: 6 * 60 * 60, labelKey: "sockscap.range6h" },
  { id: "24h", seconds: 24 * 60 * 60, labelKey: "sockscap.range24h" },
  { id: "7d", seconds: 7 * 24 * 60 * 60, labelKey: "sockscap.range7d" },
];

export interface SockscapActionBreakdown {
  direct: number;
  proxy: number;
  block: number;
  unknownHostname: number;
  classifiedTotal: number;
}

export function sockscapActionBreakdown(totals: SockscapStatsTotals): SockscapActionBreakdown {
  const direct = finiteCount(totals.directConnections);
  const proxy = finiteCount(totals.proxyConnections);
  const block = finiteCount(totals.blockedConnections);
  return {
    direct,
    proxy,
    block,
    unknownHostname: finiteCount(totals.unknownHostnameConnections),
    classifiedTotal: Math.max(1, direct + proxy + block),
  };
}

/** Aggregate adjacent points so the chart DOM stays bounded on long ranges. */
export function downsampleSockscapSeries(
  series: SockscapStatsSeriesPoint[],
  maxPoints = 96,
): SockscapStatsSeriesPoint[] {
  if (maxPoints < 1 || series.length === 0) return [];
  const ordered = [...series].sort((left, right) => left.bucketStart - right.bucketStart
    || left.resolutionSeconds - right.resolutionSeconds);
  if (ordered.length <= maxPoints) return ordered;
  const groupSize = Math.ceil(ordered.length / maxPoints);
  const result: SockscapStatsSeriesPoint[] = [];
  for (let index = 0; index < ordered.length; index += groupSize) {
    const group = ordered.slice(index, index + groupSize);
    result.push(group.reduce<SockscapStatsSeriesPoint>((total, point) => ({
      bucketStart: total.bucketStart,
      resolutionSeconds: total.resolutionSeconds + point.resolutionSeconds,
      bytesUp: total.bytesUp + finiteCount(point.bytesUp),
      bytesDown: total.bytesDown + finiteCount(point.bytesDown),
      connections: total.connections + finiteCount(point.connections),
      errors: total.errors + finiteCount(point.errors),
      directConnections: total.directConnections + finiteCount(point.directConnections),
      proxyConnections: total.proxyConnections + finiteCount(point.proxyConnections),
      blockedConnections: total.blockedConnections + finiteCount(point.blockedConnections),
    }), {
      bucketStart: group[0].bucketStart,
      resolutionSeconds: 0,
      bytesUp: 0,
      bytesDown: 0,
      connections: 0,
      errors: 0,
      directConnections: 0,
      proxyConnections: 0,
      blockedConnections: 0,
    }));
  }
  return result;
}

export function latestSockscapEgressHealth(
  points: SockscapEgressHealthPoint[],
): SockscapEgressHealthPoint[] {
  const latest = new Map<string, SockscapEgressHealthPoint>();
  for (const point of points) {
    const current = latest.get(point.profileId);
    if (!current || point.bucketStart > current.bucketStart) latest.set(point.profileId, point);
  }
  return [...latest.values()].sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export function formatSockscapBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
