import type { LlmProviderConfig } from "../../stores/aiStore";

export const PROVIDER_LABELS: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  "deepseek-app": "Tao · DeepSeek",
  deepseek:    "DeepSeek",
  agnes:       "Agnes",
  glm:         "GLM-4-Flash (Free)",
  siliconflow: "SiliconFlow",
  groq:        "Groq",
  local:       "Local (llama-server)",
  anthropic:   "Anthropic (Claude)",
};

export const PROVIDER_NOTES: Record<string, string> = {
  deepseek:    "~¥1 per million input tokens, strong Chinese support",
  agnes:       "Text, image, and video generation via Agnes AI",
  glm:         "Completely free, top pick in China",
  siliconflow: "One key, many models; many small models free",
  groq:        "Ultra-fast inference ~500 tok/s, free tier",
  local:       "Zero cost, requires downloading a model (~1.4 GB)",
  anthropic:   "claude-sonnet-4-5, pay-as-you-go",
};

export function providerApiKeys(provider: LlmProviderConfig): string[] {
  const keys = (provider.api_keys ?? []).map((key) => key ?? "");
  return keys.length > 0 ? keys : [provider.api_key ?? ""];
}

export function withProviderApiKeys(provider: LlmProviderConfig, apiKeys: string[]): LlmProviderConfig {
  const keys = apiKeys.length > 0 ? apiKeys : [""];
  return {
    ...provider,
    api_key: keys[0] ?? "",
    api_keys: keys,
  };
}

export function hasPlaintextVaultableKey(provider: LlmProviderConfig): boolean {
  return providerApiKeys(provider).some(
    (key) =>
      key.length > 0 &&
      !key.startsWith("vault:") &&
      provider.runtime !== "llama-server" &&
      (key !== "local" || provider.custom !== undefined),
  );
}
