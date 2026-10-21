import { type ChatDrawerProviderPreference, type LlmProviderCapability } from "./model";

export const CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY = "taomni.chatDrawer.provider.v1";

export function readChatDrawerProviderPreference(
  capability: LlmProviderCapability = "chat",
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatDrawerProviderPreference;
    const providerId = parsed?.[capability];
    return typeof providerId === "string" && providerId.trim() ? providerId : null;
  } catch {
    return null;
  }
}

export function rememberChatDrawerProviderPreference(
  providerId: string,
  capability: LlmProviderCapability = "chat",
) {
  if (typeof window === "undefined" || !providerId.trim()) return;
  try {
    const raw = window.localStorage.getItem(CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as ChatDrawerProviderPreference : {};
    window.localStorage.setItem(
      CHAT_DRAWER_PROVIDER_PREF_STORAGE_KEY,
      JSON.stringify({ ...parsed, [capability]: providerId }),
    );
  } catch {
    // Best-effort UI preference persistence.
  }
}
