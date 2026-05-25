import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../lib/ipc";

export interface ChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  /** Per-thread output format override ("md" | "html" | "plain"). null = inherit AiConfig. */
  output_format?: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
}

type StreamEvent =
  | { kind: "user_message"; message: ChatMessage }
  | { kind: "assistant_start"; id: string; thread_id: string; created_at: number }
  | { kind: "token"; id: string; content: string }
  | { kind: "end"; id: string; thread_id: string; content: string; redacted_count: number }
  | { kind: "error"; id: string; message: string };

type DrawerScope = "global" | "tab" | null;
type ComposerAttachScope = "global" | "tab";

interface ChatStore {
  threads: ChatThread[];
  threadsLoaded: boolean;
  activeThreadId: string | null;
  messages: Record<string, ChatMessage[]>;
  /// Currently-streaming assistant message id per thread (for cursor display).
  streamingId: Record<string, string | null>;
  sending: boolean;
  drawerOpen: boolean;
  /// "global" for title/status/shortcut entry points, "tab" for terminal-bound chat.
  drawerScope: DrawerScope;
  /// The terminal tab currently driving a tab-bound drawer, if any.
  drawerTabId: string | null;
  /// Mirrors attached SFTP state: each terminal tab remembers whether its
  /// bound chat drawer should be visible when that tab is active.
  tabDrawerOpenByTabId: Record<string, boolean>;
  drawerWidth: number;
  /// Text the Composer should pick up next render (e.g. `@selection ...`).
  /// Cleared by the Composer once consumed.
  pendingComposerText: string;

  loadThreads: () => Promise<void>;
  newThread: (providerId?: string, linkedSessionId?: string) => Promise<ChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadProvider: (threadId: string, providerId: string) => Promise<void>;
  /// Set or clear the per-thread output-format override.
  /// Pass `null` (or omit) to clear so the thread inherits the global setting.
  setThreadOutputFormat: (threadId: string, format: string | null) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, terminalContext?: string) => Promise<void>;
  /// Open the drawer (creating a thread if needed) and stage `text` in the
  /// composer. Used by the Selection toolbar's "Send to AI" action.
  attachToComposer: (text: string, scope?: ComposerAttachScope) => Promise<void>;
  consumePendingComposerText: () => string;
  /// Open the drawer, create a fresh thread, and auto-send "请解释这段输出".
  /// Used by the Selection toolbar's "Explain" action.
  explainSelection: (text: string) => Promise<void>;
  /// Sweep threads older than `keepDays`. Returns the number deleted.
  purgeOldThreads: (keepDays: number) => Promise<number>;
  /// Export every thread + message to `outPath` as JSON.
  exportArchive: (outPath: string) => Promise<number>;
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  openGlobalChat: () => Promise<void>;
  toggleGlobalChat: () => Promise<void>;
  openTabChat: (tabId: string) => Promise<void>;
  toggleTabChat: (tabId: string) => Promise<void>;
  syncTabChatWithActiveTab: (tabId: string | null) => Promise<void>;
  setDrawerWidth: (w: number) => void;
}

function latestGlobalThread(threads: ChatThread[]): ChatThread | undefined {
  return threads.find((thread) => !thread.linked_session_id);
}

function latestTabThread(threads: ChatThread[], tabId: string): ChatThread | undefined {
  return threads.find((thread) => thread.linked_session_id === tabId);
}

function scopeForThread(thread: ChatThread | undefined | null): {
  drawerScope: DrawerScope;
  drawerTabId: string | null;
} {
  if (!thread) return { drawerScope: null, drawerTabId: null };
  return thread.linked_session_id
    ? { drawerScope: "tab", drawerTabId: thread.linked_session_id }
    : { drawerScope: "global", drawerTabId: null };
}

export const useChatStore = create<ChatStore>((set, get) => ({
  threads: [],
  threadsLoaded: false,
  activeThreadId: null,
  messages: {},
  streamingId: {},
  sending: false,
  drawerOpen: false,
  drawerScope: null,
  drawerTabId: null,
  tabDrawerOpenByTabId: {},
  drawerWidth: 380,
  pendingComposerText: "",

  loadThreads: async () => {
    try {
      const threads = await invoke<ChatThread[]>("chat_list_threads", { limit: 50 });
      set({ threads, threadsLoaded: true });
    } catch (e) {
      console.error("chat_list_threads failed:", e);
      set({ threadsLoaded: true });
    }
  },

  newThread: async (providerId?: string, linkedSessionId?: string) => {
    const thread = await invoke<ChatThread>("chat_new_thread", {
      providerId: providerId ?? null,
      linkedSessionId: linkedSessionId ?? null,
    });
    const scope = scopeForThread(thread);
    set((s) => ({
      threads: [thread, ...s.threads],
      activeThreadId: thread.id,
      ...scope,
      tabDrawerOpenByTabId: linkedSessionId
        ? { ...s.tabDrawerOpenByTabId, [linkedSessionId]: true }
        : s.tabDrawerOpenByTabId,
    }));
    return thread;
  },

  deleteThread: async (threadId: string) => {
    await invoke("chat_delete_thread", { threadId });
    const active = get().activeThreadId === threadId;
    set((s) => ({
      threads: s.threads.filter((t) => t.id !== threadId),
      activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => k !== threadId)),
      ...(active ? { drawerScope: null, drawerTabId: null } : {}),
    }));
  },

  setThreadProvider: async (threadId: string, providerId: string) => {
    await invoke("chat_set_thread_provider", { threadId, providerId });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, provider_id: providerId } : t
      ),
    }));
  },

  setThreadOutputFormat: async (threadId: string, format: string | null) => {
    // Backend treats empty/null the same — clears the override.
    await invoke("chat_set_thread_output_format", {
      threadId,
      outputFormat: format ?? null,
    });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, output_format: format } : t
      ),
    }));
  },

  setActiveThread: (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    set({ activeThreadId: threadId, ...scopeForThread(thread) });
  },

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

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<StreamEvent>(`chat-stream:${threadId}`, (event) => {
        const e = event.payload;
        const upsertMessage = (msg: ChatMessage) => {
          const list = get().messages[threadId] ?? [];
          const idx = list.findIndex((m) => m.id === msg.id);
          const next = idx >= 0
            ? list.map((m, i) => (i === idx ? msg : m))
            : [...list, msg];
          set((s) => ({ messages: { ...s.messages, [threadId]: next } }));
        };

        switch (e.kind) {
          case "user_message":
            upsertMessage(e.message);
            break;
          case "assistant_start":
            upsertMessage({
              id: e.id,
              thread_id: e.thread_id,
              role: "assistant",
              content: "",
              created_at: e.created_at,
              redacted: false,
            });
            set((s) => ({ streamingId: { ...s.streamingId, [threadId]: e.id } }));
            break;
          case "token": {
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: next[idx].content + e.content };
              set((s) => ({ messages: { ...s.messages, [threadId]: next } }));
            }
            break;
          }
          case "end": {
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: e.content };
              set((s) => ({
                messages: { ...s.messages, [threadId]: next },
                streamingId: { ...s.streamingId, [threadId]: null },
                threads: s.threads.map((t) =>
                  t.id === threadId ? { ...t, updated_at: Date.now() / 1000 } : t
                ),
              }));
            }
            break;
          }
          case "error": {
            if (isVaultLockedError(e.message)) {
              window.dispatchEvent(
                new CustomEvent(VAULT_LOCKED_EVENT, {
                  detail: {
                    reason:
                      "This AI provider's API key is in the credential vault — unlock it to continue.",
                  },
                }),
              );
            }
            const list = get().messages[threadId] ?? [];
            const idx = list.findIndex((m) => m.id === e.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], content: `[错误] ${e.message}` };
              set((s) => ({
                messages: { ...s.messages, [threadId]: next },
                streamingId: { ...s.streamingId, [threadId]: null },
              }));
            }
            break;
          }
        }
      });

      await invoke("chat_stream", {
        req: { thread_id: threadId, content, terminal_context: terminalContext ?? null },
      });
    } catch (e) {
      if (isVaultLockedError(e)) {
        // Surface the unlock dialog, then bail out — the user re-presses Send
        // after unlocking. Don't fall back to chat_send since that would hit
        // the same locked vault.
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: {
              reason:
                "This AI provider's API key is in the credential vault — unlock it to continue.",
            },
          }),
        );
        throw e;
      }
      console.error("chat_stream failed, falling back to chat_send:", e);
      try {
        const resp = await invoke<{
          user_message: ChatMessage;
          assistant_message: ChatMessage;
          redacted_count: number;
        }>("chat_send", {
          req: { thread_id: threadId, content, terminal_context: terminalContext ?? null },
        });
        set((s) => ({
          messages: {
            ...s.messages,
            [threadId]: [...(s.messages[threadId] ?? []), resp.user_message, resp.assistant_message],
          },
        }));
      } catch (e2) {
        if (isVaultLockedError(e2)) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        throw e2;
      }
    } finally {
      if (unlisten) unlisten();
      set({ sending: false });
    }
  },

  toggleDrawer: () => set((s) => {
    const closing = s.drawerOpen;
    const tabId = s.drawerScope === "tab" ? s.drawerTabId : null;
    return {
      drawerOpen: !s.drawerOpen,
      ...(closing && tabId
        ? { tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false } }
        : {}),
    };
  }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setDrawerWidth: (w) => set({ drawerWidth: Math.max(50, Math.min(720, w)) }),

  openGlobalChat: async () => {
    if (!get().threadsLoaded) {
      await get().loadThreads();
    }
    let thread = latestGlobalThread(get().threads);
    if (!thread) {
      thread = await get().newThread(undefined, undefined);
    }
    set({
      activeThreadId: thread.id,
      drawerOpen: true,
      drawerScope: "global",
      drawerTabId: null,
    });
  },

  toggleGlobalChat: async () => {
    const s = get();
    if (s.drawerOpen && s.drawerScope === "global") {
      set({ drawerOpen: false });
      return;
    }
    await get().openGlobalChat();
  },

  openTabChat: async (tabId: string) => {
    if (!tabId) return;
    if (!get().threadsLoaded) {
      await get().loadThreads();
    }
    let thread = latestTabThread(get().threads, tabId);
    if (!thread) {
      thread = await get().newThread(undefined, tabId);
    }
    set((s) => ({
      activeThreadId: thread.id,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: tabId,
      tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: true },
    }));
  },

  toggleTabChat: async (tabId: string) => {
    if (!tabId) return;
    const s = get();
    if (s.drawerOpen && s.drawerScope === "tab" && s.drawerTabId === tabId) {
      set({
        drawerOpen: false,
        tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false },
      });
      return;
    }
    await get().openTabChat(tabId);
  },

  syncTabChatWithActiveTab: async (tabId: string | null) => {
    const s = get();
    if (s.drawerScope === "global" && s.drawerOpen) return;

    if (!tabId) {
      if (s.drawerScope === "tab" && s.drawerOpen) {
        set({ drawerOpen: false, drawerTabId: null });
      }
      return;
    }

    if (s.tabDrawerOpenByTabId[tabId]) {
      await get().openTabChat(tabId);
      return;
    }

    if (s.drawerScope === "tab" && s.drawerOpen) {
      set({ drawerOpen: false, drawerTabId: tabId });
    }
  },

  attachToComposer: async (text: string, scope: ComposerAttachScope = "tab") => {
    if (scope === "global") {
      await get().openGlobalChat();
    } else {
      // Selection-toolbar and `??` sends come from a terminal surface, so
      // prefer the active terminal's bound chat over whichever global thread
      // was last open.
      const { getActiveTerminalTabId } = await import("../lib/terminal/terminalRegistry");
      const tabId = getActiveTerminalTabId();
      if (tabId) {
        await get().openTabChat(tabId);
      } else if (!get().activeThreadId) {
        await get().openGlobalChat();
      }
    }
    set({
      drawerOpen: true,
      pendingComposerText: `> ${text.replace(/\n+/g, "\n> ")}\n\n`,
    });
  },

  consumePendingComposerText: () => {
    const text = get().pendingComposerText;
    if (text) set({ pendingComposerText: "" });
    return text;
  },

  explainSelection: async (text: string) => {
    // Bind the new thread to the current terminal so the user can keep
    // chatting about the same pty without re-staging context.
    const { getActiveTerminalTabId } = await import("../lib/terminal/terminalRegistry");
    const tabId = getActiveTerminalTabId();
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
  },
}));
