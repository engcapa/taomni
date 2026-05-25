import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useAiStore, type AiConfig, type LlmProviderConfig } from "../../stores/aiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { isVaultLockedError, VAULT_LOCKED_EVENT } from "../../lib/ipc";
import { useT, type TranslateFn } from "../../lib/i18n";

const PROVIDER_LABELS: Record<string, string> = {
  deepseek:    "DeepSeek",
  glm:         "GLM-4-Flash (Free)",
  siliconflow: "SiliconFlow",
  groq:        "Groq",
  local:       "Local (llama-server)",
  anthropic:   "Anthropic (Claude)",
};

const PROVIDER_NOTES: Record<string, string> = {
  deepseek:    "~¥1 per million input tokens, strong Chinese support",
  glm:         "Completely free, top pick in China",
  siliconflow: "One key, many models; many small models free",
  groq:        "Ultra-fast inference ~500 tok/s, free tier",
  local:       "Zero cost, requires downloading a model (~1.4 GB)",
  anthropic:   "claude-sonnet-4-5, pay-as-you-go",
};

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

  return (
    <div
      className={`rounded border transition-colors ${
        isActive
          ? "border-[var(--moba-accent)] bg-[var(--moba-accent)]/5"
          : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
      }`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--moba-text-muted)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--moba-text-muted)] shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium">{PROVIDER_LABELS[id] ?? id}</div>
          <div className="text-[11px] text-[var(--moba-text-muted)] truncate">
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
          className={`moba-btn h-6 px-2 text-[11px] shrink-0 ${isActive ? "opacity-50 cursor-default" : ""}`}
          onClick={(e) => { e.stopPropagation(); if (!isActive) onActivate(); }}
          disabled={isActive}
        >
          {isActive ? t("aiSettings.llmActive") : t("aiSettings.llmUse")}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-[var(--moba-divider)] pt-2 space-y-2">
          {id !== "local" && (
            <div>
              <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">{t("aiSettings.llmApiKey")}</label>
              <input
                type="password"
                className="moba-input h-7 w-full text-[12px]"
                placeholder={t("aiSettings.llmApiKeyPlaceholder")}
                value={provider.api_key}
                onChange={(e) => onChange({ ...provider, api_key: e.target.value })}
              />
            </div>
          )}
          <div>
            <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">{t("aiSettings.llmModel")}</label>
            <input
              type="text"
              className="moba-input h-7 w-full text-[12px]"
              value={provider.model}
              onChange={(e) => onChange({ ...provider, model: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">{t("aiSettings.llmBaseUrl")}</label>
            <input
              type="text"
              className="moba-input h-7 w-full text-[12px]"
              value={provider.base_url}
              onChange={(e) => onChange({ ...provider, base_url: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
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

export function LlmProvidersPanel() {
  const { config, loading, saving, testResults, loadConfig, saveConfig, updateLlmProvider, setActiveLlmProvider, testConnection } = useAiStore();
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
    return <div className="text-[12px] text-[var(--moba-text-muted)] p-3">{t("aiSettings.loading")}</div>;
  }

  const handleSave = () => {
    // The aiStore only triggers the unlock dialog when it spots a *plaintext*
    // API key that needs encrypting. But the user may have already saved
    // every key as a `vault:<id>` reference — in that case saving silently
    // succeeds even with a locked vault, which is correct (no secrets are
    // touched), yet feels broken because the user expected to be prompted.
    // To match the user's mental model, if the vault is locked when Save is
    // clicked, surface the unlock dialog and queue the save for after.
    if (vaultState === "locked") {
      pendingVaultSaveRef.current = config;
      setSaveOk(false);
      setSaveError(t("aiSettings.llmVaultLockedSettings"));
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: {
            reason: t("aiSettings.llmVaultLockedReason"),
          },
        }),
      );
      return;
    }
    void runSave(config);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-[13px] font-semibold">{t("aiSettings.llmTitle")}</div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
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
          className="moba-btn h-7 px-3 text-[12px]"
          onClick={handleSave}
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
            background: "var(--moba-warning-bg)",
            border: "1px solid var(--moba-warning-border)",
            color: "var(--moba-warning-text)",
          }}
        >
          <AlertTriangle
            className="w-3.5 h-3.5 shrink-0 mt-0.5"
            style={{ color: "var(--moba-warning-icon)" }}
          />
          <span className="leading-relaxed">{saveError}</span>
        </div>
      )}

      {saveOk && !saveError && (
        <div
          role="status"
          className="flex items-center gap-2 text-[12px] rounded px-2.5 py-2"
          style={{
            background: "var(--moba-success-bg)",
            border: "1px solid var(--moba-success-border)",
            color: "var(--moba-success-text)",
          }}
        >
          <CheckCircle
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: "var(--moba-success-icon)" }}
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
    </div>
  );
}
