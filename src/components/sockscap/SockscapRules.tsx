import { useEffect, useState } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import {
  sockscap,
  type RuleSourceMeta,
  type TestTargetResult,
} from "../../lib/sockscap";

const inputCls =
  "rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100";

/**
 * Rules & test-target (plan §6, §11): rule-source status + refresh, and the
 * "test target" explainer that shows the matched profile, rule source, rule
 * text, hostname source and final action (plan §16.3-13).
 */
export function SockscapRules() {
  const ruleSources = useSockscapStore((s) => s.ruleSources);
  const refreshRuleSources = useSockscapStore((s) => s.refreshRuleSources);

  const [meta, setMeta] = useState<Record<string, RuleSourceMeta>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    void refreshRuleSources();
  }, [refreshRuleSources]);

  const refresh = async (id: string) => {
    setRefreshing(id);
    try {
      const m = await sockscap.refreshRuleSource(id);
      setMeta((prev) => ({ ...prev, [id]: m }));
    } catch (e) {
      setMeta((prev) => ({
        ...prev,
        [id]: {
          unsupportedExamples: [],
          lastError: typeof e === "string" ? e : String(e),
        },
      }));
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Rule sources</h3>
        <div className="space-y-2">
          {ruleSources.map((src) => {
            const m = meta[src.id];
            return (
              <div key={src.id} className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{src.name}</div>
                    <div className="text-xs text-neutral-500">
                      {src.kind}
                      {m?.mirrorUrl ? ` · ${m.mirrorUrl}` : ""}
                    </div>
                  </div>
                  <button
                    disabled={refreshing === src.id}
                    onClick={() => void refresh(src.id)}
                    className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {refreshing === src.id ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                {m?.stats ? (
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-neutral-400">
                    <span>{m.stats.domainRules} domains</span>
                    <span>{m.stats.exceptionRules} exceptions</span>
                    <span>{m.stats.ipRules} IPs</span>
                    <span className="text-amber-400/80">{m.stats.unsupported} unsupported</span>
                    {m.lastGoodAt ? (
                      <span className="text-neutral-500">
                        updated {new Date(m.lastGoodAt * 1000).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {m?.lastError ? (
                  <div className="mt-2 text-xs text-red-400">{m.lastError} (kept last-good)</div>
                ) : null}
                {m?.unsupportedExamples && m.unsupportedExamples.length > 0 ? (
                  <details className="mt-2 text-xs text-neutral-500">
                    <summary className="cursor-pointer">unsupported examples</summary>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      {m.unsupportedExamples.slice(0, 8).map((ex, i) => (
                        <li key={i} className="font-mono">
                          {ex}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            );
          })}
          {ruleSources.length === 0 ? (
            <p className="text-sm text-neutral-500">No rule sources configured.</p>
          ) : null}
        </div>
      </section>

      <TestTarget />
    </div>
  );
}

function TestTarget() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(443);
  const [appIdentity, setAppIdentity] = useState("");
  const [result, setResult] = useState<TestTargetResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      const app = appIdentity.trim()
        ? {
            // Populate the common platform fields; unused ones are ignored by matchers.
            windowsExe: appIdentity.trim(),
            macosAppPath: appIdentity.trim(),
            linuxPath: appIdentity.trim(),
          }
        : undefined;
      const r = await sockscap.testTarget({ host: host || undefined, port, app });
      setResult(r);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const actionColor =
    result?.action === "proxy"
      ? "text-blue-400"
      : result?.action === "block"
        ? "text-red-400"
        : "text-neutral-200";

  return (
    <section className="rounded-lg border border-neutral-800 p-4">
      <h3 className="mb-3 text-sm font-medium text-neutral-300">Test target</h3>
      <p className="mb-3 text-xs text-neutral-500">
        Explains which profile and rule would apply (plan §6.3). Optional app identity selects the
        applications / runtime-processes profile the same way live traffic would.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col">
          <span className="mb-1 text-xs text-neutral-500">App identity (optional)</span>
          <input
            className={`${inputCls} min-w-[220px]`}
            placeholder="C:\…\chrome.exe or /usr/bin/curl"
            value={appIdentity}
            onChange={(e) => setAppIdentity(e.target.value)}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-1 text-xs text-neutral-500">Host or IP</span>
          <input
            className={inputCls}
            placeholder="mail.google.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </label>
        <label className="flex flex-col">
          <span className="mb-1 text-xs text-neutral-500">Port</span>
          <input
            type="number"
            className={`${inputCls} w-24`}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </label>
        <button
          onClick={() => void run()}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
        >
          Test
        </button>
      </div>

      {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}

      {result ? (
        <dl className="mt-4 grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500">Action</dt>
          <dd className={`font-semibold uppercase ${actionColor}`}>{result.action}</dd>
          <dt className="text-neutral-500">Reason</dt>
          <dd>{result.reason}</dd>
          <dt className="text-neutral-500">Profile</dt>
          <dd>{result.profileId ?? "— none —"}</dd>
          <dt className="text-neutral-500">Hostname source</dt>
          <dd>{result.hostnameSource}</dd>
          {result.matchedSourceId ? (
            <>
              <dt className="text-neutral-500">Rule source</dt>
              <dd>{result.matchedSourceId}</dd>
            </>
          ) : null}
          {result.matchedPattern ? (
            <>
              <dt className="text-neutral-500">Matched rule</dt>
              <dd className="font-mono text-xs">{result.matchedPattern}</dd>
            </>
          ) : null}
          {result.note ? (
            <>
              <dt className="text-neutral-500">Note</dt>
              <dd className="text-neutral-400">{result.note}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
