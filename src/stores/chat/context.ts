import type { CodeWorkspaceTabInfo } from "../../types";
import type { LlmProviderCapability } from "../aiStore";
import type { CodeWorkspaceContext } from "../appStore";
import { type ChatThread, type ChatThreadMode, type DrawerScope } from "./model";

export function isChatCapableTabType(type: string | null | undefined): boolean {
  return (
    type === "welcome" ||
    type === "terminal" ||
    type === "rdp" ||
    type === "database" ||
    type === "redis" ||
    // Without this, an HBase shell's explain prompt resolves to the welcome tab
    // and lands in an unrelated thread.
    type === "hbase-shell" ||
    type === "mail" ||
    type === "git" ||
    type === "code-workspace"
  );
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || "Workspace";
}

export function codeWorkspaceContextFromTab(info: CodeWorkspaceTabInfo): CodeWorkspaceContext {
  const legacyRoot = info.repoRoot?.trim() ?? "";
  const roots = info.roots && info.roots.length > 0
    ? info.roots
    : legacyRoot
      ? [{ id: "root-1", name: basename(legacyRoot), path: legacyRoot, kind: "git" as const }]
      : [];
  return {
    repoRoot: legacyRoot || roots[0]?.path || "",
    activePath: null,
    openPaths: [],
    dirtyPaths: [],
    roots,
    looseFiles: info.looseFiles ?? [],
    activeFile: null,
    openFiles: [],
    dirtyFiles: [],
  };
}

export function normalizeChatThreadMode(mode: string | null | undefined): ChatThreadMode {
  return mode === "image" || mode === "video" ? mode : "chat";
}

export function capabilityForThreadMode(mode: ChatThreadMode): LlmProviderCapability {
  if (mode === "image") return "image_generation";
  if (mode === "video") return "video_generation";
  return "chat";
}

export async function resolveActiveChatTabId(): Promise<string | null> {
  try {
    const { useAppStore } = await import("../appStore");
    const state = useAppStore.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (active && isChatCapableTabType(active.type)) return active.chatTabId ?? active.id;
    return state.tabs.find((tab) => tab.type === "welcome")?.id ?? null;
  } catch {
    return null;
  }
}

export function latestTabThread(threads: ChatThread[], tabId: string): ChatThread | undefined {
  const candidates = threads.filter((thread) => thread.linked_session_id === tabId);
  return candidates[0];
}

export function rememberedTabThread(
  threads: ChatThread[],
  activeThreadIdByTabId: Record<string, string>,
  tabId: string,
): ChatThread | undefined {
  const rememberedId = activeThreadIdByTabId[tabId];
  if (!rememberedId) return undefined;
  return threads.find(
    (thread) => thread.id === rememberedId && thread.linked_session_id === tabId,
  );
}

export function scopeForThread(thread: ChatThread | undefined | null): {
  drawerScope: DrawerScope;
  drawerTabId: string | null;
} {
  if (!thread) return { drawerScope: null, drawerTabId: null };
  return thread.linked_session_id
    ? { drawerScope: "tab", drawerTabId: thread.linked_session_id }
    : { drawerScope: null, drawerTabId: null };
}

export async function resolveDefaultProviderId(capability: LlmProviderCapability = "chat"): Promise<string | null> {
  try {
    const { chatDrawerProviderIds, defaultChatProviderId, useAiStore } = await import("../aiStore");
    const aiStore = useAiStore.getState();
    if (!aiStore.config) {
      await aiStore.loadConfig();
    }
    const config = useAiStore.getState().config;
    if (capability !== "chat") {
      return chatDrawerProviderIds(config, capability)[0] ?? null;
    }
    return defaultChatProviderId(config) ?? null;
  } catch (e) {
    console.warn("resolve default chat provider failed:", e);
    return null;
  }
}
