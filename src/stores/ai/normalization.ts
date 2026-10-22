import { getLocale } from "../../lib/i18n";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_CONFIG, DEFAULT_GROK_ACP_PROFILE } from "./defaults";
import {
  type AcpBridgeConfig,
  type AcpProfileCapabilities,
  type AcpProfileConfig,
  type AiConfig,
  type LlmProviderConfig,
  type LlmProviderGroupConfig,
} from "./model";

export function normalizeModelName(model: string | undefined | null): string {
  const trimmed = (model ?? "").trim();
  return trimmed === "" || trimmed === "sonnet" ? DEFAULT_CLAUDE_CODE_MODEL : trimmed;
}

export function normalizeCodexModelName(model: string | undefined | null): string {
  const trimmed = (model ?? "").trim();
  return trimmed === "" ? DEFAULT_CODEX_MODEL : trimmed;
}

export function normalizeCodexGlobalProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

export function normalizeCodexProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "none" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "inherit";
}

export function normalizeNoProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

export function normalizeCcProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "inherit" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "none";
}

export function normalizeAcpGlobalProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "app" || trimmed === "session" || trimmed === "manual") return trimmed;
  return proxyUrl?.trim() ? "manual" : "direct";
}

export function normalizeAcpProfileProxyMode(mode: string | undefined | null, proxyUrl?: string | null): string {
  const trimmed = (mode ?? "").trim();
  if (trimmed === "direct" || trimmed === "app" || trimmed === "session" || trimmed === "manual") {
    return trimmed;
  }
  return proxyUrl?.trim() ? "manual" : "inherit";
}

export function normalizeAcpProfileCapabilities(
  profile: AcpProfileConfig,
  profileId: string,
): AcpProfileCapabilities | undefined {
  const source = profile.capabilities;
  const builtInGrok = profileId === DEFAULT_GROK_ACP_PROFILE.id;
  if (!source && !builtInGrok) return undefined;
  return {
    ...(source?.image_generation !== undefined || builtInGrok
      ? { image_generation: source?.image_generation ?? builtInGrok }
      : {}),
    ...(source?.video_generation !== undefined || builtInGrok
      ? { video_generation: source?.video_generation ?? builtInGrok }
      : {}),
  };
}

export function normalizeGrokAcpArgs(profileId: string, args: string[]): string[] {
  // Migrate only the exact old built-in default. Custom Grok arguments remain
  // visible and editable here; the Rust launch layer still enforces the
  // permission policy at process start.
  if (
    profileId === DEFAULT_GROK_ACP_PROFILE.id &&
    args.length === 2 &&
    args[0] === "agent" &&
    args[1] === "stdio"
  ) {
    return [...DEFAULT_GROK_ACP_PROFILE.args];
  }
  return args;
}

export function normalizeAcpBridge(bridge: AcpBridgeConfig | undefined): AcpBridgeConfig {
  const source = bridge ?? DEFAULT_CONFIG.acp_bridge;
  let profiles = (source.profiles ?? []).map((profile, index) => {
    const id = profile.id?.trim() || `profile-${index + 1}`;
    const args = (profile.args ?? []).map((arg) => arg.trim()).filter(Boolean);
    return {
      ...profile,
      id,
      name: profile.name?.trim() || profile.id?.trim() || `ACP Agent ${index + 1}`,
      command: profile.command?.trim() || "",
      args: normalizeGrokAcpArgs(id, args),
      capabilities: normalizeAcpProfileCapabilities(profile, id),
      auth_method_id: profile.auth_method_id?.trim() || null,
      proxy_mode: normalizeAcpProfileProxyMode(profile.proxy_mode, profile.proxy_url),
      proxy_session_id: profile.proxy_session_id?.trim() || null,
      proxy_url: profile.proxy_url?.trim() || null,
    };
  });
  const requestedActiveProfileId = source.active_profile_id?.trim();
  let activeProfileId = requestedActiveProfileId && profiles.some((profile) => profile.id === requestedActiveProfileId)
    ? requestedActiveProfileId
    : profiles[0]?.id ?? null;
  if (source.enabled === true && !profiles.some((profile) => profile.enabled)) {
    const fallbackProfile = profiles.find((profile) =>
      profile.id === activeProfileId && profile.command.length > 0
    ) ?? profiles.find((profile) => profile.command.length > 0);
    if (fallbackProfile) {
      activeProfileId = fallbackProfile.id;
      profiles = profiles.map((profile) =>
        profile.id === fallbackProfile.id ? { ...profile, enabled: true } : profile
      );
    }
  }
  return {
    ...DEFAULT_CONFIG.acp_bridge,
    ...source,
    active_profile_id: activeProfileId,
    proxy_mode: normalizeAcpGlobalProxyMode(source.proxy_mode, source.proxy_url),
    proxy_session_id: source.proxy_session_id?.trim() || null,
    proxy_url: source.proxy_url?.trim() || null,
    request_timeout_seconds: Math.min(600, Math.max(1, Math.round(source.request_timeout_seconds || 120))),
    profiles,
  };
}

export function normalizeLlmProvider(provider: LlmProviderConfig): LlmProviderConfig {
  const configuredKeys = (provider.api_keys ?? [])
    .map((key) => key ?? "")
    .filter((key) => key.trim() !== "");
  const apiKeys = configuredKeys.length > 0 ? configuredKeys : [provider.api_key ?? ""];
  return {
    ...provider,
    api_key: apiKeys[0] ?? "",
    api_keys: apiKeys,
    capabilities: {
      chat: provider.capabilities?.chat !== false,
      image_generation: provider.capabilities?.image_generation === true,
      video_generation: provider.capabilities?.video_generation === true,
    },
    image_model: provider.image_model ?? null,
    video_model: provider.video_model ?? null,
    proxy_mode: (["app", "custom", "none", "session", "manual"].includes(provider.proxy_mode?.trim() ?? "")
      ? provider.proxy_mode!.trim() : provider.runtime !== "opencode-go" && provider.proxy_url?.trim() ? "manual" : "app"),
    proxy_session_id: provider.proxy_session_id?.trim() || undefined,
    proxy_url: provider.proxy_url?.trim() || undefined,
  };
}

export function normalizeProviderGroup(id: string, group: LlmProviderGroupConfig): LlmProviderGroupConfig {
  const providerIds = Array.from(
    new Set(
      (group.provider_ids ?? [])
        .map((providerId) => providerId.trim())
        .filter(Boolean),
    ),
  );
  return {
    label: group.label?.trim() || id,
    provider_ids: providerIds,
    enabled: group.enabled !== false,
  };
}

export function configuredProviderApiKeys(provider: LlmProviderConfig): string[] {
  const keys = (provider.api_keys ?? [])
    .map((key) => key ?? "")
    .filter((key) => key.trim() !== "");
  return keys.length > 0 ? keys : [provider.api_key ?? ""];
}

export function isPlaintextVaultableKey(provider: LlmProviderConfig, key: string): boolean {
  return (
    key.length > 0 &&
    !key.startsWith("vault:") &&
    provider.runtime !== "llama-server" &&
    key !== "local"
  );
}

export function isPlaintextAsrKey(key: string): boolean {
  return key.length > 0 && !key.startsWith("vault:");
}

export function normalizeAiConfig(config: AiConfig): AiConfig {
  const providers = {
    agnes: DEFAULT_CONFIG.llm.providers.agnes,
    anthropic: DEFAULT_CONFIG.llm.providers.anthropic,
    "opencode-go": DEFAULT_CONFIG.llm.providers["opencode-go"],
    ...config.llm.providers,
  };
  const providerGroups = Object.fromEntries(
    Object.entries(config.llm.provider_groups ?? {}).map(([id, group]) => [
      id,
      normalizeProviderGroup(id, group),
    ]),
  );
  return {
    ...config,
    asr: {
      ...DEFAULT_CONFIG.asr,
      // Preserve stored credentials, custom endpoints and feature proxies.
      // Defaults only fill providers absent from older configurations.
      providers: { ...DEFAULT_CONFIG.asr.providers, ...config.asr?.providers },
      download_proxy: config.asr?.download_proxy ?? DEFAULT_CONFIG.asr.download_proxy,
      mode: ["aliyun", "volcengine", "soniox", "deepgram", "gemini"].includes(config.asr?.active) ? "online" : "local",
      active: ["local-auto", "sensevoice-small", "whisper-base-q8", "whisper-small-q8", "whisper-medium-q8", "whisper-turbo-q5", "whisper-base", "whisper-small", "whisper-medium", "sherpa-zipformer-zh-en", "aliyun", "volcengine", "soniox", "deepgram", "gemini"].includes(config.asr?.active) ? config.asr.active : "local-auto",
      hotwords: config.asr?.hotwords ?? [],
      experimental: config.asr?.experimental ?? false,
      cleanup: ["off", "light", "full"].includes(config.asr?.cleanup ?? "") ? config.asr.cleanup : "off",
      language_prior: config.asr?.language_prior ?? (getLocale().startsWith("zh") ? "zh" : "en"),
      language: ["auto", "yue", "it", "zh", "en", "ja", "ko", "fr", "de", "es"].includes(config.asr?.language ?? "") ? config.asr.language : "auto",
    },
    llm: {
      ...config.llm,
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [id, normalizeLlmProvider(provider)]),
      ),
      provider_groups: providerGroups,
    },
    cc_bridge: {
      ...DEFAULT_CONFIG.cc_bridge,
      ...config.cc_bridge,
      default_model: normalizeModelName(config.cc_bridge.default_model),
      proxy_mode: normalizeNoProxyMode(config.cc_bridge?.proxy_mode, config.cc_bridge?.proxy_url),
      proxy_session_id: config.cc_bridge?.proxy_session_id?.trim() || undefined,
      proxy_url: config.cc_bridge?.proxy_url?.trim() || undefined,
      custom_settings_profiles: (config.cc_bridge?.custom_settings_profiles ?? []).map((profile) => ({
        ...profile,
        proxy_mode: normalizeCcProfileProxyMode(profile.proxy_mode, profile.proxy_url),
        proxy_session_id: profile.proxy_session_id?.trim() || undefined,
        proxy_url: profile.proxy_url?.trim() || undefined,
      })),
    },
    codex_bridge: {
      ...DEFAULT_CONFIG.codex_bridge,
      ...config.codex_bridge,
      default_model: normalizeCodexModelName(config.codex_bridge?.default_model),
      proxy_mode: normalizeCodexGlobalProxyMode(config.codex_bridge?.proxy_mode, config.codex_bridge?.proxy_url),
      proxy_session_id: config.codex_bridge?.proxy_session_id?.trim() || undefined,
      proxy_url: config.codex_bridge?.proxy_url?.trim() || undefined,
      custom_config_profiles: (config.codex_bridge?.custom_config_profiles ?? []).map((profile) => ({
        ...profile,
        proxy_mode: normalizeCodexProfileProxyMode(profile.proxy_mode, profile.proxy_url),
        proxy_session_id: profile.proxy_session_id?.trim() || undefined,
        proxy_url: profile.proxy_url?.trim() || undefined,
      })),
    },
    acp_bridge: normalizeAcpBridge(config.acp_bridge),
  };
}
