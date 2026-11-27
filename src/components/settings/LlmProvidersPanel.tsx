import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Plus, Trash2 } from "lucide-react";
import { useAiStore, type AiConfig, type LlmProviderConfig, type LlmProviderGroupConfig } from "../../stores/aiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { isVaultLockedError } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useLocale, useT } from "../../lib/i18n";
import { ProviderRow } from "./LlmProviderRow";
import { PROVIDER_LABELS, hasPlaintextVaultableKey } from "./llmProviderFields";
import { TaoSettingsPanel } from "./TaoSettingsPanel";
import { SettingsAnchor } from "./panel/search";
import { customProviderDraft, customProviderError } from "../../stores/ai/customLlm";

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
          className="taomni-input h-7 flex-1 min-w-0 text-ui-body"
          value={group.label}
          onChange={(e) => onChange({ ...group, label: e.target.value })}
        />
        <span className="text-ui-small text-[var(--taomni-text-muted)] shrink-0">group:{id}</span>
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
      <div className="grid grid-cols-2 gap-1.5 text-ui-small text-[var(--taomni-text-muted)]">
        {providerEntries.map(([providerId]) => (
          <label key={providerId} className="inline-flex min-w-0 items-center gap-1.5">
            <input
              type="checkbox"
              checked={selected.has(providerId)}
              onChange={(e) => toggleProvider(providerId, e.target.checked)}
            />
            <span className="truncate">{providers[providerId].custom?.label || PROVIDER_LABELS[providerId] || providerId}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function LlmProvidersPanel() {
  const { config, loading, saving, testResults, loadConfig, saveConfig, updateLlmProvider, removeCustomLlmProvider, updateLlmProviderGroup, removeLlmProviderGroup, setActiveLlmProvider, testConnection } = useAiStore();
  const vaultState = useVaultStore((s) => s.state);
  const t = useT();
  const zh = useLocale().locale === "zh-CN";
  const [newProviderId, setNewProviderId] = useState<string | null>(null);
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
    const error = customProviderError(provider, zh);
    if (error) { setSaveError(error); return; }
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
    void runSave(useAiStore.getState().config ?? pending);
  }, [vaultState]);

  if (loading || !config) {
    return <div className="text-ui-body text-[var(--taomni-text-muted)] p-3">{t("aiSettings.loading")}</div>;
  }

  const handleSave = async () => {
    for (const provider of Object.values(config.llm.providers)) {
      const error = customProviderError(provider, zh);
      if (error) {
        setSaveOk(false);
        setSaveError(`${provider.custom?.label || (zh ? "自定义服务" : "Custom provider")} · ${error}`);
        return;
      }
    }
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
    void runSave(useAiStore.getState().config ?? config);
  };

  const providerGroups = config.llm.provider_groups ?? {};
  const fullyDisabled = config.fully_disabled === true;

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
    <fieldset className="space-y-2 min-w-0" disabled={saving} data-testid="ai-llm-settings">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-ui-body font-semibold">{t("aiSettings.llmTitle")}</div>
          <div className="text-ui-small text-[var(--taomni-text-muted)]">
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
          className="taomni-btn h-7 px-3 text-ui-body"
          onClick={() => void handleSave()}
          data-testid="llm-providers-save"
          disabled={saving}
        >
          {saving ? t("aiSettings.llmSaving") : t("aiSettings.llmSave")}
        </button>
      </div>

      {saveError && (
        <div
          role="alert"
          className="flex items-start gap-2 text-ui-body rounded px-2.5 py-2"
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
          data-testid="llm-providers-status"
          className="flex items-center gap-2 text-ui-body rounded px-2.5 py-2"
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

      <SettingsAnchor id="ai-tao"><TaoSettingsPanel /></SettingsAnchor>

      {!fullyDisabled && <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
        data-testid="llm-add-custom-provider" onClick={() => {
          const id = `custom-${crypto.randomUUID()}`;
          setNewProviderId(id);
          updateLlmProvider(id, customProviderDraft(zh ? "自定义服务" : "Custom provider"));
        }}><Plus size={14} />{zh ? "添加自定义服务" : "Add custom provider"}</button>}

      {!fullyDisabled && Object.entries(config.llm.providers).map(([id, provider]) => (
        <ProviderRow
          key={id}
          id={id}
          provider={provider}
          startExpanded={id === newProviderId}
          onRemove={provider.custom ? () => removeCustomLlmProvider(id) : undefined}
          isActive={config.llm.active === id}
          onActivate={() => setActiveLlmProvider(id)}
          onChange={(p) => updateLlmProvider(id, p)}
          onTest={() => handleTest(id)}
          testResult={testResults[id] ?? null}
          testing={testingId === id}
          t={t}
        />
      ))}

      {!fullyDisabled && <div className="pt-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-ui-body font-semibold">Provider groups</div>
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-ui-body inline-flex items-center gap-1.5"
            onClick={handleAddGroup}
          >
            <Plus className="w-3.5 h-3.5" />
            Add group
          </button>
        </div>
        {Object.entries(providerGroups).length === 0 ? (
          <div className="text-ui-small text-[var(--taomni-text-muted)]">
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
      </div>}
    </fieldset>
  );
}
