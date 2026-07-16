import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  DEFAULT_GROK_ACP_PROFILE,
  useAiStore,
  type AcpBridgeConfig,
  type AcpProfileConfig,
} from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { AcpProxyFields } from "./AcpProxyFields";

interface AcpAuthMethodInfo {
  id: string;
  name: string;
}

interface AcpAgentInfo {
  protocolVersion: number;
  name?: string | null;
  title?: string | null;
  version?: string | null;
  supportsSessionLoad: boolean;
  supportsMcpHttp: boolean;
  supportsMcpSse: boolean;
  authMethods: AcpAuthMethodInfo[];
}

interface AcpProfileProbeResult {
  profileId: string;
  ok: boolean;
  message: string;
  agent?: AcpAgentInfo | null;
}

function cloneBridge(bridge: AcpBridgeConfig): AcpBridgeConfig {
  return {
    ...bridge,
    profiles: bridge.profiles.map((profile) => ({ ...profile, args: [...profile.args] })),
  };
}

function cloneGrokProfile(): AcpProfileConfig {
  return { ...DEFAULT_GROK_ACP_PROFILE, args: [...DEFAULT_GROK_ACP_PROFILE.args] };
}

function nextProfileId(profiles: AcpProfileConfig[]): string {
  const ids = new Set(profiles.map((profile) => profile.id));
  let index = 1;
  while (ids.has(`agent-${index}`)) index += 1;
  return `agent-${index}`;
}

export function AcpAgentsPanel() {
  const t = useT();
  const { config, loadConfig, saveConfig, saving } = useAiStore();
  const [draft, setDraft] = useState<AcpBridgeConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, AcpProfileProbeResult>>({});

  useEffect(() => {
    if (!config) void loadConfig();
  }, [config, loadConfig]);

  useEffect(() => {
    if (!config || dirty) return;
    setDraft(cloneBridge(config.acp_bridge));
  }, [config?.acp_bridge, dirty]);

  if (!config || !draft) return null;

  const patchBridge = (patch: Partial<AcpBridgeConfig>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    setSaved(false);
  };

  const patchProfile = (profileId: string, patch: Partial<AcpProfileConfig>) => {
    patchBridge({
      profiles: draft.profiles.map((profile) =>
        profile.id === profileId ? { ...profile, ...patch } : profile,
      ),
    });
  };

  const toggleBridge = () => {
    const enabled = !draft.enabled;
    if (!enabled || draft.profiles.some((profile) => profile.enabled)) {
      patchBridge({ enabled });
      return;
    }
    const fallbackProfile = draft.profiles.find((profile) =>
      profile.id === draft.active_profile_id && profile.command.trim()
    ) ?? draft.profiles.find((profile) => profile.command.trim());
    patchBridge({
      enabled,
      ...(fallbackProfile
        ? {
            active_profile_id: fallbackProfile.id,
            profiles: draft.profiles.map((profile) =>
              profile.id === fallbackProfile.id ? { ...profile, enabled: true } : profile
            ),
          }
        : {}),
    });
  };

  const toggleProfile = (profileId: string, enabled: boolean) => {
    const profiles = draft.profiles.map((profile) =>
      profile.id === profileId ? { ...profile, enabled } : profile
    );
    patchBridge({
      profiles,
      enabled: enabled ? true : profiles.some((profile) => profile.enabled) ? draft.enabled : false,
      active_profile_id: enabled && !draft.active_profile_id ? profileId : draft.active_profile_id,
    });
  };

  const persist = async (): Promise<void> => {
    await saveConfig({ ...config, acp_bridge: draft });
    setDirty(false);
    setSaved(true);
  };

  const probe = async (profileId: string) => {
    setProbing(profileId);
    try {
      if (dirty) await persist();
      const result = await invoke<AcpProfileProbeResult>("acp_probe_profile", { profileId });
      setProbeResults((current) => ({ ...current, [profileId]: result }));
    } catch (error) {
      setProbeResults((current) => ({
        ...current,
        [profileId]: {
          profileId,
          ok: false,
          message: String(error),
          agent: null,
        },
      }));
    } finally {
      setProbing(null);
    }
  };

  const addProfile = () => {
    const id = nextProfileId(draft.profiles);
    patchBridge({
      active_profile_id: draft.active_profile_id ?? id,
      profiles: [
        ...draft.profiles,
        {
          id,
          name: `${t("aiSettings.acpNewProfileName")} ${draft.profiles.length + 1}`,
          enabled: false,
          command: "",
          args: [],
          auth_method_id: null,
          proxy_mode: "inherit",
          proxy_session_id: null,
          proxy_url: null,
        },
      ],
    });
  };

  const removeProfile = (profileId: string) => {
    const profiles = draft.profiles.filter((profile) => profile.id !== profileId);
    patchBridge({
      profiles,
      active_profile_id: draft.active_profile_id === profileId
        ? profiles[0]?.id ?? null
        : draft.active_profile_id,
    });
    setProbeResults((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  };

  const restoreGrok = () => {
    if (draft.profiles.some((profile) => profile.id === DEFAULT_GROK_ACP_PROFILE.id)) return;
    patchBridge({
      profiles: [cloneGrokProfile(), ...draft.profiles],
      active_profile_id: draft.active_profile_id ?? DEFAULT_GROK_ACP_PROFILE.id,
    });
  };

  const unavailable = config.full_local_mode || config.fully_disabled;
  const hasGrok = draft.profiles.some((profile) => profile.id === DEFAULT_GROK_ACP_PROFILE.id);

  return (
    <div className="space-y-3" data-testid="acp-settings">
      <div>
        <div className="text-[13px] font-semibold">{t("aiSettings.acpTitle")}</div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {t("aiSettings.acpSubtitle")}
        </div>
      </div>

      <button
        type="button"
        className={`w-full flex items-center gap-3 rounded border p-3 text-left transition-colors ${
          draft.enabled
            ? "border-[var(--taomni-accent)]/40 bg-[var(--taomni-accent)]/5"
            : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
        }`}
        onClick={toggleBridge}
        disabled={unavailable}
        aria-pressed={draft.enabled}
        data-testid="acp-bridge-enabled"
      >
        <TerminalSquare className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold">{t("aiSettings.acpEnable")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {unavailable ? t("aiSettings.acpUnavailable") : t("aiSettings.acpEnableDesc")}
          </div>
        </div>
        <span className={`w-9 h-5 rounded-full transition-colors relative ${
          draft.enabled ? "bg-[var(--taomni-accent)]" : "bg-[var(--taomni-divider)]"
        }`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            draft.enabled ? "translate-x-4" : "translate-x-0.5"
          }`} />
        </span>
      </button>

      <div className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-3 space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_160px] gap-3">
          <div>
            <label className="text-[11px] font-semibold block mb-1">
              {t("aiSettings.acpGlobalProxy")}
            </label>
            <AcpProxyFields
              mode={draft.proxy_mode}
              sessionId={draft.proxy_session_id}
              proxyUrl={draft.proxy_url}
              testIdPrefix="acp-global-proxy"
              onChange={(patch) => patchBridge(patch)}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold block mb-1" htmlFor="acp-timeout-seconds">
              {t("aiSettings.acpTimeout")}
            </label>
            <input
              id="acp-timeout-seconds"
              type="number"
              min={1}
              max={600}
              className="taomni-input h-7 w-full text-[12px]"
              value={draft.request_timeout_seconds}
              onChange={(event) => patchBridge({
                request_timeout_seconds: Math.min(600, Math.max(1, Number(event.target.value) || 1)),
              })}
              data-testid="acp-request-timeout"
            />
          </div>
        </div>
        <div className="text-[10px] text-[var(--taomni-text-muted)]">
          {t("aiSettings.acpProxyNote")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
          onClick={addProfile}
          data-testid="acp-add-profile"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("aiSettings.acpAddProfile")}
        </button>
        {!hasGrok && (
          <button
            type="button"
            className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
            onClick={restoreGrok}
            data-testid="acp-restore-grok"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {t("aiSettings.acpRestoreGrok")}
          </button>
        )}
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
          onClick={() => void persist()}
          disabled={!dirty || saving}
          data-testid="acp-save"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? t("aiSettings.llmSaving") : t("aiSettings.llmSave")}
        </button>
        {saved && !dirty && (
          <span className="text-[11px] text-green-400">{t("aiSettings.llmSaved")}</span>
        )}
      </div>

      <div className="space-y-3">
        {draft.profiles.map((profile) => {
          const result = probeResults[profile.id];
          const isGrok = profile.id === DEFAULT_GROK_ACP_PROFILE.id;
          return (
            <div
              key={profile.id}
              className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-3 space-y-3"
              data-testid={`acp-profile-${profile.id}`}
            >
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    onChange={(event) => toggleProfile(profile.id, event.target.checked)}
                    data-testid={`acp-profile-${profile.id}-enabled`}
                  />
                  <span className="text-[12px] font-semibold truncate">{profile.name}</span>
                  <code className="text-[10px] text-[var(--taomni-text-muted)]">acp:{profile.id}</code>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                  <input
                    type="radio"
                    name="active-acp-profile"
                    checked={draft.active_profile_id === profile.id}
                    onChange={() => patchBridge({ active_profile_id: profile.id })}
                    data-testid={`acp-profile-${profile.id}-preferred`}
                  />
                  {t("aiSettings.acpPreferred")}
                </label>
                {!isGrok && (
                  <button
                    type="button"
                    className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center text-red-400"
                    onClick={() => removeProfile(profile.id)}
                    title={t("aiSettings.acpRemoveProfile")}
                    data-testid={`acp-profile-${profile.id}-remove`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">
                  {t("aiSettings.acpProfileName")}
                  <input
                    type="text"
                    className="taomni-input h-7 w-full mt-1 text-[12px]"
                    value={profile.name}
                    onChange={(event) => patchProfile(profile.id, { name: event.target.value })}
                    data-testid={`acp-profile-${profile.id}-name`}
                  />
                </label>
                <label className="text-[11px] text-[var(--taomni-text-muted)]">
                  {t("aiSettings.acpCommand")}
                  <input
                    type="text"
                    className="taomni-input h-7 w-full mt-1 text-[12px] font-mono"
                    value={profile.command}
                    onChange={(event) => patchProfile(profile.id, { command: event.target.value })}
                    placeholder="agent-cli"
                    data-testid={`acp-profile-${profile.id}-command`}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-[11px] text-[var(--taomni-text-muted)]">
                  {t("aiSettings.acpArgs")}
                  <textarea
                    className="taomni-input min-h-20 w-full mt-1 py-1.5 text-[12px] font-mono resize-y"
                    value={profile.args.join("\n")}
                    onChange={(event) => patchProfile(profile.id, {
                      args: event.target.value.split("\n").map((arg) => arg.trim()).filter(Boolean),
                    })}
                    placeholder={profile.id === DEFAULT_GROK_ACP_PROFILE.id
                      ? "--permission-mode\ndefault\nagent\n--no-leader\nstdio"
                      : "agent\nstdio"}
                    data-testid={`acp-profile-${profile.id}-args`}
                  />
                </label>
                <div className="space-y-2">
                  <label className="text-[11px] text-[var(--taomni-text-muted)]">
                    {t("aiSettings.acpAuthMethod")}
                    <input
                      type="text"
                      className="taomni-input h-7 w-full mt-1 text-[12px] font-mono"
                      value={profile.auth_method_id ?? ""}
                      onChange={(event) => patchProfile(profile.id, {
                        auth_method_id: event.target.value.trim() || null,
                      })}
                      placeholder={t("aiSettings.acpAuthMethodPlaceholder")}
                      data-testid={`acp-profile-${profile.id}-auth`}
                    />
                  </label>
                  <div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)] mb-1">
                      {t("aiSettings.acpProfileProxy")}
                    </div>
                    <AcpProxyFields
                      mode={profile.proxy_mode}
                      sessionId={profile.proxy_session_id}
                      proxyUrl={profile.proxy_url}
                      includeInherit
                      testIdPrefix={`acp-profile-${profile.id}-proxy`}
                      onChange={(patch) => patchProfile(profile.id, patch)}
                    />
                  </div>
                </div>
              </div>

              {isGrok && (
                <div className="text-[10px] text-[var(--taomni-text-muted)]">
                  {t("aiSettings.acpGrokNote")}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
                  onClick={() => void probe(profile.id)}
                  disabled={probing !== null || saving || !profile.command.trim()}
                  data-testid={`acp-profile-${profile.id}-probe`}
                >
                  {probing === profile.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <TerminalSquare className="w-3.5 h-3.5" />}
                  {t("aiSettings.acpProbe")}
                </button>
                {result && (
                  <div
                    className={`flex items-start gap-1.5 text-[11px] ${result.ok ? "text-green-400" : "text-red-400"}`}
                    data-testid={`acp-profile-${profile.id}-probe-result`}
                  >
                    {result.ok
                      ? <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                    <span>
                      {result.message}
                      {result.agent && (
                        <span className="block text-[10px] text-[var(--taomni-text-muted)]">
                          {t("aiSettings.acpCapabilities", {
                            load: result.agent.supportsSessionLoad ? t("common.yes") : t("common.no"),
                            mcp: result.agent.supportsMcpHttp ? t("common.yes") : t("common.no"),
                          })}
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
