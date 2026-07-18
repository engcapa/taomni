/**
 * Independent Sockscap window (Phase 4).
 *
 * Opened via `#sockscap=main` / `sockscap_open_window`. Close hides the window
 * semantics are handled by the OS window close for now; engine stop is explicit
 * via the Stop control (design plan §9: close button hides, explicit exit stops).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  sockscapCapabilities,
  sockscapDeleteProfile,
  sockscapListProfiles,
  sockscapPreflight,
  sockscapRecover,
  sockscapStart,
  sockscapStatus,
  sockscapStop,
  sockscapTestTarget,
  sockscapUpsertProfile,
  type CapabilitiesReport,
  type EngineStatus,
  type PreflightReport,
  type RoutingProfileDraft,
  type TestTargetResult,
} from "../../lib/sockscap";

function newProfileId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}`;
}

const emptyDraft = (): RoutingProfileDraft => ({
  id: newProfileId(),
  name: "New profile",
  enabled: true,
  priority: 100,
  scope: "applications",
  appSelectors: [],
  includeChildren: true,
  egressKind: "proxy_session",
  egressRefId: "",
  defaultAction: "direct",
  unknownDomainAction: "direct",
  udpPolicy: "block",
  dnsMode: "system_capture",
  egressFailureAction: "fail_open",
});

export function SockscapWindow() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [caps, setCaps] = useState<CapabilitiesReport | null>(null);
  const [profiles, setProfiles] = useState<RoutingProfileDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutingProfileDraft>(emptyDraft());
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [testHost, setTestHost] = useState("www.google.com");
  const [testResult, setTestResult] = useState<TestTargetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"dashboard" | "profiles" | "rules">("dashboard");

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, c, p] = await Promise.all([
        sockscapStatus(),
        sockscapCapabilities(),
        sockscapListProfiles(),
      ]);
      setStatus(s);
      setCaps(c);
      setProfiles(p);
      if (!selectedId && p[0]) {
        setSelectedId(p[0].id);
        setDraft(p[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedId]);

  useEffect(() => {
    document.title = "Sockscap — Taomni";
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) setDraft(selected);
  }, [selected]);

  const runPreflight = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await sockscapPreflight(profiles);
      setPreflight(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    setBusy(true);
    setError(null);
    try {
      await sockscapStart(profiles);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      await sockscapStop();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRecover = async () => {
    setBusy(true);
    try {
      await sockscapRecover();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveProfile = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await sockscapUpsertProfile(draft);
      await refresh();
      setSelectedId(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteProfile = async () => {
    if (!draft.id) return;
    setBusy(true);
    try {
      await sockscapDeleteProfile(draft.id);
      setSelectedId(null);
      setDraft(emptyDraft());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTestTarget = async () => {
    setBusy(true);
    try {
      const result = await sockscapTestTarget({
        hostname: testHost,
        port: 443,
        protocol: "tcp",
        profiles,
      });
      setTestResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stateColor =
    status?.state === "active"
      ? "bg-emerald-500"
      : status?.state === "degraded" || status?.state === "user_action_required"
        ? "bg-amber-400"
        : status?.state === "recovery_required"
          ? "bg-red-500"
          : "bg-zinc-400";

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${stateColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-wide">Sockscap</div>
          <div className="truncate text-xs text-zinc-400">
            {status?.message ?? "Loading…"}
            {status?.captureActive ? " · capture active" : " · capture inactive"}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStart()}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50"
            data-testid="sockscap-start"
          >
            Start
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStop()}
            className="rounded bg-zinc-700 px-3 py-1.5 text-xs font-medium hover:bg-zinc-600 disabled:opacity-50"
            data-testid="sockscap-stop"
          >
            Stop
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onRecover()}
            className="rounded bg-red-700/80 px-3 py-1.5 text-xs font-medium hover:bg-red-600 disabled:opacity-50"
            data-testid="sockscap-recover"
          >
            Recover network
          </button>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-zinc-800 px-3 py-2 text-xs">
        {(
          [
            ["dashboard", "Dashboard"],
            ["profiles", "Profiles"],
            ["rules", "Rules & test"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded px-3 py-1.5 ${
              tab === id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"
            }`}
            data-testid={`sockscap-tab-${id}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div
          className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-200"
          data-testid="sockscap-error"
        >
          {error}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "dashboard" && (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <h2 className="mb-2 text-sm font-semibold">Engine</h2>
              <dl className="space-y-1 text-xs text-zinc-300">
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">State</dt>
                  <dd data-testid="sockscap-state">{status?.state ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Platform</dt>
                  <dd>{caps?.platform ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Capture implemented</dt>
                  <dd>{caps?.captureImplemented ? "yes" : "no (Phase 0 gate)"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Profiles</dt>
                  <dd>{profiles.length}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-zinc-500">{caps?.summary}</p>
              <button
                type="button"
                className="mt-3 rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                onClick={() => void runPreflight()}
                disabled={busy}
                data-testid="sockscap-preflight"
              >
                Run preflight
              </button>
              {preflight && (
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
                  {preflight.findings.map((f) => (
                    <li
                      key={`${f.code}-${f.message}`}
                      className={
                        f.severity === "error"
                          ? "text-red-300"
                          : f.severity === "warning"
                            ? "text-amber-300"
                            : "text-zinc-400"
                      }
                    >
                      [{f.severity}] {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <h2 className="mb-2 text-sm font-semibold">Capabilities</h2>
              <ul className="max-h-72 space-y-2 overflow-auto text-xs">
                {(caps?.items ?? []).map((item) => (
                  <li key={item.id} className="rounded border border-zinc-800/80 px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{item.name}</span>
                      <span className="text-zinc-500">{item.level}</span>
                    </div>
                    <p className="mt-0.5 text-zinc-400">{item.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {tab === "profiles" && (
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <aside className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold">Profiles</h2>
                <button
                  type="button"
                  className="text-xs text-emerald-400 hover:underline"
                  onClick={() => {
                    const d = emptyDraft();
                    setDraft(d);
                    setSelectedId(null);
                  }}
                  data-testid="sockscap-new-profile"
                >
                  + New
                </button>
              </div>
              <ul className="space-y-1">
                {profiles.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                        selectedId === p.id ? "bg-zinc-800" : "hover:bg-zinc-900"
                      }`}
                    >
                      <div className="font-medium">{p.name}</div>
                      <div className="text-zinc-500">
                        p{p.priority} · {p.scope}
                        {!p.enabled ? " · off" : ""}
                      </div>
                    </button>
                  </li>
                ))}
                {profiles.length === 0 && (
                  <li className="px-2 py-3 text-xs text-zinc-500">No profiles yet.</li>
                )}
              </ul>
            </aside>

            <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <h2 className="mb-3 text-sm font-semibold">Profile editor</h2>
              <div className="grid gap-3 text-xs md:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-zinc-500">Name</span>
                  <input
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    data-testid="sockscap-profile-name"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-zinc-500">Priority (lower = higher)</span>
                  <input
                    type="number"
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.priority}
                    onChange={(e) =>
                      setDraft({ ...draft, priority: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-zinc-500">Scope</span>
                  <select
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.scope}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        scope: e.target.value as RoutingProfileDraft["scope"],
                      })
                    }
                    data-testid="sockscap-profile-scope"
                  >
                    <option value="global">global</option>
                    <option value="applications">applications</option>
                    <option value="runtime_processes">runtime_processes</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-zinc-500">Default action</span>
                  <select
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.defaultAction}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultAction: e.target.value as RoutingProfileDraft["defaultAction"],
                      })
                    }
                  >
                    <option value="direct">direct</option>
                    <option value="proxy">proxy</option>
                    <option value="block">block</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-zinc-500">Egress kind</span>
                  <select
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.egressKind ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        egressKind: (e.target.value || null) as RoutingProfileDraft["egressKind"],
                      })
                    }
                  >
                    <option value="">(none)</option>
                    <option value="proxy_session">proxy_session</option>
                    <option value="ssh_jump">ssh_jump</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-zinc-500">Egress session id</span>
                  <input
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                    value={draft.egressRefId ?? ""}
                    onChange={(e) => setDraft({ ...draft, egressRefId: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 md:col-span-2">
                  <span className="text-zinc-500">
                    App selectors (one path per line)
                  </span>
                  <textarea
                    className="min-h-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono"
                    value={(draft.appSelectors ?? []).join("\n")}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        appSelectors: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.includeChildren}
                    onChange={(e) =>
                      setDraft({ ...draft, includeChildren: e.target.checked })
                    }
                  />
                  Include children
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSaveProfile()}
                  className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium hover:bg-sky-500 disabled:opacity-50"
                  data-testid="sockscap-save-profile"
                >
                  Save
                </button>
                <button
                  type="button"
                  disabled={busy || !profiles.some((p) => p.id === draft.id)}
                  onClick={() => void onDeleteProfile()}
                  className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600 disabled:opacity-50"
                  data-testid="sockscap-delete-profile"
                >
                  Delete
                </button>
              </div>
              {!caps?.captureImplemented && (
                <p className="mt-3 text-xs text-amber-300/90">
                  Capture plane is not implemented on this build. Profiles and
                  preflight work; Start will fail closed until Phase 0 platform
                  adapters land.
                </p>
              )}
            </section>
          </div>
        )}

        {tab === "rules" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-2 text-sm font-semibold">Test target</h2>
            <p className="mb-3 text-xs text-zinc-500">
              Explains profile selection and action. GFWList URL semantics are
              projected to domain/IP matchers — not full browser equivalence.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-xs">
                <span className="text-zinc-500">Hostname</span>
                <input
                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5"
                  value={testHost}
                  onChange={(e) => setTestHost(e.target.value)}
                  data-testid="sockscap-test-host"
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onTestTarget()}
                className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium hover:bg-violet-500 disabled:opacity-50"
                data-testid="sockscap-test-run"
              >
                Test
              </button>
            </div>
            {testResult && (
              <pre
                className="mt-3 max-h-80 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300"
                data-testid="sockscap-test-result"
              >
                {JSON.stringify(testResult, null, 2)}
              </pre>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default SockscapWindow;
