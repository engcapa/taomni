import { useEffect, useRef, useState } from "react";
import { Bot, History, Plus, X } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ChatThreadList } from "./ChatThreadList";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";

interface ChatDrawerProps {
  /** Optional terminal content to attach as context. */
  terminalContext?: string;
}

export function ChatDrawer({ terminalContext }: ChatDrawerProps) {
  const {
    threads, activeThreadId, messages, sending, drawerOpen, drawerWidth,
    loadThreads, newThread, deleteThread, setActiveThread, loadMessages,
    sendMessage, toggleDrawer, setDrawerWidth, purgeOldThreads,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  const activeMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const activeThread = threads.find((t) => t.id === activeThreadId);

  // Provider switcher dropdown — pulls the live provider list from aiStore.
  const aiProviders = useAiStore((s) => s.config?.llm.providers);
  const globalOutputFormat = useAiStore((s) => s.config?.chat_output_format) ?? "md";
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const providerIds = Object.keys(aiProviders ?? {});
  const setThreadProvider = useChatStore((s) => s.setThreadProvider);
  const setThreadOutputFormat = useChatStore((s) => s.setThreadOutputFormat);

  // Effective format for rendering this thread's messages: per-thread override
  // takes precedence over the global default. Mirrors backend resolve_output_format.
  const effectiveFormat: ChatOutputFormat = (() => {
    const candidate = activeThread?.output_format ?? globalOutputFormat;
    return candidate === "html" || candidate === "plain" ? candidate : "md";
  })();

  // Load threads on mount + sweep stale (30-day retention).
  useEffect(() => {
    loadThreads();
    void purgeOldThreads(30);
    void loadAiConfig().catch(() => undefined);
  }, []);

  // Responsive behaviour (ai-native-plan §10.3):
  //   ≥1280px → expanded (default 380px)
  //   960–1280px → collapse to 50px floating handle
  //   <960px → close + hint
  const setDrawerOpen = useChatStore((s) => s.setDrawerOpen);
  useEffect(() => {
    const handle = () => {
      const w = window.innerWidth;
      if (w < 960) {
        setDrawerOpen(false);
      } else if (w < 1280) {
        // Collapse: keep open but shrink to handle width.
        setDrawerWidth(50);
      } else if (drawerWidth < 280) {
        // User just resized larger — restore a sensible default.
        setDrawerWidth(380);
      }
    };
    window.addEventListener("resize", handle);
    handle();
    return () => window.removeEventListener("resize", handle);
    // We intentionally exclude drawerWidth from deps so the resize callback
    // only restores defaults on viewport changes, not on user drags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDrawerWidth, setDrawerOpen]);

  // Load messages when active thread changes.
  useEffect(() => {
    if (activeThreadId && !messages[activeThreadId]) {
      loadMessages(activeThreadId);
    }
  }, [activeThreadId]);

  // Scroll to bottom on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages.length]);

  const handleNewThread = async () => {
    setShowHistory(false);
    await newThread();
  };

  const handleSend = async (content: string, attachedTerminalCtx?: string) => {
    // Composer can override the prop's `terminalContext` when the user
    // types `@terminal:last-N`. The override takes precedence; otherwise we
    // fall back to whatever the host (TerminalPanel) staged.
    const ctx = attachedTerminalCtx ?? terminalContext;
    if (!activeThreadId) {
      const thread = await newThread();
      setError(null);
      try {
        await sendMessage(thread.id, content, ctx);
      } catch (e) {
        setError(String(e));
      }
      return;
    }
    setError(null);
    try {
      await sendMessage(activeThreadId, content, ctx);
    } catch (e) {
      setError(String(e));
    }
  };

  // Drag-to-resize the drawer.
  const handleResizeStart = (e: React.MouseEvent) => {
    resizingRef.current = true;
    resizeStartRef.current = { x: e.clientX, width: drawerWidth };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = resizeStartRef.current.x - ev.clientX;
      setDrawerWidth(resizeStartRef.current.width + delta);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!drawerOpen) return null;

  return (
    <div
      className="flex h-full shrink-0 relative ai-z-drawer"
      style={{ width: drawerWidth }}
      data-testid="ai-chat-drawer"
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--moba-accent)] transition-colors z-10"
        onMouseDown={handleResizeStart}
      />

      <div
        className="flex flex-col w-full border-l border-[var(--moba-divider)]"
        style={{ background: "var(--moba-sidebar-bg)" }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--moba-divider)] shrink-0"
          style={{ background: "var(--moba-panel-bg)" }}
        >
          <Bot className="w-4 h-4 text-[var(--moba-accent)] shrink-0" />
          <span className="text-[13px] font-semibold flex-1 truncate">
            {activeThread?.title ?? "AI Chat"}
          </span>
          <button
            type="button"
            className="moba-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={handleNewThread}
            title="新对话"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={`moba-btn h-6 w-6 p-0 inline-flex items-center justify-center ${showHistory ? "bg-[var(--moba-selected)]" : ""}`}
            onClick={() => setShowHistory((v) => !v)}
            title="历史对话"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="moba-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={toggleDrawer}
            title="关闭 (Ctrl+L)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* History panel */}
        {showHistory && (
          <div className="h-48 shrink-0 border-b border-[var(--moba-divider)] overflow-hidden">
            <ChatThreadList
              threads={threads}
              activeThreadId={activeThreadId}
              onSelect={(id) => { setActiveThread(id); setShowHistory(false); }}
              onNew={handleNewThread}
              onDelete={deleteThread}
            />
          </div>
        )}

        {/* Provider badge / switcher */}
        {activeThread && (
          <div className="px-2 py-1 text-[10px] text-[var(--moba-text-muted)] border-b border-[var(--moba-divider)] shrink-0 flex items-center gap-1.5 flex-wrap">
            <span>Provider:</span>
            {providerIds.length > 0 ? (
              <select
                className="moba-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--moba-accent)]"
                value={activeThread.provider_id}
                aria-label="Thread LLM provider"
                onChange={(e) => {
                  void setThreadProvider(activeThread.id, e.target.value);
                }}
              >
                {providerIds.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            ) : (
              <span className="text-[var(--moba-accent)]">{activeThread.provider_id}</span>
            )}
            <span className="ml-2">Format:</span>
            <select
              className="moba-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--moba-accent)]"
              value={activeThread.output_format ?? ""}
              aria-label="Thread output format"
              title={`Effective: ${effectiveFormat} (global default: ${globalOutputFormat})`}
              onChange={(e) => {
                const v = e.target.value;
                void setThreadOutputFormat(activeThread.id, v === "" ? null : v);
              }}
            >
              <option value="">Inherit ({globalOutputFormat})</option>
              <option value="md">Markdown</option>
              <option value="html">HTML</option>
              <option value="plain">Plain text</option>
            </select>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {activeMessages.length === 0 && !sending && (
            <div className="text-[11px] text-[var(--moba-text-muted)] text-center py-8">
              <Bot className="w-8 h-8 mx-auto mb-2 opacity-30" />
              开始对话...
            </div>
          )}
          {activeMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} format={effectiveFormat} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--moba-text-muted)]">
              <div className="flex gap-0.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-[var(--moba-accent)] animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
              AI 正在思考...
            </div>
          )}
          {error && (
            <div className="text-[11px] text-red-400 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5">
              {error}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <Composer
          onSend={handleSend}
          sending={sending}
          disabled={false}
          // When the user types `@terminal:last-N`, slice off the most recent N
          // lines from whatever terminal context was staged into the drawer.
          // We slice from the bottom so it matches the user's intent.
          resolveTerminalContext={(lines) => {
            if (!terminalContext) return undefined;
            const all = terminalContext.split("\n");
            const slice = all.slice(Math.max(0, all.length - lines));
            return slice.join("\n");
          }}
        />
      </div>
    </div>
  );
}
