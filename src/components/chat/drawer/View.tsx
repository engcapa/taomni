import { GoCatalogStatus, GoModelPicker } from "../GoModelPicker";
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  Copy,
  History,
  Link2,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  StickyNote,
  TerminalSquare,
  X,
} from "lucide-react";
import { MAX_QUEUED_SENDS, type ChatThreadMode } from "../../../stores/chatStore";
import { MessageBubble } from "../MessageBubble";
import { CcToolCards } from "../CcToolCards";
import { Composer } from "../Composer";
import { ChatThreadList } from "../ChatThreadList";
import type { ChatOutputFormat } from "../../../lib/chat/renderFormatted";
import type { ChatAttachment } from "../../../lib/chat/attachments";
import { useT } from "../../../lib/i18n";
import { NotesPanel } from "../../notes/NotesPanel";
import { TaoAlertInbox } from "../../tao/TaoAlertInbox";
import { CHAT_THREAD_MODES, positionIcon, DRAWER_POSITIONS, modeIcon, providerLabel } from "./presentation";

export interface ChatDrawerViewProps {
  containerClass: string;
  themedContainerStyle: import("react").CSSProperties;
  drawerPosition: import("../../../stores/chatStore").ChatDrawerPosition;
  drawerPinned: boolean;
  drawerOpen: boolean;
  resizeHandleClass: string;
  isHorizontalDock: boolean;
  handleResizeStart: (e: import("react").PointerEvent<HTMLDivElement>, axis: "width" | "height", edge?: "left" | "right") => void;
  widthResizeHandleClass: string;
  panelBorderClass: string;
  floating: boolean;
  hubTab: import("../../../stores/taoHubStore").TaoHubTab;
  t: ReturnType<typeof useT>;
  activeThread: import("../../../stores/chatStore").ChatThread | undefined;
  setShowPositionMenu: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  positionLabel: string;
  PositionIcon: import("lucide-react").LucideIcon;
  showPositionMenu: boolean;
  setDrawerPosition: (position: import("../../../stores/chatStore").ChatDrawerPosition) => void;
  pinnedActive: boolean;
  setDrawerPinned: (pinned: boolean) => void;
  topBottomFloating: boolean;
  drawerFloatingOpacity: number;
  setShowOpacityMenu: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showOpacityMenu: boolean;
  setDrawerFloatingOpacity: (opacity: number) => void;
  copyAllToClipboard: () => Promise<void>;
  activeThreadId: string | null;
  activeMessages: import("../../../stores/chatStore").ChatMessage[];
  copiedAll: boolean;
  handleNewThread: () => Promise<void>;
  showHistory: boolean;
  setShowHistory: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  hideDrawer: () => void;
  setHubTab: (tab: import("../../../stores/taoHubStore").TaoHubTab) => void;
  alertBadgeCount: number;
  taoAlerts: import("../../../lib/tao/taoAlerts").TaoAlert[];
  alertHistory: import("../../../stores/taoAlertStore").TaoAlertHistoryEntry[];
  alertHistoryLimit: import("../../../stores/taoAlertStore").TaoAlertHistoryLimit;
  jumpToAlert: (alert: import("../../../lib/tao/taoAlerts").TaoAlert) => void;
  ackAlert: (alert: import("../../../lib/tao/taoAlerts").TaoAlert) => void;
  setAlertHistoryLimit: (limit: import("../../../stores/taoAlertStore").TaoAlertHistoryLimit) => void;
  clearAlertHistory: () => void;
  visibleThreads: import("../../../stores/chatStore").ChatThread[];
  setActiveThread: (threadId: string | null) => void;
  deleteThread: (threadId: string) => Promise<void>;
  linkedTabTitle: string | null;
  currentMode: ChatThreadMode;
  handleModeSelect: (mode: ChatThreadMode) => Promise<void>;
  availableModes: Set<ChatThreadMode>;
  providerIds: string[];
  selectedProviderId: string;
  rememberProviderForMode: (mode: ChatThreadMode, providerId: string) => void;
  setDraftProviderId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setThreadProvider: (threadId: string, providerId: string) => Promise<void>;
  aiConfig: import("../../../stores/aiStore").AiConfig | null;
  setThreadLlmModel: (threadId: string, model: string | null) => Promise<void>;
  ccModelDraft: string;
  setCcModelDraft: import("react").Dispatch<import("react").SetStateAction<string>>;
  commitThreadCcModel: () => void;
  defaultLocalAgentModel: string;
  ccTerminalEchoEnabled: boolean;
  setCcTerminalEcho: (enabled: boolean) => void;
  activeThreadMode: ChatThreadMode;
  formatLocked: boolean;
  globalOutputFormat: string;
  effectiveFormat: ChatOutputFormat;
  setThreadOutputFormat: (threadId: string, format: string | null) => Promise<void>;
  cycleRenderFormat: () => void;
  isQueryThread: boolean;
  sqlEcho: boolean;
  setSqlEcho: (enabled: boolean) => void;
  sending: boolean;
  emptyHint: string;
  sendingLabel: string;
  queuedSends: import("../../../stores/chatStore").QueuedSend[];
  stopSending: (threadId: string) => Promise<void>;
  error: string | null;
  messagesEndRef: import("react").RefObject<HTMLDivElement | null>;
  composerDraftKey: string | null;
  handleSend: (content: string, attachedTerminalCtx?: string, attachments?: ChatAttachment[]) => Promise<import("../../../stores/chatStore").EnqueueResult | undefined>;
  dequeueSend: (threadId: string, itemId: string) => void;
  attachmentsEnabled: boolean;
  composerPlaceholder: string | undefined;
  resolveTerminalText: (lines: number) => string | undefined;
}

export function ChatDrawerView(props: ChatDrawerViewProps) {
  const {
    containerClass,
    themedContainerStyle,
    drawerPosition,
    drawerPinned,
    drawerOpen,
    resizeHandleClass,
    isHorizontalDock,
    handleResizeStart,
    widthResizeHandleClass,
    panelBorderClass,
    floating,
    hubTab,
    t,
    activeThread,
    setShowPositionMenu,
    positionLabel,
    PositionIcon,
    showPositionMenu,
    setDrawerPosition,
    pinnedActive,
    setDrawerPinned,
    topBottomFloating,
    drawerFloatingOpacity,
    setShowOpacityMenu,
    showOpacityMenu,
    setDrawerFloatingOpacity,
    copyAllToClipboard,
    activeThreadId,
    activeMessages,
    copiedAll,
    handleNewThread,
    showHistory,
    setShowHistory,
    hideDrawer,
    setHubTab,
    alertBadgeCount,
    taoAlerts,
    alertHistory,
    alertHistoryLimit,
    jumpToAlert,
    ackAlert,
    setAlertHistoryLimit,
    clearAlertHistory,
    visibleThreads,
    setActiveThread,
    deleteThread,
    linkedTabTitle,
    currentMode,
    handleModeSelect,
    availableModes,
    providerIds,
    selectedProviderId,
    rememberProviderForMode,
    setDraftProviderId,
    setThreadProvider,
    aiConfig,
    setThreadLlmModel,
    ccModelDraft,
    setCcModelDraft,
    commitThreadCcModel,
    defaultLocalAgentModel,
    ccTerminalEchoEnabled,
    setCcTerminalEcho,
    activeThreadMode,
    formatLocked,
    globalOutputFormat,
    effectiveFormat,
    setThreadOutputFormat,
    cycleRenderFormat,
    isQueryThread,
    sqlEcho,
    setSqlEcho,
    sending,
    emptyHint,
    sendingLabel,
    queuedSends,
    stopSending,
    error,
    messagesEndRef,
    composerDraftKey,
    handleSend,
    dequeueSend,
    attachmentsEnabled,
    composerPlaceholder,
    resolveTerminalText,
  } = props;
  return ((
    <div
      className={containerClass}
      style={themedContainerStyle}
      data-testid="ai-chat-drawer"
      data-position={drawerPosition}
      data-pinned={drawerPinned || undefined}
      data-open={drawerOpen || undefined}
      aria-hidden={!drawerOpen}
    >
      {/* Resize handle */}
      <div
        className={resizeHandleClass}
        data-testid={isHorizontalDock ? "ai-chat-drawer-width-resize" : "ai-chat-drawer-height-resize"}
        onPointerDown={(event) => handleResizeStart(event, isHorizontalDock ? "width" : "height")}
      />
      {!isHorizontalDock && (
        <>
          <div
            className={`${widthResizeHandleClass} left-0 -translate-x-1/2`}
            data-testid="ai-chat-drawer-width-resize-left"
            onPointerDown={(event) => handleResizeStart(event, "width", "left")}
          />
          <div
            className={`${widthResizeHandleClass} right-0 translate-x-1/2`}
            data-testid="ai-chat-drawer-width-resize-right"
            onPointerDown={(event) => handleResizeStart(event, "width", "right")}
          />
        </>
      )}

      <div
        className={`flex flex-col w-full h-full ${panelBorderClass} border-[var(--taomni-divider)] ${floating ? "rounded-md overflow-hidden" : ""}`}
        style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--taomni-divider)] shrink-0"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          {hubTab === "notes" ? (
            <StickyNote className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          ) : hubTab === "notifications" ? (
            <Bell className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          ) : (
            <Bot className="w-4 h-4 text-[var(--taomni-accent)] shrink-0" />
          )}
          <span className="text-[13px] font-semibold flex-1 truncate">
            {hubTab === "notes"
              ? t("notes.title")
              : hubTab === "notifications"
                ? t("tao.tabNotifications")
                : activeThread?.title ?? t("chat.drawerTitle")}
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
                      className={`w-full h-7 px-2 text-left text-[11px] flex items-center gap-2 hover:bg-[var(--taomni-hover)] ${drawerPosition === position ? "text-[var(--taomni-accent)] bg-[var(--taomni-selected)]" : ""
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
            className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${pinnedActive ? "text-[var(--taomni-accent)]" : ""
              }`}
            onClick={() => setDrawerPinned(!drawerPinned)}
            title={
              pinnedActive
                ? t("chat.drawerUnpinTitle")
                : t("chat.drawerPinTitle")
            }
            aria-label={pinnedActive ? t("chat.drawerUnpinTitle") : t("chat.drawerPinTitle")}
            aria-pressed={pinnedActive}
            data-testid="ai-chat-drawer-pin"
          >
            {pinnedActive ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          {topBottomFloating && (
            <div className="relative">
              <button
                type="button"
                className={`taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ${drawerFloatingOpacity < 1 ? "text-[var(--taomni-accent)]" : ""
                  }`}
                onClick={() => setShowOpacityMenu((v) => !v)}
                title={t("chat.drawerOpacityTitle", { value: Math.round(drawerFloatingOpacity * 100) })}
                aria-label={t("chat.drawerOpacityAria")}
                aria-pressed={showOpacityMenu}
                data-testid="ai-chat-drawer-opacity"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
              {showOpacityMenu && (
                <div
                  className="absolute right-0 top-7 z-30 w-[180px] rounded border border-[var(--taomni-divider)] shadow-lg px-2 py-1.5"
                  style={{ background: "var(--taomni-panel-bg)" }}
                  data-testid="ai-chat-drawer-opacity-menu"
                >
                  <label
                    className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--taomni-text-muted)]"
                    htmlFor="ai-chat-drawer-opacity-slider"
                  >
                    <span>{t("chat.drawerOpacityLabel")}</span>
                    <span>{Math.round(drawerFloatingOpacity * 100)}%</span>
                  </label>
                  <input
                    id="ai-chat-drawer-opacity-slider"
                    type="range"
                    min={0.65}
                    max={1}
                    step={0.05}
                    value={drawerFloatingOpacity}
                    onChange={(event) => setDrawerFloatingOpacity(Number(event.currentTarget.value))}
                    aria-label={t("chat.drawerOpacityAria")}
                    className="w-full accent-[var(--taomni-accent)]"
                    data-testid="ai-chat-drawer-opacity-slider"
                  />
                </div>
              )}
            </div>
          )}
          {hubTab === "chat" && (
            <>
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
            </>
          )}
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

        {/* Tao Hub tab strip — one drawer, three tabs (Chat | 便签 | Notifications). */}
        <div
          className="flex items-stretch border-b border-[var(--taomni-divider)] shrink-0 text-[11px]"
          role="tablist"
          aria-label={t("tao.hubTitle")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "chat"}
            data-testid="tao-hub-tab-chat"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${hubTab === "chat"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
            onClick={() => setHubTab("chat")}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>{t("tao.tabChat")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "notes"}
            data-testid="tao-hub-tab-notes"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${hubTab === "notes"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
            onClick={() => setHubTab("notes")}
          >
            <StickyNote className="w-3.5 h-3.5" />
            <span>{t("tao.tabNotes")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={hubTab === "notifications"}
            data-testid="tao-hub-tab-notifications"
            className={`flex-1 h-7 inline-flex items-center justify-center gap-1 border-b-2 transition-colors ${hubTab === "notifications"
                ? "border-[var(--taomni-accent)] text-[var(--taomni-accent)]"
                : "border-transparent text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
            onClick={() => setHubTab("notifications")}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>{t("tao.tabNotifications")}</span>
            {alertBadgeCount > 0 && (
              <span
                className="min-w-[14px] h-[14px] px-1 rounded-full text-[8px] font-bold flex items-center justify-center bg-[var(--taomni-accent)] text-white"
                data-testid="tao-hub-notifications-badge"
              >
                {alertBadgeCount > 99 ? "99+" : alertBadgeCount}
              </span>
            )}
          </button>
        </div>

        {hubTab === "notifications" ? (
          <TaoAlertInbox
            alerts={taoAlerts}
            history={alertHistory}
            historyLimit={alertHistoryLimit}
            onJump={jumpToAlert}
            onAck={ackAlert}
            onHistoryLimitChange={setAlertHistoryLimit}
            onClearHistory={clearAlertHistory}
            embedded
          />
        ) : hubTab === "notes" ? (
          <NotesPanel />
        ) : (
          <>
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

            {/* Mode + provider switcher */}
            <div className="px-2 py-1 text-[10px] text-[var(--taomni-text-muted)] border-b border-[var(--taomni-divider)] shrink-0 flex items-center gap-1.5 flex-wrap">
              {/* Scope badge: every visible thread is bound to a concrete app tab. */}
              {activeThread?.linked_session_id && (
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
              <span>{t("chat.modeLabel")}</span>
              <div className="inline-flex h-5 overflow-hidden rounded border border-[var(--taomni-divider)]">
                {CHAT_THREAD_MODES.map((mode) => {
                  const selected = currentMode === mode;
                  const ModeIcon = modeIcon(mode);
                  return (
                    <button
                      key={mode}
                      type="button"
                      className={`h-full px-1.5 inline-flex items-center gap-1 border-r last:border-r-0 border-[var(--taomni-divider)] ${selected
                          ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]"
                          : "hover:bg-[var(--taomni-hover)]"
                        } disabled:opacity-40 disabled:hover:bg-transparent`}
                      onClick={() => void handleModeSelect(mode)}
                      disabled={!availableModes.has(mode)}
                      aria-pressed={selected}
                      aria-label={t("chat.threadModeAria", { mode: t(`chat.mode_${mode}`) })}
                      title={t(`chat.mode_${mode}`)}
                      data-testid={`chat-mode-${mode}`}
                    >
                      <ModeIcon className="w-2.5 h-2.5" />
                      <span>{t(`chat.mode_${mode}`)}</span>
                    </button>
                  );
                })}
              </div>
              <span>{t("chat.providerLabel")}</span>
              {providerIds.length > 0 ? (
                <select
                  className="taomni-input h-5 text-[10px] px-1 py-0 bg-transparent text-[var(--taomni-accent)]"
                  value={selectedProviderId}
                  aria-label={t("chat.threadProviderAria")}
                  data-testid="ai-chat-provider-select"
                  id="ai-chat-provider-select"
                  onChange={(e) => {
                    const providerId = e.target.value;
                    rememberProviderForMode(currentMode, providerId);
                    setDraftProviderId(providerId);
                    if (activeThread) {
                      void setThreadProvider(activeThread.id, providerId);
                    }
                  }}
                >
                  {activeThread && selectedProviderId === "" && (
                    <option value="" disabled>
                      {activeThread.provider_id}
                    </option>
                  )}
                  {providerIds.map((id) => (
                    <option key={id} value={id}>
                      {providerLabel(id, t, aiConfig)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[var(--taomni-accent)]">
                  {activeThread?.provider_id ?? t("chat.noProvider")}
                </span>
              )}
              {activeThread?.provider_id === "opencode-go" && (
                <div className="w-full max-w-full" data-testid="go-thread-picker">
                  <GoModelPicker testId="go-thread-model" value={activeThread.llm_model} inherit
                    overrides={aiConfig?.llm.providers["opencode-go"]?.protocol_overrides}
                    defaultModel={aiConfig?.llm.providers["opencode-go"]?.model || "deepseek-v4.1-flash"}
                    blocked={!!(aiConfig?.full_local_mode || aiConfig?.fully_disabled)}
                    onChange={(model) => setThreadLlmModel(activeThread.id, model)} />
                  <GoCatalogStatus blocked={!!(aiConfig?.full_local_mode || aiConfig?.fully_disabled)} />
                </div>
              )}
              {activeThread && (activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && (
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
              {activeThread && (activeThread.provider_id === "claude-code" || activeThread.provider_id === "codex") && activeThread.linked_session_id && (
                <button
                  type="button"
                  className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${ccTerminalEchoEnabled
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
              {activeThread && activeThreadMode === "chat" && (
                <>
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
                </>
              )}
              {activeThread && activeThreadMode === "chat" && isQueryThread && (
                <button
                  type="button"
                  className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 text-[10px] ${sqlEcho
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

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {activeMessages.length === 0 && !sending && (
                <div className="text-[11px] text-[var(--taomni-text-muted)] text-center py-8">
                  <Bot className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  {emptyHint}
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
                    <span>{sendingLabel}</span>
                    {queuedSends.length > 0 && (
                      <span className="text-[10px] text-[var(--taomni-accent)]" data-testid="ai-chat-queue-badge">
                        {t("chat.queuedBadge", { count: queuedSends.length })}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="taomni-btn h-5 px-2 text-[10px] flex items-center gap-1 hover:text-red-400 border border-[var(--taomni-divider)] rounded hover:bg-[var(--taomni-hover)] transition-colors"
                    // Stops this turn only — the queue keeps draining, so this is
                    // "skip this answer" rather than "abandon everything".
                    title={queuedSends.length > 0 ? t("chat.stopKeepsQueue") : undefined}
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
              key={composerDraftKey ?? "global"}
              draftKey={composerDraftKey}
              onSend={handleSend}
              sending={sending}
              disabled={false}
              queuedItems={queuedSends}
              queueLimit={MAX_QUEUED_SENDS}
              onRemoveQueued={(itemId) => {
                if (activeThreadId) dequeueSend(activeThreadId, itemId);
              }}
              attachmentsEnabled={attachmentsEnabled}
              placeholder={composerPlaceholder}
              // Use the active terminal registry when available — that's what
              // makes `@terminal:last-N` work even when the drawer is rendered
              // without a `terminalContext` prop (the production case).
              resolveTerminalContext={currentMode === "chat" ? resolveTerminalText : undefined}
            />
          </>
        )}
      </div>
    </div>
  ));
}
