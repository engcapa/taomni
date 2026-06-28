import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useAiStore, type AiConfig, type LlmProviderConfig, type LlmProviderGroupConfig } from "../../stores/aiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { isVaultLockedError } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useT, type TranslateFn } from "../../lib/i18n";

const PROVIDER_LABELS: Record<string, string> = {
  deepseek:    "DeepSeek",
  agnes:       "Agnes",
  glm:         "GLM-4-Flash (Free)",
  siliconflow: "SiliconFlow",
  groq:        "Groq",
  local:       "Local (llama-server)",
  anthropic:   "Anthropic (Claude)",
};

const PROVIDER_NOTES: Record<string, string> = {
  deepseek:    "~¥1 per million input tokens, strong Chinese support",
  agnes:       "Text, image, and video generation via Agnes AI",
  glm:         "Completely free, top pick in China",
  siliconflow: "One key, many models; many small models free",
  groq:        "Ultra-fast inference ~500 tok/s, free tier",
  local:       "Zero cost, requires downloading a model (~1.4 GB)",
  anthropic:   "claude-sonnet-4-5, pay-as-you-go",
};

function providerApiKeys(provider: LlmProviderConfig): string[] {
  const keys = (provider.api_keys ?? []).map((key) => key ?? "");
  return keys.length > 0 ? keys : [provider.api_key ?? ""];
}

function withProviderApiKeys(provider: LlmProviderConfig, apiKeys: string[]): LlmProviderConfig {
  const keys = apiKeys.length > 0 ? apiKeys : [""];
  return {
    ...provider,
    api_key: keys[0] ?? "",
    api_keys: keys,
  };
}

function hasPlaintextVaultableKey(provider: LlmProviderConfig): boolean {
  return providerApiKeys(provider).some(
    (key) =>
      key.length > 0 &&
      !key.startsWith("vault:") &&
      provider.runtime !== "llama-server" &&
      key !== "local",
  );
}

interface ProviderRowProps {
  id: string;
  provider: LlmProviderConfig;
  isActive: boolean;
  onActivate: () => void;
  onChange: (p: LlmProviderConfig) => void;
  onTest: () => void;
  testResult: { ok: boolean; message: string; latency_ms: number } | null;
  testing: boolean;
  t: TranslateFn;
}

function ProviderRow({ id, provider, isActive, onActivate, onChange, onTest, testResult, testing, t }: ProviderRowProps) {
  const [expanded, setExpanded] = useState(false);
  const apiKeys = providerApiKeys(provider);
  const capabilities = {
    chat: provider.capabilities?.chat !== false,
    image_generation: provider.capabilities?.image_generation === true,
    video_generation: provider.capabilities?.video_generation === true,
  };
  const setCapability = (key: keyof typeof capabilities, value: boolean) => {
    onChange({
      ...provider,
      capabilities: {
        ...capabilities,
        [key]: value,
      },
    });
  };

  return (
    <div
      className={`rounded border transition-colors ${
        isActive
          ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/5"
          : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
      }`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--taomni-text-muted)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--taomni-text-muted)] shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium">{PROVIDER_LABELS[id] ?? id}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {PROVIDER_NOTES[id] ?? provider.base_url}
          </div>
        </div>

        {testResult && (
          <span className={`text-[11px] ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
            {testResult.ok ? `✓ ${testResult.latency_ms}ms` : t("aiSettings.llmFailed")}
          </span>
        )}

        <button
          type="button"
          className={`taomni-btn h-6 px-2 text-[11px] shrink-0 ${isActive ? "opacity-50 cursor-default" : ""}`}
          onClick={(e) => { e.stopPropagation(); if (!isActive) onActivate(); }}
          disabled={isActive}
        >
          {isActive ? t("aiSettings.llmActive") : t("aiSettings.llmUse")}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-[var(--taomni-divider)] pt-2 space-y-2">
          {id !== "local" && (
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmApiKey")}</label>
              <div className="space-y-1.5">
                {apiKeys.map((key, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <input
                      type="password"
                      className="taomni-input h-7 flex-1 min-w-0 text-[12px]"
                      placeholder={`${t("aiSettings.llmApiKeyPlaceholder")} #${index + 1}`}
                      value={key}
                      onChange={(e) => {
                        const next = [...apiKeys];
                        next[index] = e.target.value;
                        onChange(withProviderApiKeys(provider, next));
                      }}
                    />
                    <button
                      type="button"
                      className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                      title="Remove API key"
                      aria-label="Remove API key"
                      disabled={apiKeys.length <= 1}
                      onClick={() => {
                        const next = apiKeys.filter((_, i) => i !== index);
                        onChange(withProviderApiKeys(provider, next));
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-[12px] inline-flex items-center gap-1.5"
                  onClick={() => onChange(withProviderApiKeys(provider, [...apiKeys, ""]))}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add key
                </button>
              </div>
            </div>
          )}
          <div>
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmModel")}</label>
            <input
              type="text"
              className="taomni-input h-7 w-full text-[12px]"
              value={provider.model}
              onChange={(e) => onChange({ ...provider, model: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmCapabilities")}</label>
            <div className="flex flex-wrap gap-3 text-[11px] text-[var(--taomni-text-muted)]">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.chat}
                  onChange={(e) => setCapability("chat", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityChat")}
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.image_generation}
                  onChange={(e) => setCapability("image_generation", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityImage")}
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.video_generation}
                  onChange={(e) => setCapability("video_generation", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityVideo")}
              </label>
            </div>
          </div>
          {capabilities.image_generation && (
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmImageModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-[12px]"
                value={provider.image_model ?? ""}
                onChange={(e) => onChange({ ...provider, image_model: e.target.value })}
              />
            </div>
          )}
          {capabilities.video_generation && (
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmVideoModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-[12px]"
                value={provider.video_model ?? ""}
                onChange={(e) => onChange({ ...provider, video_model: e.target.value })}
              />
            </div>
          )}
          <div>
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmBaseUrl")}</label>
            <input
              type="text"
              className="taomni-input h-7 w-full text-[12px]"
              value={provider.base_url}
              onChange={(e) => onChange({ ...provider, base_url: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
              onClick={onTest}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                t("aiSettings.llmTestConnection")
              )}
            </button>
            {testResult && (
              <span className={`text-[12px] flex items-center gap-1 ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.ok ? (
                  <><CheckCircle className="w-3.5 h-3.5" /> {t("aiSettings.llmConnected", { ms: testResult.latency_ms })}</>
                ) : (
                  <><XCircle className="w-3.5 h-3.5" /> {testResult.message.slice(0, 60)}</>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ProviderGroupRowProps {
  id: string;
  group: LlmProviderGroupConfig;
  providers: Record<string, LlmProviderConfig>;
  onChange: (group: LlmProviderGroupConfig) => void;
  onRemove: () => void;
}

function ProviderGroupRow({ id, group, providers, onChange, onRemove }: ProviderGroupRowProps) {
  const providerEntries = Object.entries(providers).filter(([providerId]) => providerId !== "claude-code" && providerId !== "codex");
  const selected = new Set(group.provider_ids);

  const toggleProvider = (providerId: string, checked: boolean) => {
    const next = new Set(group.provider_ids);
    if (checked) {
      next.add(providerId);
    } else {
      next.delete(providerId);
    }
    onChange({ ...group, provider_ids: Array.from(next) });
  };

  return (
    <div className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={group.enabled !== false}
          onChange={(e) => onChange({ ...group, enabled: e.target.checked })}
        />
        <input
          type="text"
          className="taomni-input h-7 flex-1 min-w-0 text-[12px]"
          value={group.label}
          onChange={(e) => onChange({ ...group, label: e.target.value })}
        />
        <span className="text-[11px] text-[var(--taomni-text-muted)] shrink-0">group:{id}</span>
        <button
          type="button"
          className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
          title="Remove provider group"
          aria-label="Remove provider group"
          onClick={onRemove}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[11px] text-[var(--taomni-text-muted)]">
        {providerEntries.map(([providerId]) => (
          <label key={providerId} className="inline-flex min-w-0 items-center gap-1.5">
            <input
              type="checkbox"
              checked={selected.has(providerId)}
              onChange={(e) => toggleProvider(providerId, e.target.checked)}
            />
            <span className="truncate">{PROVIDER_LABELS[providerId] ?? providerId}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function LlmProvidersPanel() {
  const { config, loading, saving, testResults, loadConfig, saveConfig, updateLlmProvider, updateLlmProviderGroup, removeLlmProviderGroup, setActiveLlmProvider, testConnection } = useAiStore();
  const vaultState = useVaultStore((s) => s.state);
  const t = useT();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  // True while we're holding a save that bailed out because the vault was
  // locked. We retry the save automatically once the vault transitions to
  // unlocked, so the user doesn't need to click Save a second time.
  const pendingVaultSaveRef = useRef<AiConfig | null>(null);
  // Auto-dismiss timer for the success banner.
  const saveOkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  // Clear the dismissal timer if the panel unmounts mid-fade.
  useEffect(() => {
    return () => {
      if (saveOkTimerRef.current) clearTimeout(saveOkTimerRef.current);
    };
  }, []);

  const handleTest = async (id: string) => {
    if (!config) return;
    const provider = config.llm.providers[id];
    if (!provider) return;
    setTestingId(id);
    await testConnection(id, provider);
    setTestingId(null);
  };

  const runSave = async (cfg: AiConfig) => {
    setSaveError(null);
    setSaveOk(false);
    if (saveOkTimerRef.current) {
      clearTimeout(saveOkTimerRef.current);
      saveOkTimerRef.current = null;
    }
    try {
      await saveConfig(cfg);
      pendingVaultSaveRef.current = null;
      setSaveOk(true);
      // Auto-dismiss the success banner so it doesn't linger if the user
      // tweaks settings later.
      saveOkTimerRef.current = setTimeout(() => {
        setSaveOk(false);
        saveOkTimerRef.current = null;
      }, 3000);
    } catch (e) {
      if (isVaultLockedError(e)) {
        // aiStore already dispatched VAULT_LOCKED_EVENT so MainLayout's
        // unlock dialog opens. Stash the config and let the vault-state
        // effect retry the save once the user unlocks.
        pendingVaultSaveRef.current = cfg;
        setSaveError(t("aiSettings.llmVaultLockedRetry"));
      } else {
        pendingVaultSaveRef.current = null;
        setSaveError(String(e));
        console.error("Failed to save AI config:", e);
      }
    }
  };

  // When the vault becomes unlocked (or empty) and we have a save pending
  // because of a previous lock, replay it. This is what makes the warning
  // disappear on its own once the unlock dialog succeeds.
  useEffect(() => {
    if (vaultState !== "unlocked" && vaultState !== "empty") return;
    const pending = pendingVaultSaveRef.current;
    if (!pending) return;
    pendingVaultSaveRef.current = null;
    void runSave(pending);
  }, [vaultState]);

  if (loading || !config) {
    return <div className="text-[12px] text-[var(--taomni-text-muted)] p-3">{t("aiSettings.loading")}</div>;
  }

  const handleSave = async () => {
    // Determine whether any provider carries a *plaintext* API key that would
    // need to be encrypted into the vault on save. (Keys already stored as a
    // `vault:<id>` reference, the local sidecar's literal "local", and
    // llama-server runtimes need no vault.)
    const hasPlaintextKey = Object.values(config.llm.providers).some(
      (provider) => hasPlaintextVaultableKey(provider),
    );

    // If we have a plaintext key to encrypt but the vault isn't unlocked, pop
    // the on-demand gate (set a master password if empty, unlock if locked)
    // before saving. This replaces the old text-only warning + manual trip to
    // the vault settings. Bail out if the user cancels.
    if (hasPlaintextKey && vaultState !== "unlocked") {
      setSaveOk(false);
      const ready = await ensureVaultReady(t("vault.gateReasonLlm"));
      if (!ready) {
        setSaveError(t("aiSettings.llmVaultLockedSettings"));
        return;
      }
    }
    void runSave(config);
  };

  const providerGroups = config.llm.provider_groups ?? {};

  const handleAddGroup = () => {
    let index = Object.keys(providerGroups).length + 1;
    let id = `group_${index}`;
    while (providerGroups[id]) {
      index += 1;
      id = `group_${index}`;
    }
    updateLlmProviderGroup(id, {
      label: `Provider group ${index}`,
      provider_ids: [],
      enabled: true,
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-[13px] font-semibold">{t("aiSettings.llmTitle")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {t("aiSettings.llmActiveLine", {
              active: config.llm.active,
              fallback: config.llm.fallback.enabled
                ? t("aiSettings.llmFallbackOn", { ms: config.llm.fallback.timeout_ms, secondary: config.llm.fallback.secondary })
                : t("aiSettings.llmFallbackOff"),
            })}
          </div>
        </div>
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px]"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? t("aiSettings.llmSaving") : t("aiSettings.llmSave")}
        </button>
      </div>

      {saveError && (
        <div
          role="alert"
          className="flex items-start gap-2 text-[12px] rounded px-2.5 py-2"
          style={{
            background: "var(--taomni-warning-bg)",
            border: "1px solid var(--taomni-warning-border)",
            color: "var(--taomni-warning-text)",
          }}
        >
          <AlertTriangle
            className="w-3.5 h-3.5 shrink-0 mt-0.5"
            style={{ color: "var(--taomni-warning-icon)" }}
          />
          <span className="leading-relaxed">{saveError}</span>
        </div>
      )}

      {saveOk && !saveError && (
        <div
          role="status"
          className="flex items-center gap-2 text-[12px] rounded px-2.5 py-2"
          style={{
            background: "var(--taomni-success-bg)",
            border: "1px solid var(--taomni-success-border)",
            color: "var(--taomni-success-text)",
          }}
        >
          <CheckCircle
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: "var(--taomni-success-icon)" }}
          />
          <span>{t("aiSettings.llmSaved")}</span>
        </div>
      )}

      {Object.entries(config.llm.providers).map(([id, provider]) => (
        <ProviderRow
          key={id}
          id={id}
          provider={provider}
          isActive={config.llm.active === id}
          onActivate={() => setActiveLlmProvider(id)}
          onChange={(p) => updateLlmProvider(id, p)}
          onTest={() => handleTest(id)}
          testResult={testResults[id] ?? null}
          testing={testingId === id}
          t={t}
        />
      ))}

      <div className="pt-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold">Provider groups</div>
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-[12px] inline-flex items-center gap-1.5"
            onClick={handleAddGroup}
          >
            <Plus className="w-3.5 h-3.5" />
            Add group
          </button>
        </div>
        {Object.entries(providerGroups).length === 0 ? (
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            No provider groups configured.
          </div>
        ) : (
          Object.entries(providerGroups).map(([id, group]) => (
            <ProviderGroupRow
              key={id}
              id={id}
              group={group}
              providers={config.llm.providers}
              onChange={(next) => updateLlmProviderGroup(id, next)}
              onRemove={() => removeLlmProviderGroup(id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
