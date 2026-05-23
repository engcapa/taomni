import { useEffect, useRef, useState } from "react";
import { Bot, History, Plus, X } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ChatThreadList } from "./ChatThreadList";

interface ChatDrawerProps {
  /** Optional terminal content to attach as context. */
  terminalContext?: string;
}

export function ChatDrawer({ terminalContext }: ChatDrawerProps) {
  const {
    threads, activeThreadId, messages, sending, drawerOpen, drawerWidth,
    loadThreads, newThread, deleteThread, setActiveThread, loadMessages,
    sendMessage, toggleDrawer, setDrawerWidth,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  const activeMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const activeThread = threads.find((t) => t.id === activeThreadId);

  // Load threads on mount.
  useEffect(() => {
    loadThreads();
  }, []);

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

  const handleSend = async (content: string) => {
    if (!activeThreadId) {
      const thread = await newThread();
      setError(null);
      try {
        await sendMessage(thread.id, content, terminalContext);
      } catch (e) {
        setError(String(e));
      }
      return;
    }
    setError(null);
    try {
      await sendMessage(activeThreadId, content, terminalContext);
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
      className="flex h-full shrink-0 relative"
      style={{ width: drawerWidth }}
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

        {/* Provider badge */}
        {activeThread && (
          <div className="px-2 py-1 text-[10px] text-[var(--moba-text-muted)] border-b border-[var(--moba-divider)] shrink-0">
            Provider: <span className="text-[var(--moba-accent)]">{activeThread.provider_id}</span>
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
            <MessageBubble key={msg.id} message={msg} />
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
        />
      </div>
    </div>
  );
}
