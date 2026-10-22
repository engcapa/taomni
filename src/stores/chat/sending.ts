import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StoreApi } from "zustand";
import type { ChatAttachment } from "../../lib/chat/attachments";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../../lib/ipc";
import type { CodeWorkspaceContext, DbSelectedObject } from "../appStore";
import { codeWorkspaceContextFromTab, normalizeChatThreadMode } from "./context";
import { type ChatGenerateMediaResponse, type ChatMessage, type ChatStore, type LocalTerminalEnv, type StreamEvent } from "./model";
import { nextThreadSendingState } from "./queue";

export function createChatSendingActions(set: StoreApi<ChatStore>["setState"], get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "sendMessage"> {
  return {

    sendMessage: async (threadId: string, content: string, terminalContext?: string, attachments?: ChatAttachment[]) => {
      set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, true));

      const thread = get().threads.find((t) => t.id === threadId) ?? null;
      const threadMode = normalizeChatThreadMode(thread?.mode);
      if (threadMode !== "chat") {
        try {
          const hadMessages = (get().messages[threadId]?.length ?? 0) > 0;
          const resp = await invoke<ChatGenerateMediaResponse>("chat_generate_media", {
            req: {
              thread_id: threadId,
              prompt: content,
              kind: threadMode,
              attachments: attachments ?? [],
            },
          });
          set((s) => ({
            messages: {
              ...s.messages,
              [threadId]: [
                ...(s.messages[threadId] ?? []),
                resp.user_message,
                resp.assistant_message,
              ],
            },
            threads: s.threads.map((t) =>
              t.id === threadId
                ? {
                  ...t,
                  updated_at: Date.now() / 1000,
                  title: hadMessages ? t.title : resp.user_message.content.slice(0, 40) || t.title,
                }
                : t
            ),
          }));
        } catch (e) {
          if (isVaultLockedError(e)) {
            window.dispatchEvent(
              new CustomEvent(VAULT_LOCKED_EVENT, {
                detail: {
                  reason:
                    "This AI provider's API key is in the credential vault — unlock it to continue.",
                },
              }),
            );
          }
          throw e;
        } finally {
          set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
        }
        return;
      }

      // Phase 3.S — resolve the saved SessionConfig.id this thread is bound to so
      // the backend can build Claude Code's session-identity card.
      // `thread.linked_session_id` is a terminal *tab* id; the saved-session id
      // lives on the Tab as `sessionId` (set when the tab was opened from a saved
      // session). Null for unbound / local / unsaved-tab threads — the backend
      // then emits a degraded "local workspace" card.
      let boundSessionId: string | null = null;
      // Phase 3.3 — the bound terminal's live cwd (OSC-7), injected per-turn so
      // CC knows the working directory without re-querying. Volatile, so resolved
      // fresh each send. Null for unbound/local/unsaved-tab threads or shells that
      // can't report a cwd.
      let cwd: string | null = null;
      // Phase 6 — the live DB connection id for a thread bound to a DB/Redis tab,
      // bridged per-turn so the CC DB MCP can target it (the backend can't derive
      // the runtime key). Null for non-DB threads or a disconnected DB tab.
      let boundDbConnectionId: string | null = null;
      // Current object-tree selection for DB SQL MCP. Empty for non-DB/Redis tabs
      // or when no object is selected.
      let boundDbSelectedObjects: DbSelectedObject[] = [];
      // Local terminal facts for Claude Code's appended system prompt. Only set
      // for a live local terminal; SSH/remote tabs deliberately leave this null.
      let localTerminalEnv: LocalTerminalEnv | null = null;
      // Current code workspace state for Codex/Claude Code turns bound to an
      // editor tab. This is context only; file writes still go through tools.
      let codeWorkspace: CodeWorkspaceContext | null = null;
      {
        const tabId = get().threads.find((t) => t.id === threadId)?.linked_session_id ?? null;
        if (tabId) {
          try {
            const { useAppStore } = await import("../appStore");
            const { getTerminal } = await import("../../lib/terminal/terminalRegistry");
            const appState = useAppStore.getState();
            const boundTab = appState.tabs.find((t) => t.id === tabId || t.chatTabId === tabId) ?? null;
            const runtimeTabId = boundTab?.id ?? tabId;
            boundSessionId = boundTab?.sessionId ?? null;
            cwd = appState.cwdByTab[tabId] ?? appState.cwdByTab[runtimeTabId] ?? null;
            boundDbConnectionId = appState.dbConnByTab[tabId] ?? appState.dbConnByTab[runtimeTabId] ?? null;
            boundDbSelectedObjects =
              appState.dbSelectedObjectsByTab[tabId] ??
              appState.dbSelectedObjectsByTab[runtimeTabId] ??
              [];
            codeWorkspace =
              appState.codeWorkspaceByTab[tabId] ??
              appState.codeWorkspaceByTab[runtimeTabId] ??
              (boundTab?.type === "code-workspace" && boundTab.codeWorkspace
                ? codeWorkspaceContextFromTab(boundTab.codeWorkspace)
                : null);
            const localEnv = getTerminal(tabId)?.localEnvironment ?? getTerminal(runtimeTabId)?.localEnvironment ?? null;
            if (localEnv) {
              localTerminalEnv = { ...localEnv, cwd };
            }
          } catch (err) {
            console.warn("bound_session_id resolution failed:", err);
          }
        }
      }

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
                attachments: [],
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
                set((s) => {
                  // The persisted content now holds the text transcript of tool
                  // activity, so the live cards would duplicate it — drop them.
                  const cards = { ...s.ccToolCards };
                  delete cards[e.id];
                  return {
                    messages: { ...s.messages, [threadId]: next },
                    streamingId: { ...s.streamingId, [threadId]: null },
                    ccToolCards: cards,
                    threads: s.threads.map((t) =>
                      t.id === threadId ? { ...t, updated_at: Date.now() / 1000 } : t
                    ),
                  };
                });
              }
              // Tao Ribbon: if this reply landed while its Chat panel wasn't the
              // visible surface, raise an `ai_done` alert so the user is notified
              // and can jump back to the thread (§10.2).
              void (async () => {
                try {
                  const { useTaoAlertStore } = await import("../taoAlertStore");
                  const { useTaoHubStore } = await import("../taoHubStore");
                  const s = get();
                  const visible =
                    s.drawerOpen &&
                    s.activeThreadId === threadId &&
                    useTaoHubStore.getState().hubTab === "chat";
                  if (!visible) {
                    const thread = s.threads.find((th) => th.id === threadId);
                    useTaoAlertStore.getState().pushAiDone(threadId, thread?.title ?? "AI");
                  }
                } catch {
                  /* alert bridge is best-effort */
                }
              })();
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
            case "cc_tool_activity": {
              set((s) => {
                const cards = [...(s.ccToolCards[e.id] ?? [])];
                if (e.phase === "use") {
                  cards.push({ call_id: e.call_id, tool: e.tool, detail: e.detail });
                } else {
                  // "result" — attach the preview to the matching pending card.
                  const ci = cards.findIndex(
                    (c) => c.call_id === e.call_id && c.result === undefined,
                  );
                  if (ci >= 0) {
                    cards[ci] = { ...cards[ci], result: e.detail };
                  }
                }
                return { ccToolCards: { ...s.ccToolCards, [e.id]: cards } };
              });
              break;
            }
            case "usage": {
              set((s) => ({
                ccUsage: {
                  ...s.ccUsage,
                  [e.id]: {
                    input_tokens: e.input_tokens,
                    output_tokens: e.output_tokens,
                    cost_usd: e.cost_usd,
                    duration_ms: e.duration_ms,
                  },
                },
              }));
              break;
            }
          }
        });

        await invoke("chat_stream", {
          req: {
            thread_id: threadId,
            content,
            attachments: attachments ?? [],
            terminal_context: terminalContext ?? null,
            bound_session_id: boundSessionId,
            cwd,
            local_terminal_env: localTerminalEnv,
            bound_db_connection_id: boundDbConnectionId,
            bound_db_selected_objects: boundDbSelectedObjects,
            code_workspace: codeWorkspace,
          },
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
            req: {
              thread_id: threadId,
              content,
              attachments: attachments ?? [],
              terminal_context: terminalContext ?? null,
              bound_session_id: boundSessionId,
              cwd,
              local_terminal_env: localTerminalEnv,
              bound_db_connection_id: boundDbConnectionId,
              bound_db_selected_objects: boundDbSelectedObjects,
              code_workspace: codeWorkspace,
            },
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
        set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
      }
    }
  };
}
