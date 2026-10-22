import { invoke } from "@tauri-apps/api/core";
import type { StoreApi } from "zustand";
import { capabilityForThreadMode, resolveDefaultProviderId, scopeForThread } from "./context";
import { type ChatMessage, type ChatStore, type ChatThread, type ChatThreadMode } from "./model";
import { markThreadMutation, mergeThreadsPreservingLocal, threadMutationRevision } from "./threadRevision";

export function createChatThreadActions(set: StoreApi<ChatStore>["setState"], get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "loadThreads" | "newThread" | "deleteThread" | "setThreadProvider" | "setThreadLlmModel" | "setThreadCcModel" | "setThreadOutputFormat" | "setActiveThread" | "loadMessages"> {
  return {

    loadThreads: async () => {
      const revisionAtRequest = threadMutationRevision;
      try {
        const threads = await invoke<ChatThread[]>("chat_list_threads", { limit: 50 });
        const current = get();
        set({
          threads: threadMutationRevision === revisionAtRequest
            ? threads
            : mergeThreadsPreservingLocal(threads, current.threads),
          threadsLoaded: true,
        });
      } catch (e) {
        console.error("chat_list_threads failed:", e);
        set({ threadsLoaded: true });
      }
    },

    newThread: async (providerId?: string, linkedSessionId?: string, mode?: ChatThreadMode) => {
      const threadMode = mode ?? "chat";
      const resolvedProviderId = providerId ?? (await resolveDefaultProviderId(capabilityForThreadMode(threadMode)));
      const thread = await invoke<ChatThread>("chat_new_thread", {
        providerId: resolvedProviderId,
        linkedSessionId: linkedSessionId ?? null,
        mode: threadMode,
      });
      markThreadMutation();
      const scope = scopeForThread(thread);
      set((s) => ({
        threads: [thread, ...s.threads],
        activeThreadId: thread.id,
        ...scope,
        tabDrawerOpenByTabId: linkedSessionId
          ? { ...s.tabDrawerOpenByTabId, [linkedSessionId]: true }
          : s.tabDrawerOpenByTabId,
        activeThreadIdByTabId: linkedSessionId
          ? { ...s.activeThreadIdByTabId, [linkedSessionId]: thread.id }
          : s.activeThreadIdByTabId,
      }));
      return thread;
    },

    deleteThread: async (threadId: string) => {
      await invoke("chat_delete_thread", { threadId });
      markThreadMutation();
      const active = get().activeThreadId === threadId;
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
        messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => k !== threadId)),
        activeThreadIdByTabId: Object.fromEntries(
          Object.entries(s.activeThreadIdByTabId).filter(([, id]) => id !== threadId),
        ),
        composerDrafts: Object.fromEntries(
          Object.entries(s.composerDrafts).filter(([key]) => key !== `thread:${threadId}`),
        ),
        // A deleted thread has nowhere left to send — drop anything parked for it
        // so it cannot be delivered to a thread that no longer exists.
        sendQueues: Object.fromEntries(
          Object.entries(s.sendQueues).filter(([key]) => key !== threadId),
        ),
        ...(active ? { drawerScope: null, drawerTabId: null } : {}),
      }));
    },

    setThreadProvider: async (threadId: string, providerId: string) => {
      await invoke("chat_set_thread_provider", { threadId, providerId });
      markThreadMutation();
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, provider_id: providerId } : t
        ),
      }));
    },

    setThreadLlmModel: async (threadId: string, model: string | null) => {
      await invoke("chat_set_thread_llm_model", { threadId, model });
      markThreadMutation();
      set((state) => ({
        threads: state.threads.map((thread) => thread.id === threadId ? { ...thread, llm_model: model } : thread),
      }));
    },
    setThreadCcModel: async (threadId: string, model: string | null) => {
      // Backend recycles the CC process so the next message respawns with the
      // new --model; empty/null clears the override (inherit default).
      await invoke("chat_set_thread_cc_model", { threadId, model: model ?? null });
      markThreadMutation();
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, cc_model: model } : t
        ),
      }));
    },

    setThreadOutputFormat: async (threadId: string, format: string | null) => {
      // Backend treats empty/null the same — clears the override.
      await invoke("chat_set_thread_output_format", {
        threadId,
        outputFormat: format ?? null,
      });
      markThreadMutation();
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, output_format: format } : t
        ),
      }));
    },

    setActiveThread: (threadId) => {
      const thread = get().threads.find((t) => t.id === threadId);
      set((s) => ({
        activeThreadId: threadId,
        ...scopeForThread(thread),
        activeThreadIdByTabId: thread?.linked_session_id
          ? { ...s.activeThreadIdByTabId, [thread.linked_session_id]: thread.id }
          : s.activeThreadIdByTabId,
      }));
    },

    loadMessages: async (threadId: string) => {
      try {
        const msgs = await invoke<ChatMessage[]>("chat_list_messages", { threadId });
        set((s) => ({ messages: { ...s.messages, [threadId]: msgs } }));
      } catch (e) {
        console.error("chat_list_messages failed:", e);
      }
    }
  };
}
