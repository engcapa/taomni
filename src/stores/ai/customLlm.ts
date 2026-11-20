import type { CustomLlmModelConfig, CustomLlmProtocol, LlmProviderConfig, LlmReasoningEffort } from "./model";

export const CUSTOM_LLM_PROTOCOLS: Record<CustomLlmProtocol, string> = {
  anthropic: "Anthropic",
  "openai-compat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

export function customReasoningEfforts(protocol: string): LlmReasoningEffort[] {
  return protocol === "anthropic" ? ["low", "medium", "high", "max"] : ["none", "minimal", "low", "medium", "high", "xhigh"];
}

export function newCustomModel(): CustomLlmModelConfig {
  return { id: "", context_window: 128_000, max_output_tokens: 8192, multimodal: false, reasoning_efforts: [], native_search: false };
}

export function customProviderDraft(label: string): LlmProviderConfig {
  return { runtime: "openai-compat", base_url: "", api_key: "", model: "", proxy_mode: "app", custom: { label, models: [newCustomModel()] } };
}

export function customProviderEndpoint(url: string, protocol: string): string {
  const suffix = protocol === "anthropic" ? "/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions";
  const base = url.trim().replace(/\/+$/, "");
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

export function customProviderError(provider: LlmProviderConfig, zh: boolean): string | undefined {
  if (!provider.custom) return;
  const label = (cn: string, en: string) => zh ? cn : en;
  if (!provider.custom.label.trim()) return label("请输入服务名称。", "Enter a provider name.");
  try {
    const url = new URL(provider.base_url.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    return label("请输入 HTTPS 服务 URL 或本机 HTTP URL。", "Enter an HTTPS provider URL or a loopback HTTP URL.");
  }
  const models = provider.custom.models;
  if (!models.length || models.some((model) => !model.id.trim() || /[\x00-\x1F\x7F]/.test(model.id) || new TextEncoder().encode(model.id.trim()).length > 256)) {
    return label("请输入每个模型的有效 ID。", "Enter a valid ID for each model.");
  }
  if (new Set(models.map((model) => model.id.trim())).size !== models.length) {
    return label("模型 ID 必须唯一。", "Model IDs must be unique.");
  }
  if (!models.some((model) => model.id.trim() === provider.model.trim())) return label("请选择默认模型。", "Choose a default model.");
  if (models.some(({ context_window, max_output_tokens }) => !Number.isInteger(context_window) || context_window > 0xffffffff || !Number.isInteger(max_output_tokens) || max_output_tokens < 1 || max_output_tokens >= context_window)) {
    return label("最大输出 Token 必须为正整数并小于上下文大小。", "Max output tokens must be a positive integer below the context size.");
  }
}
