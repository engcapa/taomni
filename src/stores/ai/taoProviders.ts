import type { AiConfig, LlmProviderConfig, LlmReasoningEffort } from "./model";
import { customProviderError } from "./customLlm";

const RUNTIMES = new Set(["openai-compat", "openai-responses", "anthropic", "deepseek-messages", "opencode-go", "llama-server", "ollama"]);
const LABELS: Record<string, string> = { "deepseek-app": "DeepSeek App", "opencode-go": "OpenCode Go", anthropic: "Anthropic (Claude)", local: "Local (llama-server)" };

export function isTaoLlmProvider(id: string, provider: LlmProviderConfig): boolean {
  return !["claude-code", "codex"].includes(id) && !id.startsWith("acp:") && !id.startsWith("group:")
    && RUNTIMES.has(provider.runtime) && provider.capabilities?.chat !== false;
}

export function isLocalLlmEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ["http:", "https:"].includes(url.protocol) && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname));
  } catch { return false; }
}

export function taoModelCapabilities(provider: LlmProviderConfig, modelId: string) {
  if (provider.custom) {
    const model = provider.custom.models.find(({ id }) => id === modelId);
    const efforts = model?.reasoning_efforts ?? [];
    return { thinking: efforts.length > 0, web: model?.native_search === true, multimodal: model?.multimodal === true, efforts };
  }
  const native = provider.runtime === "deepseek-messages" || provider.runtime === "opencode-go";
  const efforts: LlmReasoningEffort[] = provider.runtime === "opencode-go" ? ["low", "medium", "high", "max"] : [];
  return { thinking: native, web: native, multimodal: true, efforts };
}

export function taoProviderOptions(config: AiConfig | null | undefined) {
  if (!config || config.fully_disabled) return [];
  return Object.entries(config.llm.providers)
    .filter(([id, provider]) => isTaoLlmProvider(id, provider))
    .filter(([, provider]) => !config.full_local_mode || isLocalLlmEndpoint(provider.base_url))
    .map(([id, provider]) => {
      const presets = provider.runtime === "deepseek-messages" ? ["deepseek-flash", "deepseek-v4-pro"]
        : provider.runtime === "opencode-go" ? ["deepseek-v4.1-flash", "deepseek-v4-pro"] : [];
      return {
        id, label: provider.custom?.label || LABELS[id] || id, model: provider.model,
        custom: Boolean(provider.custom),
        models: provider.custom?.models.map((model) => model.id).filter(Boolean) ?? Array.from(new Set([provider.model, ...presets])).filter(Boolean),
        capabilities: (model: string) => taoModelCapabilities(provider, model),
        ready: Boolean(provider.model.trim() && provider.base_url.trim() && !customProviderError(provider, false) &&
          (isLocalLlmEndpoint(provider.base_url) || provider.api_key?.trim() || provider.api_keys?.some((key) => key.trim()))),
      };
    });
}

export function taoDefaults(config: AiConfig) {
  const options = taoProviderOptions(config);
  const saved = config.deepseek_app;
  const provider = options.find((option) => option.id === saved?.provider)
    ?? options.find((option) => option.id === config.llm.active) ?? options[0];
  const preferred = provider?.id === saved?.provider ? saved?.model : undefined;
  const model = (preferred && (!provider?.custom || provider.models.includes(preferred)) ? preferred : provider?.model) || saved?.model || "deepseek-flash";
  const capabilities = provider?.capabilities(model);
  const effort = saved?.reasoning_effort ?? "high";
  return {
    defaultProvider: provider?.id ?? saved?.provider ?? "deepseek-app",
    defaultModel: model,
    defaultReasoningEffort: capabilities?.efforts.length && !capabilities.efforts.includes(effort) ? capabilities.efforts[0] : effort,
    defaultCapabilities: { thinking: capabilities?.thinking ?? false, web: capabilities?.web ?? false },
    defaultThinking: Boolean(capabilities?.thinking && saved?.thinking_default),
    defaultWeb: Boolean(capabilities?.web && saved?.search_default),
  };
}
