import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface ChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
}

interface ChatStore {
  threads: ChatThread[];
  activeThreadId: string | null;
  messages: Record<string, ChatMessage[]>;
  sending: boolean;
  drawerOpen: boolean;
  drawerWidth: number;

  loadThreads: () => Promise<void>;
  newThread: (providerId?: string, linkedSessionId?: string) => Promise<ChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, terminalContext?: string) => Promise<void>;
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerWidth: (w: number) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  threads: [],
  activeThreadId: null,
  messages: {},
  sending: false,
  drawerOpen: false,
  drawerWidth: 380,

  loadThreads: async () => {
    try {
      const threads = await invoke<ChatThread[]>("chat_list_threads", { limit: 50 });
      set({ threads });
    } catch (e) {
      console.error("chat_list_threads failed:", e);
    }
  },

  newThread: async (providerId?: string, linkedSessionId?: string) => {
    const thread = await invoke<ChatThread>("chat_new_thread", {
      providerId: providerId ?? null,
      linkedSessionId: linkedSessionId ?? null,
    });
    set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id }));
    return thread;
  },

  deleteThread: async (threadId: string) => {
    await invoke("chat_delete_thread", { threadId });
    set((s) => ({
      threads: s.threads.filter((t) => t.id !== threadId),
      activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => k !== threadId)),
    }));
  },

  setActiveThread: (threadId) => set({ activeThreadId: threadId }),

  loadMessages: async (threadId: string) => {
    try {
      const msgs = await invoke<ChatMessage[]>("chat_list_messages", { threadId });
      set((s) => ({ messages: { ...s.messages, [threadId]: msgs } }));
    } catch (e) {
      console.error("chat_list_messages failed:", e);
    }
  },

  sendMessage: async (threadId: string, content: string, terminalContext?: string) => {
    set({ sending: true });

    // Optimistically add user message.
    const optimisticUser: ChatMessage = {
      id: `opt-${Date.now()}`,
      thread_id: threadId,
      role: "user",
      content,
      created_at: Date.now() / 1000,
      redacted: false,
    };
    set((s) => ({
      messages: {
        ...s.messages,
        [threadId]: [...(s.messages[threadId] ?? []), optimisticUser],
      },
    }));

    try {
      const resp = await invoke<{
        user_message: ChatMessage;
        assistant_message: ChatMessage;
        redacted_count: number;
      }>("chat_send", {
        req: { thread_id: threadId, content, terminal_context: terminalContext ?? null },
      });

      // Replace optimistic message with real ones.
      set((s) => ({
        messages: {
          ...s.messages,
          [threadId]: [
            ...(s.messages[threadId] ?? []).filter((m) => m.id !== optimisticUser.id),
            resp.user_message,
            resp.assistant_message,
          ],
        },
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, updated_at: resp.assistant_message.created_at } : t
        ),
      }));
    } catch (e) {
      // Remove optimistic message on error.
      set((s) => ({
        messages: {
          ...s.messages,
          [threadId]: (s.messages[threadId] ?? []).filter((m) => m.id !== optimisticUser.id),
        },
      }));
      throw e;
    } finally {
      set({ sending: false });
    }
  },

  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setDrawerWidth: (w) => set({ drawerWidth: Math.max(280, Math.min(600, w)) }),
}));
