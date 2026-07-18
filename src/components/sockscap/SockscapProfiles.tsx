import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import {
  sockscap,
  type EgressSession,
  type RoutingProfile,
  type SockscapScope,
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

/**
 * Profiles editor (plan §5, §11): list on the left, an editor form on the
 * right. Scope, egress (Proxy session or SSH jump), routing default and the
 * always-visible DNS / unknown / UDP / local-network policies. Save routes
 * through the Rust command, which re-validates conflicts and surfaces them.
 */
export function SockscapProfiles() {
  const profiles = useSockscapStore((s) => s.profiles);
  const busy = useSockscapStore((s) => s.busy);
  const saveProfile = useSockscapStore((s) => s.saveProfile);
  const deleteProfile = useSockscapStore((s) => s.deleteProfile);
  const refreshProfiles = useSockscapStore((s) => s.refreshProfiles);

  const [draft, setDraft] = useState<RoutingProfile | null>(null);
  const [egressSessions, setEgressSessions] = useState<EgressSession[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void refreshProfiles();
    void sockscap.listEgressSessions().then(setEgressSessions).catch(() => setEgressSessions([]));
  }, [refreshProfiles]);

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
    } catch (e) {
      setSaveError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid grid-cols-[260px_1fr] gap-5">
      <aside className="space-y-2">
        <button
          onClick={() => {
            setSaveError(null);
            setDraft(newProfile());
          }}
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500"
        >
          + New profile
        </button>
        <ul className="space-y-1">
          {profiles.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => {
                  setSaveError(null);
                  setDraft(structuredClone(p));
                }}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${
                  draft?.id === p.id ? "bg-neutral-800" : "hover:bg-neutral-900"
                }`}
              >
                <span className="truncate">
                  <span className={p.enabled ? "" : "text-neutral-500 line-through"}>{p.name}</span>
                  <span className="ml-2 text-xs text-neutral-500">{p.scope}</span>
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
              onChange={(e) => patch({ scope: e.target.value as SockscapScope })}
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

        {renderEgress()}
        {renderPolicies()}

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
            onClick={() => setDraft(null)}
            className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderEgress() {
    if (!draft) return null;
    return (
      <div className="rounded-lg border border-neutral-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Egress</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Upstream kind">
            <select
              className={selectCls}
              value={draft.egressKind}
              onChange={(e) =>
                patch({ egressKind: e.target.value as RoutingProfile["egressKind"], egressRefId: "" })
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
          <p className="mt-2 text-xs text-amber-400/80">
            SSH jump carries TCP only; UDP/QUIC follows the UDP policy below (default BLOCK). Host
            keys are verified on first use; a changed key blocks the connection.
          </p>
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
                patch({ unknownDomainAction: e.target.value as RoutingProfile["unknownDomainAction"] })
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
                patch({ localNetworkPolicy: e.target.value as RoutingProfile["localNetworkPolicy"] })
              }
            >
              <option value="direct">DIRECT</option>
              <option value="by-rule">By rule</option>
              <option value="block">BLOCK</option>
            </select>
          </Field>
          <Field label="Rule source ids (comma-separated)">
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
}
