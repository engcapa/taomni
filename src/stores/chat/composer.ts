import { invoke } from "@tauri-apps/api/core";
import type { StoreApi } from "zustand";
import { resolveActiveChatTabId, scopeForThread } from "./context";
import { type ChatComposerDraft, type ChatStore } from "./model";

export function createChatComposerActions(set: StoreApi<ChatStore>["setState"], get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "attachToComposer" | "sendPromptToTabChat" | "consumePendingComposerText" | "setComposerDraft" | "clearComposerDraft" | "explainSelection" | "purgeOldThreads" | "exportArchive"> {
  return {

    attachToComposer: async (text: string) => {
      const { getActiveTerminalTabId } = await import("../../lib/terminal/terminalRegistry");
      const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
      if (tabId) {
        await get().openTabChat(tabId);
      }
      set({
        drawerOpen: true,
        pendingComposerText: `> ${text.replace(/\n+/g, "\n> ")}\n\n`,
      });
    },

    sendPromptToTabChat: async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return { status: "skipped" };
      const { getActiveTerminalTabId } = await import("../../lib/terminal/terminalRegistry");
      const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
      let threadId: string | null = null;
      if (tabId) {
        // Resolves the remembered/latest thread for this tab, or creates one.
        await get().openTabChat(tabId);
        threadId = get().activeThreadId;
      }
      if (!threadId) {
        const thread = await get().newThread(undefined, tabId ?? undefined);
        set((s) => ({
          activeThreadId: thread.id,
          ...scopeForThread(thread),
          tabDrawerOpenByTabId: tabId
            ? { ...s.tabDrawerOpenByTabId, [tabId]: true }
            : s.tabDrawerOpenByTabId,
        }));
        threadId = thread.id;
      }
      set({ drawerOpen: true });
      // Queues behind an in-flight turn instead of racing it. The outcome goes
      // back to the caller so an editor/DB action can tell the user their prompt
      // was parked, or refused because the queue is full.
      return await get().enqueueMessage(threadId, trimmed);
    },

    consumePendingComposerText: () => {
      const text = get().pendingComposerText;
      if (text) set({ pendingComposerText: "", pendingComposerOriginal: undefined });
      return text;
    },

    setComposerDraft: (key: string, draft: ChatComposerDraft) => {
      set((s) => ({
        composerDrafts: {
          ...s.composerDrafts,
          [key]: draft,
        },
      }));
    },

    clearComposerDraft: (key: string) => {
      set((s) => {
        if (!(key in s.composerDrafts)) return s;
        const next = { ...s.composerDrafts };
        delete next[key];
        return { composerDrafts: next };
      });
    },

    explainSelection: async (text: string) => {
      // Bind the new thread to the current terminal so the user can keep
      // chatting about the same pty without re-staging context.
      const { getActiveTerminalTabId } = await import("../../lib/terminal/terminalRegistry");
      const tabId = getActiveTerminalTabId() ?? (await resolveActiveChatTabId());
      const thread = await get().newThread(undefined, tabId ?? undefined);
      set((s) => ({
        drawerOpen: true,
        ...scopeForThread(thread),
        tabDrawerOpenByTabId: tabId
          ? { ...s.tabDrawerOpenByTabId, [tabId]: true }
          : s.tabDrawerOpenByTabId,
      }));
      // Fire-and-forget — sendMessage owns its own loading state.
      void get().sendMessage(thread.id, `请解释下面这段终端输出：\n\n\`\`\`\n${text}\n\`\`\``);
    },

    purgeOldThreads: async (keepDays: number) => {
      try {
        const deleted = await invoke<number>("chat_purge_old", { keepDays });
        if (deleted > 0) {
          await get().loadThreads();
        }
        return deleted;
      } catch (e) {
        console.error("chat_purge_old failed:", e);
        return 0;
      }
    },

    exportArchive: async (outPath: string) => {
      return await invoke<number>("chat_export_archive", { outPath });
    }
  };
}
