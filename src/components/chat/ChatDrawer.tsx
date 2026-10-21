import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeChatThreadMode, useChatStore, isChatCapableTabType, type ChatThreadMode } from "../../stores/chatStore";
import {
  chatDrawerProviderIds,
  acpProfileIdFromProvider,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GROK_ACP_PROFILE,
  rememberChatDrawerProviderPreference,
  useAiStore,
} from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { getTerminal } from "../../lib/terminal/terminalRegistry";
import { getQueryTab } from "../../lib/queryRegistry";
import type { ChatOutputFormat } from "../../lib/chat/renderFormatted";
import type { ChatAttachment } from "../../lib/chat/attachments";
import { useT } from "../../lib/i18n";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useNotesStore } from "../../stores/notesStore";
import { EMPTY_QUEUE, capabilityForMode, CHAT_THREAD_MODES } from "./drawer/presentation";
import { useChatDrawerDock } from "./drawer/dock";
import { useChatDrawerAlerts } from "./drawer/alerts";
import { ChatDrawerView } from "./drawer/View";

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
    threads,
    activeThreadId,
    messages,
    sendingByThreadId,
    sendQueues,
    drawerOpen,
    drawerWidth,
    drawerHeight,
    drawerPosition,
    drawerPinned,
    drawerFloatingOpacity,
    drawerTabId,
    loadThreads,
    newThread,
    deleteThread,
    setActiveThread,
    loadMessages,
    enqueueMessage,
    dequeueSend,
    hideDrawer,
    setDrawerWidth,
    setDrawerHeight,
    setDrawerPosition,
    setDrawerPinned,
    setDrawerFloatingOpacity,
    dismissDrawer,
    purgeOldThreads,
    stopSending,
  } = useChatStore();

  const [showHistory, setShowHistory] = useState(false);
  const hubTab = useTaoHubStore((s) => s.hubTab);
  const setHubTab = useTaoHubStore((s) => s.setHubTab);
  const notesTheme = useNotesStore((s) => s.theme);
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
  const [newThreadMode, setNewThreadMode] = useState<ChatThreadMode>("chat");
  const [draftProviderId, setDraftProviderId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track open/thread/length so tab-return (same thread, just re-shown) keeps
  // the current scroll offset instead of re-animating top→bottom.
  const prevDrawerOpenRef = useRef(false);
  const prevScrollThreadIdRef = useRef<string | null>(null);
  const prevScrollMessageCountRef = useRef(0);

  // Subscribe to the active tab so the drawer re-renders (and the
  // scope/picker logic re-evaluates) whenever the user switches tabs. We
  // can't read this from terminalRegistry alone because the registry is a
  // plain global and isn't reactive.
  const activeTab = useAppStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId) ?? null,
  );
  const setActiveAppTab = useAppStore((s) => s.setActiveTab);
  const activeTabId = activeTab?.id ?? null;
  const activeTabType = activeTab?.type ?? null;
  const activeChatTabId = isChatCapableTabType(activeTabType)
    ? activeTab?.chatTabId ?? activeTabId
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
  const queuedSends = activeThreadId ? sendQueues[activeThreadId] ?? EMPTY_QUEUE : EMPTY_QUEUE;
  const activeThread = (threads ?? []).find((t) => t.id === activeThreadId);
  const linkedTab = useAppStore((s) =>
    activeThread?.linked_session_id
      ? s.tabs.find((tab) =>
        tab.id === activeThread.linked_session_id ||
        tab.chatTabId === activeThread.linked_session_id
      ) ?? null
      : null,
  );
  const linkedTabTitle = activeThread?.linked_session_id
    ? (
      getTerminal(activeThread.linked_session_id)?.title
      ?? (linkedTab ? getTerminal(linkedTab.id)?.title : undefined)
      ?? getQueryTab(activeThread.linked_session_id)?.title
      ?? (linkedTab ? getQueryTab(linkedTab.id)?.title : undefined)
      ?? linkedTab?.title
      ?? activeThread.linked_session_id.slice(0, 8)
    )
    : null;
  // The SQL echo toggle only applies to threads bound to a SQL ("database")
  // tab. Resolved from the tab type so it stays reactive as tabs open/close.
  const linkedTabType = linkedTab?.type ?? null;
  const isQueryThread = linkedTabType === "database";
  const visibleThreads = useMemo(
    () => {
      const list = threads ?? [];
      return drawerTabId
        ? list.filter((thread) => thread.linked_session_id === drawerTabId)
        : list.filter((thread) => thread.linked_session_id);
    },
    [drawerTabId, threads],
  );
  const { alertBadgeCount, taoAlerts, alertHistory, alertHistoryLimit, jumpToAlert, ackAlert, setAlertHistoryLimit, clearAlertHistory } = useChatDrawerAlerts({
    setHubTab,
    setActiveAppTab,
    setActiveThread,
  });

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
  const activeThreadMode = normalizeChatThreadMode(activeThread?.mode);
  const currentMode = activeThread ? activeThreadMode : newThreadMode;
  const activeProviderIds = useMemo(
    () => chatDrawerProviderIds(aiConfig, capabilityForMode(activeThreadMode)),
    [aiConfig, activeThreadMode],
  );
  const draftProviderIds = useMemo(
    () => chatDrawerProviderIds(aiConfig, capabilityForMode(newThreadMode)),
    [aiConfig, newThreadMode],
  );
  const availableModes = useMemo(
    () => new Set(CHAT_THREAD_MODES.filter((mode) =>
      chatDrawerProviderIds(aiConfig, capabilityForMode(mode)).length > 0
    )),
    [aiConfig],
  );
  const setThreadProvider = useChatStore((s) => s.setThreadProvider);
  const setThreadCcModel = useChatStore((s) => s.setThreadCcModel);
  const setThreadLlmModel = useChatStore((s) => s.setThreadLlmModel);
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
    if (activeThread) {
      setNewThreadMode(normalizeChatThreadMode(activeThread.mode));
    }
  }, [activeThread?.id, activeThread?.mode]);

  useEffect(() => {
    setDraftProviderId((current) =>
      current && draftProviderIds.includes(current) ? current : draftProviderIds[0] ?? null
    );
  }, [draftProviderIds]);

  useEffect(() => {
    if (!isLocalAgentProvider) {
      setCcModelDraft(defaultLocalAgentModel);
      return;
    }
    setCcModelDraft(activeThread.cc_model?.trim() || defaultLocalAgentModel);
  }, [activeThread?.id, activeThread?.provider_id, activeThread?.cc_model, isLocalAgentProvider, defaultLocalAgentModel]);

  // Load messages when active thread changes.
  useEffect(() => {
    if (activeThreadId && !messages[activeThreadId]) {
      loadMessages(activeThreadId);
    }
  }, [activeThreadId]);

  // Scroll policy:
  // - same thread re-shown after hide (tab switch away/back): keep scroll
  // - thread change / first open: jump to bottom instantly
  // - new messages while open: smooth-scroll only when the list already had content
  useEffect(() => {
    if (!drawerOpen) {
      prevDrawerOpenRef.current = false;
      return;
    }
    const end = messagesEndRef.current;
    if (!end) return;

    const opened = !prevDrawerOpenRef.current;
    const threadChanged = prevScrollThreadIdRef.current !== activeThreadId;
    const previousCount = prevScrollMessageCountRef.current;
    const grew = activeMessages.length > previousCount;

    prevDrawerOpenRef.current = true;
    prevScrollThreadIdRef.current = activeThreadId;
    prevScrollMessageCountRef.current = activeMessages.length;

    // Re-opening the same transcript (tab return) — preserve scroll position.
    if (opened && !threadChanged) return;

    if (threadChanged || opened) {
      end.scrollIntoView({ behavior: "auto" });
      return;
    }

    if (grew) {
      end.scrollIntoView({ behavior: previousCount === 0 ? "auto" : "smooth" });
    }
  }, [drawerOpen, activeThreadId, activeMessages.length]);

  const pickProviderForMode = (mode: ChatThreadMode, preferredProviderId?: string | null): string | null => {
    const ids = chatDrawerProviderIds(aiConfig, capabilityForMode(mode));
    if (preferredProviderId && ids.includes(preferredProviderId)) return preferredProviderId;
    return ids[0] ?? null;
  };

  const rememberProviderForMode = (mode: ChatThreadMode, providerId: string) => {
    rememberChatDrawerProviderPreference(providerId, capabilityForMode(mode));
  };

  const handleNewThread = async () => {
    const linked = drawerTabId ?? activeChatTabId;
    if (!linked) {
      setError(t("chat.noTabBinding"));
      return;
    }
    const providerId = draftProviderId && draftProviderIds.includes(draftProviderId)
      ? draftProviderId
      : draftProviderIds[0] ?? null;
    if (!providerId) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${newThreadMode}`) }));
      return;
    }
    setShowHistory(false);
    try {
      await newThread(providerId, linked, newThreadMode);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleModeSelect = async (mode: ChatThreadMode) => {
    setNewThreadMode(mode);
    setError(null);
    if (!availableModes.has(mode)) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${mode}`) }));
      return;
    }
    const providerId = pickProviderForMode(mode, activeThread?.provider_id ?? draftProviderId);
    setDraftProviderId(providerId);
    if (!activeThread) return;
    if (activeThreadMode === mode) return;
    const linked = activeThread.linked_session_id ?? drawerTabId ?? activeChatTabId;
    if (!linked) {
      setError(t("chat.noTabBinding"));
      return;
    }
    if (!providerId) {
      setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${mode}`) }));
      return;
    }
    setShowHistory(false);
    try {
      const loadedMessages = messages[activeThread.id];
      const replaceEmptyActiveThread = loadedMessages !== undefined && loadedMessages.length === 0;
      const oldThreadId = activeThread.id;
      await newThread(providerId, linked, mode);
      if (replaceEmptyActiveThread) {
        await deleteThread(oldThreadId);
      }
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
    const entry = getTerminal(linked) ?? (linkedTab ? getTerminal(linkedTab.id) : null) ?? focusedTerminal;
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

  const handleSend = async (content: string, attachedTerminalCtx?: string, attachments?: ChatAttachment[]) => {
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
        const providerId = draftProviderId && draftProviderIds.includes(draftProviderId)
          ? draftProviderId
          : draftProviderIds[0] ?? null;
        if (!providerId) {
          setError(t("chat.noProviderForMode", { mode: t(`chat.mode_${newThreadMode}`) }));
          return;
        }
        const thread = await newThread(providerId, linked, newThreadMode);
        threadId = thread.id;
      }
      // Queued rather than sent directly, so typing ahead of a running turn
      // parks the message instead of racing it into the same transcript.
      const result = await enqueueMessage(threadId, content, ctx, attachments);
      if (result.status === "rejected") {
        setError(t("chat.queueFull", { limit: result.limit }));
      }
      return result;
    } catch (e) {
      setError(String(e));
    }
  };
  const {
    containerClass,
    themedContainerStyle,
    resizeHandleClass,
    isHorizontalDock,
    handleResizeStart,
    widthResizeHandleClass,
    panelBorderClass,
    floating,
    setShowPositionMenu,
    positionLabel,
    PositionIcon,
    showPositionMenu,
    pinnedActive,
    topBottomFloating,
    setShowOpacityMenu,
    showOpacityMenu,
  } = useChatDrawerDock({
    hideDrawer,
    drawerPosition,
    drawerPinned,
    setDrawerPinned,
    drawerOpen,
    dismissDrawer,
    drawerWidth,
    drawerHeight,
    setDrawerWidth,
    setDrawerHeight,
    t,
    drawerFloatingOpacity,
    hubTab,
    notesTheme,
  });
  const providerIds = activeThread ? activeProviderIds : draftProviderIds;
  const selectedProviderId = activeThread
    ? (providerIds.includes(activeThread.provider_id) ? activeThread.provider_id : "")
    : draftProviderId ?? providerIds[0] ?? "";
  const emptyHint = currentMode === "image"
    ? t("chat.emptyImageHint")
    : currentMode === "video"
      ? t("chat.emptyVideoHint")
      : t("chat.emptyHint");
  const sendShortcutLabel = (aiConfig?.chat_send_shortcut === "enter")
    ? t("chat.shortcutEnter")
    : t("chat.shortcutCtrlEnter");
  const composerPlaceholder = currentMode === "image"
    ? t("chat.imagePromptPlaceholder", { shortcut: sendShortcutLabel })
    : currentMode === "video"
      ? t("chat.videoPromptPlaceholder", { shortcut: sendShortcutLabel })
      : undefined;
  const composerDraftKey = activeThreadId
    ? `thread:${activeThreadId}`
    : (drawerTabId ?? activeChatTabId)
      ? `tab:${drawerTabId ?? activeChatTabId}`
      : null;
  // Grok media mode accepts a reference image as a local ACP resource link.
  // Other API media providers currently expose text-only generation endpoints,
  // so keep their composer attachment surface disabled rather than silently
  // discarding a picked file.
  const attachmentsEnabled = currentMode === "chat"
    || acpProfileIdFromProvider(selectedProviderId) === DEFAULT_GROK_ACP_PROFILE.id;
  const sendingLabel = currentMode === "image"
    ? t("chat.imageGenerating")
    : currentMode === "video"
      ? t("chat.videoGenerating")
      : t("chat.aiThinking");

  return <ChatDrawerView
    containerClass={containerClass}
    themedContainerStyle={themedContainerStyle}
    drawerPosition={drawerPosition}
    drawerPinned={drawerPinned}
    drawerOpen={drawerOpen}
    resizeHandleClass={resizeHandleClass}
    isHorizontalDock={isHorizontalDock}
    handleResizeStart={handleResizeStart}
    widthResizeHandleClass={widthResizeHandleClass}
    panelBorderClass={panelBorderClass}
    floating={floating}
    hubTab={hubTab}
    t={t}
    activeThread={activeThread}
    setShowPositionMenu={setShowPositionMenu}
    positionLabel={positionLabel}
    PositionIcon={PositionIcon}
    showPositionMenu={showPositionMenu}
    setDrawerPosition={setDrawerPosition}
    pinnedActive={pinnedActive}
    setDrawerPinned={setDrawerPinned}
    topBottomFloating={topBottomFloating}
    drawerFloatingOpacity={drawerFloatingOpacity}
    setShowOpacityMenu={setShowOpacityMenu}
    showOpacityMenu={showOpacityMenu}
    setDrawerFloatingOpacity={setDrawerFloatingOpacity}
    copyAllToClipboard={copyAllToClipboard}
    activeThreadId={activeThreadId}
    activeMessages={activeMessages}
    copiedAll={copiedAll}
    handleNewThread={handleNewThread}
    showHistory={showHistory}
    setShowHistory={setShowHistory}
    hideDrawer={hideDrawer}
    setHubTab={setHubTab}
    alertBadgeCount={alertBadgeCount}
    taoAlerts={taoAlerts}
    alertHistory={alertHistory}
    alertHistoryLimit={alertHistoryLimit}
    jumpToAlert={jumpToAlert}
    ackAlert={ackAlert}
    setAlertHistoryLimit={setAlertHistoryLimit}
    clearAlertHistory={clearAlertHistory}
    visibleThreads={visibleThreads}
    setActiveThread={setActiveThread}
    deleteThread={deleteThread}
    linkedTabTitle={linkedTabTitle}
    currentMode={currentMode}
    handleModeSelect={handleModeSelect}
    availableModes={availableModes}
    providerIds={providerIds}
    selectedProviderId={selectedProviderId}
    rememberProviderForMode={rememberProviderForMode}
    setDraftProviderId={setDraftProviderId}
    setThreadProvider={setThreadProvider}
    aiConfig={aiConfig}
    setThreadLlmModel={setThreadLlmModel}
    ccModelDraft={ccModelDraft}
    setCcModelDraft={setCcModelDraft}
    commitThreadCcModel={commitThreadCcModel}
    defaultLocalAgentModel={defaultLocalAgentModel}
    ccTerminalEchoEnabled={ccTerminalEchoEnabled}
    setCcTerminalEcho={setCcTerminalEcho}
    activeThreadMode={activeThreadMode}
    formatLocked={formatLocked}
    globalOutputFormat={globalOutputFormat}
    effectiveFormat={effectiveFormat}
    setThreadOutputFormat={setThreadOutputFormat}
    cycleRenderFormat={cycleRenderFormat}
    isQueryThread={isQueryThread}
    sqlEcho={sqlEcho}
    setSqlEcho={setSqlEcho}
    sending={sending}
    emptyHint={emptyHint}
    sendingLabel={sendingLabel}
    queuedSends={queuedSends}
    stopSending={stopSending}
    error={error}
    messagesEndRef={messagesEndRef}
    composerDraftKey={composerDraftKey}
    handleSend={handleSend}
    dequeueSend={dequeueSend}
    attachmentsEnabled={attachmentsEnabled}
    composerPlaceholder={composerPlaceholder}
    resolveTerminalText={resolveTerminalText}
  />;
}

export { ChatDrawerRibbon } from "./drawer/ribbon";
