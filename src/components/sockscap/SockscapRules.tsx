import { useEffect, useState } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import {
  sockscap,
  type CustomRule,
  type EgressTestResult,
  type RuleDirection,
  type RuleSource,
  type RuleSourceKind,
  type RuleSourceMeta,
  type TestTargetResult,
} from "../../lib/sockscap";

const inputCls =
  "rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100";
const btnSecondary =
  "rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50";

/**
 * Rules & lifecycle (plan §6, §11): rule-source status/CRUD/refresh, custom
 * override rules per profile, egress preflight, and test-target explainer.
 */
export function SockscapRules() {
  const ruleSources = useSockscapStore((s) => s.ruleSources);
  const profiles = useSockscapStore((s) => s.profiles);
  const refreshRuleSources = useSockscapStore((s) => s.refreshRuleSources);
  const refreshProfiles = useSockscapStore((s) => s.refreshProfiles);

  const [meta, setMeta] = useState<Record<string, RuleSourceMeta>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    void refreshRuleSources();
    void refreshProfiles();
  }, [refreshRuleSources, refreshProfiles]);

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
    <div className="space-y-6" data-testid="sockscap-rules">
      <RuleSourcePanel
        ruleSources={ruleSources}
        meta={meta}
        refreshing={refreshing}
        onRefresh={(id) => void refresh(id)}
        onChanged={() => void refreshRuleSources()}
      />
      <CustomRulesPanel profiles={profiles.map((p) => ({ id: p.id, name: p.name }))} />
      <EgressTestPanel />
      <TestTarget />
    </div>
  );
}

function RuleSourcePanel({
  ruleSources,
  meta,
  refreshing,
  onRefresh,
  onChanged,
}: {
  ruleSources: RuleSource[];
  meta: Record<string, RuleSourceMeta>;
  refreshing: string | null;
  onRefresh: (id: string) => void;
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<RuleSourceKind>("custom-url");
  const [error, setError] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [importText, setImportText] = useState("");

  const addSource = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const id = `src-${Date.now().toString(36)}`;
    try {
      await sockscap.upsertRuleSource({
        id,
        name: name.trim(),
        kind,
        urls: url.trim() ? [url.trim()] : [],
        localPath: null,
        enabled: true,
        minRefreshSecs: 6 * 60 * 60,
      });
      setName("");
      setUrl("");
      setShowAdd(false);
      onChanged();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const remove = async (id: string) => {
    if (id === "gfwlist-official") {
      setError("Built-in GFWList cannot be deleted; disable it instead or leave unused.");
      return;
    }
    try {
      await sockscap.deleteRuleSource(id);
      onChanged();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const doImport = async () => {
    if (!importId || !importText.trim()) return;
    setError(null);
    try {
      await sockscap.importRuleSource(importId, importText);
      setImportId(null);
      setImportText("");
      onChanged();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-300">Rule sources</h3>
        <button type="button" className={btnSecondary} onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add source"}
        </button>
      </div>
      {error ? <div className="mb-2 text-xs text-red-400">{error}</div> : null}
      {showAdd ? (
        <div className="mb-3 space-y-2 rounded border border-neutral-800 p-3">
          <input
            className={`${inputCls} w-full`}
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className={`${inputCls} w-full`}
            value={kind}
            onChange={(e) => setKind(e.target.value as RuleSourceKind)}
          >
            <option value="custom-url">Custom URL (AutoProxy / GFWList)</option>
            <option value="local-auto-proxy">Local AutoProxy (import content)</option>
            <option value="local-domain-list">Local domain list</option>
          </select>
          {kind === "custom-url" ? (
            <input
              className={`${inputCls} w-full`}
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          ) : null}
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium hover:bg-blue-500"
            onClick={() => void addSource()}
          >
            Save source
          </button>
        </div>
      ) : null}
      <div className="space-y-2">
        {ruleSources.map((src) => {
          const m = meta[src.id];
          return (
            <div key={src.id} className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{src.name}</div>
                  <div className="text-xs text-neutral-500">
                    {src.kind}
                    {m?.mirrorUrl ? ` · ${m.mirrorUrl}` : ""}
                    {src.urls[0] ? ` · ${src.urls[0]}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    disabled={refreshing === src.id}
                    onClick={() => onRefresh(src.id)}
                    className={btnSecondary}
                  >
                    {refreshing === src.id ? "Refreshing…" : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={() => {
                      setImportId(src.id);
                      setImportText("");
                    }}
                  >
                    Import…
                  </button>
                  {src.id !== "gfwlist-official" ? (
                    <button type="button" className={btnSecondary} onClick={() => void remove(src.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
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
              {importId === src.id ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    className={`${inputCls} w-full font-mono text-xs`}
                    rows={4}
                    placeholder="Paste AutoProxy / domain list content…"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button type="button" className={btnSecondary} onClick={() => void doImport()}>
                      Apply import
                    </button>
                    <button type="button" className={btnSecondary} onClick={() => setImportId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {ruleSources.length === 0 ? (
          <p className="text-sm text-neutral-500">No rule sources configured.</p>
        ) : null}
      </div>
    </section>
  );
}

function CustomRulesPanel({ profiles }: { profiles: { id: string; name: string }[] }) {
  const [profileId, setProfileId] = useState("");
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [patternType, setPatternType] = useState<"domain-suffix" | "domain-exact" | "ip" | "cidr">(
    "domain-suffix",
  );
  const [action, setAction] = useState<RuleDirection>("proxy");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profileId && profiles[0]) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  useEffect(() => {
    if (!profileId) {
      setRules([]);
      return;
    }
    void sockscap
      .getCustomRules(profileId)
      .then(setRules)
      .catch(() => setRules([]));
  }, [profileId]);

  const persist = async (next: CustomRule[]) => {
    if (!profileId) return;
    setBusy(true);
    setError(null);
    try {
      const ordered = next.map((r, i) => ({ ...r, order: i }));
      await sockscap.setCustomRules(profileId, ordered);
      setRules(ordered);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const value = pattern.trim();
    if (!value) return;
    const rule: CustomRule = {
      id: `rule-${Date.now().toString(36)}`,
      order: rules.length,
      pattern: { type: patternType, value },
      action,
      note: null,
      enabled: true,
    };
    void persist([...rules, rule]);
    setPattern("");
  };

  const remove = (id: string) => {
    void persist(rules.filter((r) => r.id !== id));
  };

  const toggle = (id: string) => {
    void persist(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  return (
    <section className="rounded-lg border border-neutral-800 p-4" data-testid="sockscap-custom-rules">
      <h3 className="mb-2 text-sm font-medium text-neutral-300">Custom override rules</h3>
      <p className="mb-3 text-xs text-neutral-500">
        First-match wins, ahead of subscription rules (plan §6.3, §16.3-11).
      </p>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-neutral-500">Profile</span>
        <select
          className={`${inputCls} w-full max-w-md`}
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
        >
          {profiles.length === 0 ? <option value="">— no profiles —</option> : null}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {error ? <div className="mb-2 text-xs text-red-400">{error}</div> : null}
      <ul className="mb-3 space-y-1">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs"
          >
            <span className={r.enabled ? "text-neutral-200" : "text-neutral-500 line-through"}>
              <span className="uppercase text-neutral-500">{r.action}</span>{" "}
              <span className="font-mono">
                {r.pattern.type}:{r.pattern.value}
              </span>
            </span>
            <span className="flex gap-2">
              <button type="button" className="text-neutral-400 hover:text-neutral-200" onClick={() => toggle(r.id)}>
                {r.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" className="text-red-300 hover:text-red-200" onClick={() => remove(r.id)}>
                Remove
              </button>
            </span>
          </li>
        ))}
        {rules.length === 0 ? (
          <li className="text-sm text-neutral-500">No custom rules for this profile.</li>
        ) : null}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <select
          className={inputCls}
          value={patternType}
          onChange={(e) => setPatternType(e.target.value as typeof patternType)}
        >
          <option value="domain-suffix">domain-suffix</option>
          <option value="domain-exact">domain-exact</option>
          <option value="ip">ip</option>
          <option value="cidr">cidr</option>
        </select>
        <input
          className={`${inputCls} min-w-[180px] flex-1`}
          placeholder="example.com or 10.0.0.0/8"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <select
          className={inputCls}
          value={action}
          onChange={(e) => setAction(e.target.value as RuleDirection)}
        >
          <option value="proxy">PROXY</option>
          <option value="direct">DIRECT</option>
          <option value="block">BLOCK</option>
        </select>
        <button
          type="button"
          disabled={busy || !profileId}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium hover:bg-blue-500 disabled:opacity-50"
          onClick={add}
        >
          Add rule
        </button>
      </div>
    </section>
  );
}

function EgressTestPanel() {
  const [sessions, setSessions] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [result, setResult] = useState<EgressTestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sockscap
      .listEgressSessions()
      .then((list) => {
        setSessions(list);
        if (list[0]) setSessionId(list[0].id);
      })
      .catch(() => setSessions([]));
  }, []);

  const run = async () => {
    if (!sessionId) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await sockscap.testEgress(sessionId));
    } catch (e) {
      setResult({
        ok: false,
        sessionId,
        kind: "?",
        endpoint: "",
        message: typeof e === "string" ? e : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-neutral-800 p-4" data-testid="sockscap-egress-test">
      <h3 className="mb-2 text-sm font-medium text-neutral-300">Test egress</h3>
      <p className="mb-3 text-xs text-neutral-500">
        TCP reachability to the Proxy/SSH session endpoint (no secrets leave Vault).
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <select
          className={`${inputCls} min-w-[200px]`}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {sessions.length === 0 ? <option value="">— no Proxy/SSH sessions —</option> : null}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.kind})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !sessionId}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          onClick={() => void run()}
        >
          {busy ? "Testing…" : "Test"}
        </button>
      </div>
      {result ? (
        <div
          className={`mt-3 text-sm ${result.ok ? "text-green-400" : "text-red-400"}`}
        >
          {result.ok ? "OK" : "Failed"} · {result.endpoint || "—"} · {result.message}
          {result.latencyMs != null ? ` · ${result.latencyMs} ms` : ""}
        </div>
      ) : null}
    </section>
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
    <section className="rounded-lg border border-neutral-800 p-4" data-testid="sockscap-test-target">
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
