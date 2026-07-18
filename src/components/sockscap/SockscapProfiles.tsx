import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import { getAppPlatform } from "../../lib/runtime";
import {
  sockscap,
  type AppSelector,
  type EgressSession,
  type ProcessInfo,
  type RoutingProfile,
  type RuntimeProcessSelector,
  type SockscapScope,
  type SshPoolOptions,
} from "../../lib/sockscap";

function newProfile(): RoutingProfile {
  return {
    id: `profile-${Date.now().toString(36)}`,
    name: "New profile",
    enabled: true,
    priority: 100,
    scope: "global",
    appSelectors: [],
    runtimeProcesses: [],
    includeChildren: true,
    egressKind: "proxy-session",
    egressRefId: "",
    egressFailureAction: "fail-open",
    ruleSourceIds: [],
    defaultAction: "direct",
    dnsMode: "system-capture",
    unknownDomainAction: "direct",
    udpPolicy: "block",
    localNetworkPolicy: "direct",
    sshPoolOptions: null,
    statsPrivacy: {
      retainDomainAggregates: false,
      domainRetentionDays: 7,
      ephemeralOnly: false,
    },
  };
}

function defaultSshPool(): SshPoolOptions {
  return {
    maxControlConnections: 2,
    maxChannelsPerControl: 128,
    keepaliveSecs: 15,
    connectTimeoutSecs: 15,
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

const selectCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100";

const btnSecondary =
  "rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50";

/** Build a platform-appropriate AppSelector from a path or process name. */
export function appSelectorFromPath(pathOrName: string): AppSelector {
  const v = pathOrName.trim();
  const platform = getAppPlatform();
  if (platform === "macos") {
    if (v.endsWith(".app") || v.includes(".app/")) {
      return { kind: "macos-app-path", value: v };
    }
    return { kind: "macos-signing-identity", value: v };
  }
  if (platform === "linux") {
    if (v.startsWith("/") || v.includes("/")) {
      return { kind: "linux-path", value: v };
    }
    return { kind: "linux-cgroup", value: v };
  }
  // Windows + unknown: executable path / name.
  return { kind: "windows-executable", value: v };
}

function selectorLabel(sel: AppSelector): string {
  switch (sel.kind) {
    case "windows-executable":
      return sel.value;
    case "macos-app-path":
      return sel.value;
    case "macos-signing-identity":
      return `id:${sel.value}`;
    case "linux-path":
      return sel.value;
    case "linux-cgroup":
      return `cgroup:${sel.value}`;
  }
}

function selectorKindHint(): string {
  const platform = getAppPlatform();
  if (platform === "macos") return "macOS: .app path or signing identity / Team ID";
  if (platform === "linux") return "Linux: executable path or cgroup v2 fragment";
  return "Windows: full path to .exe (case-insensitive match)";
}

/**
 * Profiles editor (plan §5, §11): list on the left, an editor form on the
 * right. Scope, app/process selectors, egress (Proxy session or SSH jump),
 * routing default and always-visible DNS / unknown / UDP / local-network /
 * privacy policies. Save routes through the Rust command, which re-validates
 * conflicts and empty-selector rules.
 */
export function SockscapProfiles() {
  const profiles = useSockscapStore((s) => s.profiles);
  const ruleSources = useSockscapStore((s) => s.ruleSources);
  const busy = useSockscapStore((s) => s.busy);
  const saveProfile = useSockscapStore((s) => s.saveProfile);
  const deleteProfile = useSockscapStore((s) => s.deleteProfile);
  const refreshProfiles = useSockscapStore((s) => s.refreshProfiles);
  const refreshRuleSources = useSockscapStore((s) => s.refreshRuleSources);

  const [draft, setDraft] = useState<RoutingProfile | null>(null);
  const [egressSessions, setEgressSessions] = useState<EgressSession[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [showProcessPicker, setShowProcessPicker] = useState(false);

  useEffect(() => {
    void refreshProfiles();
    void refreshRuleSources();
    void sockscap.listEgressSessions().then(setEgressSessions).catch(() => setEgressSessions([]));
  }, [refreshProfiles, refreshRuleSources]);

  const egressForKind = useMemo(
    () =>
      egressSessions.filter((s) =>
        draft?.egressKind === "ssh-jump" ? s.kind === "ssh" : s.kind === "proxy",
      ),
    [egressSessions, draft?.egressKind],
  );

  const patch = (p: Partial<RoutingProfile>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const onSave = async () => {
    if (!draft) return;
    setSaveError(null);
    try {
      await saveProfile(draft);
      setDraft(null);
      setPathDraft("");
      setShowProcessPicker(false);
    } catch (e) {
      setSaveError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  };

  const addAppSelector = (sel: AppSelector) => {
    setDraft((d) => {
      if (!d) return d;
      const key = `${sel.kind}:${sel.value.toLowerCase()}`;
      if (d.appSelectors.some((s) => `${s.kind}:${s.value.toLowerCase()}` === key)) return d;
      return { ...d, appSelectors: [...d.appSelectors, sel] };
    });
  };

  const removeAppSelector = (idx: number) => {
    setDraft((d) => {
      if (!d) return d;
      return { ...d, appSelectors: d.appSelectors.filter((_, i) => i !== idx) };
    });
  };

  const addRuntimeProcess = (proc: ProcessInfo) => {
    const start =
      proc.processStartTime?.trim() ||
      `listed:${proc.pid}:${proc.name}`;
    const entry: RuntimeProcessSelector = {
      pid: proc.pid,
      processStartTime: start,
      label: proc.name,
    };
    setDraft((d) => {
      if (!d) return d;
      if (d.runtimeProcesses.some((r) => r.pid === entry.pid && r.processStartTime === entry.processStartTime)) {
        return d;
      }
      return { ...d, runtimeProcesses: [...d.runtimeProcesses, entry] };
    });
  };

  const removeRuntimeProcess = (idx: number) => {
    setDraft((d) => {
      if (!d) return d;
      return { ...d, runtimeProcesses: d.runtimeProcesses.filter((_, i) => i !== idx) };
    });
  };

  const rememberAsApp = (proc: ProcessInfo) => {
    const identity = (proc.path && proc.path.trim()) || proc.name;
    addAppSelector(appSelectorFromPath(identity));
  };

  const pickExecutableFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Select application executable",
        filters:
          getAppPlatform() === "windows"
            ? [{ name: "Executable", extensions: ["exe", "com", "bat", "cmd"] }]
            : getAppPlatform() === "macos"
              ? [{ name: "Application", extensions: ["app"] }]
              : undefined,
      });
      const path = typeof selected === "string" ? selected : null;
      if (path) addAppSelector(appSelectorFromPath(path));
    } catch {
      // Browser preview / dialog unavailable — user can paste a path.
    }
  };

  return (
    <div className="grid grid-cols-[260px_1fr] gap-5" data-testid="sockscap-profiles">
      <aside className="space-y-2">
        <button
          onClick={() => {
            setSaveError(null);
            setPathDraft("");
            setShowProcessPicker(false);
            setDraft(newProfile());
          }}
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500"
          data-testid="sockscap-new-profile"
        >
          + New profile
        </button>
        <ul className="space-y-1">
          {profiles.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => {
                  setSaveError(null);
                  setPathDraft("");
                  setShowProcessPicker(false);
                  setDraft(structuredClone(p));
                }}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${
                  draft?.id === p.id ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
              >
                <span className="truncate">
                  <span className={p.enabled ? "" : "text-neutral-500 line-through"}>{p.name}</span>
                  <span className="ml-2 text-xs text-neutral-500">{p.scope}</span>
                  {p.scope === "applications" && p.appSelectors.length > 0 ? (
                    <span className="ml-1 text-xs text-neutral-600">· {p.appSelectors.length} apps</span>
                  ) : null}
                  {p.scope === "runtime-processes" && p.runtimeProcesses.length > 0 ? (
                    <span className="ml-1 text-xs text-neutral-600">
                      · {p.runtimeProcesses.length} pids
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-neutral-600">#{p.priority}</span>
              </button>
            </li>
          ))}
          {profiles.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No profiles yet.</li>
          ) : null}
        </ul>
      </aside>

      <section>{draft ? renderEditor() : <Placeholder />}</section>
    </div>
  );

  function Placeholder() {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Select a profile or create a new one.
      </div>
    );
  }

  function renderEditor() {
    if (!draft) return null;
    return (
      <div className="space-y-4">
        {saveError ? (
          <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {saveError}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              className={selectCls}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Priority (lower wins)">
            <input
              type="number"
              className={selectCls}
              value={draft.priority}
              onChange={(e) => patch({ priority: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Scope">
            <select
              className={selectCls}
              value={draft.scope}
              onChange={(e) => {
                const scope = e.target.value as SockscapScope;
                patch({ scope });
                setShowProcessPicker(false);
              }}
            >
              <option value="global">Global</option>
              <option value="applications">Applications</option>
              <option value="runtime-processes">Running processes</option>
            </select>
          </Field>
          <Field label="Enabled">
            <select
              className={selectCls}
              value={draft.enabled ? "1" : "0"}
              onChange={(e) => patch({ enabled: e.target.value === "1" })}
            >
              <option value="1">Enabled</option>
              <option value="0">Disabled</option>
            </select>
          </Field>
        </div>

        {draft.scope === "applications" || draft.scope === "runtime-processes"
          ? renderScopeTargets()
          : null}

        {renderEgress()}
        {renderPolicies()}
        {renderPrivacy()}

        <div className="flex gap-2 pt-2">
          <button
            disabled={busy}
            onClick={() => void onSave()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => void deleteProfile(draft.id).then(() => setDraft(null))}
            className="rounded border border-red-500/60 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10"
          >
            Delete
          </button>
          <button
            onClick={() => {
              setDraft(null);
              setShowProcessPicker(false);
            }}
            className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderScopeTargets() {
    if (!draft) return null;
    const isApps = draft.scope === "applications";
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-neutral-300">
            {isApps ? "Applications" : "Running processes"}
          </h3>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={draft.includeChildren}
              onChange={(e) => patch({ includeChildren: e.target.checked })}
            />
            Include child processes
          </label>
        </div>

        {isApps ? (
          <>
            <p className="mb-2 text-xs text-neutral-500">{selectorKindHint()}</p>
            <ul className="mb-3 space-y-1">
              {draft.appSelectors.map((sel, idx) => (
                <li
                  key={`${sel.kind}-${sel.value}-${idx}`}
                  className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate font-mono text-xs text-neutral-200">
                    <span className="mr-2 text-neutral-500">{sel.kind}</span>
                    {selectorLabel(sel)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-red-300 hover:text-red-200"
                    onClick={() => removeAppSelector(idx)}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {draft.appSelectors.length === 0 ? (
                <li className="text-sm text-amber-400/90">
                  Add at least one application before saving an enabled profile.
                </li>
              ) : null}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[240px] flex-1">
                <Field label="Path or identity">
                  <input
                    className={selectCls}
                    placeholder={
                      getAppPlatform() === "windows"
                        ? String.raw`C:\Program Files\App\app.exe`
                        : "/usr/bin/app"
                    }
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && pathDraft.trim()) {
                        addAppSelector(appSelectorFromPath(pathDraft));
                        setPathDraft("");
                      }
                    }}
                  />
                </Field>
              </div>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  if (!pathDraft.trim()) return;
                  addAppSelector(appSelectorFromPath(pathDraft));
                  setPathDraft("");
                }}
              >
                + Add
              </button>
              <button type="button" className={btnSecondary} onClick={() => void pickExecutableFile()}>
                Browse…
              </button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => setShowProcessPicker((v) => !v)}
              >
                {showProcessPicker ? "Hide process list" : "From running process…"}
              </button>
            </div>
            {showProcessPicker ? (
              <ProcessPicker
                mode="remember-app"
                onPick={(p) => {
                  rememberAsApp(p);
                }}
              />
            ) : null}
          </>
        ) : (
          <>
            <p className="mb-2 text-xs text-neutral-500">
              Only future connections of the selected PID are captured. PID + process start time are
              stored together to block PID reuse (plan §16.4-17). Use “Remember as application” to
              convert a process into a durable app identity instead of a short-lived PID.
            </p>
            <ul className="mb-3 space-y-1">
              {draft.runtimeProcesses.map((rp, idx) => (
                <li
                  key={`${rp.pid}-${rp.processStartTime}-${idx}`}
                  className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-xs text-neutral-200">
                    <span className="font-mono">pid {rp.pid}</span>
                    {rp.label ? <span className="ml-2 text-neutral-300">{rp.label}</span> : null}
                    <span className="ml-2 text-neutral-600">start {rp.processStartTime}</span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-red-300 hover:text-red-200"
                    onClick={() => removeRuntimeProcess(idx)}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {draft.runtimeProcesses.length === 0 ? (
                <li className="text-sm text-amber-400/90">
                  Select at least one process before saving an enabled profile.
                </li>
              ) : null}
            </ul>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setShowProcessPicker((v) => !v)}
            >
              {showProcessPicker ? "Hide process list" : "Select running processes…"}
            </button>
            {showProcessPicker ? (
              <ProcessPicker
                mode="runtime"
                onPick={(p) => addRuntimeProcess(p)}
                onRememberAsApp={(p) => {
                  rememberAsApp(p);
                  // Soft switch: user often wants durable app identity.
                  patch({ scope: "applications" });
                }}
              />
            ) : null}
          </>
        )}
      </div>
    );
  }

  function renderEgress() {
    if (!draft) return null;
    const pool = draft.sshPoolOptions ?? defaultSshPool();
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Egress</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Upstream kind">
            <select
              className={selectCls}
              value={draft.egressKind}
              onChange={(e) =>
                patch({
                  egressKind: e.target.value as RoutingProfile["egressKind"],
                  egressRefId: "",
                  sshPoolOptions:
                    e.target.value === "ssh-jump" ? (draft.sshPoolOptions ?? defaultSshPool()) : null,
                })
              }
            >
              <option value="proxy-session">Proxy session (SOCKS5 / HTTP CONNECT)</option>
              <option value="ssh-jump">SSH jump</option>
            </select>
          </Field>
          <Field label="Session">
            <select
              className={selectCls}
              value={draft.egressRefId}
              onChange={(e) => patch({ egressRefId: e.target.value })}
            >
              <option value="">— select —</option>
              {egressForKind.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="On egress failure">
          <select
            className={selectCls}
            value={draft.egressFailureAction}
            onChange={(e) =>
              patch({ egressFailureAction: e.target.value as RoutingProfile["egressFailureAction"] })
            }
          >
            <option value="fail-open">Fail open (fall back to DIRECT)</option>
            <option value="fail-closed">Fail closed (BLOCK)</option>
          </select>
        </Field>
        {draft.egressKind === "ssh-jump" ? (
          <>
            <p className="mt-2 text-xs text-amber-400/80">
              SSH jump carries TCP only; UDP/QUIC follows the UDP policy below (default BLOCK). Host
              keys are verified on first use; a changed key blocks the connection. Nested Proxy/Jump
              on the SSH session is rejected.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Max control connections">
                <input
                  type="number"
                  min={1}
                  className={selectCls}
                  value={pool.maxControlConnections}
                  onChange={(e) =>
                    patch({
                      sshPoolOptions: {
                        ...pool,
                        maxControlConnections: Number(e.target.value) || 1,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Max channels / control">
                <input
                  type="number"
                  min={1}
                  className={selectCls}
                  value={pool.maxChannelsPerControl}
                  onChange={(e) =>
                    patch({
                      sshPoolOptions: {
                        ...pool,
                        maxChannelsPerControl: Number(e.target.value) || 1,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Keepalive (secs)">
                <input
                  type="number"
                  min={0}
                  className={selectCls}
                  value={pool.keepaliveSecs}
                  onChange={(e) =>
                    patch({
                      sshPoolOptions: {
                        ...pool,
                        keepaliveSecs: Number(e.target.value) || 0,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Connect timeout (secs)">
                <input
                  type="number"
                  min={1}
                  className={selectCls}
                  value={pool.connectTimeoutSecs}
                  onChange={(e) =>
                    patch({
                      sshPoolOptions: {
                        ...pool,
                        connectTimeoutSecs: Number(e.target.value) || 1,
                      },
                    })
                  }
                />
              </Field>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  function renderPolicies() {
    if (!draft) return null;
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Routing policy</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default action">
            <select
              className={selectCls}
              value={draft.defaultAction}
              onChange={(e) =>
                patch({ defaultAction: e.target.value as RoutingProfile["defaultAction"] })
              }
            >
              <option value="direct">DIRECT</option>
              <option value="proxy">PROXY</option>
              <option value="block">BLOCK</option>
            </select>
          </Field>
          <Field label="Unknown domain (DoH/ECH)">
            <select
              className={selectCls}
              value={draft.unknownDomainAction}
              onChange={(e) =>
                patch({
                  unknownDomainAction: e.target.value as RoutingProfile["unknownDomainAction"],
                })
              }
            >
              <option value="direct">DIRECT (best selectivity, may leak)</option>
              <option value="proxy">PROXY (safer reachability)</option>
              <option value="block">BLOCK (strict)</option>
            </select>
          </Field>
          <Field label="DNS mode">
            <select
              className={selectCls}
              value={draft.dnsMode}
              onChange={(e) => patch({ dnsMode: e.target.value as RoutingProfile["dnsMode"] })}
            >
              <option value="system-capture">System capture</option>
              <option value="virtual-dns">Virtual DNS (Fake-IP)</option>
              <option value="strict-proxy">Strict proxy</option>
            </select>
          </Field>
          <Field label="UDP policy">
            <select
              className={selectCls}
              value={draft.udpPolicy}
              onChange={(e) => patch({ udpPolicy: e.target.value as RoutingProfile["udpPolicy"] })}
            >
              <option value="proxy-if-supported">Proxy if supported (SOCKS5 UDP)</option>
              <option value="direct">DIRECT (potential leak)</option>
              <option value="block">BLOCK (push to TCP)</option>
            </select>
          </Field>
          <Field label="Local / LAN traffic">
            <select
              className={selectCls}
              value={draft.localNetworkPolicy}
              onChange={(e) =>
                patch({
                  localNetworkPolicy: e.target.value as RoutingProfile["localNetworkPolicy"],
                })
              }
            >
              <option value="direct">DIRECT</option>
              <option value="by-rule">By rule</option>
              <option value="block">BLOCK</option>
            </select>
          </Field>
        </div>

        <div className="mt-3">
          <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
            Rule sources
          </span>
          {ruleSources.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No rule sources yet. Configure them under the Rules tab, or paste ids below.
            </p>
          ) : (
            <div className="mb-2 flex flex-wrap gap-3">
              {ruleSources.map((src) => {
                const checked = draft.ruleSourceIds.includes(src.id);
                return (
                  <label key={src.id} className="flex items-center gap-1.5 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...draft.ruleSourceIds, src.id]
                          : draft.ruleSourceIds.filter((id) => id !== src.id);
                        patch({ ruleSourceIds: next });
                      }}
                    />
                    {src.name}
                    <span className="text-neutral-600">({src.id})</span>
                  </label>
                );
              })}
            </div>
          )}
          <Field label="Rule source ids (comma-separated, advanced)">
            <input
              className={selectCls}
              value={draft.ruleSourceIds.join(", ")}
              onChange={(e) =>
                patch({
                  ruleSourceIds: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
      </div>
    );
  }

  function renderPrivacy() {
    if (!draft) return null;
    const sp = draft.statsPrivacy;
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Stats privacy</h3>
        <p className="mb-3 text-xs text-neutral-500">
          Domain aggregates are off by default (plan §10, §16.6-25). No payloads or full URLs are
          ever stored.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={sp.retainDomainAggregates}
              onChange={(e) =>
                patch({
                  statsPrivacy: { ...sp, retainDomainAggregates: e.target.checked },
                })
              }
            />
            Retain domain aggregates
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={sp.ephemeralOnly}
              onChange={(e) =>
                patch({
                  statsPrivacy: { ...sp, ephemeralOnly: e.target.checked },
                })
              }
            />
            Ephemeral only (this run)
          </label>
          <Field label="Domain retention (days)">
            <input
              type="number"
              min={1}
              className={selectCls}
              disabled={!sp.retainDomainAggregates}
              value={sp.domainRetentionDays}
              onChange={(e) =>
                patch({
                  statsPrivacy: {
                    ...sp,
                    domainRetentionDays: Number(e.target.value) || 7,
                  },
                })
              }
            />
          </Field>
        </div>
      </div>
    );
  }
}

function ProcessPicker({
  mode,
  onPick,
  onRememberAsApp,
}: {
  mode: "runtime" | "remember-app";
  onPick: (p: ProcessInfo) => void;
  onRememberAsApp?: (p: ProcessInfo) => void;
}) {
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setProcs(await sockscap.listProcesses());
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
      setProcs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return procs;
    return procs.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        (p.path ?? "").toLowerCase().includes(q),
    );
  }, [procs, filter]);

  return (
    <div className="mt-3 rounded border border-neutral-800 bg-neutral-950/80 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          className={`${selectCls} max-w-xs`}
          placeholder="Filter by name, pid, path…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className={btnSecondary} onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span className="text-xs text-neutral-500">{filtered.length} processes</span>
      </div>
      {error ? <div className="mb-2 text-xs text-red-400">{error}</div> : null}
      <div className="max-h-56 overflow-auto rounded border border-neutral-900">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-500">
            <tr>
              <th className="px-2 py-1 font-medium">PID</th>
              <th className="px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 font-medium">Path</th>
              <th className="px-2 py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((p) => (
              <tr key={`${p.pid}-${p.name}`} className="border-t border-neutral-900 hover:bg-neutral-900/60">
                <td className="px-2 py-1 font-mono text-neutral-400">{p.pid}</td>
                <td className="px-2 py-1 text-neutral-200">{p.name}</td>
                <td className="max-w-[220px] truncate px-2 py-1 font-mono text-neutral-500">
                  {p.path || "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right">
                  <button
                    type="button"
                    className="text-blue-400 hover:text-blue-300"
                    onClick={() => onPick(p)}
                  >
                    {mode === "runtime" ? "Add PID" : "Add as app"}
                  </button>
                  {mode === "runtime" && onRememberAsApp ? (
                    <button
                      type="button"
                      className="ml-2 text-neutral-400 hover:text-neutral-200"
                      onClick={() => onRememberAsApp(p)}
                      title="Convert to durable application identity (not a short-lived PID)"
                    >
                      Remember
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-2 py-3 text-neutral-500">
                  No processes match.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
