import type { ChatAttachment } from "../../lib/chat/attachments";

export type ChatThreadMode = "chat" | "image" | "video";

export interface ChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  mode?: ChatThreadMode | string | null;
  /** Per-thread output format override ("md" | "html" | "plain"). null = inherit AiConfig. */
  output_format?: string | null;
  /** Per-thread Claude Code model override. null = inherit the Claude Code default model. */
  cc_model?: string | null;
  llm_model?: string | null;
}

/** A live, display-only Claude Code tool-activity card (3.5). */
export interface CcToolCard {
  call_id: string;
  tool: string;
  detail: string;
  /** Result preview, once the tool's result arrives. */
  result?: string;
}

/** Claude Code token/cost/timing rollup for the assistant message footer (3.5). */
export interface CcUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
}

export interface LocalTerminalEnv {
  platform: string;
  shellId?: string | null;
  shellName?: string | null;
  shellArgs?: string[];
  cwd?: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
  attachments?: ChatAttachment[];
}

export interface ChatComposerDraft {
  text: string;
  selectedAttachments: ChatAttachment[];
}

export interface ChatGenerateMediaResponse {
  user_message: ChatMessage;
  assistant_message: ChatMessage;
  redacted_count: number;
  saved_path: string;
  remote_url?: string | null;
  video_id?: string | null;
  model: string;
}

export type StreamEvent =
  | { kind: "user_message"; message: ChatMessage; }
  | { kind: "assistant_start"; id: string; thread_id: string; created_at: number; }
  | { kind: "token"; id: string; content: string; }
  | { kind: "end"; id: string; thread_id: string; content: string; redacted_count: number; }
  | { kind: "error"; id: string; message: string; }
  | {
    kind: "cc_tool_activity";
    id: string;
    call_id: string;
    phase: "use" | "result";
    tool: string;
    detail: string;
  }
  | {
    kind: "usage";
    id: string;
    input_tokens?: number | null;
    output_tokens?: number | null;
    cost_usd?: number | null;
    duration_ms?: number | null;
  };

export type DrawerScope = "tab" | null;

export type ChatDrawerPosition = "left" | "right" | "top" | "bottom";

/**
 * A send waiting behind the thread's in-flight turn.
 *
 * Queued rather than sent concurrently because a thread is a conversation: two
 * turns racing would interleave their tokens in one transcript and give the
 * model a history that never happened.
 */
export interface QueuedSend {
  id: string;
  content: string;
  terminalContext?: string;
  attachments?: ChatAttachment[];
}

/** What `enqueueMessage` did with the request. */
export type EnqueueResult =
  /** The thread was idle — sent immediately. */
  | { status: "sent"; }
  /** A turn was in flight — parked at position `position` (1-based). */
  | { status: "queued"; position: number; }
  /** The queue was already full; nothing was sent or stored. */
  | { status: "rejected"; limit: number; }
  /** No thread could be resolved or the content was blank. */
  | { status: "skipped"; };

export interface ChatDrawerLayoutPrefs {
  position: ChatDrawerPosition;
  pinned: boolean;
  width: number;
  height: number;
  floatingOpacity: number;
  /** Tao Ribbon offset along its docked edge, 0..1. */
  ribbonOffsetRatio: number;
}

export interface ChatStore {
  threads: ChatThread[];
  threadsLoaded: boolean;
  activeThreadId: string | null;
  messages: Record<string, ChatMessage[]>;
  /// Currently-streaming assistant message id per thread (for cursor display).
  streamingId: Record<string, string | null>;
  /// Live, display-only Claude Code tool cards per assistant message id (3.5).
  /// Cleared when the message stops streaming (the persisted content then holds
  /// the text transcript).
  ccToolCards: Record<string, CcToolCard[]>;
  /// Claude Code usage rollup per assistant message id (3.5), for the footer.
  ccUsage: Record<string, CcUsage>;
  /// In-flight send state by thread. A tab switch can change `activeThreadId`
  /// while the original turn keeps running, so lifecycle must stay thread-bound.
  sendingByThreadId: Record<string, boolean>;
  /// Sends parked behind each thread's in-flight turn, oldest first. Keyed by
  /// thread for the same reason as `sendingByThreadId`: one busy conversation
  /// must not hold up a different tab's.
  sendQueues: Record<string, QueuedSend[]>;
  /// Back-compat aggregate used by older call sites/tests. Prefer
  /// `sendingByThreadId[threadId]` when a specific drawer/thread is rendered.
  sending: boolean;
  drawerOpen: boolean;
  /// "tab" when the drawer is bound to a concrete app tab.
  drawerScope: DrawerScope;
  /// The terminal tab currently driving a tab-bound drawer, if any.
  drawerTabId: string | null;
  /// Mirrors attached SFTP state: each terminal tab remembers whether its
  /// bound chat drawer should be visible when that tab is active.
  tabDrawerOpenByTabId: Record<string, boolean>;
  /// The current thread per chat-capable tab. Switching tabs should restore
  /// the user's last selected/open thread for that tab instead of promoting an
  /// older history item or creating a fresh thread.
  activeThreadIdByTabId: Record<string, string>;
  drawerWidth: number;
  drawerHeight: number;
  drawerPosition: ChatDrawerPosition;
  drawerPinned: boolean;
  drawerFloatingOpacity: number;
  /// Tao Ribbon offset along its docked edge (0..1); the edge itself mirrors
  /// `drawerPosition`.
  ribbonOffsetRatio: number;
  /// Text the Composer should pick up next render (e.g. `@selection ...`).
  /// Cleared by the Composer once consumed.
  pendingComposerText: string;
  pendingComposerOriginal?: string;
  /// Unsent composer drafts keyed by thread/tab scope. Kept in memory so
  /// switching app tabs does not discard a half-written prompt.
  composerDrafts: Record<string, ChatComposerDraft>;

  loadThreads: () => Promise<void>;
  newThread: (providerId?: string, linkedSessionId?: string, mode?: ChatThreadMode) => Promise<ChatThread>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadProvider: (threadId: string, providerId: string) => Promise<void>;
  setThreadCcModel: (threadId: string, model: string | null) => Promise<void>;
  setThreadLlmModel: (threadId: string, model: string | null) => Promise<void>;
  /// Set or clear the per-thread output-format override.
  /// Pass `null` (or omit) to clear so the thread inherits the global setting.
  setThreadOutputFormat: (threadId: string, format: string | null) => Promise<void>;
  setActiveThread: (threadId: string | null) => void;
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, terminalContext?: string, attachments?: ChatAttachment[]) => Promise<void>;
  /// Send now if the thread is idle, otherwise park behind the running turn.
  /// Every user-facing send path goes through here — the composer and the
  /// programmatic prompts from the editor / DB explain actions share one queue
  /// and one limit, so a burst of "Explain" clicks cannot jump the line ahead
  /// of something typed by hand.
  ///
  /// Resolves as soon as the request is placed, not when the turn finishes.
  enqueueMessage: (
    threadId: string,
    content: string,
    terminalContext?: string,
    attachments?: ChatAttachment[],
  ) => Promise<EnqueueResult>;
  /// Drop one parked send. No effect once it has started.
  dequeueSend: (threadId: string, itemId: string) => void;
  /// Drop every parked send for a thread. Does not touch the running turn.
  clearQueue: (threadId: string) => void;
  /// Stop the running turn. The queue keeps draining — this means "skip this
  /// answer", not "abandon everything". Use `clearQueue` for the latter.
  stopSending: (threadId: string) => Promise<void>;
  /// Open the drawer (creating a thread if needed) and stage `text` in the
  /// composer as a blockquote. For raw *selections* the user will write around
  /// — terminal output, a voice transcript. Callers that have already built a
  /// complete prompt want `sendPromptToTabChat` instead: the blockquote prefix
  /// would swallow their instructions and code fences.
  attachToComposer: (text: string) => Promise<void>;
  /// Send an already-composed prompt to the active tab's chat thread verbatim.
  /// Reuses (or creates) the tab-bound thread so follow-up questions stay in the
  /// same context, and auto-sends rather than staging.
  /// Returns the queue outcome so callers can tell the user their prompt was
  /// parked rather than sent, or rejected because the queue was full.
  sendPromptToTabChat: (prompt: string) => Promise<EnqueueResult>;
  consumePendingComposerText: () => string;
  setComposerDraft: (key: string, draft: ChatComposerDraft) => void;
  clearComposerDraft: (key: string) => void;
  /// Open the drawer, create a fresh thread, and auto-send "请解释这段输出".
  /// Used by the Selection toolbar's "Explain" action.
  explainSelection: (text: string) => Promise<void>;
  /// Sweep threads older than `keepDays`. Returns the number deleted.
  purgeOldThreads: (keepDays: number) => Promise<number>;
  /// Export every thread + message to `outPath` as JSON.
  exportArchive: (outPath: string) => Promise<number>;
  toggleDrawer: () => void;
  /// Visibility-only primitive. This does not change the tab auto-restore flag.
  setDrawerOpen: (open: boolean) => void;
  /// User-driven dismissal: hide the drawer and clear the current tab's
  /// auto-restore flag. This never stops in-flight AI work; the streaming footer
  /// owns the explicit Stop action.
  dismissDrawer: () => void;
  hideDrawer: () => void;
  openTabChat: (tabId: string) => Promise<void>;
  toggleTabChat: (tabId: string) => Promise<void>;
  syncTabChatWithActiveTab: (tabId: string | null) => Promise<void>;
  setDrawerWidth: (w: number) => void;
  setDrawerHeight: (h: number) => void;
  setDrawerPosition: (position: ChatDrawerPosition) => void;
  setDrawerPinned: (pinned: boolean) => void;
  setDrawerFloatingOpacity: (opacity: number) => void;
  /// Set the Tao Ribbon's docked edge + offset in one shot. The edge updates
  /// `drawerPosition` (and pinned defaults) so the drawer opens from that edge.
  setRibbonPlacement: (position: ChatDrawerPosition, offsetRatio: number) => void;
}
