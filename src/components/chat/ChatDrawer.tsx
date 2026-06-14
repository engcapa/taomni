import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Copy, Check, History, Plus, Globe, Link2, RefreshCw, X } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { ChatThreadList } from "./ChatThreadList";
import { NewThreadFormatPicker } from "./NewThreadFormatPicker";
import {
  getTerminal,
} from "../../lib/terminal/terminalRegistry";
import { getQueryTab } from "../../lib/queryRegistry";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";
import { useT } from "../../lib/i18n";

interface ChatDrawerProps {
  /**
   * Optional fallback terminal scrollback. When omitted (the default in the
   * production layout), the drawer pulls live buffer text from the terminal
   * registry instead — that's what makes `@terminal:last-N` actually work.
   */
  terminalContext?: string;
}

export function ChatDrawer({ terminalContext }: ChatDrawerProps) {
  const t = useT();
  const {
    threads, activeThreadId, messages, sending, drawerOpen, drawerScope, drawerWidth,
    loadThreads, newThread, deleteThread, setActiveThread, loadMessages,
    sendMessage, toggleDrawer, setDrawerWidth, purgeOldThreads,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const [showNewThreadPicker, setShowNewThreadPicker] = useState(false);
  const [pickerInitialScope, setPickerInitialScope] = useState<"terminal" | "global">("terminal");
  const [error, setError] = useState<string | null>(null);
  // Per-thread render-format override applied client-side ONLY (the persisted
  // `output_format` is locked once the thread has any messages — see issue
  // #3). Setting this lets the user re-render the existing transcript in
  // another format via the convert button without changing the prompt
  // contract sent to the LLM for the next turn.
  const [renderFormatOverride, setRenderFormatOverride] =
    useState<Record<string, ChatOutputFormat>>({});
  const [copiedAll, setCopiedAll] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  // Subscribe to the active tab so the drawer re-renders (and the
  // scope/picker logic re-evaluates) whenever the user switches tabs. We
  // can't read this from terminalRegistry alone because the registry is a
  // plain global and isn't reactive.
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTabType = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)?.type ?? null,
  );
  const focusedTerminal = useMemo(() => {
    if (activeTabType !== "terminal") return null;
    return activeTabId ? getTerminal(activeTabId) : null;
    // We deliberately depend on activeTabId/Type so the memo recomputes on
    // tab switch even though terminalRegistry itself is non-reactive.
  }, [activeTabId, activeTabType]);

  const activeMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const activeThread = threads.find((t) => t.id === activeThreadId);
  const linkedTabTitle = activeThread?.linked_session_id
    ? (
        getTerminal(activeThread.linked_session_id)?.title
        ?? getQueryTab(activeThread.linked_session_id)?.title
        ?? activeThread.linked_session_id.slice(0, 8)
      )
    : null;

  // Provider switcher dropdown — pulls the live provider list from aiStore.
  const aiProviders = useAiStore((s) => s.config?.llm.providers);
  const ccBridgeEnabled = useAiStore((s) => s.config?.cc_bridge.enabled);
  const globalOutputFormat = useAiStore((s) => s.config?.chat_output_format) ?? "md";
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const providerIds = Object.keys(aiProviders ?? {});
  if (ccBridgeEnabled) {
    providerIds.push("claude-code");
  }
  const setThreadProvider = useChatStore((s) => s.setThreadProvider);
  const setThreadOutputFormat = useChatStore((s) => s.setThreadOutputFormat);

  // Effective format for rendering this thread's messages. Resolution order:
  //   1. Client-side render-only override (set by the convert button).
  //   2. Persisted per-thread `output_format` (chosen at thread creation).
  //   3. Global default from AiConfig.
  // Mirrors the backend's resolve_output_format for #2 and #3.
  const effectiveFormat: ChatOutputFormat = useMemo(() => {
    const override = activeThreadId ? renderFormatOverride[activeThreadId] : undefined;
    if (override) return override;
    const candidate = activeThread?.output_format ?? globalOutputFormat;
    return candidate === "html" || candidate === "plain" ? candidate : "md";
  }, [activeThreadId, renderFormatOverride, activeThread?.output_format, globalOutputFormat]);

  // Once a thread has any messages, the persisted `output_format` is locked —
  // re-rendering existing replies in another format would silently invalidate
  // them (HTML rendered as Markdown is unreadable, plain text rendered as
  // Markdown collides with `*` and `_`). The user can still convert the
  // visible transcript via the render-only override.
  const formatLocked = activeThreadId
    ? (messages[activeThreadId]?.length ?? 0) > 0
    : false;

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

  const openNewThreadPicker = (scope: "terminal" | "global") => {
    setShowHistory(false);
    setPickerInitialScope(scope);
    setShowNewThreadPicker(true);
  };

  const handleNewThread = async () => {
    // Default to "terminal" when there's an active terminal, otherwise global.
    openNewThreadPicker(focusedTerminal ? "terminal" : "global");
  };

  const handleNewGlobalThread = async () => {
    openNewThreadPicker("global");
  };

  const createThreadWithFormat = async (
    format: ChatOutputFormat | null,
    scope: "terminal" | "global",
  ) => {
    setShowNewThreadPicker(false);
    const linked = scope === "terminal" ? focusedTerminal?.tabId ?? null : null;
    const thread = await newThread(undefined, linked ?? undefined);
    if (format) {
      try {
        await useChatStore.getState().setThreadOutputFormat(thread.id, format);
      } catch (e) {
        console.warn("set initial output_format failed:", e);
      }
    }
  };

  const copyAllToClipboard = async () => {
    if (!activeThreadId) return;
    const list = messages[activeThreadId] ?? [];
    if (list.length === 0) return;
    const text = list
      .map((m) => {
        const role = m.role === "user" ? t("chat.role_user") : m.role === "assistant" ? t("chat.role_assistant") : t("chat.role_system");
        return `### ${role}\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    } catch (e) {
      console.warn("copy all failed:", e);
    }
  };

  const cycleRenderFormat = () => {
    if (!activeThreadId) return;
    const order: ChatOutputFormat[] = ["md", "html", "plain"];
    const idx = order.indexOf(effectiveFormat);
    const next = order[(idx + 1) % order.length];
    setRenderFormatOverride((m) => ({ ...m, [activeThreadId]: next }));
  };

  const resolveTerminalText = (lines: number): string | undefined => {
    // Prefer the terminal linked to the active thread; fall back to the
    // currently focused terminal tab; final fallback is the legacy prop the
    // caller passed (kept for tests / programmatic use).
    const linked = activeThread?.linked_session_id ?? null;
    const entry = getTerminal(linked) ?? focusedTerminal;
    if (entry) {
      return entry.getLastLines(lines);
    }
    if (terminalContext) {
      const all = terminalContext.split("\n");
      const slice = all.slice(Math.max(0, all.length - lines));
      return slice.join("\n");
    }
    return undefined;
  };

  const handleSend = async (content: string, attachedTerminalCtx?: string) => {
    // Composer can override the prop's `terminalContext` when the user
    // types `@terminal:last-N`. The override takes precedence; otherwise we
    // fall back to whatever the host (TerminalPanel) staged.
    const ctx = attachedTerminalCtx ?? terminalContext;
    if (!activeThreadId) {
      // No thread selected — open the format picker rather than silently
      // creating one with the default format.
      openNewThreadPicker(focusedTerminal ? "terminal" : "global");
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
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--taomni-accent)] transition-colors z-10"
        onMouseDown={handleResizeStart}
      />

      <div
        className="flex flex-col w-full border-l border-[var(--taomni-divider)]"
        style={{ background: "var(--taomni-sidebar-bg)" }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          <Bot className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          <span className="text-[13px] font-semibold flex-1 truncate">
            {activeThread?.title ?? t("chat.drawerTitle")}
          </span>
          <button
            type="button"
            className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={copyAllToClipboard}
            disabled={!activeThreadId || activeMessages.length === 0}
            title={t("chat.copyAllTitle")}
            aria-label={t("chat.copyAllAria")}
          >
            {copiedAll ? (
              <Check className="w-3.5 h-3.5 text-green-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={handleNewGlobalThread}
            title={t("chat.newGlobalTitle")}
            aria-label={t("chat.newGlobalAria")}
          >
            <Globe className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={handleNewThread}
            title={t("chat.newChatTitle")}
            aria-label={t("chat.newChatAria")}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${showHistory ? "bg-[var(--taomni-selected)]" : ""}`}
            onClick={() => setShowHistory((v) => !v)}
            title={t("chat.historyTitle")}
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
            onClick={toggleDrawer}
            title={drawerScope === "tab" ? t("chat.closeShortcutTab") : t("chat.closeShortcutGlobal")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* History panel */}
        {showHistory && (
          <div className="h-48 shrink-0 border-b border-[var(--taomni-divider)] overflow-hidden">
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
          <div className="px-2 py-1 text-[10px] text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)] shrink-0 flex items-center gap-1.5 flex-wrap">
            {/* Scope badge: shows whether this thread is bound to a specific
                terminal or is a global conversation. */}
            {activeThread.linked_session_id ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--taomni-accent)]/10 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
                title={t("chat.boundToTab", { id: activeThread.linked_session_id })}
              >
                <Link2 className="w-2.5 h-2.5" />
                <span className="truncate max-w-[100px]">
                  {linkedTabTitle}
                </span>
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--taomni-divider)]/30 border border-[var(--taomni-divider)]"
                title={t("chat.globalScopeTooltip")}
              >
                <Globe className="w-2.5 h-2.5" />
                <span>{t("chat.globalBadge")}</span>
              </span>
            )}
            <span>{t("chat.providerLabel")}</span>
            {providerIds.length > 0 ? (
              <select
                className="taomni-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)]"
                value={activeThread.provider_id}
                aria-label={t("chat.threadProviderAria")}
                onChange={(e) => {
                  void setThreadProvider(activeThread.id, e.target.value);
                }}
              >
                {providerIds.map((id) => (
                  <option key={id} value={id}>
                    {id === "claude-code" ? t("chat.claudeCodeLocal") : id}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[var(--taomni-accent)]">{activeThread.provider_id}</span>
            )}
            <span className="ml-2">{t("chat.formatLabel")}</span>
            {formatLocked ? (
              // Locked once the thread has any messages — issue #3.
              <span
                className="text-[var(--taomni-accent)] px-1"
                title={t("chat.formatLockedTooltip")}
              >
                {activeThread.output_format ?? t("chat.inheritFormat", { format: globalOutputFormat })}
              </span>
            ) : (
              <select
                className="taomni-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)]"
                value={activeThread.output_format ?? ""}
                aria-label={t("chat.formatAria")}
                title={t("chat.formatEffectiveTooltip", { format: effectiveFormat, global: globalOutputFormat })}
                onChange={(e) => {
                  const v = e.target.value;
                  void setThreadOutputFormat(activeThread.id, v === "" ? null : v);
                }}
              >
                <option value="">{t("chat.inheritFormat", { format: globalOutputFormat })}</option>
                <option value="md">{t("chat.formatMd")}</option>
                <option value="html">{t("chat.formatHtml")}</option>
                <option value="plain">{t("chat.formatPlainOption")}</option>
              </select>
            )}
            <button
              type="button"
              className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px]"
              onClick={cycleRenderFormat}
              title={t("chat.convertCycleTitle", { format: effectiveFormat })}
              aria-label={t("chat.convertVisibleAria")}
            >
              <RefreshCw className="w-2.5 h-2.5" />
              <span>{t("chat.convertLabel", { format: effectiveFormat })}</span>
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
          {activeMessages.length === 0 && !sending && (
            <div className="text-[11px] text-[var(--taomni-text-muted)] text-center py-8">
              <Bot className="w-8 h-8 mx-auto mb-2 opacity-30" />
              {t("chat.emptyHint")}
            </div>
          )}
          {activeMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              format={effectiveFormat}
              preferredTerminalTabId={activeThread?.linked_session_id ?? null}
              preferredQueryTabId={activeThread?.linked_session_id ?? null}
            />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
              <div className="flex gap-0.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-[var(--taomni-accent)] animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
              {t("chat.aiThinking")}
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
          // Use the active terminal registry when available — that's what
          // makes `@terminal:last-N` work even when the drawer is rendered
          // without a `terminalContext` prop (the production case).
          resolveTerminalContext={resolveTerminalText}
        />
      </div>

      {showNewThreadPicker && (
        <NewThreadFormatPicker
          defaultFormat={
            (globalOutputFormat === "html" || globalOutputFormat === "plain")
              ? globalOutputFormat
              : "md"
          }
          defaultScope={pickerInitialScope}
          activeTerminalTitle={focusedTerminal?.title ?? null}
          onCancel={() => setShowNewThreadPicker(false)}
          onConfirm={createThreadWithFormat}
        />
      )}
    </div>
  );
}
