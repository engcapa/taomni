import { AlertTriangle, CheckCircle2, ChevronDown, Inbox, Loader2, MailOpen, ShieldCheck, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { isMailCertificateError, type MailCertificateInfo, type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { type MailAddressBookEntry } from "../../../lib/mailContacts";
import { type MailFilter } from "../../../lib/mailFilters";
import { loadResizableLayout, saveResizableLayout } from "../../../lib/resizableLayout";
import { type MenuItem } from "../../ContextMenu";
import { MailArchivePanel } from "../MailArchivePanel";
import { MailAddressBookDialog } from "./MailAddressBookDialog";
import { MailAgendaDialog } from "./MailAgendaDialog";
import { MailCertificateDialog } from "./MailCertificateDialog";
import { MailComposePrompt } from "./MailComposePrompt";
import { MailComposer } from "./MailComposer";
import { MailDraftsDialog } from "./MailDraftsDialog";
import { MailFiltersDialog } from "./MailFiltersDialog";
import { MailFoldersPane } from "./MailFoldersPane";
import { MailMessagePopup } from "./MailMessagePopup";
import { MailMessagesPane } from "./MailMessagesPane";
import { MailReaderPane } from "./MailReaderPane";
import { MailSourceDialog } from "./MailSourceDialog";
import { MailSubscriptionsDialog } from "./MailSubscriptionsDialog";
import { MailToolbar } from "./MailToolbar";
import type { createMailMutations } from "./mutations";
import { type AiAction } from "./types";
import type { useMailAppearance } from "./useMailAppearance";
import type { useMailCacheActions } from "./useMailCacheActions";
import type { useMailCacheState } from "./useMailCacheState";
import { useMailComposer } from "./useMailComposer";
import type { useMailMessageTabs } from "./useMailMessageTabs";
import type { useMailReading } from "./useMailReading";
import type { useMailSearch } from "./useMailSearch";
import type { useMailSelection } from "./useMailSelection";
import type { useMailSynchronization } from "./useMailSynchronization";

export interface MailClientViewProps {
  readingOwner: ReturnType<typeof useMailReading>;
  cacheActionsOwner: ReturnType<typeof useMailCacheActions>;
  cacheOwner: ReturnType<typeof useMailCacheState>;
  appearanceOwner: ReturnType<typeof useMailAppearance>;
  syncOwner: ReturnType<typeof useMailSynchronization>;
  selectionOwner: ReturnType<typeof useMailSelection>;
  searchOwner: ReturnType<typeof useMailSearch>;
  messageTabsOwner: ReturnType<typeof useMailMessageTabs>;
  mutationOwner: ReturnType<typeof createMailMutations>;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  visible: boolean;
  info: import("../../../types").MailTabInfo;
  composerOwner: ReturnType<typeof useMailComposer>;
  idleEnabled: boolean;
  idleState: string | null;
  activeFolder: MailFolder;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
  openTabChat: (tabId: string) => Promise<void>;
  tabId: string;
  mailMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  messageMenuItems: (message: MailMessageHeader) => MenuItem[];
  mutationFailure: { message: string; retryable: boolean; detail: string | null; } | null;
  error: string | null;
  status: string | null;
  busyAction: boolean;
  retryMailActionRef: import("react").RefObject<(() => Promise<void>) | null>;
  confirmDialog: { confirm: (options: import("../../sidebar/ConfirmDialog").ConfirmDialogOptions) => Promise<boolean>; render: import("react").ReactNode; };
  openCertReview: (protocol: "imap" | "smtp") => Promise<void>;
  oauthReauthRequired: boolean;
  onEditSession: ((sessionId: string) => void) | undefined;
  mutationProgress: string | null;
  renderReaderSurface: (message: MailMessageHeader | null, popup?: boolean) => import("react").JSX.Element;
  setSubscriptionsOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setContactDraft: import("react").Dispatch<SetStateAction<MailAddressBookEntry | null>>;
  setAddressBookOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setAgendaOpen: import("react").Dispatch<SetStateAction<boolean>>;
  filterErrors: string[];
  setFilterDraft: import("react").Dispatch<SetStateAction<MailFilter | null>>;
  setFiltersOpen: import("react").Dispatch<SetStateAction<boolean>>;
  treeFolders: MailFolder[];
  dropFolder: string | null;
  draggedMessagesRef: import("react").RefObject<MailMessageHeader[]>;
  setDropFolder: import("react").Dispatch<SetStateAction<string | null>>;
  handleFolderSelect: (folder: MailFolder) => void;
  folderMenuItems: (folder: MailFolder) => MenuItem[];
  cacheLine: string;
  handleMessageListScroll: (event: import("react").UIEvent<HTMLDivElement>) => void;
  messageListMenuItems: () => MenuItem[];
  displayFolders: MailFolder[];
  rowActionsRef: import("react").RefObject<import("./MailRowActions").MailRowActions | null>;
  loadMoreMessages: () => Promise<void>;
  showReaderMenu: (event: ReactMouseEvent, message: MailMessageHeader | null) => void;
  handleAiAction: (action: AiAction) => Promise<void>;
  selectedBody: import("../../../lib/mail").MailMessageBody | null;
  selectedHasRemoteImages: boolean;
  selectedMessageRemoteKey: string | null;
  toggleRemoteForMessage: (key: string) => void;
  selectedAllowsRemote: boolean;
  renderUnsubscribe: (message: MailMessageHeader) => import("react").JSX.Element | null;
  visibleAttachments: import("../../../lib/mail").MailAttachmentInfo[];
  handleSaveAllAttachments: (message: MailMessageHeader, attachments: import("../../../lib/mail").MailAttachmentInfo[]) => Promise<void>;
  downloadingAttachmentIndex: number | null;
  handleOpenAttachment: (message: MailMessageHeader, attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => Promise<void>;
  handleAttachmentContextMenu: (event: ReactMouseEvent, message: MailMessageHeader, attachments: import("../../../lib/mail").MailAttachmentInfo[], attachment: import("../../../lib/mail").MailAttachmentInfo, index: number) => void;
  renderInviteCard: (message: MailMessageHeader) => import("react").JSX.Element | null;
  renderReceiptBanner: (message: MailMessageHeader) => import("react").JSX.Element | null;
  allowRemoteForMessage: (key: string) => void;
  setAllowRemoteAllInTab: import("react").Dispatch<SetStateAction<boolean>>;
  blockRemoteForMessage: (key: string) => void;
  attachmentMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  textInputDialog: { promptText: (options: import("../../sidebar/ConfirmDialog").TextInputDialogOptions) => Promise<string | null>; render: import("react").ReactNode; };
  sourceView: { subject: string; content: string; } | null;
  setSourceView: import("react").Dispatch<SetStateAction<{ subject: string; content: string; } | null>>;
  copyText: (label: string, value: string | null | undefined) => void;
  certReview: { protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null;
  setCertReview: import("react").Dispatch<SetStateAction<{ protocol: "imap" | "smtp"; loading: boolean; info?: MailCertificateInfo; error?: string; } | null>>;
  trustReviewedCertificate: () => Promise<void>;
  agendaOpen: boolean;
  agendaRevision: number;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  onAgendaChanged: (events: import("../../../lib/mailCalendar").MailAgendaEvent[]) => void;
  addressBookOpen: boolean;
  contactDraft: MailAddressBookEntry | null;
  filtersOpen: boolean;
  setFilterErrors: import("react").Dispatch<SetStateAction<string[]>>;
  filterDraft: MailFilter | null;
  subscriptionsOpen: boolean;
  subscribedOnly: boolean;
  setSubscribedOnly: (value: boolean) => void;
  subscriptionBusy: string | null;
  toggleSubscription: (folder: MailFolder, subscribed: boolean) => Promise<void>;
}

export function MailClientView(props: MailClientViewProps) {
  const {
    rootRef,
    visible,
    info,
    composerOwner,
    idleEnabled,
    idleState,
    activeFolder,
    searchInputRef,
    openTabChat,
    tabId,
    mailMenu,
    messageMenuItems,
    mutationFailure,
    error,
    status,
    busyAction,
    retryMailActionRef,
    confirmDialog,
    openCertReview,
    oauthReauthRequired,
    onEditSession,
    mutationProgress,
    renderReaderSurface,
    setSubscriptionsOpen,
    setContactDraft,
    setAddressBookOpen,
    setAgendaOpen,
    filterErrors,
    setFilterDraft,
    setFiltersOpen,
    treeFolders,
    dropFolder,
    draggedMessagesRef,
    setDropFolder,
    handleFolderSelect,
    folderMenuItems,
    cacheLine,
    handleMessageListScroll,
    messageListMenuItems,
    displayFolders,
    rowActionsRef,
    loadMoreMessages,
    showReaderMenu,
    handleAiAction,
    selectedBody,
    selectedHasRemoteImages,
    selectedMessageRemoteKey,
    toggleRemoteForMessage,
    selectedAllowsRemote,
    renderUnsubscribe,
    visibleAttachments,
    handleSaveAllAttachments,
    downloadingAttachmentIndex,
    handleOpenAttachment,
    handleAttachmentContextMenu,
    renderInviteCard,
    renderReceiptBanner,
    allowRemoteForMessage,
    setAllowRemoteAllInTab,
    blockRemoteForMessage,
    attachmentMenu,
    textInputDialog,
    sourceView,
    setSourceView,
    copyText,
    certReview,
    setCertReview,
    trustReviewedCertificate,
    agendaOpen,
    agendaRevision,
    setStatus,
    onAgendaChanged,
    addressBookOpen,
    contactDraft,
    filtersOpen,
    setFilterErrors,
    filterDraft,
    subscriptionsOpen,
    subscribedOnly,
    setSubscribedOnly,
    subscriptionBusy,
    toggleSubscription,
    appearanceOwner,
    syncOwner,
    selectionOwner,
    searchOwner,
    messageTabsOwner,
    mutationOwner,
    readingOwner,
    cacheActionsOwner,
    cacheOwner,
  } = props;
  return ((
    <div
      ref={rootRef}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
      style={appearanceOwner.mailAppearance}
      data-testid="mail-client-tab"
      data-active={visible ? "true" : "false"}
    >
      <MailArchivePanel info={info} />
      <MailToolbar
        openCompose={composerOwner.openCompose}
        setDraftsOpen={composerOwner.setDraftsOpen}
        refreshDrafts={composerOwner.refreshDrafts}
        outboxCount={composerOwner.outboxCount}
        syncAllFolders={syncOwner.syncAllFolders}
        batchSize={syncOwner.batchSize}
        syncing={syncOwner.syncing}
        idleEnabled={idleEnabled}
        idleState={idleState}
        handleMarkSelectedRead={readingOwner.handleMarkSelectedRead}
        markingRead={readingOwner.markingRead}
        checkedUnreadCount={selectionOwner.checkedUnreadCount}
        handleMarkFolderRead={readingOwner.handleMarkFolderRead}
        activeFolder={activeFolder}
        visibleUnreadCount={selectionOwner.visibleUnreadCount}
        handleTest={cacheActionsOwner.handleTest}
        testing={cacheActionsOwner.testing}
        searchInputRef={searchInputRef}
        searchScope={searchOwner.searchScope}
        query={searchOwner.query}
        setQuery={searchOwner.setQuery}
        runServerSearch={searchOwner.runServerSearch}
        searchField={searchOwner.searchField}
        setSearchField={searchOwner.setSearchField}
        setSearchScope={searchOwner.setSearchScope}
        searchActive={searchOwner.searchActive}
        serverSearching={searchOwner.serverSearching}
        quickFilters={searchOwner.quickFilters}
        setQuickFilters={searchOwner.setQuickFilters}
        tagFilter={searchOwner.tagFilter}
        setTagFilter={searchOwner.setTagFilter}
        decreaseFontSize={appearanceOwner.decreaseFontSize}
        increaseFontSize={appearanceOwner.increaseFontSize}
        openTabChat={openTabChat}
        tabId={tabId}
        handleClearCache={cacheActionsOwner.handleClearCache}
        clearing={cacheActionsOwner.clearing}
        info={info}
      />

      {selectionOwner.messageTabs.length > 0 && (
        <div className="h-8 shrink-0 flex items-end gap-1 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] overflow-x-auto">
          <button
            type="button"
            className={`h-7 max-w-[220px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${selectionOwner.mailViewKey === "mailbox" ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
            style={{ borderColor: "var(--taomni-divider)" }}
            onClick={() => selectionOwner.setMailViewKey("mailbox")}
          >
            <Inbox className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Mailbox</span>
          </button>
          {selectionOwner.messageTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`h-7 max-w-[280px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${selectionOwner.mailViewKey === tab.key ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
              style={{ borderColor: "var(--taomni-divider)" }}
              title={tab.message.subject || "(no subject)"}
              onClick={() => messageTabsOwner.selectMessage(tab.message, tab.key)}
              onContextMenu={(event) => mailMenu.show(event, messageMenuItems(tab.message))}
            >
              <MailOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.message.subject || "(no subject)"}</span>
              <X
                className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                onClick={(event) => {
                  event.stopPropagation();
                  messageTabsOwner.closeMessageTab(tab.key);
                }}
              />
            </button>
          ))}
        </div>
      )}

      {composerOwner.sentCopyNotice && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--taomni-divider)] text-[12px]" data-testid="mail-sent-copy-status" role="status">
          {composerOwner.sentCopyNotice.error ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />}
          <span className={`min-w-0 flex-1 break-words ${composerOwner.sentCopyNotice.error ? "text-red-500" : "text-[var(--taomni-text-muted)]"}`}>{composerOwner.sentCopyNotice.text}</span>
          <button type="button" className="taomni-btn h-6 w-6 p-0 shrink-0 inline-flex items-center justify-center" aria-label="Dismiss Sent copy status" onClick={() => composerOwner.setSentCopyNotice(null)}><X className="w-3 h-3" /></button>
        </div>
      )}
      {/* Reserve the status strip so transient progress never moves the toolbar or message rows. */}
      <div className="h-7 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[11px] bg-[var(--taomni-sidebar-bg)]">
        {(mutationFailure?.message || error || status) && (
          <>
            {(mutationFailure?.message || error) ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />}
            <span
              className={`min-w-0 flex-1 truncate ${(mutationFailure?.message || error) ? "text-red-500" : "text-[var(--taomni-text-muted)]"}`}
              title={(mutationFailure?.message || error) ?? status ?? undefined}
            >
              {(mutationFailure?.message || error) ?? status}
            </span>
          </>
        )}
        <div className="ml-auto min-w-0 flex items-center gap-2 overflow-x-auto">
          {mutationProgress && (
            <span className="shrink-0" role="status" data-testid="mail-mutation-progress" aria-busy={busyAction}>{mutationProgress}</span>
          )}
          {syncOwner.syncProgress && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-sync-progress"
              data-folder={syncOwner.syncProgress.folder}
              title={`Catching up ${syncOwner.syncProgress.folder}`}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Catching up {syncOwner.syncProgress.fetched}
              {syncOwner.syncProgress.remaining > 0 ? ` / ${syncOwner.syncProgress.fetched + syncOwner.syncProgress.remaining}` : ""}
            </span>
          )}
          {syncOwner.backfillProgress && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-backfill-progress"
              data-folder={syncOwner.backfillProgress.folder}
              title={`Downloading older headers of ${syncOwner.backfillProgress.folder}`}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              History {syncOwner.backfillProgress.cached}/{syncOwner.backfillProgress.total}
            </span>
          )}
          {cacheOwner.bodyWarming.active && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-body-warming-progress"
              title={cacheOwner.bodyWarming.folder ? `Warming ${cacheOwner.bodyWarming.folder}` : "Warming recent message bodies"}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Bodies {cacheOwner.bodyWarming.total > 0 ? `${cacheOwner.bodyWarming.done}/${cacheOwner.bodyWarming.total}` : "warming"}
            </span>
          )}
        </div>
        {/* Keep recovery controls at the edge while background progress changes width. */}
        {mutationFailure?.retryable && (
          <button type="button" className="taomni-btn h-5 px-2 shrink-0" data-testid="mail-mutation-retry"
            disabled={busyAction} onClick={() => { if (retryMailActionRef.current) void mutationOwner.runMailAction(retryMailActionRef.current, true); }}>
            Retry remaining
          </button>
        )}
        {mutationFailure?.detail && (
          <button type="button" className="taomni-btn h-5 px-2 shrink-0" data-testid="mail-mutation-details"
            onClick={() => void confirmDialog.confirm({ title: "Mail operation details", message: mutationFailure.detail ?? "", confirmLabel: "Close" })}>
            Details
          </button>
        )}
        {error && isMailCertificateError(error) && (
          <button
            type="button"
            className="h-5 shrink-0 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
            data-testid="mail-cert-review"
            onClick={() => void openCertReview(/smtp/i.test(error) ? "smtp" : "imap")}
          >
            <ShieldCheck className="w-3 h-3" />
            Review certificate
          </button>
        )}
        {error && oauthReauthRequired && onEditSession && (
          <button
            type="button"
            className="h-5 shrink-0 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
            onClick={() => onEditSession(info.sessionId)}
          >
            <ShieldCheck className="w-3 h-3" />
            Reauthorize
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        {appearanceOwner.mailboxCollapsed && (
          <button
            type="button"
            className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
            style={{
              background: "var(--taomni-panel-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
            title="Show mailbox"
            aria-label="Show mailbox"
            onClick={appearanceOwner.expandMailboxPanel}
          >
            <ChevronDown className="w-3.5 h-3.5 -rotate-90" />
            <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
              Mailbox
            </span>
          </button>
        )}
        {selectionOwner.mailViewKey !== "mailbox" && selectionOwner.activeMessageTab ? (
          <div className="h-full min-h-0 border-l border-[var(--taomni-divider)]">
            {renderReaderSurface(selectionOwner.selectedMessage ?? selectionOwner.activeMessageTab.message)}
          </div>
        ) : (
          <PanelGroup
            orientation="horizontal"
            id={`mail-client-${info.sessionId}`}
            defaultLayout={loadResizableLayout(`mail-client-${info.sessionId}`, ["folders", "messages", "reader"])}
            onLayoutChanged={saveResizableLayout(`mail-client-${info.sessionId}`)}
            className="h-full min-h-0"
          >
            <MailFoldersPane
              foldersPanelRef={appearanceOwner.foldersPanelRef}
              handleMailboxResize={appearanceOwner.handleMailboxResize}
              mailboxCollapsed={appearanceOwner.mailboxCollapsed}
              loadingFolders={cacheOwner.loadingFolders}
              setSubscriptionsOpen={setSubscriptionsOpen}
              setContactDraft={setContactDraft}
              setAddressBookOpen={setAddressBookOpen}
              info={info}
              setAgendaOpen={setAgendaOpen}
              filterErrors={filterErrors}
              setFilterDraft={setFilterDraft}
              setFiltersOpen={setFiltersOpen}
              treeFolders={treeFolders}
              selectedFolder={cacheOwner.selectedFolder}
              dropFolder={dropFolder}
              draggedMessagesRef={draggedMessagesRef}
              setDropFolder={setDropFolder}
              handleCopyMessages={mutationOwner.handleCopyMessages}
              handleMoveMessages={mutationOwner.handleMoveMessages}
              handleFolderSelect={handleFolderSelect}
              mailMenu={mailMenu}
              folderMenuItems={folderMenuItems}
              cacheLine={cacheLine}
            />

            <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

            <MailMessagesPane
              allFilteredMessagesChecked={selectionOwner.allFilteredMessagesChecked}
              filteredMessages={searchOwner.filteredMessages}
              toggleFilteredMessagesChecked={selectionOwner.toggleFilteredMessagesChecked}
              activeFolder={activeFolder}
              threadView={selectionOwner.threadView}
              setThreadView={selectionOwner.setThreadView}
              messages={cacheOwner.messages}
              hasMoreMessages={cacheOwner.hasMoreMessages}
              loadingMessages={cacheOwner.loadingMessages}
              query={searchOwner.query}
              busyAction={busyAction}
              checkedMessages={selectionOwner.checkedMessages}
              handleDeleteMessages={mutationOwner.handleDeleteMessages}
              setCheckedMessageKeys={selectionOwner.setCheckedMessageKeys}
              handleMessageListScroll={handleMessageListScroll}
              mailMenu={mailMenu}
              messageListMenuItems={messageListMenuItems}
              quickFilterActive={searchOwner.quickFilterActive}
              listRows={selectionOwner.listRows}
              selectedMessageKey={selectionOwner.selectedMessageKey}
              checkedMessageKeys={selectionOwner.checkedMessageKeys}
              selectedFolder={cacheOwner.selectedFolder}
              displayFolders={displayFolders}
              rowActionsRef={rowActionsRef}
              loadingMoreMessages={cacheOwner.loadingMoreMessages}
              loadMoreMessages={loadMoreMessages}
            />

            <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

            <MailReaderPane
              showReaderMenu={showReaderMenu}
              selectedMessage={selectionOwner.selectedMessage}
              bodyLoadingKey={cacheOwner.bodyLoadingKey}
              openReply={composerOwner.openReply}
              openReplyAll={composerOwner.openReplyAll}
              openMessagePopup={messageTabsOwner.openMessagePopup}
              handleAiAction={handleAiAction}
              info={info}
              selectedBody={selectedBody}
              selectedHasRemoteImages={selectedHasRemoteImages}
              selectedMessageRemoteKey={selectedMessageRemoteKey}
              toggleRemoteForMessage={toggleRemoteForMessage}
              selectedAllowsRemote={selectedAllowsRemote}
              renderUnsubscribe={renderUnsubscribe}
              visibleAttachments={visibleAttachments}
              handleSaveAllAttachments={handleSaveAllAttachments}
              downloadingAttachmentIndex={downloadingAttachmentIndex}
              handleOpenAttachment={handleOpenAttachment}
              handleAttachmentContextMenu={handleAttachmentContextMenu}
              renderInviteCard={renderInviteCard}
              renderReceiptBanner={renderReceiptBanner}
              allowRemoteForMessage={allowRemoteForMessage}
              setAllowRemoteAllInTab={setAllowRemoteAllInTab}
              blockRemoteForMessage={blockRemoteForMessage}
              preferDarkReader={appearanceOwner.preferDarkReader}
              mailFontSize={appearanceOwner.mailFontSize}
              openComposeFromMailto={composerOwner.openComposeFromMailto}
            />
          </PanelGroup>
        )}
      </div>

      {attachmentMenu.render}
      {mailMenu.render}
      {confirmDialog.render}
      {textInputDialog.render}

      {composerOwner.composePrompt && (
        <MailComposePrompt
          prompt={composerOwner.composePrompt}
          onClose={() => composerOwner.setComposePrompt(null)}
          onAttach={() => {
            composerOwner.setComposePrompt(null);
            void composerOwner.handleAddDraftAttachments();
          }}
          onSendAnyway={() => {
            composerOwner.setComposePrompt(null);
            void composerOwner.handleSendDraft(true);
          }}
        />
      )}

      {<MailSourceDialog sourceView={sourceView} setSourceView={setSourceView} copyText={copyText} />}

      {<MailMessagePopup popupMessage={selectionOwner.popupMessage} setPopupMessageKey={selectionOwner.setPopupMessageKey} openMessageTab={messageTabsOwner.openMessageTab} renderReaderSurface={renderReaderSurface} />}

      {<MailCertificateDialog certReview={certReview} setCertReview={setCertReview} trustReviewedCertificate={trustReviewedCertificate} />}

      {composerOwner.undoSend && (
        <div
          className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[160] h-9 px-3 rounded shadow-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] flex items-center gap-3 text-[12px]"
          role="status"
          data-testid="mail-undo-send"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Sending in {Math.max(0, Math.ceil(composerOwner.undoSend.until - composerOwner.undoNow / 1000))}s…
          <button type="button" className="taomni-btn h-7 px-2" data-testid="mail-undo-send-button" onClick={() => void composerOwner.handleUndoSend()}>
            Undo
          </button>
        </div>
      )}

      {<MailAgendaDialog agendaOpen={agendaOpen} info={info} setAgendaOpen={setAgendaOpen} agendaRevision={agendaRevision} setStatus={setStatus} onAgendaChanged={onAgendaChanged} />}

      {<MailAddressBookDialog addressBookOpen={addressBookOpen} setAddressBookOpen={setAddressBookOpen} info={info} contactDraft={contactDraft} setStatus={setStatus} openCompose={composerOwner.openCompose} />}

      {<MailFiltersDialog filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen} setFilterErrors={setFilterErrors} filterErrors={filterErrors} info={info} displayFolders={displayFolders} selectedFolder={cacheOwner.selectedFolder} filterDraft={filterDraft} runFiltersOnFolder={mutationOwner.runFiltersOnFolder} setStatus={setStatus} />}

      {<MailSubscriptionsDialog subscriptionsOpen={subscriptionsOpen} setSubscriptionsOpen={setSubscriptionsOpen} subscribedOnly={subscribedOnly} setSubscribedOnly={setSubscribedOnly} displayFolders={displayFolders} subscriptionBusy={subscriptionBusy} toggleSubscription={toggleSubscription} />}

      {<MailDraftsDialog draftsOpen={composerOwner.draftsOpen} draftsTab={composerOwner.draftsTab} setDraftsOpen={composerOwner.setDraftsOpen} refreshDrafts={composerOwner.refreshDrafts} draftsLoading={composerOwner.draftsLoading} setDraftsTab={composerOwner.setDraftsTab} outboxCount={composerOwner.outboxCount} visibleDrafts={composerOwner.visibleDrafts} processOutbox={composerOwner.processOutbox} openFromTemplate={composerOwner.openFromTemplate} openSavedDraft={composerOwner.openSavedDraft} sendOutboxItem={composerOwner.sendOutboxItem} deleteSavedDraft={composerOwner.deleteSavedDraft} />}

      {composerOwner.composeOpen && (
        <MailComposer
          composeRootRef={composerOwner.composeRootRef}
          sending={composerOwner.sending}
          setComposeDragActive={composerOwner.setComposeDragActive}
          addDraftAttachmentPaths={composerOwner.addDraftAttachmentPaths}
          handleDropComposeFiles={composerOwner.handleDropComposeFiles}
          draft={composerOwner.draft}
          setComposeOpen={composerOwner.setComposeOpen}
          setComposePrompt={composerOwner.setComposePrompt}
          saveCurrentDraft={composerOwner.saveCurrentDraft}
          savingDraft={composerOwner.savingDraft}
          handleAddDraftAttachments={composerOwner.handleAddDraftAttachments}
          setDraft={composerOwner.setDraft}
          attachProgress={composerOwner.attachProgress}
          tabId={tabId}
          identityById={composerOwner.identityById}
          identities={composerOwner.identities}
          recipientSuggestionsFor={composerOwner.recipientSuggestionsFor}
          defaultMailDomain={composerOwner.defaultMailDomain}
          recipientSearch={composerOwner.recipientSearch}
          handleRecipientQueryChange={composerOwner.handleRecipientQueryChange}
          composeDragActive={composerOwner.composeDragActive}
          handleInsertInlineImage={composerOwner.handleInsertInlineImage}
          handlePasteImages={composerOwner.handlePasteImages}
          removeDraftAttachment={composerOwner.removeDraftAttachment}
          saveCurrentAsTemplate={composerOwner.saveCurrentAsTemplate}
          discardCurrentDraft={composerOwner.discardCurrentDraft}
          setSendLaterAt={composerOwner.setSendLaterAt}
          setSendLaterOpen={composerOwner.setSendLaterOpen}
          sendLaterOpen={composerOwner.sendLaterOpen}
          sendLaterAt={composerOwner.sendLaterAt}
          handleSendLater={composerOwner.handleSendLater}
          handleSendDraft={composerOwner.handleSendDraft}
        />
      )}
    </div>
  ));
}
