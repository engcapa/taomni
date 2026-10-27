import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { selectUploadFile } from "../../lib/ipc";
import {
  mailExportMbox,
  mailImportMessages,
  mailUnsubscribeOneClick,
  type MailCertificateInfo,
  type MailFolder,
  type MailMessageHeader,
} from "../../lib/mail";
import { type MailAddressBookEntry } from "../../lib/mailContacts";
import { type MailFilter } from "../../lib/mailFilters";
import { folderLabel, visibleFolders } from "../../lib/mailFolders";
import { mailHtmlHasRemoteImages } from "../../lib/mailHtml";
import { MailMutationSession } from "../../lib/mailMutations";
import { useChatStore } from "../../stores/chatStore";
import { useContextMenu } from "../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { aiPrompt } from "./client/ai";
import { createAttachmentActions } from "./client/createAttachmentActions";
import { createCertificateActions } from "./client/createCertificateActions";
import { createFolderActions } from "./client/createFolderActions";
import { createInvitationControls } from "./client/createInvitationControls";
import { createMailMenus } from "./client/createMailMenus";
import { createMailReaderRenderer } from "./client/createMailReaderRenderer";
import { createMessageExportActions } from "./client/createMessageExportActions";
import { DEFAULT_FOLDER, MAIL_DRAG_TYPE } from "./client/folders";
import { MailClientView } from "./client/MailClientView";
import { type MailRowActions } from "./client/MailRowActions";
import { createLoadMoreMessages } from "./client/messageLoading";
import { bodyMatchesMessage, isOAuthReauthRequired, mailClientErrorMessage, messageKey, messagePageSize } from "./client/messages";
import { createMailMutations } from "./client/mutations";
import { type AiAction, type MailClientTabProps } from "./client/types";
import { useMailAppearance } from "./client/useMailAppearance";
import { useMailboxLifecycle } from "./client/useMailboxLifecycle";
import { useMailCacheActions } from "./client/useMailCacheActions";
import { useMailCacheLoading } from "./client/useMailCacheLoading";
import { useMailCacheState } from "./client/useMailCacheState";
import { useMailCalendar } from "./client/useMailCalendar";
import { useMailComposer } from "./client/useMailComposer";
import { useMailFeedback } from "./client/useMailFeedback";
import { useMailMessageTabs } from "./client/useMailMessageTabs";
import { useMailReading } from "./client/useMailReading";
import { useMailSearch } from "./client/useMailSearch";
import { useMailSelection } from "./client/useMailSelection";
import { useMailShortcuts } from "./client/useMailShortcuts";
import { useMailSynchronization } from "./client/useMailSynchronization";
import { useMailSubscriptions } from "./client/useMailSubscriptions";
import { useReadReceipts } from "./client/useReadReceipts";
import { useRemoteContentPermissions } from "./client/useRemoteContentPermissions";

export function MailClientTab({ tabId, info, visible, onEditSession }: MailClientTabProps) {
  const rowActionsRef = useRef<MailRowActions | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { status, setStatus, setLoadingStatus, error, setError } = useMailFeedback();
  const [downloadingAttachmentIndex, setDownloadingAttachmentIndex] = useState<number | null>(null);
  const cacheOwner = useMailCacheState({
    visible,
    accountId: info.sessionId,
  });
  const attachmentMenu = useContextMenu();
  const mailMenu = useContextMenu();
  const confirmDialog = useConfirmDialog();
  const textInputDialog = useTextInputDialog();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sourceView, setSourceView] = useState<{ subject: string; content: string; } | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const mutationSessionRef = useRef(new MailMutationSession());
  const retryMailActionRef = useRef<(() => Promise<void>) | null>(null);
  const [mutationFailure, setMutationFailure] = useState<{ message: string; retryable: boolean; detail: string | null; } | null>(null);
  const [mutationProgress, setMutationProgress] = useState<string | null>(null);

  const openTabChat = useChatStore((s) => s.openTabChat);
  const sendMessageToAi = useChatStore((s) => s.sendMessage);

  const displayFolders = cacheOwner.folders.length > 0 ? cacheOwner.folders : [{ ...DEFAULT_FOLDER, accountId: info.sessionId }];
  const { subscribedOnly, subscribedOnlyRef, setSubscribedOnly, subscriptionsOpen,
    setSubscriptionsOpen, subscriptionBusy, toggleSubscription } = useMailSubscriptions({
    info, foldersRef: cacheOwner.foldersRef, setFolders: cacheOwner.setFolders,
    folderSnapshots: cacheOwner.folderSnapshots, setError,
  });
  const treeFolders = useMemo(() => visibleFolders(displayFolders, subscribedOnly), [displayFolders, subscribedOnly]);
  const draggedMessagesRef = useRef<MailMessageHeader[]>([]);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [unsubscribeArmed, setUnsubscribeArmed] = useState<string | null>(null);
  /** Message filters dialog (TASK-13); the draft pre-fills "Create filter from message". */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<MailFilter | null>(null);
  /** Failed actions of the last incoming filter run (AC-42), kept until the dialog is opened. */
  const [filterErrors, setFilterErrors] = useState<string[]>([]);
  const incomingFiltersRef = useRef<(() => Promise<void>) | null>(null);
  /** Address book dialog (TASK-19); the draft pre-fills "Add sender to address book". */
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [contactDraft, setContactDraft] = useState<MailAddressBookEntry | null>(null);
  const [certReview, setCertReview] = useState<{
    protocol: "imap" | "smtp";
    loading: boolean;
    info?: MailCertificateInfo;
    error?: string;
  } | null>(null);
  const retryAfterTrustRef = useRef(false);
  const oauthReauthRequired = isOAuthReauthRequired(error);
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const appearanceOwner = useMailAppearance({
    info,
    visible,
    rootRef,
  });
  const {
    messageAllowsRemote,
    toggleRemoteForMessage,
    allowRemoteForMessage,
    blockRemoteForMessage,
    setAllowRemoteAllInTab,
    setRemoteAllowedMessageKeys,
  } = useRemoteContentPermissions();
  // Search can return headers outside the loaded folder/page. They still need
  // to participate in selection, reading and bulk actions.
  const searchOwner = useMailSearch({
    info,
    selectedFolder: cacheOwner.selectedFolder,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    setError,
    setStatus,
    messages: cacheOwner.messages,
  });

  useEffect(() => {
    cacheOwner.visibleRef.current = visible;
    if (visible) return;
    cacheOwner.bodyWarmSeqRef.current += 1;
    cacheOwner.bodyLoadSeqRef.current += 1;
    syncOwner.setSyncing(false);
    cacheOwner.setLoadingFolders(false);
    cacheOwner.setLoadingMessages(false);
    cacheOwner.setLoadingMoreMessages(false);
    cacheOwner.setBodyLoadingKey(null);
    cacheOwner.setBodyWarming((current) => (
      current.active
        ? { active: false, done: current.done, total: current.total, folder: current.folder }
        : current
    ));
  }, [visible]);
  const selectionOwner = useMailSelection({
    query: searchOwner.query,
    searchResults: searchOwner.searchResults,
    messages: cacheOwner.messages,
    filteredMessages: searchOwner.filteredMessages,
  });
  const selectedBody = useMemo(() => {
    if (!selectionOwner.selectedMessage) return null;
    const cached = cacheOwner.bodyCache.get(messageKey(selectionOwner.selectedMessage));
    if (cached && bodyMatchesMessage(cached, selectionOwner.selectedMessage)) return cached;
    return bodyMatchesMessage(cacheOwner.body, selectionOwner.selectedMessage) ? cacheOwner.body : null;
  }, [cacheOwner.body, cacheOwner.bodyCache, selectionOwner.selectedMessage]);

  const selectedHasRemoteImages = useMemo(
    () => mailHtmlHasRemoteImages(selectedBody?.html),
    [selectedBody?.html],
  );
  const selectedMessageRemoteKey = selectionOwner.selectedMessage ? messageKey(selectionOwner.selectedMessage) : null;
  const selectedAllowsRemote = messageAllowsRemote(selectedMessageRemoteKey);

  const visibleAttachments = useMemo(
    () => (selectedBody?.attachments.length ? selectedBody.attachments : selectionOwner.selectedMessage?.attachments ?? []),
    [selectedBody?.attachments, selectionOwner.selectedMessage?.attachments],
  );
  const { setInviteView, setAgendaRevision, inviteView, setAgendaOpen, agendaOpen, agendaRevision, onAgendaChanged } = useMailCalendar({
    info,
    selectedMessage: selectionOwner.selectedMessage,
    visibleAttachments,
    setStatus,
  });

  const cacheLoadingOwner = useMailCacheLoading({
    cacheOwner,
    setError,
    info,
    pageSize,
    setStatus: setLoadingStatus,
    searchOwner,
    selectionOwner,
  });
  const syncOwner = useMailSynchronization({
    info,
    folderSnapshots: cacheOwner.folderSnapshots,
    foldersRef: cacheOwner.foldersRef,
    tabId,
    visibleRef: cacheOwner.visibleRef,
    setFolders: cacheOwner.setFolders,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    messagesRef: cacheOwner.messagesRef,
    pageSize,
    setMessages: cacheOwner.setMessages,
    setStatus,
    setLoadingStatus,
    reloadVisibleFromCache: cacheLoadingOwner.reloadVisibleFromCache,
    incomingFiltersRef,
    setError,
    loadCachedFolders: cacheLoadingOwner.loadCachedFolders,
    setHasMoreMessages: cacheOwner.setHasMoreMessages,
    subscribedOnlyRef,
    updateSelectedFolder: cacheOwner.updateSelectedFolder,
    loadCachedMessages: cacheLoadingOwner.loadCachedMessages,
    warmRecentBodies: cacheLoadingOwner.warmRecentBodies,
  });
  const messageTabsOwner = useMailMessageTabs({
    updateSelectedFolder: cacheOwner.updateSelectedFolder,
    setSelectedMessageKey: selectionOwner.setSelectedMessageKey,
    setMailViewKey: selectionOwner.setMailViewKey,
    bodyCacheRef: cacheOwner.bodyCacheRef,
    setBody: cacheOwner.setBody,
    selectionAnchorRef: selectionOwner.selectionAnchorRef,
    setCheckedMessageKeys: selectionOwner.setCheckedMessageKeys,
    setMessageTabs: selectionOwner.setMessageTabs,
    mailViewKey: selectionOwner.mailViewKey,
    popupMessageKey: selectionOwner.popupMessageKey,
    setPopupMessageKey: selectionOwner.setPopupMessageKey,
  });
  const { idleEnabled, idleState } = useMailboxLifecycle({
    loadCachedMessages: cacheLoadingOwner.loadCachedMessages,
    initialSyncDoneRef: syncOwner.initialSyncDoneRef,
    foldersRef: cacheOwner.foldersRef,
    bodyWarmSeqRef: cacheOwner.bodyWarmSeqRef,
    bodyLoadSeqRef: cacheOwner.bodyLoadSeqRef,
    bodyCacheRef: cacheOwner.bodyCacheRef,
    bodyRequestsRef: cacheOwner.bodyRequestsRef,
    setFolders: cacheOwner.setFolders,
    setMessages: cacheOwner.setMessages,
    setSelectedMessageKey: selectionOwner.setSelectedMessageKey,
    setMailViewKey: selectionOwner.setMailViewKey,
    setMessageTabs: selectionOwner.setMessageTabs,
    setPopupMessageKey: selectionOwner.setPopupMessageKey,
    setCheckedMessageKeys: selectionOwner.setCheckedMessageKeys,
    setBody: cacheOwner.setBody,
    setBodyCache: cacheOwner.setBodyCache,
    setBodyLoadingKey: cacheOwner.setBodyLoadingKey,
    setBodyWarming: cacheOwner.setBodyWarming,
    setHasMoreMessages: cacheOwner.setHasMoreMessages,
    setLoadingMoreMessages: cacheOwner.setLoadingMoreMessages,
    setDownloadingAttachmentIndex,
    updateSelectedFolder: cacheOwner.updateSelectedFolder,
    loadCachedFolders: cacheLoadingOwner.loadCachedFolders,
    info,
    selectedFolder: cacheOwner.selectedFolder,
    visible,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    syncFolderNow: syncOwner.syncFolderNow,
    refreshFolderTree: syncOwner.refreshFolderTree,
    startBackfill: syncOwner.startBackfill,
    syncAllFolders: syncOwner.syncAllFolders,
    batchSize: syncOwner.batchSize,
    quietPollSelectedAndInbox: syncOwner.quietPollSelectedAndInbox,
    syncInFlightRef: syncOwner.syncInFlightRef,
    availableMessages: selectionOwner.availableMessages,
    selectedMessageKey: selectionOwner.selectedMessageKey,
    messageTabs: selectionOwner.messageTabs,
  });
  const readingOwner = useMailReading({
    cacheOwner,
    searchOwner,
    selectionOwner,
    setStatus,
    setError,
    info,
    cacheLoadingOwner,
    visible,
    setAllowRemoteAllInTab,
    setRemoteAllowedMessageKeys,
    selectedBody,
  });

  const handleFolderSelect = (folder: MailFolder) => {
    selectionOwner.selectionAnchorRef.current = null;
    const changed = folder.name !== cacheOwner.selectedFolderRef.current;
    cacheOwner.updateSelectedFolder(folder.name);
    if (changed) {
      syncOwner.backfillSeqRef.current += 1;
      syncOwner.setBackfillProgress(null);
      void syncOwner.syncSelectedFolder(folder.name);
    }
    selectionOwner.setSelectedMessageKey(null);
    selectionOwner.setCheckedMessageKeys(new Set());
    cacheOwner.setBody(null);
    cacheOwner.setHasMoreMessages(false);
    cacheOwner.setLoadingMoreMessages(false);
    searchOwner.setQuery("");
  };

  const loadMoreMessages = useCallback(createLoadMoreMessages({
    query: searchOwner.query,
    loadingMessages: cacheOwner.loadingMessages,
    loadingMoreMessages: cacheOwner.loadingMoreMessages,
    hasMoreMessages: cacheOwner.hasMoreMessages,
    selectedFolder: cacheOwner.selectedFolder,
    messages: cacheOwner.messages,
    info,
    setLoadingMoreMessages: cacheOwner.setLoadingMoreMessages,
    pageSize,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    messagesRef: cacheOwner.messagesRef,
    setMessages: cacheOwner.setMessages,
    setHasMoreMessages: cacheOwner.setHasMoreMessages,
    setError,
    loadCachedMessages: cacheLoadingOwner.loadCachedMessages,
    foldersRef: cacheOwner.foldersRef,
    syncInFlightRef: syncOwner.syncInFlightRef,
    folderSnapshots: cacheOwner.folderSnapshots,
    applySyncedFolder: syncOwner.applySyncedFolder,
    setStatus,
  }), [
    syncOwner.applySyncedFolder,
    cacheOwner.hasMoreMessages,
    info,
    cacheLoadingOwner.loadCachedMessages,
    cacheOwner.loadingMessages,
    cacheOwner.loadingMoreMessages,
    cacheOwner.messages.length,
    pageSize,
    searchOwner.query,
    cacheOwner.selectedFolder,
  ]);

  const handleMessageListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 96) {
      void loadMoreMessages();
    }
  }, [loadMoreMessages]);
  const cacheActionsOwner = useMailCacheActions({
    setError,
    info,
    setStatus,
    cacheOwner,
    selectionOwner,
  });
  const composerOwner = useMailComposer({
    info,
    messages: cacheOwner.messages,
    setError,
    setStatus,
    selectedMessage: selectionOwner.selectedMessage,
    body: cacheOwner.body,
    retryAfterTrustRef,
    syncFolderNow: syncOwner.syncFolderNow,
    selectedFolderRef: cacheOwner.selectedFolderRef,
  });
  const mutationOwner = createMailMutations({
    setMessages: cacheOwner.setMessages,
    setSearchResults: searchOwner.setSearchResults,
    setMessageTabs: selectionOwner.setMessageTabs,
    setFolders: cacheOwner.setFolders,
    cacheRemovalVersionsRef: cacheOwner.cacheRemovalVersionsRef,
    setCheckedMessageKeys: selectionOwner.setCheckedMessageKeys,
    setMailViewKey: selectionOwner.setMailViewKey,
    setSelectedMessageKey: selectionOwner.setSelectedMessageKey,
    setPopupMessageKey: selectionOwner.setPopupMessageKey,
    mutationSessionRef,
    setMutationProgress,
    retryMailActionRef,
    setMutationFailure,
    setBusyAction,
    setError,
    displayFolders,
    info,
    incomingFiltersRef,
    setFilterErrors,
    setStatus,
    reloadVisibleFromCache: cacheLoadingOwner.reloadVisibleFromCache,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    loadCachedFolders: cacheLoadingOwner.loadCachedFolders,
    setContactDraft,
    setAddressBookOpen,
    setFilterDraft,
    setFiltersOpen,
    confirmDialog,
  });
  useMailShortcuts({
    visible,
    rootRef,
    composerOwner,
    subscriptionsOpen,
    listRows: selectionOwner.listRows,
    selectedMessage: selectionOwner.selectedMessage,
    selectListMessage: messageTabsOwner.selectListMessage,
    searchInputRef,
    checkedMessages: selectionOwner.checkedMessages,
    busyAction,
    handleMarkSelectedRead: readingOwner.handleMarkSelectedRead,
    handleMarkSingleRead: readingOwner.handleMarkSingleRead,
    handleMarkUnread: mutationOwner.handleMarkUnread,
    handleToggleFlagged: mutationOwner.handleToggleFlagged,
    handleArchiveMessages: mutationOwner.handleArchiveMessages,
    handleJunkMessages: mutationOwner.handleJunkMessages,
    handleNotJunkMessages: mutationOwner.handleNotJunkMessages,
    handleDeleteMessages: mutationOwner.handleDeleteMessages,
  });
  const { renderReceiptBanner } = useReadReceipts({
    selectedMessage: selectionOwner.selectedMessage,
    info,
    resolveSpecialFolder: mutationOwner.resolveSpecialFolder,
    setStatus,
    applyFlagsLocally: mutationOwner.applyFlagsLocally,
    setError,
  });

  if (!visible) {
    return (
      <div
        ref={rootRef}
        className="h-full min-h-0 bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
        style={appearanceOwner.mailAppearance}
        data-testid="mail-client-tab"
        data-active={visible ? "true" : "false"}
        aria-hidden="true"
      />
    );
  }

  const handleAiAction = async (action: AiAction) => {
    if (!selectionOwner.selectedMessage) return;
    if (!info.ai.enabled) {
      setError("AI actions are disabled for this mail account.");
      return;
    }
    let currentBody = cacheOwner.body;
    if (!currentBody || currentBody.uid !== selectionOwner.selectedMessage.uid || currentBody.folder !== selectionOwner.selectedMessage.folder) {
      currentBody = await cacheLoadingOwner.loadBody(selectionOwner.selectedMessage);
    }
    if (!currentBody) return;
    if (!info.ai.skipBodyConfirm) {
      const confirmed = window.confirm("Send this email body to the configured Taomni AI provider?");
      if (!confirmed) return;
    }
    try {
      await openTabChat(tabId);
      const threadId = useChatStore.getState().activeThreadId;
      if (!threadId) throw new Error("No AI chat thread is available.");
      await sendMessageToAi(threadId, aiPrompt(action, selectionOwner.selectedMessage, currentBody));
      setStatus("Sent mail context to AI");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };
  const { handleDownloadAttachment, handleOpenAttachment, handleSaveAllAttachments, handleAttachmentContextMenu } = createAttachmentActions({
    setDownloadingAttachmentIndex,
    setError,
    setStatus,
    info,
    downloadingAttachmentIndex,
    attachmentMenu,
  });

  const copyText = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => setStatus(`Copied ${label}`))
      .catch((e) => setError(mailClientErrorMessage(e)));
  };
  const { handleSaveEml, handleViewSource, handlePrintMessage } = createMessageExportActions({
    selectedMessage: selectionOwner.selectedMessage,
    body: cacheOwner.body,
    mailFontSize: appearanceOwner.mailFontSize,
    setError,
    runMailAction: mutationOwner.runMailAction,
    info,
    setSourceView,
    setStatus,
  });

  const handleSearchInFolder = (folder: MailFolder) => {
    handleFolderSelect(folder);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };
  const { handleCreateFolder, handleRenameFolder, handleEmptyFolder, handleDeleteFolder } = createFolderActions({
    runMailAction: mutationOwner.runMailAction,
    textInputDialog,
    info,
    loadCachedFolders: cacheLoadingOwner.loadCachedFolders,
    setStatus,
    selectedFolder: cacheOwner.selectedFolder,
    updateSelectedFolder: cacheOwner.updateSelectedFolder,
    confirmDialog,
    setSelectedMessageKey: selectionOwner.setSelectedMessageKey,
    setBody: cacheOwner.setBody,
    mutationSessionRef,
    removeMessagesLocally: mutationOwner.removeMessagesLocally,
    messages: cacheOwner.messages,
    reportMutationProgress: mutationOwner.reportMutationProgress,
    setMessages: cacheOwner.setMessages,
    setCheckedMessageKeys: selectionOwner.setCheckedMessageKeys,
    setFolders: cacheOwner.setFolders,
  });

  const handleUnsubscribe = async (message: MailMessageHeader) => {
    const list = message.listUnsubscribe;
    if (!list) return;
    const key = messageKey(message);
    const https = list.uris.find((uri) => /^https:/i.test(uri));
    const mailto = list.uris.find((uri) => /^mailto:/i.test(uri));
    if (list.oneClick && https) {
      // RFC 8058: confirm first, then POST without opening a browser.
      if (unsubscribeArmed !== key) {
        setUnsubscribeArmed(key);
        return;
      }
      setUnsubscribeArmed(null);
      try {
        await mailUnsubscribeOneClick(https);
        setStatus("Unsubscribe request sent");
      } catch (e) {
        setError(mailClientErrorMessage(e));
      }
      return;
    }
    if (mailto) {
      composerOwner.openComposeFromMailto(mailto);
      return;
    }
    const web = list.uris.find((uri) => /^https?:/i.test(uri));
    if (web) void openExternalUrl(web);
  };

  const renderUnsubscribe = (message: MailMessageHeader) => {
    if (!message.listUnsubscribe || message.listUnsubscribe.uris.length === 0) return null;
    const armed = unsubscribeArmed === messageKey(message);
    return (
      <button
        type="button"
        className="taomni-btn h-5 px-2 text-[10px]"
        data-testid="mail-unsubscribe"
        data-armed={armed ? "true" : undefined}
        title={message.listUnsubscribe.uris.join("\n")}
        onClick={() => void handleUnsubscribe(message)}
      >
        {armed ? "Confirm unsubscribe" : "Unsubscribe"}
      </button>
    );
  };
  const { renderInviteCard } = createInvitationControls({
    setInviteView,
    info,
    setAgendaRevision,
    setStatus,
    inviteView,
    visibleAttachments,
    handleDownloadAttachment,
    handleOpenAttachment,
  });

  const handleExportMbox = (folder: MailFolder) => mutationOwner.runMailAction(async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const safe = folderLabel(folder).replace(/[\\/:*?"<>|]+/g, "_") || "folder";
    const targetPath = await save({ title: `Export ${folderLabel(folder)} as mbox`, defaultPath: `${safe}.mbox` });
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      setStatus("Export cancelled");
      return;
    }
    setStatus(`Exporting ${folderLabel(folder)}…`);
    const result = await mailExportMbox(info, folder.name, targetPath);
    setStatus(`Exported ${result.count} message${result.count === 1 ? "" : "s"} to ${result.path}`);
  });

  const handleImportMessages = (folder: MailFolder) => mutationOwner.runMailAction(async () => {
    const paths = await selectUploadFile();
    if (!paths.length) {
      setStatus("Import cancelled");
      return;
    }
    let imported = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const path of paths) {
      const result = await mailImportMessages(info, folder.name, path);
      imported += result.imported;
      failed += result.failed;
      firstError = firstError ?? result.firstError ?? null;
    }
    setStatus(`Imported ${imported} message${imported === 1 ? "" : "s"} into ${folderLabel(folder)}${failed ? `; ${failed} failed` : ""}`);
    if (firstError) setError(`Import failed for some messages: ${firstError}`);
    // Pull the appended mail into the cache and list.
    await syncOwner.runFolderSync(folder.name, { maxSteps: 20 }).catch(() => undefined);
    await cacheLoadingOwner.reloadVisibleFromCache(folder.name);
  });
  const { openCertReview, trustReviewedCertificate } = createCertificateActions({
    setCertReview,
    info,
    certReview,
    setError,
    tabId,
    setStatus,
    retryAfterTrustRef,
  });

  const openExternalUrl = async (url: string) => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const dragTargetsFor = (message: MailMessageHeader): MailMessageHeader[] =>
    selectionOwner.checkedMessageKeys.has(messageKey(message)) && selectionOwner.checkedMessages.length > 0 ? selectionOwner.checkedMessages : [message];
  const activeFolder = displayFolders.find((folder) => folder.name === cacheOwner.selectedFolder) ?? displayFolders[0];
  const { showReaderMenu, messageMenuItems, folderMenuItems, messageListMenuItems } = createMailMenus({
    displayFolders,
    selectionOwner,
    messageTabsOwner,
    composerOwner,
    markingRead: readingOwner.markingRead,
    busyAction,
    handleMarkSelectedRead: readingOwner.handleMarkSelectedRead,
    handleMarkSingleRead: readingOwner.handleMarkSingleRead,
    mutationOwner,
    handleMarkFolderRead: readingOwner.handleMarkFolderRead,
    handleSaveEml,
    handleViewSource,
    handlePrintMessage,
    copyText,
    info,
    handleFolderSelect,
    handleSearchInFolder,
    syncOwner,
    handleCreateFolder,
    handleRenameFolder,
    handleExportMbox,
    handleImportMessages,
    handleEmptyFolder,
    handleDeleteFolder,
    activeFolder,
    searchOwner,
    body: cacheOwner.body,
    openExternalUrl,
    messageAllowsRemote,
    toggleRemoteForMessage,
    mailMenu,
  });

  const cacheLine = info.cache.enabled
    ? `${info.cache.headerRetentionDays > 0 ? `${info.cache.headerRetentionDays}d` : "all"} headers, ${info.cache.bodyRecentLimit} recent bodies`
    : "cache off";
  const { renderReaderSurface } = createMailReaderRenderer({
    bodyCache: cacheOwner.bodyCache,
    body: cacheOwner.body,
    messageAllowsRemote,
    bodyLoadingKey: cacheOwner.bodyLoadingKey,
    showReaderMenu,
    openReply: composerOwner.openReply,
    openReplyAll: composerOwner.openReplyAll,
    openMessagePopup: messageTabsOwner.openMessagePopup,
    toggleRemoteForMessage,
    renderUnsubscribe,
    handleSaveAllAttachments,
    downloadingAttachmentIndex,
    handleOpenAttachment,
    handleAttachmentContextMenu,
    allowRemoteForMessage,
    setAllowRemoteAllInTab,
    blockRemoteForMessage,
    preferDarkReader: appearanceOwner.preferDarkReader,
    mailFontSize: appearanceOwner.mailFontSize,
    openComposeFromMailto: composerOwner.openComposeFromMailto,
  });

  const rowActions: MailRowActions = {
    selectListMessage: messageTabsOwner.selectListMessage, openMessageTab: messageTabsOwner.openMessageTab, toggleMessageChecked: selectionOwner.toggleMessageChecked, toggleThreadExpanded: selectionOwner.toggleThreadExpanded,
    contextMenu: (event, message) => mailMenu.show(event, messageMenuItems(message)),
    dragStart: (event, message) => {
      draggedMessagesRef.current = dragTargetsFor(message);
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData(MAIL_DRAG_TYPE, String(draggedMessagesRef.current.length));
    },
    dragEnd: () => {
      draggedMessagesRef.current = [];
      setDropFolder(null);
    },
  };
  rowActionsRef.current = rowActions;

  return <MailClientView
    readingOwner={readingOwner}
    cacheActionsOwner={cacheActionsOwner}
    cacheOwner={cacheOwner}
    appearanceOwner={appearanceOwner}
    syncOwner={syncOwner}
    selectionOwner={selectionOwner}
    searchOwner={searchOwner}
    messageTabsOwner={messageTabsOwner}
    mutationOwner={mutationOwner}
    rootRef={rootRef}
    visible={visible}
    info={info}
    composerOwner={composerOwner}
    idleEnabled={idleEnabled}
    idleState={idleState}
    activeFolder={activeFolder}
    searchInputRef={searchInputRef}
    openTabChat={openTabChat}
    tabId={tabId}
    mailMenu={mailMenu}
    messageMenuItems={messageMenuItems}
    mutationFailure={mutationFailure}
    error={error}
    status={status}
    busyAction={busyAction}
    retryMailActionRef={retryMailActionRef}
    confirmDialog={confirmDialog}
    openCertReview={openCertReview}
    oauthReauthRequired={oauthReauthRequired}
    onEditSession={onEditSession}
    mutationProgress={mutationProgress}
    renderReaderSurface={renderReaderSurface}
    setSubscriptionsOpen={setSubscriptionsOpen}
    setContactDraft={setContactDraft}
    setAddressBookOpen={setAddressBookOpen}
    setAgendaOpen={setAgendaOpen}
    filterErrors={filterErrors}
    setFilterDraft={setFilterDraft}
    setFiltersOpen={setFiltersOpen}
    treeFolders={treeFolders}
    dropFolder={dropFolder}
    draggedMessagesRef={draggedMessagesRef}
    setDropFolder={setDropFolder}
    handleFolderSelect={handleFolderSelect}
    folderMenuItems={folderMenuItems}
    cacheLine={cacheLine}
    handleMessageListScroll={handleMessageListScroll}
    messageListMenuItems={messageListMenuItems}
    displayFolders={displayFolders}
    rowActionsRef={rowActionsRef}
    loadMoreMessages={loadMoreMessages}
    showReaderMenu={showReaderMenu}
    handleAiAction={handleAiAction}
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
    attachmentMenu={attachmentMenu}
    textInputDialog={textInputDialog}
    sourceView={sourceView}
    setSourceView={setSourceView}
    copyText={copyText}
    certReview={certReview}
    setCertReview={setCertReview}
    trustReviewedCertificate={trustReviewedCertificate}
    agendaOpen={agendaOpen}
    agendaRevision={agendaRevision}
    setStatus={setStatus}
    onAgendaChanged={onAgendaChanged}
    addressBookOpen={addressBookOpen}
    contactDraft={contactDraft}
    filtersOpen={filtersOpen}
    setFilterErrors={setFilterErrors}
    filterDraft={filterDraft}
    subscriptionsOpen={subscriptionsOpen}
    subscribedOnly={subscribedOnly}
    setSubscribedOnly={setSubscribedOnly}
    subscriptionBusy={subscriptionBusy}
    toggleSubscription={toggleSubscription}
  />;
}
