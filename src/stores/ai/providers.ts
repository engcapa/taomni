import { ACP_PROVIDER_PREFIX, DEFAULT_GROK_ACP_PROFILE } from "./defaults";
import { type AcpProfileConfig, type AiConfig, type LlmProviderCapability, type LlmProviderConfig } from "./model";
import { readChatDrawerProviderPreference } from "./preference";

export function isClaudeCodeAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.cc_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function isCodexAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.codex_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function acpProviderId(profileId: string): string {
  return profileId.startsWith(ACP_PROVIDER_PREFIX) ? profileId : `${ACP_PROVIDER_PREFIX}${profileId}`;
}

export function acpProfileIdFromProvider(providerId: string): string | null {
  if (!providerId.startsWith(ACP_PROVIDER_PREFIX)) return null;
  const profileId = providerId.slice(ACP_PROVIDER_PREFIX.length);
  return profileId || null;
}

export function isAcpAvailableForChat(config: AiConfig | null | undefined): boolean {
  return (
    config?.acp_bridge.enabled === true &&
    config.full_local_mode !== true &&
    config.fully_disabled !== true
  );
}

export function defaultChatProviderId(config: AiConfig | null | undefined): string | undefined {
  return chatDrawerProviderIds(config, "chat")[0];
}

export const PROVIDER_GROUP_PREFIX = "group:";

export function providerGroupRouteId(groupId: string): string {
  return groupId.startsWith(PROVIDER_GROUP_PREFIX) ? groupId : `${PROVIDER_GROUP_PREFIX}${groupId}`;
}

export function providerGroupIdFromRoute(routeId: string): string | null {
  return routeId.startsWith(PROVIDER_GROUP_PREFIX)
    ? routeId.slice(PROVIDER_GROUP_PREFIX.length)
    : null;
}

export function llmProviderSupports(provider: LlmProviderConfig | null | undefined, capability: LlmProviderCapability): boolean {
  if (!provider) return false;
  if (capability === "chat") return provider.capabilities?.chat !== false;
  return provider.capabilities?.[capability] === true;
}

export function acpProfileSupports(profile: AcpProfileConfig, capability: LlmProviderCapability): boolean {
  if (capability === "chat") return true;
  if (profile.id.trim() !== DEFAULT_GROK_ACP_PROFILE.id) return false;
  if (profile.capabilities?.[capability] === true) return true;
  // Grok profiles saved before media capabilities were added retain the
  // built-in preset's support. An explicit false remains an opt-out.
  return profile.id.trim() === DEFAULT_GROK_ACP_PROFILE.id && profile.capabilities?.[capability] === undefined;
}

export function chatDrawerProviderIds(
  config: AiConfig | null | undefined,
  capability: LlmProviderCapability = "chat",
): string[] {
  const groups = Object.entries(config?.llm.provider_groups ?? {})
    .filter(([, group]) => group.enabled !== false)
    .filter(([, group]) =>
      group.provider_ids.some((providerId) =>
        llmProviderSupports(config?.llm.providers[providerId], capability),
      ),
    )
    .map(([groupId]) => providerGroupRouteId(groupId));
  const ids = Object.entries(config?.llm.providers ?? {})
    .filter(([id, provider]) => id !== "claude-code" && id !== "codex" && llmProviderSupports(provider, capability))
    .map(([id]) => id);
  const active = config?.llm.active;
  const orderedLlmIds = active && ids.includes(active)
    ? [active, ...ids.filter((id) => id !== active)]
    : ids;
  const localAgentIds: string[] = [];
  if (capability === "chat" && isClaudeCodeAvailableForChat(config)) localAgentIds.push("claude-code");
  if (capability === "chat" && isCodexAvailableForChat(config)) localAgentIds.push("codex");
  if (isAcpAvailableForChat(config)) {
    const activeProfileId = config?.acp_bridge.active_profile_id;
    const profiles = [...(config?.acp_bridge.profiles ?? [])]
      .filter((profile) => profile.enabled && profile.command.trim() && acpProfileSupports(profile, capability))
      .sort((left, right) => Number(right.id === activeProfileId) - Number(left.id === activeProfileId));
    localAgentIds.push(...profiles.map((profile) => acpProviderId(profile.id)));
  }
  const orderedIds = [...orderedLlmIds, ...groups, ...localAgentIds];
  const preferred = readChatDrawerProviderPreference(capability);
  return Array.from(new Set(
    preferred && orderedIds.includes(preferred)
      ? [preferred, ...orderedIds]
      : orderedIds,
  )).filter((id) => id !== "opencode-go" || !(config?.full_local_mode || config?.fully_disabled));
}
