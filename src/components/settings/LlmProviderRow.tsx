import { useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useAiStore, type LlmProviderConfig } from "../../stores/aiStore";
import { type TranslateFn } from "../../lib/i18n";
import { GoProxyFields } from "./GoProxyFields";
import { GoProviderFields } from "./GoProviderFields";
import { ModelInspectorPanel } from "./ModelInspectorPanel";
import { CustomLlmProviderFields } from "./CustomLlmProviderFields";
import { openExternalUrl } from "../../lib/sftp";
import { PROVIDER_LABELS, PROVIDER_NOTES, providerApiKeys, withProviderApiKeys } from "./llmProviderFields";

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
  startExpanded?: boolean;
  onRemove?: () => void;
}

export function ProviderRow({ id, provider, isActive, onActivate, onChange, onTest, testResult, testing, t, startExpanded = false, onRemove }: ProviderRowProps) {
  const blocked = useAiStore((s) => !!(s.config?.full_local_mode || s.config?.fully_disabled));
  const [expanded, setExpanded] = useState(startExpanded);
  const [inspecting, setInspecting] = useState(false);
  const inspectorButton = useRef<HTMLButtonElement>(null);
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
      data-testid={id === "opencode-go" ? "go-provider-row" : "llm-provider-row"}
      data-provider={id}
      data-custom={provider.custom ? "true" : undefined}
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
          {provider.custom ? <button type="button" className="text-left text-ui-body font-medium" data-testid="llm-custom-toggle"
            aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); setExpanded(!expanded); }}>{provider.custom.label || "Custom provider"}</button>
            : <div className="text-ui-body font-medium">{PROVIDER_LABELS[id] ?? id}</div>}
          <div className="text-ui-small text-[var(--taomni-text-muted)] truncate">
            {id === "opencode-go" ? t("opencodeGo.subscription") : PROVIDER_NOTES[id] ?? provider.base_url}
          </div>
        </div>

        {testResult && (
          <span className={`text-ui-small ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
            {testResult.ok ? `✓ ${testResult.latency_ms}ms` : t("aiSettings.llmFailed")}
          </span>
        )}

        <button
          type="button"
          className={`taomni-btn h-6 px-2 text-ui-small shrink-0 ${isActive ? "opacity-50 cursor-default" : ""}`}
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
              <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmApiKey")}</label>
              <div className="space-y-1.5">
                {apiKeys.map((key, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <input
                      type="password"
                      data-testid="llm-provider-key"
                      className="taomni-input h-7 flex-1 min-w-0 text-ui-body"
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
                  className="taomni-btn h-7 px-2 text-ui-body inline-flex items-center gap-1.5"
                  onClick={() => onChange(withProviderApiKeys(provider, [...apiKeys, ""]))}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add key
                </button>
              </div>
            </div>
          )}
          {provider.custom ? <CustomLlmProviderFields provider={provider} onChange={onChange} focusName={startExpanded} /> : <div>
            <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmModel")}</label>
            {id === "opencode-go" ? <>
              <a href="https://opencode.ai/console" data-testid="go-console" className="text-ui-small underline"
                onClick={(e) => { e.preventDefault(); void openExternalUrl("https://opencode.ai/console"); }}>{t("opencodeGo.console")}</a>
              <GoProviderFields provider={provider} onChange={onChange} blocked={blocked} />
            </> : <input
              type="text"
              data-testid="llm-provider-model"
              className="taomni-input h-7 w-full text-ui-body"
              value={provider.model}
              onChange={(e) => onChange({ ...provider, model: e.target.value })}
            />}
          </div>}
          {!provider.custom && <div>
            <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmCapabilities")}</label>
            <div className="flex flex-wrap gap-3 text-ui-small text-[var(--taomni-text-muted)]">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.chat}
                  disabled={id === "opencode-go"}
                  onChange={(e) => setCapability("chat", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityChat")}
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.image_generation}
                  disabled={id === "opencode-go"}
                  onChange={(e) => setCapability("image_generation", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityImage")}
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={capabilities.video_generation}
                  disabled={id === "opencode-go"}
                  onChange={(e) => setCapability("video_generation", e.target.checked)}
                />
                {t("aiSettings.llmCapabilityVideo")}
              </label>
            </div>
          </div>}
          {capabilities.image_generation && (
            <div>
              <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmImageModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-ui-body"
                value={provider.image_model ?? ""}
                onChange={(e) => onChange({ ...provider, image_model: e.target.value })}
              />
            </div>
          )}
          {capabilities.video_generation && (
            <div>
              <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmVideoModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-ui-body"
                value={provider.video_model ?? ""}
                onChange={(e) => onChange({ ...provider, video_model: e.target.value })}
              />
            </div>
          )}
          <div>
            <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.llmBaseUrl")}</label>
            <input
              type="text"
              className="taomni-input h-7 w-full text-ui-body"
              data-testid="llm-provider-base-url"
              value={provider.base_url}
              onChange={(e) => onChange({ ...provider, base_url: e.target.value })}
            />
          </div>
          <div>
            <label className="text-ui-small text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.codexProxyTitle")}</label>
            <GoProxyFields provider={provider} onChange={onChange} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            {!provider.custom && <button ref={inspectorButton} type="button" data-testid="model-inspector-open" data-provider={id}
              className="taomni-btn h-7 px-3 text-ui-body" aria-expanded={inspecting}
              onClick={() => setInspecting((open) => !open)}>{t("modelInspector.title")}</button>}
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-ui-body inline-flex items-center gap-1.5"
              onClick={onTest}
              data-testid="llm-provider-test"
              disabled={testing || (id === "opencode-go" && blocked)}
            >
              {testing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                t("aiSettings.llmTestConnection")
              )}
            </button>
            {onRemove && <button type="button" className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
              data-testid="llm-custom-remove" title={t("common.delete")} aria-label={t("common.delete")} onClick={onRemove}><Trash2 size={14} /></button>}
            {testResult && (
              <span className={`text-ui-body flex items-center gap-1 ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.ok ? (
                  <><CheckCircle className="w-3.5 h-3.5" /> {t("aiSettings.llmConnected", { ms: testResult.latency_ms })}</>
                ) : (
                  <><XCircle className="w-3.5 h-3.5" /> {testResult.message.slice(0, 60)}</>
                )}
              </span>
            )}
          </div>
          {inspecting && <ModelInspectorPanel providerId={id} currentModel={provider.model}
            blocked={blocked && (provider.runtime !== "llama-server" && provider.runtime !== "ollama"
              || !!useAiStore.getState().config?.fully_disabled)}
            onClose={() => { setInspecting(false); inspectorButton.current?.focus(); }} />}
        </div>
      )}
    </div>
  );
}
