import { useSockscapStore } from "../../stores/sockscapStore";

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

/**
 * Dashboard (plan §11): KPIs (up/down, connections, proxy ratio, errors) and
 * the DIRECT/PROXY/BLOCK distribution. Numbers come from persisted aggregates;
 * no payload or URLs are ever shown (plan §10).
 */
export function SockscapDashboard() {
  const stats = useSockscapStore((s) => s.stats);
  const clearStats = useSockscapStore((s) => s.clearStats);

  const total = stats ? stats.direct + stats.proxy + stats.block : 0;
  const proxyRatio = total > 0 ? Math.round(((stats?.proxy ?? 0) / total) * 100) : 0;

  const seg = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Upload" value={fmtBytes(stats?.bytesUp ?? 0)} />
        <Kpi label="Download" value={fmtBytes(stats?.bytesDown ?? 0)} />
        <Kpi label="Connections" value={String(stats?.connections ?? 0)} />
        <Kpi label="Proxy ratio" value={`${proxyRatio}%`} />
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
          <span className="ml-auto text-neutral-500">Errors {stats?.errors ?? 0}</span>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => void clearStats()}
          className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Clear statistics
        </button>
      </div>
    </div>
  );
}
