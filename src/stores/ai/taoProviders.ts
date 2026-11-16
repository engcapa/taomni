import type { AiConfig, LlmProviderConfig } from "./model";

const RUNTIMES = new Set(["openai-compat", "anthropic", "deepseek-messages", "opencode-go", "llama-server", "ollama"]);
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

export function taoProviderOptions(config: AiConfig | null | undefined) {
  if (!config || config.fully_disabled) return [];
  return Object.entries(config.llm.providers)
    .filter(([id, provider]) => isTaoLlmProvider(id, provider))
    .filter(([, provider]) => !config.full_local_mode || isLocalLlmEndpoint(provider.base_url))
    .map(([id, provider]) => {
      const nativeCapabilities = provider.runtime === "deepseek-messages" || provider.runtime === "opencode-go";
      const presets = provider.runtime === "deepseek-messages" ? ["deepseek-flash", "deepseek-v4-pro"]
        : provider.runtime === "opencode-go" ? ["deepseek-v4.1-flash", "deepseek-v4-pro"] : [];
      return {
        id, label: LABELS[id] ?? id, model: provider.model,
        models: Array.from(new Set([provider.model, ...presets])).filter(Boolean),
        thinking: nativeCapabilities, web: nativeCapabilities,
        reasoningEffort: provider.runtime === "opencode-go",
        ready: Boolean(provider.model.trim() && provider.base_url.trim() &&
          (isLocalLlmEndpoint(provider.base_url) || provider.api_key?.trim() || provider.api_keys?.some((key) => key.trim()))),
      };
    });
}

export function taoDefaults(config: AiConfig) {
  const options = taoProviderOptions(config);
  const saved = config.deepseek_app;
  const provider = options.find((option) => option.id === saved?.provider)
    ?? options.find((option) => option.id === config.llm.active) ?? options[0];
  return {
    defaultProvider: provider?.id ?? saved?.provider ?? "deepseek-app",
    defaultModel: provider?.id === saved?.provider ? saved?.model || provider.model : provider?.model ?? saved?.model ?? "deepseek-flash",
    defaultReasoningEffort: saved?.reasoning_effort ?? "high" as const,
    defaultCapabilities: { thinking: provider?.thinking ?? false, web: provider?.web ?? false },
    defaultThinking: Boolean(provider?.thinking && saved?.thinking_default),
    defaultWeb: Boolean(provider?.web && saved?.search_default),
  };
}
