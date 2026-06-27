import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Loader2, Plus, Shield, Sliders, Trash2, X } from "lucide-react";
import { CodexCustomConfigProfile, useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import {
  codexGetProfileConfig,
  isVaultLockedError,
  VAULT_LOCKED_EVENT,
  vaultDelete,
  vaultPut,
  vaultStatus,
  vaultUpdate,
} from "../../lib/ipc";
import { CodexProxyFields } from "./CodexProxyFields";

const CONFIG_TEMPLATE = `model = "gpt-5.4"
model_provider = "openai_api_key"
model_reasoning_effort = "medium"
model_verbosity = "medium"

[model_providers.openai_api_key]
name = "OpenAI API key"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"

[env]
# Required: replace this with the API key for this Codex profile.
# Taomni injects [env] into the isolated app-server process and does
# not pass [env] itself to Codex config.
OPENAI_API_KEY = "REPLACE_ME_OPENAI_API_KEY"

# Optional: add other profile-only environment values here.
# EXAMPLE_FEATURES = "on"
`;

interface Props {
  onClose: () => void;
}

export function CodexCodeConfigDialog({ onClose }: Props) {
  const t = useT();
  const { config, saveConfig } = useAiStore();
  const [profiles, setProfiles] = useState<CodexCustomConfigProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const testSessionRef = useRef(0);

  useEffect(() => {
    testSessionRef.current += 1;
    setTestOutput(null);
    setTestError(null);
    setTesting(false);
    void invoke("codex_stop_session", { threadId: "codex_test_config_thread" }).catch(() => {});
  }, [selectedProfileId]);

  useEffect(() => {
    return () => {
      testSessionRef.current += 1;
      void invoke("codex_stop_session", { threadId: "codex_test_config_thread" }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    const codex = config.codex_bridge;
    const next = [...(codex.custom_config_profiles ?? [])];
    setProfiles(next);
    setActiveProfileId(codex.active_profile_id);
    if (next.length > 0) {
      setSelectedProfileId(
        codex.active_profile_id && next.some((p) => p.id === codex.active_profile_id)
          ? codex.active_profile_id
          : next[0].id,
      );
    }
  }, [config]);

  useEffect(() => {
    if (!selectedProfileId || contents[selectedProfileId] !== undefined) return;
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile?.vault_ref) {
      setContents((cur) => ({ ...cur, [selectedProfileId]: CONFIG_TEMPLATE }));
      return;
    }

    setLoading((cur) => ({ ...cur, [selectedProfileId]: true }));
    setError(null);
    codexGetProfileConfig(profile.vault_ref)
      .then((text) => setContents((cur) => ({ ...cur, [selectedProfileId]: text ?? CONFIG_TEMPLATE })))
      .catch((e) => {
        if (!isVaultLockedError(e)) setError(String(e));
      })
      .finally(() => setLoading((cur) => ({ ...cur, [selectedProfileId]: false })));
  }, [selectedProfileId, contents, profiles]);

  const sortedProfiles = useMemo(
    () => profiles.filter((p) => !deleted.has(p.id)).sort((a, b) => a.created_at - b.created_at),
    [profiles, deleted],
  );
  const selected = selectedProfileId ? profiles.find((p) => p.id === selectedProfileId) : null;
  const selectedContent = selectedProfileId ? contents[selectedProfileId] ?? "" : "";
  const selectedLoading = selectedProfileId ? !!loading[selectedProfileId] : false;

  const markDirty = (id: string) => setDirty((cur) => new Set(cur).add(id));

  const updateSelectedProfile = (patch: Partial<CodexCustomConfigProfile>) => {
    if (!selectedProfileId) return;
    setProfiles((cur) => cur.map((p) => (p.id === selectedProfileId ? { ...p, ...patch } : p)));
  };

  const addProfile = () => {
    const id = `codex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const p: CodexCustomConfigProfile = {
      id,
      name: `${t("aiSettings.ccCustomNewProfileName")} ${profiles.length + 1}`,
      enabled: true,
      vault_ref: "",
      created_at: Date.now(),
      proxy_mode: "inherit",
      proxy_session_id: null,
      proxy_url: null,
    };
    setProfiles((cur) => [...cur, p]);
    setContents((cur) => ({ ...cur, [id]: CONFIG_TEMPLATE }));
    setDirty((cur) => new Set(cur).add(id));
    setSelectedProfileId(id);
    if (!activeProfileId) setActiveProfileId(id);
  };

  const deleteProfile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(t("aiSettings.ccCustomConfirmDelete", { name: p.name }))) return;
    setDeleted((cur) => new Set(cur).add(id));
    if (selectedProfileId === id) {
      const rest = sortedProfiles.filter((x) => x.id !== id);
      setSelectedProfileId(rest[0]?.id ?? null);
    }
    if (activeProfileId === id) {
      const rest = sortedProfiles.filter((x) => x.id !== id);
      setActiveProfileId(rest[0]?.id);
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const status = await vaultStatus().catch(() => null);
      if (!status || status.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("aiSettings.codexCustomVaultRequired") },
          }),
        );
        setError(t("aiSettings.codexCustomVaultRequired"));
        return;
      }

      const validated: Record<string, string> = {};
      for (const id of dirty) {
        if (deleted.has(id)) continue;
        try {
          const text = contents[id] ?? "";
          await invoke("codex_validate_config", { configToml: text });
          validated[id] = text;
        } catch (e) {
          const prof = profiles.find((p) => p.id === id);
          setError(`${prof ? `[${prof.name}] ` : ""}${t("aiSettings.codexCustomInvalidToml", { error: (e as Error).message })}`);
          return;
        }
      }

      for (const id of deleted) {
        const p = profiles.find((x) => x.id === id);
        if (p?.vault_ref.startsWith("vault:")) {
          await vaultDelete(p.vault_ref.slice("vault:".length)).catch(() => {});
        }
      }

      const updated: CodexCustomConfigProfile[] = [];
      for (const p of profiles) {
        if (deleted.has(p.id)) continue;
        let vaultRef = p.vault_ref;
        if (dirty.has(p.id)) {
          const text = validated[p.id];
          if (vaultRef.startsWith("vault:")) {
            await vaultUpdate(vaultRef.slice("vault:".length), text);
          } else {
            const res = await vaultPut("codex_bridge:config", `Codex config (${p.name})`, text);
            vaultRef = res.reference;
          }
        }
        updated.push({
          ...p,
          vault_ref: vaultRef,
          proxy_session_id: p.proxy_session_id?.trim() || null,
          proxy_url: p.proxy_url?.trim() || null,
        });
      }

      await saveConfig({
        ...config,
        codex_bridge: {
          ...config.codex_bridge,
          custom_config_profiles: updated,
          active_profile_id: activeProfileId,
        },
      });
      onClose();
    } catch (e) {
      if (!isVaultLockedError(e)) setError((e as Error).message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!selected || !selectedContent) return;
    testSessionRef.current += 1;
    const session = testSessionRef.current;
    setTesting(true);
    setTestOutput("");
    setTestError(null);
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<any>("codex-test-config-stream", (event) => {
        if (testSessionRef.current !== session) return;
        const payload = event.payload;
        if (payload.kind === "token") setTestOutput((cur) => (cur ?? "") + payload.content);
        if (payload.kind === "end") setTestOutput(payload.content);
        if (payload.kind === "error") setTestError(payload.message);
      });
      await invoke("codex_test_config", {
        configToml: selectedContent,
        proxyMode: selected.proxy_mode ?? "inherit",
        proxySessionId: selected.proxy_session_id ?? null,
        proxyUrl: selected.proxy_url ?? null,
      });
    } catch (e: any) {
      if (testSessionRef.current === session) setTestError(e?.message || String(e));
    } finally {
      unlisten?.();
      if (testSessionRef.current === session) setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-[860px] max-w-[96%] max-h-[85vh] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        <div className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none" style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}>
          <Sliders className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">{t("aiSettings.codexCustomModalTitle")}</div>
          <button className="ml-auto hover:bg-red-500 rounded p-0.5" onClick={onClose} type="button" title={t("common.close")}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex border-x border-b overflow-hidden" style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}>
          <div className="w-[240px] border-r flex flex-col shrink-0" style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}>
            <div className="p-2 border-b text-[11px] font-semibold" style={{ borderColor: "var(--taomni-divider)" }}>
              {t("aiSettings.ccCustomListHeader")}
            </div>
            <div className="flex-1 overflow-auto p-1.5 space-y-1">
              {sortedProfiles.map((p) => {
                const isActive = activeProfileId === p.id;
                const isSelected = selectedProfileId === p.id;
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center justify-between p-2 rounded cursor-pointer transition-colors text-[11px] ${
                      isSelected ? "bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] font-medium" : "hover:bg-[var(--taomni-hover)]"
                    }`}
                    onClick={() => setSelectedProfileId(p.id)}
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className="truncate">{p.name}</span>
                      {isActive && (
                        <span className="px-1 text-[8px] leading-tight bg-green-500/15 text-green-400 border border-green-500/35 rounded shrink-0">
                          {t("aiSettings.ccCustomActiveLabel")}
                        </span>
                      )}
                      {!p.enabled && (
                        <span className="px-1 text-[8px] leading-tight bg-[var(--taomni-divider)] text-[var(--taomni-text-muted)] border rounded shrink-0">
                          {t("aiSettings.ccCustomDisabled")}
                        </span>
                      )}
                    </div>
                    <button type="button" title={t("common.delete")} className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-0.5 transition-opacity rounded" onClick={(e) => deleteProfile(p.id, e)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="p-2 border-t" style={{ borderColor: "var(--taomni-divider)" }}>
              <button type="button" className="taomni-btn w-full h-7 px-3 text-[11px] inline-flex items-center justify-center gap-1" onClick={addProfile}>
                <Plus className="w-3.5 h-3.5" />
                {t("aiSettings.ccCustomAddProfile")}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4 flex flex-col min-w-0">
            {selected ? (
              <div className="flex-1 flex flex-col gap-3 min-h-0">
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.ccCustomProfileNameLabel")}</label>
                    <input type="text" className="taomni-input h-7 w-full text-[12px]" value={selected.name} onChange={(e) => updateSelectedProfile({ name: e.target.value })} />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                      <input type="checkbox" className="taomni-checkbox" checked={activeProfileId === selected.id} onChange={(e) => e.target.checked && setActiveProfileId(selected.id)} />
                      <span>{t("aiSettings.ccCustomActiveLabel")}</span>
                    </label>
                    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                      <input type="checkbox" className="taomni-checkbox" checked={selected.enabled} onChange={(e) => updateSelectedProfile({ enabled: e.target.checked })} />
                      <span>{t("aiSettings.ccCustomToggleEnable")}</span>
                    </label>
                  </div>
                  <div>
                    <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.codexProxyTitle")}</label>
                    <CodexProxyFields
                      includeInherit
                      mode={selected.proxy_mode}
                      sessionId={selected.proxy_session_id}
                      proxyUrl={selected.proxy_url}
                      onChange={(patch) => updateSelectedProfile(patch)}
                    />
                  </div>
                </div>

                <div className="flex-1 flex flex-col min-h-[220px] mt-2 relative">
                  <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.codexCustomTomlLabel")}</label>
                  {selectedLoading ? (
                    <div className="flex-1 flex items-center justify-center border rounded" style={{ borderColor: "var(--taomni-input-border)" }}>
                      <Loader2 className="w-6 h-6 animate-spin text-[var(--taomni-text-muted)]" />
                    </div>
                  ) : (
                    <textarea
                      className="taomni-input flex-1 font-mono text-[11px] leading-relaxed w-full resize-none"
                      spellCheck={false}
                      value={selectedContent}
                      onChange={(e) => {
                        setContents((cur) => ({ ...cur, [selected.id]: e.target.value }));
                        markDirty(selected.id);
                      }}
                      placeholder={t("aiSettings.codexCustomPlaceholder")}
                    />
                  )}
                </div>

                <div className="border border-[var(--taomni-divider)] rounded p-2 bg-[var(--taomni-panel-bg)]/50 flex flex-col gap-1.5 shrink-0 mt-1">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold text-[var(--taomni-text)]">{t("aiSettings.ccTestTitle")}</div>
                    <button type="button" className="taomni-btn h-6 px-2 text-[10px]" onClick={test} disabled={testing || selectedLoading}>
                      {testing ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin mr-1 inline" />
                          {t("aiSettings.ccTesting")}
                        </>
                      ) : (
                        t("aiSettings.ccTestBtn")
                      )}
                    </button>
                  </div>
                  {(testOutput !== null || testError !== null || testing) && (
                    <div className="bg-[var(--taomni-bg)] border border-[var(--taomni-input-border)] rounded p-1.5 text-[10px] font-mono max-h-[100px] overflow-y-auto leading-relaxed relative">
                      <div className="text-[9px] text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)] pb-0.5 mb-1">
                        Prompt: "Hello, My name is Taomni, Can you help me?"
                      </div>
                      {testing && !testOutput && (
                        <div className="text-[var(--taomni-text-muted)] flex items-center gap-1">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          <span>{t("aiSettings.codexTestSpawning")}</span>
                        </div>
                      )}
                      {testOutput && <div className="whitespace-pre-wrap text-[var(--taomni-text)]">{testOutput}</div>}
                      {testError && <div className="text-red-400 whitespace-pre-wrap">Error: {testError}</div>}
                    </div>
                  )}
                </div>

                <div className="text-[10px] text-[var(--taomni-text-muted)] flex items-center gap-1 shrink-0">
                  <Shield className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("aiSettings.codexCustomNote")}</span>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--taomni-text-muted)] gap-2">
                <Sliders className="w-8 h-8 opacity-40" />
                <span className="text-[11px]">{t("aiSettings.codexCustomEmpty")}</span>
              </div>
            )}
          </div>
        </div>

        <div className="h-10 px-3 flex items-center gap-2 border-t shrink-0" style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}>
          {error && (
            <span className="text-[11px] text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[400px]">{error}</span>
            </span>
          )}
          <div className="flex-1" />
          <button className="taomni-btn" onClick={onClose} disabled={saving} type="button">
            {t("common.cancel")}
          </button>
          <button className="taomni-btn" data-primary="true" onClick={save} disabled={saving} type="button">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1 inline" /> : null}
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
