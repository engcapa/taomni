import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  History,
  Link2,
  PanelBottomOpen,
  PanelLeftOpen,
  PanelRightOpen,
  PanelTopOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { useChatStore, type ChatDrawerPosition } from "../../stores/chatStore";
import { chatDrawerProviderIds, DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { MessageBubble } from "./MessageBubble";
import { CcToolCards } from "./CcToolCards";
import { Composer } from "./Composer";
import { ChatThreadList } from "./ChatThreadList";
import {
  getTerminal,
} from "../../lib/terminal/terminalRegistry";
import { getQueryTab } from "../../lib/queryRegistry";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";
import { useT } from "../../lib/i18n";

const CHAT_CAPABLE_TAB_TYPES = new Set(["welcome", "terminal", "rdp", "database", "redis"]);
const DRAWER_POSITIONS: ChatDrawerPosition[] = ["left", "right", "top", "bottom"];

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
    threads, activeThreadId, messages, sendingByThreadId, drawerOpen, drawerWidth,
    drawerHeight, drawerPosition, drawerPinned, drawerTabId,
    loadThreads, newThread, deleteThread, setActiveThread, loadMessages,
    sendMessage, hideDrawer, setDrawerWidth, setDrawerHeight, setDrawerPosition,
    setDrawerPinned, purgeOldThreads, stopSending,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const [showPositionMenu, setShowPositionMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-thread render-format override applied client-side ONLY (the persisted
  // `output_format` is locked once the thread has any messages — see issue
  // #3). Setting this lets the user re-render the existing transcript in
  // another format via the convert button without changing the prompt
  // contract sent to the LLM for the next turn.
  const [renderFormatOverride, setRenderFormatOverride] =
    useState<Record<string, ChatOutputFormat>>({});
  const [copiedAll, setCopiedAll] = useState(false);
  const [ccModelDraft, setCcModelDraft] = useState(DEFAULT_CLAUDE_CODE_MODEL);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  // Subscribe to the active tab so the drawer re-renders (and the
  // scope/picker logic re-evaluates) whenever the user switches tabs. We
  // can't read this from terminalRegistry alone because the registry is a
  // plain global and isn't reactive.
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTabType = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)?.type ?? null,
  );
  const activeChatTabId = CHAT_CAPABLE_TAB_TYPES.has(activeTabType ?? "")
    ? activeTabId
    : null;
  // SQL echo toggle (Phase 6) — appended to the linked query tab when CC runs
  // SQL. Subscribed so the toggle reflects/persists across the app.
  const sqlEcho = useAppStore((s) => s.sqlEcho);
  const setSqlEcho = useAppStore((s) => s.setSqlEcho);
  const focusedTerminal = useMemo(() => {
    if (activeTabType !== "terminal") return null;
    return activeTabId ? getTerminal(activeTabId) : null;
    // We deliberately depend on activeTabId/Type so the memo recomputes on
    // tab switch even though terminalRegistry itself is non-reactive.
  }, [activeTabId, activeTabType]);

  const activeMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const sending = activeThreadId ? sendingByThreadId[activeThreadId] === true : false;
  const activeThread = threads.find((t) => t.id === activeThreadId);
  const linkedTab = useAppStore((s) =>
    activeThread?.linked_session_id
      ? s.tabs.find((tab) => tab.id === activeThread.linked_session_id) ?? null
      : null,
  );
  const linkedTabTitle = activeThread?.linked_session_id
    ? (
        getTerminal(activeThread.linked_session_id)?.title
        ?? getQueryTab(activeThread.linked_session_id)?.title
        ?? linkedTab?.title
        ?? activeThread.linked_session_id.slice(0, 8)
      )
    : null;
  // The SQL echo toggle only applies to threads bound to a SQL ("database")
  // tab. Resolved from the tab type so it stays reactive as tabs open/close.
  const linkedTabType = linkedTab?.type ?? null;
  const isQueryThread = linkedTabType === "database";
  const visibleThreads = useMemo(
    () => drawerTabId
      ? threads.filter((thread) => thread.linked_session_id === drawerTabId)
      : threads.filter((thread) => thread.linked_session_id),
    [drawerTabId, threads],
  );

  // Provider switcher dropdown — pulls the live provider list from aiStore.
  const aiConfig = useAiStore((s) => s.config);
  const defaultCcModel = aiConfig?.cc_bridge.default_model?.trim() || DEFAULT_CLAUDE_CODE_MODEL;
  const defaultCodexModel = aiConfig?.codex_bridge.default_model?.trim() || DEFAULT_CODEX_MODEL;
  const isLocalAgentProvider = activeThread?.provider_id === "claude-code" || activeThread?.provider_id === "codex";
  const defaultLocalAgentModel = activeThread?.provider_id === "codex" ? defaultCodexModel : defaultCcModel;
  const ccTerminalEchoEnabled = activeThread?.provider_id === "codex"
    ? (aiConfig?.codex_bridge.terminal_echo_enabled ?? true)
    : (aiConfig?.cc_bridge.terminal_echo_enabled ?? true);
  const globalOutputFormat = aiConfig?.chat_output_format ?? "md";
  const loadAiConfig = useAiStore((s) => s.loadConfig);
  const saveAiConfig = useAiStore((s) => s.saveConfig);
  const providerIds = useMemo(() => chatDrawerProviderIds(aiConfig), [aiConfig]);
  const setThreadProvider = useChatStore((s) => s.setThreadProvider);
  const setThreadCcModel = useChatStore((s) => s.setThreadCcModel);
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

  useEffect(() => {
    if (!isLocalAgentProvider) {
      setCcModelDraft(defaultLocalAgentModel);
      return;
    }
    setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
  }, [activeThread?.id, activeThread?.provider_id, activeThread?.cc_model, isLocalAgentProvider, defaultLocalAgentModel]);

  // Narrow windows keep the tab usable by hiding to the ribbon; medium widths
  // float the drawer instead of consuming layout width.
  useEffect(() => {
    const handle = () => {
      const w = window.innerWidth;
      if (w < 760) {
        hideDrawer();
      } else if (w < 1120 && (drawerPosition === "left" || drawerPosition === "right") && drawerPinned) {
        setDrawerPinned(false);
      }
    };
    window.addEventListener("resize", handle);
    handle();
    return () => window.removeEventListener("resize", handle);
  }, [drawerPinned, drawerPosition, hideDrawer, setDrawerPinned]);

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
    const linked = drawerTabId ?? activeChatTabId;
    if (!linked) {
      setError(t("chat.noTabBinding"));
      return;
    }
    setShowHistory(false);
    try {
      await newThread(undefined, linked);
      setError(null);
    } catch (e) {
      setError(String(e));
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

  const setCcTerminalEcho = (enabled: boolean) => {
    if (!aiConfig) return;
    const next = activeThread?.provider_id === "codex"
      ? { ...aiConfig, codex_bridge: { ...aiConfig.codex_bridge, terminal_echo_enabled: enabled } }
      : { ...aiConfig, cc_bridge: { ...aiConfig.cc_bridge, terminal_echo_enabled: enabled } };
    void saveAiConfig(next).catch((e) => {
      console.warn("save local agent terminal echo setting failed:", e);
    });
  };

  const commitThreadCcModel = () => {
    if (!activeThread || !isLocalAgentProvider) return;
    const trimmed = ccModelDraft.trim();
    const nextModel = trimmed === "" || trimmed === defaultLocalAgentModel ? null : trimmed;
    if ((activeThread.cc_model ?? null) === nextModel) {
      setCcModelDraft(nextModel ?? defaultLocalAgentModel);
      return;
    }
    setCcModelDraft(nextModel ?? defaultLocalAgentModel);
    void setThreadCcModel(activeThread.id, nextModel).catch((e) => {
      console.warn("set local agent thread model failed:", e);
      setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
    });
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
    setError(null);
    try {
      let threadId = activeThreadId;
      if (!threadId) {
        const linked = drawerTabId ?? activeChatTabId;
        if (!linked) {
          setError(t("chat.noTabBinding"));
          return;
        }
        const thread = await newThread(undefined, linked);
        threadId = thread.id;
      }
      await sendMessage(threadId, content, ctx);
    } catch (e) {
      setError(String(e));
    }
  };

  // Drag-to-resize the drawer.
  const handleResizeStart = (e: React.MouseEvent) => {
    resizingRef.current = true;
    resizeStartRef.current = { x: e.clientX, y: e.clientY, width: drawerWidth, height: drawerHeight };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      if (drawerPosition === "left") {
        setDrawerWidth(resizeStartRef.current.width + ev.clientX - resizeStartRef.current.x);
      } else if (drawerPosition === "right") {
        setDrawerWidth(resizeStartRef.current.width + resizeStartRef.current.x - ev.clientX);
      } else if (drawerPosition === "top") {
        setDrawerHeight(resizeStartRef.current.height + ev.clientY - resizeStartRef.current.y);
      } else {
        setDrawerHeight(resizeStartRef.current.height + resizeStartRef.current.y - ev.clientY);
      }
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

  const isHorizontalDock = drawerPosition === "left" || drawerPosition === "right";
  const sideBySide = isHorizontalDock && drawerPinned;
  const floating = !sideBySide;
  const positionLabel = t(`chat.drawerPosition_${drawerPosition}`);
  const PositionIcon = positionIcon(drawerPosition);
  const containerClass = [
    "ai-z-drawer",
    sideBySide ? "relative h-full shrink-0" : "absolute shadow-2xl",
    drawerPosition === "left" ? "order-first" : "",
    floating ? "rounded-md overflow-hidden" : "",
  ].filter(Boolean).join(" ");
  const containerStyle: CSSProperties = sideBySide
    ? { width: drawerWidth }
    : isHorizontalDock
    ? {
        width: drawerWidth,
        top: 0,
        bottom: 0,
        [drawerPosition]: 0,
      }
    : {
        height: drawerHeight,
        left: 56,
        right: 56,
        [drawerPosition]: 0,
      };
  const resizeHandleClass = isHorizontalDock
    ? `absolute ${drawerPosition === "left" ? "right-0" : "left-0"} top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--taomni-accent)] transition-colors z-10`
    : `absolute left-0 right-0 ${drawerPosition === "top" ? "bottom-0" : "top-0"} h-1 cursor-row-resize hover:bg-[var(--taomni-accent)] transition-colors z-10`;
  const panelBorderClass = sideBySide
    ? drawerPosition === "left"
      ? "border-r"
      : "border-l"
    : "border";

  return (
    <div
      className={containerClass}
      style={containerStyle}
      data-testid="ai-chat-drawer"
      data-position={drawerPosition}
      data-pinned={drawerPinned || undefined}
    >
      {/* Resize handle */}
      <div
        className={resizeHandleClass}
        onMouseDown={handleResizeStart}
      />

      <div
        className={`flex flex-col w-full h-full ${panelBorderClass} border-[var(--taomni-divider)]`}
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
          <div className="relative">
            <button
              type="button"
              className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1 text-[11px]"
              onClick={() => setShowPositionMenu((v) => !v)}
              title={t("chat.drawerPositionTitle", { position: positionLabel })}
              aria-label={t("chat.drawerPositionAria")}
              data-testid="ai-chat-drawer-position"
            >
              <PositionIcon className="w-3.5 h-3.5" />
              <ChevronDown className="w-3 h-3" />
            </button>
            {showPositionMenu && (
              <div
                className="absolute right-0 top-7 z-30 min-w-[118px] rounded border border-[var(--taomni-divider)] shadow-lg overflow-hidden"
                style={{ background: "var(--taomni-panel-bg)" }}
              >
                {DRAWER_POSITIONS.map((position) => {
                  const Icon = positionIcon(position);
                  return (
                    <button
                      key={position}
                      type="button"
                      className={`w-full h-7 px-2 text-left text-[11px] flex items-center gap-2 hover:bg-[var(--taomni-hover)] ${
                        drawerPosition === position ? "text-[var(--taomni-accent)] bg-[var(--taomni-selected)]" : ""
                      }`}
                      onClick={() => {
                        setDrawerPosition(position);
                        setShowPositionMenu(false);
                      }}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{t(`chat.drawerPosition_${position}`)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${
              sideBySide ? "text-[var(--taomni-accent)]" : ""
            }`}
            onClick={() => setDrawerPinned(!drawerPinned)}
            disabled={!isHorizontalDock}
            title={
              !isHorizontalDock
                ? t("chat.drawerPinUnavailable")
                : drawerPinned
                ? t("chat.drawerUnpinTitle")
                : t("chat.drawerPinTitle")
            }
            aria-label={drawerPinned ? t("chat.drawerUnpinTitle") : t("chat.drawerPinTitle")}
            aria-pressed={sideBySide}
            data-testid="ai-chat-drawer-pin"
          >
            {sideBySide ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
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
            onClick={hideDrawer}
            title={t("chat.drawerHideTitle")}
            aria-label={t("chat.drawerHideTitle")}
            data-testid="ai-chat-drawer-hide"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* History panel */}
        {showHistory && (
          <div className="h-48 shrink-0 border-b border-[var(--taomni-divider)] overflow-hidden">
            <ChatThreadList
              threads={visibleThreads}
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
            {/* Scope badge: every visible thread is bound to a concrete app tab. */}
            {activeThread.linked_session_id && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--taomni-accent)]/10 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
                title={t("chat.boundToTab", { id: activeThread.linked_session_id })}
              >
                <Link2 className="w-2.5 h-2.5" />
                <span className="truncate max-w-[100px]">
                  {linkedTabTitle}
                </span>
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
                    {id === "claude-code" ? t("chat.claudeCodeLocal") : id === "codex" ? "Codex local" : id}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[var(--taomni-accent)]">{activeThread.provider_id}</span>
            )}
            {(activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && (
              <input
                className="taomni-input h-5 w-[150px] min-w-[120px] text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)] font-mono"
                value={ccModelDraft}
                aria-label={t("chat.threadModelAria")}
                title={t("chat.threadModelTitle")}
                spellCheck={false}
                onChange={(e) => setCcModelDraft(e.target.value)}
                onBlur={commitThreadCcModel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
                    e.currentTarget.blur();
                  }
                }}
              />
            )}
            {(activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && activeThread.linked_session_id && (
              <button
                type="button"
                className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${
                  ccTerminalEchoEnabled
                    ? "text-[var(--taomni-accent)]"
                    : "text-[var(--taomni-text-muted)]"
                }`}
                onClick={() => setCcTerminalEcho(!ccTerminalEchoEnabled)}
                disabled={!aiConfig}
                title={t("chat.ccTerminalEchoTitle")}
                aria-pressed={ccTerminalEchoEnabled}
                aria-label={t("chat.ccTerminalEchoAria")}
                data-testid="chat-cc-terminal-echo-toggle"
              >
                <TerminalSquare className="w-2.5 h-2.5" />
                <span>{ccTerminalEchoEnabled ? t("chat.ccTerminalEchoOn") : t("chat.ccTerminalEchoOff")}</span>
              </button>
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
            {isQueryThread && (
              <button
                type="button"
                className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${
                  sqlEcho
                    ? "text-[var(--taomni-accent)]"
                    : "text-[var(--taomni-text-muted)]"
                }`}
                onClick={() => setSqlEcho(!sqlEcho)}
                title={t("chat.sqlEchoTitle")}
                aria-pressed={sqlEcho}
                data-testid="chat-sql-echo-toggle"
              >
                <TerminalSquare className="w-2.5 h-2.5" />
                <span>{sqlEcho ? t("chat.sqlEchoOn") : t("chat.sqlEchoOff")}</span>
              </button>
            )}
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
            <div key={msg.id}>
              <MessageBubble
                message={msg}
                format={effectiveFormat}
                preferredTerminalTabId={activeThread?.linked_session_id ?? null}
                preferredQueryTabId={activeThread?.linked_session_id ?? null}
              />
              {msg.role === "assistant" && <CcToolCards messageId={msg.id} />}
            </div>
          ))}
          {sending && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--taomni-text-muted)] p-1.5 border border-[var(--taomni-divider)] rounded bg-[var(--taomni-bg)]/50 shrink-0">
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-[var(--taomni-accent)] animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
                <span>{t("chat.aiThinking")}</span>
              </div>
              <button
                type="button"
                className="taomni-btn h-5 px-2 text-[10px] flex items-center gap-1 hover:text-red-400 border border-[var(--taomni-divider)] rounded hover:bg-[var(--taomni-hover)] transition-colors"
                onClick={() => {
                  if (activeThreadId) {
                    void stopSending(activeThreadId);
                  }
                }}
              >
                <span className="w-1.5 h-1.5 bg-red-500 rounded-sm" />
                <span>{t("common.stop") || "Stop"}</span>
              </button>
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
    </div>
  );
}

export function ChatDrawerRibbon() {
  const t = useT();
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const drawerPosition = useChatStore((s) => s.drawerPosition);
  const openTabChat = useChatStore((s) => s.openTabChat);
  const activeTab = useAppStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId) ?? null,
  );

  if (drawerOpen || !activeTab || !CHAT_CAPABLE_TAB_TYPES.has(activeTab.type)) return null;

  const Icon = positionIcon(drawerPosition);
  const placementClass = ribbonPlacementClass(drawerPosition);

  return (
    <button
      type="button"
      data-testid="ai-chat-drawer-ribbon"
      data-position={drawerPosition}
      className={`group absolute ${placementClass} z-40 flex items-center justify-center overflow-hidden border border-[var(--taomni-ribbon-border)] text-[10px] font-semibold text-[var(--taomni-text)] shadow-sm transition-all duration-150`}
      style={{
        background: "linear-gradient(to bottom, var(--taomni-ribbon-from), var(--taomni-ribbon-to))",
      }}
      title={t("chat.ribbonOpenTitle", { title: activeTab.title })}
      aria-label={t("chat.ribbonOpenTitle", { title: activeTab.title })}
      onClick={() => void openTabChat(activeTab.id)}
    >
      <span className="absolute h-1.5 w-1.5 rounded-full bg-[var(--taomni-accent)] shadow-[0_0_0_3px_rgba(30,95,168,0.16)] group-hover:opacity-0" />
      <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Icon className="w-3 h-3" />
        <span>Tao</span>
      </span>
    </button>
  );
}

function positionIcon(position: ChatDrawerPosition) {
  switch (position) {
    case "left":
      return PanelLeftOpen;
    case "right":
      return PanelRightOpen;
    case "top":
      return PanelTopOpen;
    case "bottom":
      return PanelBottomOpen;
  }
}

function ribbonPlacementClass(position: ChatDrawerPosition): string {
  switch (position) {
    case "left":
      return "left-0 top-1/2 -translate-y-1/2 h-12 w-3.5 rounded-r-full border-l-0 hover:w-14";
    case "right":
      return "right-0 top-1/2 -translate-y-1/2 h-12 w-3.5 rounded-l-full border-r-0 hover:w-14";
    case "top":
      return "top-0 left-1/2 -translate-x-1/2 h-3.5 w-14 rounded-b-full border-t-0 hover:h-8";
    case "bottom":
      return "bottom-0 left-1/2 -translate-x-1/2 h-3.5 w-14 rounded-t-full border-b-0 hover:h-8";
  }
}
