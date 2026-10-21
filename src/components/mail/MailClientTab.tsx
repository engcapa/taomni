import { MailMutationSession } from "../../lib/mailMutations";
import { MailArchivePanel } from "./MailArchivePanel";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SetStateAction, type UIEvent } from "react";
import { Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { AlertTriangle, Archive, Ban, BookUser, CalendarDays, CheckCircle2, ChevronDown, Code, Copy, Download, ExternalLink, FileText, Filter as FilterIcon, Folder, FolderInput, FolderPlus, FolderSymlink, FolderX, Forward, ImageOff, Inbox, Link as LinkIcon, ListChecks, Loader2, Mail as MailIcon, MailOpen, MessageSquareReply, PenLine, Printer, RefreshCw, Save, Search, Send, ShieldCheck, Star, Tag, Trash2, X } from "lucide-react";
import { mailClearCache, mailCreateFolder, mailDeleteFolder, mailDeleteMessages, mailDownloadAttachment, mailExportMbox, isMailCertificateError, mailProbeCertificate, mailImportMessages, mailFetchRaw, mailSendReceipt, MAIL_MDN_SENT, mailGetInvite, mailRespondInvite, mailIdleStart, mailIdleStop, mailIndexCachedContacts, mailDeleteDraft, mailListFolders, mailMarkRead, mailRenameFolder, mailSaveRaw, mailSetFlags, mailSetFolderSubscription, mailSearchContacts, mailSearchMessages, mailSearchServer, mailTestConnection, mailUnsubscribeOneClick, MAIL_IDLE_EVENT, type MailAttachmentInfo, type MailDraft, type MailFolder, type MailCertificateInfo, type MailIdleEvent, type MailInvite, type MailInviteReply, type MailMessageBody, type MailMessageHeader, type MailSearchField, type MailSyncRequestMode } from "../../lib/mail";
import { listen } from "@tauri-apps/api/event";
import { notifyDesktop } from "../../lib/lanNotify";
import { formatInviteRange, hasCalendarPart, myPartstat } from "../../lib/mailInvite";
import { type MailFilter } from "../../lib/mailFilters";
import { MailFiltersPanel } from "./MailFiltersPanel";
import { MailAddressBookPanel } from "./MailAddressBookPanel";
import { MailAgendaPanel } from "./MailAgendaPanel";
import { agendaKey, agendaTimeLabel, dueReminders, mailAddInviteToCalendar, mailCalDavSync, mailListAgenda, type MailAgendaEvent } from "../../lib/mailCalendar";
import { type MailAddressBookEntry } from "../../lib/mailContacts";
import { folderLabel, isSelectable, isSubscribed, loadSubscribedOnly, saveSubscribedOnly, visibleFolders } from "../../lib/mailFolders";
import { isOutbox, outboxNextAttemptAt, outboxState } from "../../lib/mailOutbox";
import { parseMailto } from "../../lib/mailto";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { isEditableTarget, mailShortcutAction, type MailShortcutAction } from "../../lib/mailShortcuts";
import { buildMailThreads, flattenMailThreads, type MailThreadRow } from "../../lib/mailThreads";
import { mailIdentities, ownIdentityAddresses, pickReplyIdentity } from "../../lib/mailIdentities";
import { MAIL_TAGS, messageTags } from "../../lib/mailTags";
import { mergeFolderMeta } from "../../lib/mailSync";
import { MailMessageBodyView } from "./MailMessageBodyView";
import { extractDefaultMailDomain, mergeRecipientSuggestions, parseRecipientsText, searchCachedMessageContacts, type RecipientSuggestion } from "../../lib/mailRecipients";
import { buildForwardHtml, buildMailReaderSrcDoc, buildReplyHtml, mailHtmlHasRemoteImages, mailHtmlToPlainText, plainTextToMailHtml, quotePlainText } from "../../lib/mailHtml";
import { formatMailPlainTextHtml } from "../../lib/mailPlainText";
import { openLocalPath, selectUploadFile, temporaryFilePath } from "../../lib/ipc";
import { NATIVE_FILE_DROP_EVENT, type NativeFileDropDetail } from "../../lib/osFileDrop";
import { useChatStore } from "../../stores/chatStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { DEFAULT_MAIL_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { useAppTheme } from "../../lib/appTheme";
import { type MailClientTabProps, type OpenMailMessageTab, type BodyWarmState, type ComposeDraft, type ComposePromptState, type RecipientSearchState, type RecipientFieldKey, type AiAction } from "./client/types";
import { type MailRowActions } from "./client/MailRowActions";
import { MAIL_THREAD_VIEW_STORAGE_KEY, isOAuthReauthRequired, messagePageSize, refreshBatchSize, catchupStepSize, dedupeMessages, messageKey, sortMessages, mailClientErrorMessage, addressLabel, isFlagged, bodyMatchesMessage, formatFullDate, escapeHtml, formatBytes, formatShortDate } from "./client/messages";
import { EMPTY_DRAFT, isTemplate, emptyComposeDraft, serializeDraftContent, draftHasContent, replyContextFor, normalizedMailAddress, appendUniqueAddress, forwardSubject } from "./client/compose";
import { MAILBOX_EXPANDED_SIZE, clampMailFontSize, mailAppearanceStyle, MAILBOX_RIBBON_THRESHOLD } from "./client/appearance";
import { DEFAULT_FOLDER, isUnread, NEW_MAIL_EXCLUDED_KINDS, folderMatchesSpecial, folderIcon, MAIL_DRAG_TYPE, folderDepth } from "./client/folders";
import { escapeRegExp, suggestedAttachmentName, ALL_ATTACHMENTS_INDEX, uniqueAttachmentName, joinLocalPath } from "./client/attachments";
import { aiPrompt } from "./client/ai";
import { RemoteImagesBanner } from "./client/RemoteImagesBanner";
import { MailComposePrompt } from "./client/MailComposePrompt";
import { MailDraggableDialog } from "./client/MailDraggableDialog";
import { createLoadCachedFolders, createLoadCachedMessages, createRememberBody, createFetchBodyForMessage, createWarmRecentBodies, createLoadBody, createLoadMoreMessages } from "./client/messageLoading";
import { createRunFolderSync, createQueueFolderCatchups, createStartBackfill, createSyncFolderNow, createSyncSelectedFolder, createQuietPollSelectedAndInbox, createSyncAllFolders } from "./client/synchronization";
import { createMarkMessagesReadLocally, createHandleMarkSelectedRead, createHandleMarkFolderRead, createHandleMarkSingleRead } from "./client/readActions";
import { createAddDraftAttachmentPaths, createInsertInlineImageFromPath, createInsertInlineImageFromFile, createHandlePasteImages, createHandleDropComposeFiles } from "./client/composerAttachments";
import { MailToolbar } from "./client/MailToolbar";
import { MailFoldersPane } from "./client/MailFoldersPane";
import { MailMessagesPane } from "./client/MailMessagesPane";
import { MailReaderPane } from "./client/MailReaderPane";
import { MailComposer } from "./client/MailComposer";
import { createDraftActions } from "./client/draftActions";
import { useMailOutbox } from "./client/useMailOutbox";
import { createMailMutations } from "./client/mutations";







export function MailClientTab({ tabId, info, visible, onEditSession }: MailClientTabProps) {
  const rowActionsRef = useRef<MailRowActions | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [messages, setMessagesState] = useState<MailMessageHeader[]>([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
  const [mailViewKey, setMailViewKey] = useState("mailbox");
  const [messageTabs, setMessageTabs] = useState<OpenMailMessageTab[]>([]);
  const [popupMessageKey, setPopupMessageKey] = useState<string | null>(null);
  const [checkedMessageKeys, setCheckedMessageKeys] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [body, setBody] = useState<MailMessageBody | null>(null);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"folder" | "all">("folder");
  const [searchField, setSearchField] = useState<MailSearchField>("all");
  const [quickFilters, setQuickFilters] = useState<{ unread: boolean; flagged: boolean; attachments: boolean }>({
    unread: false,
    flagged: false,
    attachments: false,
  });
  const [tagFilter, setTagFilter] = useState<string>("");
  const [searchResults, setSearchResults] = useState<MailMessageHeader[] | null>(null);
  const [serverSearching, setServerSearching] = useState(false);
  const searchSeqRef = useRef(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bodyCache, setBodyCache] = useState<Map<string, MailMessageBody>>(() => new Map());
  const [bodyLoadingKey, setBodyLoadingKey] = useState<string | null>(null);
  const [bodyWarming, setBodyWarming] = useState<BodyWarmState>({ active: false, done: 0, total: 0 });
  const [threadView, setThreadView] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MAIL_THREAD_VIEW_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());
  const [syncProgress, setSyncProgress] = useState<{ folder: string; fetched: number; remaining: number } | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<{ folder: string; cached: number; total: number } | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [sentCopyNotice, setSentCopyNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftsTab, setDraftsTab] = useState<"drafts" | "templates" | "outbox">("drafts");
  const visibleDrafts = useMemo(
    () => drafts.filter((saved) => {
      if (draftsTab === "outbox") return isOutbox(saved);
      if (isOutbox(saved)) return false;
      return isTemplate(saved) === (draftsTab === "templates");
    }),
    [drafts, draftsTab],
  );
  const outboxCount = useMemo(() => drafts.filter(isOutbox).length, [drafts]);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [composePrompt, setComposePrompt] = useState<ComposePromptState | null>(null);
  const [sendLaterAt, setSendLaterAt] = useState("");
  const [undoSend, setUndoSend] = useState<{ draftId: string; until: number } | null>(null);
  const [undoNow, setUndoNow] = useState(() => Date.now());
  const undoTimerRef = useRef<number | null>(null);
  const outboxBusyIdsRef = useRef(new Set<string>());
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState<RecipientSearchState>({
    field: null,
    query: "",
    suggestions: [],
    loading: false,
  });
  const [sending, setSending] = useState(false);
  const [downloadingAttachmentIndex, setDownloadingAttachmentIndex] = useState<number | null>(null);
  /** Thunderbird-style: allow remote content for specific messages, or the whole tab session. */
  const [allowRemoteAllInTab, setAllowRemoteAllInTab] = useState(false);
  const [remoteAllowedMessageKeys, setRemoteAllowedMessageKeys] = useState<Set<string>>(() => new Set());
  const [composeDragActive, setComposeDragActive] = useState(false);
  const [attachProgress, setAttachProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const composeRootRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const pendingCacheRefreshRef = useRef(false);
  const initialSyncDoneRef = useRef(false);
  /** Bumped by user-driven syncs; stale catch-up loops stop at their next step. */
  const syncGenerationRef = useRef(0);
  const backfillSeqRef = useRef(0);
  const contactIndexAccountRef = useRef<string | null>(null);
  const contactSearchSeqRef = useRef(0);
  const bodyCacheRef = useRef<Map<string, MailMessageBody>>(new Map());
  const bodyRequestsRef = useRef<Map<string, Promise<MailMessageBody>>>(new Map());
  const bodyLoadSeqRef = useRef(0);
  const bodyWarmSeqRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const manualSyncPendingRef = useRef(false);
  const pendingCatchupsRef = useRef({ folders: new Map<string, { mode: MailSyncRequestMode; reconcile: MailSyncRequestMode }>(), running: false, disposed: false });
  useEffect(() => {
    const queue = { folders: new Map<string, { mode: MailSyncRequestMode; reconcile: MailSyncRequestMode }>(), running: false, disposed: false };
    pendingCatchupsRef.current = queue;
    return () => {
      queue.disposed = true;
      queue.folders.clear();
      // The queue owns only its worker. Cancelling all folder loops here also
      // cancels on-open catch-up during StrictMode's setup/cleanup replay.
      manualSyncPendingRef.current = false;
    };
  }, [info.sessionId]);
  const folderSelectSeqRef = useRef(0);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastSavedDraftJsonRef = useRef("");
  const foldersRef = useRef<MailFolder[]>([]);
  /** Tracks the live selected folder across awaits (folder switches ignore syncInFlight). */
  const selectedFolderRef = useRef(selectedFolder);
  const messagesRef = useRef<MailMessageHeader[]>([]);
  const cacheRemovalVersionsRef = useRef(new Map<string, number>());
  // Sync batches and cache reloads can finish before React commits the prior
  // render. Publish one current list for both async work and rendering; a
  // delayed effect must never overwrite a newer cache reload with old rows.
  const setMessages = useCallback((next: SetStateAction<MailMessageHeader[]>) => {
    const value = typeof next === "function" ? next(messagesRef.current) : next;
    messagesRef.current = value;
    setMessagesState(value);
  }, []);
  const foldersPanelRef = useRef<PanelImperativeHandle>(null);
  const [mailboxCollapsed, setMailboxCollapsed] = useState(false);
  const [mailboxPaneSize, setMailboxPaneSize] = useState(MAILBOX_EXPANDED_SIZE);
  const profileFontSize = clampMailFontSize(info.terminalProfile?.fontSize ?? DEFAULT_MAIL_TERMINAL_PROFILE.fontSize);
  const [mailFontSize, setMailFontSize] = useState(profileFontSize);
  const attachmentMenu = useContextMenu();
  const mailMenu = useContextMenu();
  const confirmDialog = useConfirmDialog();
  const textInputDialog = useTextInputDialog();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sourceView, setSourceView] = useState<{ subject: string; content: string } | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const mutationSessionRef = useRef(new MailMutationSession());
  const retryMailActionRef = useRef<(() => Promise<void>) | null>(null);
  const [mutationFailure, setMutationFailure] = useState<{ message: string; retryable: boolean; detail: string | null } | null>(null);
  const [mutationProgress, setMutationProgress] = useState<string | null>(null);
  const { resolvedTheme } = useAppTheme();
  const appPrefersDark = resolvedTheme === "dark";

  const openTabChat = useChatStore((s) => s.openTabChat);
  const sendMessageToAi = useChatStore((s) => s.sendMessage);
  const pushMailNew = useTaoAlertStore((s) => s.pushMailNew);

  const displayFolders = folders.length > 0 ? folders : [{ ...DEFAULT_FOLDER, accountId: info.sessionId }];
  // TASK-10: "show only subscribed folders" (per account, this browser).
  const [subscribedOnly, setSubscribedOnlyState] = useState(
    () => loadSubscribedOnly(info.sessionId, info.sync.subscribedOnly ?? false),
  );
  const subscribedOnlyRef = useRef(subscribedOnly);
  subscribedOnlyRef.current = subscribedOnly;
  const treeFolders = useMemo(() => visibleFolders(displayFolders, subscribedOnly), [displayFolders, subscribedOnly]);
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
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
  /** CalDAV agenda (DEC-14): dialog, cache revision and reminder bookkeeping. */
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaRevision, setAgendaRevision] = useState(0);
  const agendaEventsRef = useRef<MailAgendaEvent[]>([]);
  const remindedRef = useRef<Set<string>>(new Set());
  /** Read receipt answered for these messages in this session (TASK-17). */
  const [receiptBusy, setReceiptBusy] = useState(false);
  const autoReceiptRef = useRef<Set<string>>(new Set());
  /** Calendar invitation of the open message (TASK-20), keyed by message. */
  const [inviteView, setInviteView] = useState<{
    key: string;
    invite: MailInvite | null;
    loading: boolean;
    responding?: MailInviteReply;
    responded?: string;
    error?: string;
    /** CalDAV write of the invitation (TASK-20 phase 2). */
    calendar?: "adding" | "added";
    calendarError?: string;
  } | null>(null);
  const [certReview, setCertReview] = useState<{
    protocol: "imap" | "smtp";
    loading: boolean;
    info?: MailCertificateInfo;
    error?: string;
  } | null>(null);
  const retryAfterTrustRef = useRef(false);
  const [subscriptionBusy, setSubscriptionBusy] = useState<string | null>(null);
  const oauthReauthRequired = isOAuthReauthRequired(error);
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const batchSize = useMemo(() => refreshBatchSize(info), [info.sync.maxFetchPerSync]);
  const catchupBatchSize = useMemo(() => catchupStepSize(info), [info.sync.maxFetchPerSync]);
  const identities = useMemo(() => mailIdentities(info), [info]);
  const identityById = useCallback(
    (id: string | null | undefined) => identities.find((identity) => identity.id === id) ?? identities[0],
    [identities],
  );
  const defaultMailDomain = useMemo(
    () => extractDefaultMailDomain([info.emailAddress, info.imap.username, info.smtp.username]),
    [info.emailAddress, info.imap.username, info.smtp.username],
  );
  const mailAppearance = useMemo(
    () => mailAppearanceStyle(info.terminalProfile, mailFontSize, appPrefersDark),
    [info.terminalProfile, mailFontSize, appPrefersDark],
  );
  const preferDarkReader = useMemo(() => {
    const scheme = String((mailAppearance as Record<string, string | number | undefined>)["--taomni-color-scheme"] ?? "");
    return scheme === "dark";
  }, [mailAppearance]);

  const messageAllowsRemote = useCallback((key: string | null | undefined) => {
    if (allowRemoteAllInTab) return true;
    if (!key) return false;
    return remoteAllowedMessageKeys.has(key);
  }, [allowRemoteAllInTab, remoteAllowedMessageKeys]);

  const allowRemoteForMessage = useCallback((key: string) => {
    setRemoteAllowedMessageKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const blockRemoteForMessage = useCallback((key: string) => {
    setAllowRemoteAllInTab(false);
    setRemoteAllowedMessageKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleRemoteForMessage = useCallback((key: string) => {
    if (messageAllowsRemote(key)) blockRemoteForMessage(key);
    else allowRemoteForMessage(key);
  }, [allowRemoteForMessage, blockRemoteForMessage, messageAllowsRemote]);
  // Search can return headers outside the loaded folder/page. They still need
  // to participate in selection, reading and bulk actions.
  const availableMessages = useMemo(
    () => query.trim() && searchResults ? dedupeMessages([...searchResults, ...messages]) : messages,
    [messages, query, searchResults],
  );
  const selectedMessage = useMemo(
    () =>
      availableMessages.find((message) => messageKey(message) === selectedMessageKey)
      ?? messageTabs.find((tab) => tab.key === selectedMessageKey)?.message
      ?? null,
    [availableMessages, messageTabs, selectedMessageKey],
  );
  const activeMessageTab = useMemo(
    () => messageTabs.find((tab) => tab.key === mailViewKey) ?? null,
    [mailViewKey, messageTabs],
  );
  const popupMessage = useMemo(
    () =>
      popupMessageKey
        ? availableMessages.find((message) => messageKey(message) === popupMessageKey)
          ?? messageTabs.find((tab) => tab.key === popupMessageKey)?.message
          ?? null
        : null,
    [availableMessages, messageTabs, popupMessageKey],
  );
  const checkedMessages = useMemo(
    () => availableMessages.filter((message) => checkedMessageKeys.has(messageKey(message))),
    [availableMessages, checkedMessageKeys],
  );
  const checkedUnreadCount = useMemo(
    () => checkedMessages.filter(isUnread).length,
    [checkedMessages],
  );
  const visibleUnreadCount = useMemo(
    () => messages.filter(isUnread).length,
    [messages],
  );

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  /** Keep selectedFolderRef in sync immediately (folder switches can race quiet poll awaits). */
  const updateSelectedFolder = useCallback((next: string | ((prev: string) => string)) => {
    const value = typeof next === "function" ? next(selectedFolderRef.current) : next;
    selectedFolderRef.current = value;
    setSelectedFolder(value);
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) return;
    bodyWarmSeqRef.current += 1;
    bodyLoadSeqRef.current += 1;
    setSyncing(false);
    setLoadingFolders(false);
    setLoadingMessages(false);
    setLoadingMoreMessages(false);
    setBodyLoadingKey(null);
    setBodyWarming((current) => (
      current.active
        ? { active: false, done: current.done, total: current.total, folder: current.folder }
        : current
    ));
  }, [visible]);

  const quickFilterActive = quickFilters.unread || quickFilters.flagged || quickFilters.attachments || Boolean(tagFilter);
  const searchActive = query.trim().length > 0;

  // Local full-text search over the whole cached index (not just loaded rows).
  useEffect(() => {
    const text = query.trim();
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    if (!text || !info.cache.enabled) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void mailSearchMessages(info.sessionId, {
        text,
        folder: searchScope === "folder" ? selectedFolder : null,
        field: searchField,
        unreadOnly: quickFilters.unread,
        flaggedOnly: quickFilters.flagged,
        withAttachments: quickFilters.attachments,
        keyword: tagFilter || null,
        limit: 1000,
      })
        .then((results) => {
          if (searchSeqRef.current === seq) setSearchResults(results);
        })
        .catch((e) => {
          if (searchSeqRef.current === seq) {
            setSearchResults(null);
            console.debug("mail local search failed", e);
          }
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [info.cache.enabled, info.sessionId, query, quickFilters, searchField, searchScope, selectedFolder, tagFilter]);

  const runServerSearch = useCallback(async () => {
    const text = query.trim();
    if (!text) return;
    const folder = selectedFolderRef.current;
    const seq = searchSeqRef.current;
    setServerSearching(true);
    setError(null);
    try {
      const results = await mailSearchServer(info, folder, {
        text,
        field: searchField,
        unreadOnly: quickFilters.unread,
        flaggedOnly: quickFilters.flagged,
        limit: 200,
      });
      if (searchSeqRef.current !== seq) return;
      setSearchResults((current) => {
        const byKey = new Map<string, MailMessageHeader>();
        for (const message of current ?? []) byKey.set(messageKey(message), message);
        for (const message of results) byKey.set(messageKey(message), message);
        return sortMessages(Array.from(byKey.values()));
      });
      setStatus(`Server search found ${results.length} message${results.length === 1 ? "" : "s"} in ${folder}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setServerSearching(false);
    }
  }, [info, query, quickFilters.flagged, quickFilters.unread, searchField]);

  const filteredMessages = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: MailMessageHeader[];
    if (q && searchResults) {
      base = searchResults;
    } else if (q) {
      // Cache disabled (or index not ready): filter the loaded rows.
      base = messages.filter((message) => {
        const haystack = [
          message.subject,
          addressLabel(message.from),
          message.snippet ?? "",
          ...message.to.map(addressLabel),
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    } else {
      base = messages;
    }
    if (!quickFilterActive) return base;
    return base.filter((message) =>
      (!quickFilters.unread || isUnread(message))
      && (!quickFilters.flagged || isFlagged(message))
      && (!quickFilters.attachments || message.hasAttachments)
      && (!tagFilter || message.flags.some((flag) => flag.toLowerCase() === tagFilter.toLowerCase())));
  }, [messages, query, quickFilterActive, quickFilters, searchResults, tagFilter]);
  const listRows = useMemo<MailThreadRow[]>(() => {
    if (threadView) return flattenMailThreads(buildMailThreads(filteredMessages), expandedThreads);
    return filteredMessages.map((message) => ({
      message,
      threadKey: messageKey(message),
      depth: 0,
      isRoot: true,
      threadSize: 1,
      threadUnread: isUnread(message) ? 1 : 0,
      expanded: false,
    }));
  }, [expandedThreads, filteredMessages, threadView]);
  const toggleThreadExpanded = useCallback((key: string) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const allFilteredMessagesChecked = listRows.length > 0
    && listRows.every(({ message }) => checkedMessageKeys.has(messageKey(message)));
  const selectedBody = useMemo(() => {
    if (!selectedMessage) return null;
    const cached = bodyCache.get(messageKey(selectedMessage));
    if (cached && bodyMatchesMessage(cached, selectedMessage)) return cached;
    return bodyMatchesMessage(body, selectedMessage) ? body : null;
  }, [body, bodyCache, selectedMessage]);

  const selectedHasRemoteImages = useMemo(
    () => mailHtmlHasRemoteImages(selectedBody?.html),
    [selectedBody?.html],
  );
  const selectedMessageRemoteKey = selectedMessage ? messageKey(selectedMessage) : null;
  const selectedAllowsRemote = messageAllowsRemote(selectedMessageRemoteKey);

  const visibleAttachments = useMemo(
    () => (selectedBody?.attachments.length ? selectedBody.attachments : selectedMessage?.attachments ?? []),
    [selectedBody?.attachments, selectedMessage?.attachments],
  );
  // AC-62: parse the invitation once the body shows a calendar part.
  const inviteInfoRef = useRef(info);
  inviteInfoRef.current = info;
  const selectedInviteKey = selectedMessage && hasCalendarPart(visibleAttachments)
    ? messageKey(selectedMessage)
    : null;
  useEffect(() => {
    if (!selectedInviteKey || !selectedMessage) {
      setInviteView(null);
      return;
    }
    let cancelled = false;
    const { folder, uid } = selectedMessage;
    setInviteView({ key: selectedInviteKey, invite: null, loading: true });
    mailGetInvite(inviteInfoRef.current, folder, uid)
      .then((invite) => {
        if (!cancelled) setInviteView({ key: selectedInviteKey, invite, loading: false });
      })
      .catch((e) => {
        if (!cancelled) {
          setInviteView({ key: selectedInviteKey, invite: null, loading: false, error: mailClientErrorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
    // selectedMessage is identified by selectedInviteKey.
  }, [selectedInviteKey]);

  // TASK-17: "always" answers a read receipt request when the message is shown.
  const selectedReceiptKey = selectedMessage?.receiptTo ? messageKey(selectedMessage) : null;
  useEffect(() => {
    if (!selectedReceiptKey || !selectedMessage || (info.receiptPolicy ?? "ask") !== "always") return;
    if (autoReceiptRef.current.has(selectedReceiptKey) || !receiptRequest(selectedMessage)) return;
    autoReceiptRef.current.add(selectedReceiptKey);
    void answerReceipt(selectedMessage, true, true);
    // selectedMessage is identified by selectedReceiptKey.
  }, [selectedReceiptKey, info.receiptPolicy]);

  // DEC-14: reminders for CalDAV events while this tab is open (DEC-01).
  const caldavUrl = info.caldav?.url ?? "";
  const onAgendaChanged = useCallback((events: MailAgendaEvent[]) => {
    agendaEventsRef.current = events;
  }, []);
  useEffect(() => {
    if (!caldavUrl) return;
    let cancelled = false;
    const refresh = async (sync: boolean) => {
      try {
        if (sync) await mailCalDavSync(inviteInfoRef.current);
        const events = await mailListAgenda(inviteInfoRef.current.sessionId, 2);
        if (!cancelled) agendaEventsRef.current = events;
      } catch (e) {
        console.debug("mail agenda refresh failed", e);
      }
    };
    void refresh(false);
    const firstSync = window.setTimeout(() => void refresh(true), 5_000);
    const syncTimer = window.setInterval(() => void refresh(true), 15 * 60_000);
    const reminderTimer = window.setInterval(() => {
      for (const event of dueReminders(agendaEventsRef.current, Date.now(), remindedRef.current)) {
        remindedRef.current.add(agendaKey(event));
        const when = agendaTimeLabel(event);
        setStatus(`Reminder: ${event.summary || "event"} at ${when}`);
        void notifyDesktop(
          `Reminder: ${event.summary || "Event"}`,
          event.location ? `${when} · ${event.location}` : when,
        );
      }
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstSync);
      window.clearInterval(syncTimer);
      window.clearInterval(reminderTimer);
    };
  }, [caldavUrl]);
  useEffect(() => {
    if (!caldavUrl || agendaRevision === 0) return;
    void mailListAgenda(inviteInfoRef.current.sessionId, 2)
      .then((events) => {
        agendaEventsRef.current = events;
      })
      .catch(() => undefined);
  }, [agendaRevision, caldavUrl]);
  const activeRecipientSuggestions = useMemo<RecipientSuggestion[]>(() => {
    const { field, query: recipientQuery, suggestions } = recipientSearch;
    if (!field || !recipientQuery.trim()) return [];
    const selected = draft[field];
    const remote = suggestions.map((suggestion) => ({ ...suggestion }));
    const local = searchCachedMessageContacts(messages, recipientQuery, selected, 8);
    return mergeRecipientSuggestions(remote, local, selected, 8);
  }, [draft, messages, recipientSearch]);

  const recipientSuggestionsFor = useCallback((field: RecipientFieldKey): RecipientSuggestion[] => {
    return recipientSearch.field === field ? activeRecipientSuggestions : [];
  }, [activeRecipientSuggestions, recipientSearch.field]);

  const handleRecipientQueryChange = useCallback((field: RecipientFieldKey, nextQuery: string) => {
    setRecipientSearch((current) => {
      if (current.field === field && current.query === nextQuery) return current;
      return {
        field,
        query: nextQuery,
        suggestions: [],
        loading: !!nextQuery.trim(),
      };
    });
  }, []);

  const increaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size + 1));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size - 1));
  }, []);

  const resetFontSize = useCallback(() => {
    setMailFontSize(profileFontSize);
  }, [profileFontSize]);

  useEffect(() => {
    setMailFontSize(profileFontSize);
  }, [info.sessionId, profileFontSize]);

  useEffect(() => {
    if (!composeOpen || contactIndexAccountRef.current === info.sessionId) return;
    contactIndexAccountRef.current = info.sessionId;
    mailIndexCachedContacts(info.sessionId).catch(() => undefined);
  }, [composeOpen, info.sessionId]);

  useEffect(() => {
    const field = recipientSearch.field;
    const recipientQuery = recipientSearch.query.trim();
    if (!composeOpen || !field || !recipientQuery) {
      setRecipientSearch((current) => (
        current.loading || current.suggestions.length > 0
          ? { ...current, suggestions: [], loading: false }
          : current
      ));
      return;
    }

    const seq = contactSearchSeqRef.current + 1;
    contactSearchSeqRef.current = seq;
    const timer = window.setTimeout(() => {
      mailSearchContacts(info.sessionId, recipientQuery, 8)
        .then((suggestions) => {
          if (contactSearchSeqRef.current !== seq) return;
          setRecipientSearch((current) => (
            current.field === field && current.query.trim() === recipientQuery
              ? { ...current, suggestions, loading: false }
              : current
          ));
        })
        .catch(() => {
          if (contactSearchSeqRef.current !== seq) return;
          setRecipientSearch((current) => (
            current.field === field && current.query.trim() === recipientQuery
              ? { ...current, suggestions: [], loading: false }
              : current
          ));
        });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [composeOpen, info.sessionId, recipientSearch.field, recipientSearch.query]);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        increaseFontSize();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        decreaseFontSize();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetFontSize();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [decreaseFontSize, increaseFontSize, resetFontSize, visible]);

  // Thunderbird-style list shortcuts (TASK-22); never inside inputs/editors.
  const shortcutRef = useRef<(action: MailShortcutAction) => boolean>(() => false);
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const action = mailShortcutAction(event);
      if (!action) return;
      const root = rootRef.current;
      const target = event.target as Node | null;
      const inTab = !target || target === document.body || Boolean(root?.contains(target));
      if (!inTab || isEditableTarget(event.target)) return;
      if (shortcutRef.current(action)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const root = rootRef.current;
    if (!root) return;

    const handleWheel = (event: WheelEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    root.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, visible]);

  const expandMailboxPanel = useCallback(() => {
    foldersPanelRef.current?.resize(`${MAILBOX_EXPANDED_SIZE}%`);
    setMailboxPaneSize(MAILBOX_EXPANDED_SIZE);
    setMailboxCollapsed(false);
  }, []);

  const handleMailboxResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    setMailboxPaneSize(percentage);
    setMailboxCollapsed(percentage === 0);
  }, []);

  useEffect(() => {
    if (mailboxPaneSize > 0 && mailboxPaneSize <= MAILBOX_RIBBON_THRESHOLD) {
      setMailboxCollapsed(true);
      window.requestAnimationFrame(() => foldersPanelRef.current?.resize("0%"));
    }
  }, [mailboxPaneSize]);

  const loadCachedFolders = useCallback(createLoadCachedFolders({
    visibleRef,
    pendingCacheRefreshRef,
    setLoadingFolders,
    setError,
    info,
    foldersRef,
    setFolders,
    updateSelectedFolder,
  }), [info.sessionId, updateSelectedFolder]);

  const loadCachedMessages = useCallback(createLoadCachedMessages({
    visibleRef,
    pendingCacheRefreshRef,
    setLoadingMoreMessages,
    setLoadingMessages,
    setHasMoreMessages,
    setError,
    pageSize,
    cacheRemovalVersionsRef,
    info,
    selectedFolderRef,
    foldersRef,
    messagesRef,
    setMessages,
    setStatus,
  }), [info.sessionId, pageSize]);

  const rememberBody = useCallback(createRememberBody({
    bodyCacheRef,
    visibleRef,
    pendingCacheRefreshRef,
    setBodyCache,
    setBody,
    setMessages,
    setSearchResults,
    setMessageTabs,
  }), []);

  const fetchBodyForMessage = useCallback(createFetchBodyForMessage({
    bodyCacheRef,
    rememberBody,
    bodyRequestsRef,
    info,
  }), [info, rememberBody]);

  const warmRecentBodies = useCallback(createWarmRecentBodies({
    info,
    setBodyWarming,
    visibleRef,
    pendingCacheRefreshRef,
    bodyWarmSeqRef,
    bodyCacheRef,
  }), [info]);

  const isNewMailExcludedFolder = useCallback((folder: MailFolder) =>
    NEW_MAIL_EXCLUDED_KINDS.some((kind) => folderMatchesSpecial(folder, kind, info.specialFolders))
    || /draft|草稿/i.test(`${folder.name} ${folderLabel(folder)}`), [info.specialFolders]);

  const isNewMailExcludedName = useCallback((name: string) => {
    const folder = foldersRef.current.find((entry) => entry.name === name);
    return folder ? isNewMailExcludedFolder(folder) : false;
  }, [isNewMailExcludedFolder]);

  const notifyNewMail = useCallback((count: number) => {
    if (count <= 0) return;
    const title = info.displayName?.trim() || info.emailAddress || info.sessionId;
    pushMailNew(tabId, info.sessionId, title, count);
    // Only while the tab is open (DEC-01); opt-in per account.
    if (info.sync.desktopNotify) {
      void notifyDesktop(title, count === 1 ? "1 new message" : `${count} new messages`);
    }
  }, [info.displayName, info.emailAddress, info.sessionId, info.sync.desktopNotify, pushMailNew, tabId]);

  const applySyncedFolder = useCallback((folder: MailFolder) => {
    const next = mergeFolderMeta(foldersRef.current, folder);
    foldersRef.current = next;
    if (visibleRef.current) setFolders(next);
  }, []);

  /** Remote LIST on open so a new account shows every folder at once. */
  const refreshFolderTree = useCallback(async () => {
    try {
      const listed = await mailListFolders(info);
      if (listed.length === 0) return;
      // Keep counts/watermarks a concurrent sync may have just updated.
      const byName = new Map(foldersRef.current.map((entry) => [entry.name, entry]));
      const next = listed.map((entry) => {
        const known = byName.get(entry.name);
        return known ? { ...entry, ...known, flags: entry.flags } : entry;
      });
      foldersRef.current = next;
      if (visibleRef.current) setFolders(next);
    } catch (e) {
      console.debug("mail folder LIST failed", e);
    }
  }, [info]);

  const setSubscribedOnly = useCallback((value: boolean) => {
    setSubscribedOnlyState(value);
    saveSubscribedOnly(info.sessionId, value);
  }, [info.sessionId]);

  const toggleSubscription = useCallback(async (folder: MailFolder, subscribed: boolean) => {
    setSubscriptionBusy(folder.name);
    setError(null);
    try {
      const listed = await mailSetFolderSubscription(info, folder.name, subscribed);
      // Only the attributes change; keep cached counts and watermarks.
      const merged = foldersRef.current.map((entry) => {
        const remote = listed.find((candidate) => candidate.name === entry.name);
        return remote ? { ...entry, flags: remote.flags } : entry;
      });
      foldersRef.current = merged;
      setFolders(merged);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setSubscriptionBusy(null);
    }
  }, [info]);

  /** Reload the visible list from the cache, keeping the loaded depth. */
  const reloadVisibleFromCache = useCallback(async (folder: string) => {
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return;
    }
    if (selectedFolderRef.current !== folder) return;
    const loaded = messagesRef.current.filter((message) => message.folder === folder).length;
    await loadCachedMessages(folder, 0, false, true, Math.max(pageSize, loaded));
  }, [loadCachedMessages, pageSize]);

  /**
   * Run gap-free sync steps for one folder until the backend reports no more
   * work (bounded by maxSteps). New headers appear as each step lands; the
   * visible list is then reloaded from the cache so deletions and flag
   * changes from other clients show up too.
   */
  const runFolderSync = useCallback(createRunFolderSync({
    syncGenerationRef,
    info,
    catchupBatchSize,
    applySyncedFolder,
    visibleRef,
    pendingCacheRefreshRef,
    selectedFolderRef,
    messagesRef,
    pageSize,
    setMessages,
    setStatus,
    setSyncProgress,
    reloadVisibleFromCache,
    incomingFiltersRef,
  }), [applySyncedFolder, catchupBatchSize, info, pageSize, reloadVisibleFromCache]);

  // A manual scan must not wait for up to 120 additional history batches.
  // Drain every pending folder fairly in the background, releasing the guard
  // between steps so another Sync/folder switch can get its turn.
  const queueFolderCatchups = useCallback(createQueueFolderCatchups({
    pendingCatchupsRef,
    syncInFlightRef,
    manualSyncPendingRef,
    runFolderSync,
    isNewMailExcludedName,
    notifyNewMail,
    visibleRef,
    setError,
    loadCachedFolders,
  }), [isNewMailExcludedName, loadCachedFolders, notifyNewMail, runFolderSync]);

  /**
   * Fetch older history for the selected folder in the background (full
   * header index). Yields to user-triggered syncs and stops on folder switch,
   * tab hide or unmount; the next open resumes from the stored watermark.
   */
  const startBackfill = useCallback(createStartBackfill({
    foldersRef,
    info,
    backfillSeqRef,
    visibleRef,
    selectedFolderRef,
    syncInFlightRef,
    manualSyncPendingRef,
    catchupBatchSize,
    applySyncedFolder,
    setBackfillProgress,
    setHasMoreMessages,
    messagesRef,
  }), [applySyncedFolder, catchupBatchSize, info]);

  /**
   * Open / folder-select sync: catch the folder (and INBOX) up completely,
   * however long the tab was closed.
   */
  const syncFolderNow = useCallback(createSyncFolderNow({
    syncInFlightRef,
    visibleRef,
    setStatus,
    syncGenerationRef,
    setSyncing,
    setError,
    runFolderSync,
    isNewMailExcludedName,
    manualSyncPendingRef,
    notifyNewMail,
    loadCachedFolders,
  }), [isNewMailExcludedName, loadCachedFolders, notifyNewMail, runFolderSync]);

  const syncSelectedFolder = useCallback(createSyncSelectedFolder({
    folderSelectSeqRef,
    visibleRef,
    selectedFolderRef,
    syncInFlightRef,
    manualSyncPendingRef,
    syncFolderNow,
    startBackfill,
  }), [startBackfill, syncFolderNow]);

  useEffect(() => () => { folderSelectSeqRef.current += 1; }, [info.sessionId]);

  /** Quiet background poll: catch up the selected folder and INBOX, reconcile flags. */
  const quietPollSelectedAndInbox = useCallback(createQuietPollSelectedAndInbox({
    syncInFlightRef,
    manualSyncPendingRef,
    selectedFolderRef,
    runFolderSync,
    isNewMailExcludedName,
    info,
    notifyNewMail,
  }), [info.cache.enabled, isNewMailExcludedName, notifyNewMail, runFolderSync]);

  const syncAllFolders = useCallback(createSyncAllFolders({
    batchSize,
    selectedFolderRef,
    manualSyncPendingRef,
    syncGenerationRef,
    syncInFlightRef,
    setSyncing,
    visibleRef,
    setStatus,
    setError,
    info,
    subscribedOnlyRef,
    foldersRef,
    isNewMailExcludedFolder,
    queueFolderCatchups,
    notifyNewMail,
    incomingFiltersRef,
    pendingCacheRefreshRef,
    setFolders,
    updateSelectedFolder,
    messagesRef,
    loadCachedMessages,
    pageSize,
    warmRecentBodies,
    startBackfill,
  }), [
    batchSize,
    info,
    isNewMailExcludedFolder,
    loadCachedMessages,
    notifyNewMail,
    pageSize,
    queueFolderCatchups,
    startBackfill,
    updateSelectedFolder,
    warmRecentBodies,
  ]);

  const loadBody = useCallback(createLoadBody({
    bodyCacheRef,
    rememberBody,
    bodyLoadSeqRef,
    setBodyLoadingKey,
    setError,
    fetchBodyForMessage,
    setStatus,
  }), [fetchBodyForMessage, rememberBody]);

  const markMessagesReadLocally = useCallback(createMarkMessagesReadLocally({
    setMessages,
    setSearchResults,
    setMessageTabs,
    setFolders,
  }), []);

  const handleMarkSelectedRead = useCallback(createHandleMarkSelectedRead({
    checkedMessages,
    setStatus,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
    setCheckedMessageKeys,
  }), [checkedMessages, info, markMessagesReadLocally]);

  const handleMarkFolderRead = useCallback(createHandleMarkFolderRead({
    selectedFolder,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
    loadCachedFolders,
    selectedFolderRef,
    loadCachedMessages,
    messagesRef,
    setStatus,
  }), [info, loadCachedFolders, loadCachedMessages, markMessagesReadLocally, selectedFolder]);

  const toggleMessageChecked = useCallback((message: MailMessageHeader, checked: boolean, range = false) => {
    const key = messageKey(message);
    const anchor = listRows.findIndex((row) => messageKey(row.message) === selectionAnchorRef.current);
    const index = listRows.findIndex((row) => messageKey(row.message) === key);
    const keys = range && anchor >= 0 && index >= 0
      ? listRows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((row) => messageKey(row.message))
      : [key];
    if (!range || anchor < 0) selectionAnchorRef.current = key;
    setCheckedMessageKeys((current) => {
      const next = new Set(current);
      for (const target of keys) {
        if (checked) next.add(target);
        else next.delete(target);
      }
      return next;
    });
  }, [listRows]);

  const toggleFilteredMessagesChecked = useCallback((checked: boolean) => {
    setCheckedMessageKeys((current) => {
      const next = new Set(current);
      for (const { message } of listRows) {
        const key = messageKey(message);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, [listRows]);

  const selectMessage = useCallback((message: MailMessageHeader, viewKey = "mailbox") => {
    const key = messageKey(message);
    updateSelectedFolder(message.folder);
    setSelectedMessageKey(key);
    setMailViewKey(viewKey);
    const cached = bodyCacheRef.current.get(key);
    setBody((current) => (
      cached && bodyMatchesMessage(cached, message)
        ? cached
        : bodyMatchesMessage(current, message) ? current : null
    ));
  }, [updateSelectedFolder]);

  const selectListMessage = useCallback((message: MailMessageHeader) => {
    const key = messageKey(message);
    selectionAnchorRef.current = key;
    setCheckedMessageKeys(new Set([key]));
    selectMessage(message, "mailbox");
  }, [selectMessage]);

  const openMessageTab = useCallback((message: MailMessageHeader) => {
    const key = messageKey(message);
    setMessageTabs((current) => {
      if (current.some((tab) => tab.key === key)) return current;
      return [...current, { key, message }];
    });
    selectMessage(message, key);
  }, [selectMessage]);

  const closeMessageTab = useCallback((key: string) => {
    setMessageTabs((current) => current.filter((tab) => tab.key !== key));
    if (mailViewKey === key) {
      setMailViewKey("mailbox");
      setBody(null);
    }
    if (popupMessageKey === key) {
      setPopupMessageKey(null);
    }
  }, [mailViewKey, popupMessageKey]);

  const openMessagePopup = useCallback((message: MailMessageHeader) => {
    selectMessage(message, mailViewKey === "mailbox" ? "mailbox" : messageKey(message));
    setPopupMessageKey(messageKey(message));
  }, [mailViewKey, selectMessage]);

  const handleMarkSingleRead = useCallback(createHandleMarkSingleRead({
    setStatus,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
  }), [info, markMessagesReadLocally]);

  const loadInitialMessages = useCallback(async (folder: string) => {
    await loadCachedMessages(folder);
  }, [loadCachedMessages]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
    foldersRef.current = [];
    bodyWarmSeqRef.current += 1;
    bodyLoadSeqRef.current += 1;
    bodyCacheRef.current = new Map();
    bodyRequestsRef.current.clear();
    setFolders([]);
    setMessages([]);
    setSelectedMessageKey(null);
    setMailViewKey("mailbox");
    setMessageTabs([]);
    setPopupMessageKey(null);
    setCheckedMessageKeys(new Set());
    setBody(null);
    setBodyCache(new Map());
    setBodyLoadingKey(null);
    setBodyWarming({ active: false, done: 0, total: 0 });
    setHasMoreMessages(false);
    setLoadingMoreMessages(false);
    setDownloadingAttachmentIndex(null);
    updateSelectedFolder("INBOX");
    void loadCachedFolders();
  }, [info.sessionId, loadCachedFolders, updateSelectedFolder]);

  useEffect(() => {
    void loadInitialMessages(selectedFolder);
  }, [loadInitialMessages, selectedFolder]);

  useEffect(() => {
    if (!visible || !pendingCacheRefreshRef.current) return;
    pendingCacheRefreshRef.current = false;
    if (bodyCacheRef.current.size > 0) {
      setBodyCache(new Map(bodyCacheRef.current));
    }
    void loadCachedFolders();
    void loadCachedMessages(selectedFolder, 0, false, true);
  }, [loadCachedFolders, loadCachedMessages, selectedFolder, visible]);

  useEffect(() => {
    if (!visible || !info.sync.onOpen || initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    const folder = selectedFolder;
    // Catch up everything that arrived while the tab was closed, then keep
    // backfilling older history for the full local header index.
    void syncFolderNow(folder, "sync", true)
      .then(() => refreshFolderTree())
      .then(() => startBackfill(folder));
  }, [info.sync.onOpen, refreshFolderTree, selectedFolder, startBackfill, syncFolderNow, visible]);

  // Quiet background poll: most ticks refresh selected folder (+ INBOX when
  // different) without remote LIST. Every 6th tick does a full-folder scan for
  // badges / new-mail notifications across the account.
  const pollTickRef = useRef(0);
  useEffect(() => {
    pollTickRef.current = 0;
    if (info.sync.intervalMinutes <= 0) return;
    const intervalMs = Math.max(1, info.sync.intervalMinutes) * 60 * 1000;
    const id = window.setInterval(() => {
      pollTickRef.current += 1;
      const fullScan = pollTickRef.current % 6 === 0;
      if (fullScan) {
        void syncAllFolders(true, {
          limit: batchSize,
          includeBodies: false,
          indicator: "none",
        });
      } else {
        void quietPollSelectedAndInbox();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [batchSize, info.sync.intervalMinutes, quietPollSelectedAndInbox, syncAllFolders]);

  // IMAP IDLE push (TASK-12): while the tab is open a dedicated connection
  // waits on INBOX; each change runs the normal gap-free quiet catch-up, so a
  // lost push only delays mail until the next poll. Stopped on close (DEC-01).
  const quietPollRef = useRef(quietPollSelectedAndInbox);
  quietPollRef.current = quietPollSelectedAndInbox;
  const idleConfigRef = useRef(info);
  idleConfigRef.current = info;
  const [idleState, setIdleState] = useState<string | null>(null);
  const idleEnabled = info.sync.idle !== false;
  useEffect(() => {
    if (!idleEnabled) return;
    const accountId = info.sessionId;
    let disposed = false;
    let debounce: number | null = null;
    let unlisten: (() => void) | null = null;
    const schedulePoll = (waitMs = 400) => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        if (disposed) return;
        // The quiet poll skips while another sync (open catch-up, backfill)
        // holds the lock; keep the push pending instead of dropping it.
        if (syncInFlightRef.current) {
          schedulePoll(500);
          return;
        }
        void quietPollRef.current();
      }, waitMs);
    };
    void listen<MailIdleEvent>(MAIL_IDLE_EVENT, (event) => {
      const payload = event.payload;
      if (disposed || payload?.accountId !== accountId) return;
      // "stopped" may come from a previous watcher replaced by this tab's.
      if (payload.kind === "stopped") return;
      setIdleState(payload.kind);
      if (payload.kind === "changed") schedulePoll();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    void mailIdleStart(idleConfigRef.current, "INBOX").catch((e) => {
      console.debug("mail IDLE unavailable; polling only", e);
      if (!disposed) setIdleState("unsupported");
    });
    return () => {
      disposed = true;
      if (debounce != null) window.clearTimeout(debounce);
      unlisten?.();
      void mailIdleStop(accountId).catch(() => {});
    };
  }, [idleEnabled, info.sessionId]);

  useEffect(() => {
    if (availableMessages.length === 0) {
      if (!selectedMessageKey || !messageTabs.some((tab) => tab.key === selectedMessageKey)) {
        setSelectedMessageKey(null);
      }
      setBody(null);
      return;
    }
    if (
      !selectedMessageKey
      || (
        !availableMessages.some((message) => messageKey(message) === selectedMessageKey)
        && !messageTabs.some((tab) => tab.key === selectedMessageKey)
      )
    ) {
      setSelectedMessageKey(messageKey(availableMessages[0]));
      setBody(null);
    }
  }, [availableMessages, messageTabs, selectedMessageKey]);

  const autoReadKeyRef = useRef<string | null>(null);
  const remoteImagesMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    if (!selectedMessage) return;
    const key = messageKey(selectedMessage);
    let cancelled = false;
    if (remoteImagesMessageKeyRef.current !== key) {
      remoteImagesMessageKeyRef.current = key;
      setAllowRemoteAllInTab(false);
      setRemoteAllowedMessageKeys(new Set());
    }
    if (!selectedBody) {
      void loadBody(selectedMessage);
    }
    if (autoReadKeyRef.current === key || !isUnread(selectedMessage)) {
      return () => {
        cancelled = true;
      };
    }
    autoReadKeyRef.current = key;
    void (async () => {
      try {
        const result = await mailMarkRead(info, selectedMessage.folder, [selectedMessage.uid], false);
        // Body completion or a header refresh reruns this effect while STORE
        // is in flight. Its confirmed result still applies to these UIDs even
        // if the reader has moved on; dropping it leaves stale unread rows.
        if (result.marked > 0) {
          markMessagesReadLocally(selectedMessage.folder, [selectedMessage.uid], result.marked);
        }
      } catch (e) {
        if (!cancelled) setError(mailClientErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, loadBody, markMessagesReadLocally, selectedBody, selectedMessage, visible]);

  useEffect(() => {
    setCheckedMessageKeys((current) => {
      if (current.size === 0) return current;
      const liveKeys = new Set(availableMessages.map(messageKey));
      const next = new Set([...current].filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [availableMessages]);

  const handleFolderSelect = (folder: MailFolder) => {
    selectionAnchorRef.current = null;
    const changed = folder.name !== selectedFolderRef.current;
    updateSelectedFolder(folder.name);
    if (changed) {
      backfillSeqRef.current += 1;
      setBackfillProgress(null);
      void syncSelectedFolder(folder.name);
    }
    setSelectedMessageKey(null);
    setCheckedMessageKeys(new Set());
    setBody(null);
    setHasMoreMessages(false);
    setLoadingMoreMessages(false);
    setQuery("");
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await mailTestConnection(info);
      setStatus(`${info.incoming === "pop3" ? "POP3" : "IMAP"} ${result.imapOk ? "ok" : "failed"}, SMTP ${result.smtpOk ? "ok" : "failed"}, ${result.folderCount} folders`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      await mailClearCache(info.sessionId);
      bodyWarmSeqRef.current += 1;
      bodyLoadSeqRef.current += 1;
      bodyCacheRef.current = new Map();
      bodyRequestsRef.current.clear();
      setFolders([]);
      setMessages([]);
      setBody(null);
      setBodyCache(new Map());
      setBodyLoadingKey(null);
      setBodyWarming({ active: false, done: 0, total: 0 });
      setSelectedMessageKey(null);
      setMailViewKey("mailbox");
      setMessageTabs([]);
      setPopupMessageKey(null);
      setCheckedMessageKeys(new Set());
      setHasMoreMessages(false);
      setLoadingMoreMessages(false);
      setStatus("Mail cache cleared");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setClearing(false);
    }
  };

  const loadMoreMessages = useCallback(createLoadMoreMessages({
    query,
    loadingMessages,
    loadingMoreMessages,
    hasMoreMessages,
    selectedFolder,
    messages,
    info,
    setLoadingMoreMessages,
    pageSize,
    selectedFolderRef,
    messagesRef,
    setMessages,
    setHasMoreMessages,
    setError,
    loadCachedMessages,
    foldersRef,
    syncInFlightRef,
    applySyncedFolder,
    setStatus,
  }), [
    applySyncedFolder,
    hasMoreMessages,
    info,
    loadCachedMessages,
    loadingMessages,
    loadingMoreMessages,
    messages.length,
    pageSize,
    query,
    selectedFolder,
  ]);

  const handleMessageListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 96) {
      void loadMoreMessages();
    }
  }, [loadMoreMessages]);
  const { fallbackBodyFor, openCompose, saveCurrentDraft, refreshDrafts, openFromTemplate, openSavedDraft, deleteSavedDraft, saveCurrentAsTemplate } = createDraftActions({
    setDraftsLoading,
    setDrafts,
    info,
    setError,
    identityById,
    setDraft,
    setComposePrompt,
    lastSavedDraftJsonRef,
    setRecipientSearch,
    setComposeOpen,
    draft,
    setSavingDraft,
    setStatus,
    setDraftsOpen,
  });

  const replyDraftBody = (target: MailMessageHeader, currentBody: MailMessageBody, signature: string | null | undefined) => {
    const intro = `On ${formatFullDate(target.dateTs) || "an unknown date"}, ${addressLabel(target.from) || "(unknown sender)"} wrote:`;
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildReplyHtml(intro, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}${intro}\n${quotePlainText(originalText)}`,
    };
  };

  const openReply = (target = selectedMessage) => {
    if (!target) return;
    const from = target.from?.address ?? addressLabel(target.from);
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(from),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("reply", target),
      richFormatUsed: true,
    }, false);
  };

  const openReplyAll = (target = selectedMessage) => {
    if (!target) return;
    const ownAddresses = new Set([
      normalizedMailAddress(info.emailAddress),
      normalizedMailAddress(info.imap.username),
      normalizedMailAddress(info.smtp.username),
      ...ownIdentityAddresses(identities),
    ].filter(Boolean));
    const to: string[] = [];
    const cc: string[] = [];
    const seenTo = new Set<string>();
    const seenCc = new Set<string>();
    appendUniqueAddress(to, seenTo, target.from, ownAddresses);
    for (const recipient of target.to) appendUniqueAddress(to, seenTo, recipient, ownAddresses);
    for (const recipient of target.cc) {
      const mail = normalizedMailAddress(recipient.address ?? addressLabel(recipient));
      if (seenTo.has(mail)) continue;
      appendUniqueAddress(cc, seenCc, recipient, ownAddresses);
    }
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(to.join(", ")),
      cc: parseRecipientsText(cc.join(", ")),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("replyAll", target),
      richFormatUsed: true,
    }, false);
  };
  const { handleSendDraft, handleUndoSend, processOutbox, sendOutboxItem, handleSendLater } = useMailOutbox({
    identityById,
    setSentCopyNotice,
    setStatus,
    info,
    setDrafts,
    setError,
    setComposeOpen,
    setSendLaterOpen,
    setComposePrompt,
    setDraft,
    outboxBusyIdsRef,
    undoSend,
    composeOpen,
    draft,
    retryAfterTrustRef,
    syncFolderNow,
    selectedFolderRef,
    setUndoNow,
    undoTimerRef,
    setUndoSend,
    setSending,
    sendLaterAt,
    drafts,
    lastSavedDraftJsonRef,
  });

  const addDraftAttachmentPaths = useCallback(createAddDraftAttachmentPaths({
    setAttachProgress,
    setDraft,
    setStatus,
    setError,
  }), []);

  const handleAddDraftAttachments = async () => {
    try {
      const paths = await selectUploadFile();
      if (!paths.length) return;
      await addDraftAttachmentPaths(paths);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const insertInlineImageFromPath = useCallback(createInsertInlineImageFromPath({
    setError,
    setDraft,
  }), []);

  const insertInlineImageFromFile = useCallback(createInsertInlineImageFromFile({
    setError,
    setDraft,
  }), []);

  const handleInsertInlineImage = async (): Promise<string | null> => {
    try {
      const paths = await selectUploadFile();
      const path = paths[0];
      if (!path) return null;
      return await insertInlineImageFromPath(path);
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    }
  };

  const handlePasteImages = useCallback(createHandlePasteImages({
    setAttachProgress,
    insertInlineImageFromPath,
    setStatus,
    setError,
    insertInlineImageFromFile,
  }), [insertInlineImageFromFile, insertInlineImageFromPath]);

  const handleDropComposeFiles = useCallback(createHandleDropComposeFiles({
    setAttachProgress,
    addDraftAttachmentPaths,
    setError,
  }), [addDraftAttachmentPaths]);

  const removeDraftAttachment = (index: number) => {
    setDraft((current) => {
      const removed = current.attachments[index];
      const attachments = current.attachments.filter((_, i) => i !== index);
      if (!removed?.inline || !removed.contentId) {
        return { ...current, attachments };
      }
      const cid = escapeRegExp(removed.contentId);
      const htmlBody = current.htmlBody
        .replace(new RegExp(`<img\\b[^>]*\\bdata-taomni-cid=["']${cid}["'][^>]*>`, "gi"), "")
        .replace(new RegExp(`<img\\b[^>]*\\bsrc=["']cid:${cid}["'][^>]*>`, "gi"), "");
      return {
        ...current,
        attachments,
        htmlBody,
        textBody: mailHtmlToPlainText(htmlBody),
      };
    });
  };

  useEffect(() => {
    if (!composeOpen) {
      setComposeDragActive(false);
      return;
    }
    const handleNativeFileDrop = (event: Event) => {
      if (sending) return;
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;
      const root = composeRootRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!root || !target || !root.contains(target)) return;
      setComposeDragActive(false);
      void addDraftAttachmentPaths(detail.paths);
    };
    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [addDraftAttachmentPaths, composeOpen, sending]);

  const discardCurrentDraft = async () => {
    const draftId = draft.id;
    setComposeOpen(false);
    setComposePrompt(null);
    setDraft(emptyComposeDraft());
    lastSavedDraftJsonRef.current = "";
    if (!draftId) return;
    try {
      await mailDeleteDraft(info.sessionId, draftId);
      setDrafts((current) => current.filter((item) => item.id !== draftId));
      setStatus("Draft discarded");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  useEffect(() => {
    if (!composeOpen || sending || savingDraft || !draftHasContent(draft)) return;
    const serialized = serializeDraftContent(draft);
    if (serialized === lastSavedDraftJsonRef.current) return;
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft("auto");
    }, 1800);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [composeOpen, draft, savingDraft, sending]);

  if (!visible) {
    return (
      <div
        ref={rootRef}
        className="h-full min-h-0 bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
        style={mailAppearance}
        data-testid="mail-client-tab"
      data-active={visible ? "true" : "false"}
        aria-hidden="true"
      />
    );
  }

  const handleAiAction = async (action: AiAction) => {
    if (!selectedMessage) return;
    if (!info.ai.enabled) {
      setError("AI actions are disabled for this mail account.");
      return;
    }
    let currentBody = body;
    if (!currentBody || currentBody.uid !== selectedMessage.uid || currentBody.folder !== selectedMessage.folder) {
      currentBody = await loadBody(selectedMessage);
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
      await sendMessageToAi(threadId, aiPrompt(action, selectedMessage, currentBody));
      setStatus("Sent mail context to AI");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const handleDownloadAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      const targetPath = await save({
        title: "Save attachment",
        defaultPath,
      });
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        setStatus("Attachment save cancelled");
        return;
      }
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath, attachment.section);
      setStatus(`Saved attachment to ${result.path}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleOpenAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      const targetPath = await temporaryFilePath(defaultPath);
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath, attachment.section);
      await openLocalPath(result.path);
      setStatus(`Opened attachment ${result.name || defaultPath}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleSaveAllAttachments = async (message: MailMessageHeader, attachments: MailAttachmentInfo[]) => {
    if (attachments.length === 0) return;
    setDownloadingAttachmentIndex(ALL_ATTACHMENTS_INDEX);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const targetDir = await open({
        title: "Save all attachments",
        directory: true,
        multiple: false,
      });
      if (typeof targetDir !== "string" || !targetDir.trim()) {
        setStatus("Save all attachments cancelled");
        return;
      }
      const usedNames = new Set<string>();
      let saved = 0;
      for (const [index, attachment] of attachments.entries()) {
        const fileName = uniqueAttachmentName(
          suggestedAttachmentName(attachment, index, message.subject),
          usedNames,
        );
        await mailDownloadAttachment(info, message.folder, message.uid, index, joinLocalPath(targetDir, fileName), attachment.section);
        saved += 1;
      }
      setStatus(`Saved ${saved} attachment${saved === 1 ? "" : "s"} to ${targetDir}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const attachmentMenuItems = (
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ): MenuItem[] => {
    const busy = downloadingAttachmentIndex !== null;
    const items: MenuItem[] = [
      {
        label: "Open with default app",
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleOpenAttachment(message, attachment, index),
      },
      {
        label: "Save attachment as...",
        icon: <Download className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleDownloadAttachment(message, attachment, index),
      },
    ];
    if (attachments.length > 1) {
      items.push(
        { label: "", separator: true },
        {
          label: "Save all attachments...",
          icon: <Download className="w-3.5 h-3.5" />,
          disabled: busy,
          onClick: () => void handleSaveAllAttachments(message, attachments),
        },
      );
    }
    return items;
  };

  const handleAttachmentContextMenu = (
    event: ReactMouseEvent,
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ) => {
    attachmentMenu.show(event, attachmentMenuItems(message, attachments, attachment, index));
  };

  const copyText = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => setStatus(`Copied ${label}`))
      .catch((e) => setError(mailClientErrorMessage(e)));
  };
  const { runMailAction, removeMessagesLocally, reportMutationProgress, resolveSpecialFolder, applyFlagsLocally, handleMarkUnread, handleToggleFlagged, handleToggleKeyword, handleClearTags, handleArchiveMessages, handleMoveMessages, handleCopyMessages, handleJunkMessages, handleNotJunkMessages, handleDeleteMessages, openFilterFromMessage, openContactFromMessage, runFiltersOnFolder } = createMailMutations({
    setMessages,
    setSearchResults,
    setMessageTabs,
    setFolders,
    cacheRemovalVersionsRef,
    setCheckedMessageKeys,
    setMailViewKey,
    setSelectedMessageKey,
    setPopupMessageKey,
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
    reloadVisibleFromCache,
    selectedFolderRef,
    loadCachedFolders,
    setContactDraft,
    setAddressBookOpen,
    setFilterDraft,
    setFiltersOpen,
    confirmDialog,
  });

  const buildForwardBody = (
    target: MailMessageHeader,
    signature: string | null | undefined = info.signature,
  ): { htmlBody: string; textBody: string } => {
    const currentBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const headerLines = [
      `From: ${addressLabel(target.from) || "(unknown sender)"}`,
      target.dateTs ? `Date: ${formatFullDate(target.dateTs)}` : "",
      `Subject: ${target.subject || "(no subject)"}`,
      `To: ${target.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}`,
    ].filter(Boolean);
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildForwardHtml(headerLines, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}---------- Forwarded message ----------\n${headerLines.join("\n")}\n\n${originalText}`,
    };
  };

  const openForward = (target = selectedMessage) => {
    if (!target) return;
    const identity = pickReplyIdentity(identities, target);
    const forwardBody = buildForwardBody(target, identity.signature);
    openCompose({
      identityId: identity.id,
      subject: forwardSubject(target.subject),
      htmlBody: forwardBody.htmlBody,
      textBody: forwardBody.textBody,
      replyContext: replyContextFor("forward", target),
      richFormatUsed: true,
    }, false);
  };

  const handlePrintMessage = (message = selectedMessage) => {
    if (!message) return;
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const headerHtml = `
      <div class="taomni-print-header" style="font-family:system-ui,sans-serif;padding:0 0 12px;margin:0 0 12px;border-bottom:1px solid #ccc;color:#111">
        <h2 style="margin:0 0 8px">${escapeHtml(message.subject || "(no subject)")}</h2>
        <div style="font-size:12px;color:#555;margin-bottom:4px">From: ${escapeHtml(addressLabel(message.from) || "(unknown)")}</div>
        <div style="font-size:12px;color:#555;margin-bottom:4px">To: ${escapeHtml(message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)")}</div>
        <div style="font-size:12px;color:#555">Date: ${escapeHtml(formatFullDate(message.dateTs) || "(unknown)")}</div>
      </div>`;
    const printHtml = currentBody?.html
      ? buildMailReaderSrcDoc(currentBody.html, {
        allowRemoteImages: true,
        fontSize: mailFontSize,
        preferDark: false,
      }).replace(
        /<body([^>]*)>/i,
        (_full, attrs: string) => `<body${attrs}>${headerHtml}`,
      )
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(message.subject || "Message")}</title>
<style>
.mail-quote{border-left:2px solid #729fcf;padding-left:.55em;margin:.1em 0}
.mail-quote-1{color:#1d4ed8}.mail-quote-2{color:#047857}.mail-quote-3{color:#6d28d9}
.mail-line{white-space:pre-wrap;min-height:1.35em}
</style>
</head><body style="font-family:system-ui,sans-serif;padding:24px;color:#111">${headerHtml}${formatMailPlainTextHtml(currentBody?.text ?? message.snippet ?? "")}</body></html>`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      setError("Unable to prepare the message for printing.");
      return;
    }
    doc.open();
    doc.write(printHtml);
    doc.close();
    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 500);
    };
    window.setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (e) {
        setError(mailClientErrorMessage(e));
      } finally {
        cleanup();
      }
    }, 150);
  };

  const handleViewSource = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const raw = await mailFetchRaw(info, message.folder, message.uid);
    setSourceView({ subject: message.subject || "(no subject)", content: raw });
  });

  const handleSaveEml = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = suggestedAttachmentName({ name: `${message.subject || "message"}.eml` }, 0, message.subject);
    const defaultPath = base.toLowerCase().endsWith(".eml") ? base : `${base}.eml`;
    const targetPath = await save({ title: "Save message as .eml", defaultPath });
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      setStatus("Save cancelled");
      return;
    }
    const result = await mailSaveRaw(info, message.folder, message.uid, targetPath);
    setStatus(`Saved message to ${result.path}`);
  });

  const handleSearchInFolder = (folder: MailFolder) => {
    handleFolderSelect(folder);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleCreateFolder = (parent?: MailFolder) => runMailAction(async () => {
    const name = await textInputDialog.promptText({
      title: parent ? `New subfolder in ${folderLabel(parent)}` : "New folder",
      label: "Folder name",
      placeholder: "Folder name",
    });
    if (!name || !name.trim()) return;
    const delimiter = parent?.delimiter || "/";
    const fullName = parent ? `${parent.name}${delimiter}${name.trim()}` : name.trim();
    await mailCreateFolder(info, fullName);
    await loadCachedFolders();
    setStatus(`Created folder ${name.trim()}`);
  });

  const handleRenameFolder = (folder: MailFolder) => runMailAction(async () => {
    const label = folderLabel(folder);
    const next = await textInputDialog.promptText({
      title: `Rename ${label}`,
      label: "New folder name",
      initialValue: label,
    });
    const trimmed = next?.trim();
    if (!trimmed || trimmed === label) return;
    const delimiter = folder.delimiter || "/";
    const idx = folder.name.lastIndexOf(delimiter);
    const parentPath = idx >= 0 ? folder.name.slice(0, idx + delimiter.length) : "";
    const target = `${parentPath}${trimmed}`;
    await mailRenameFolder(info, folder.name, target);
    if (selectedFolder === folder.name) updateSelectedFolder(target);
    await loadCachedFolders();
    setStatus(`Renamed folder to ${trimmed}`);
  });

  const handleDeleteFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Delete folder",
      message: `Delete folder "${folderLabel(folder)}" and its cached messages? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    await mailDeleteFolder(info, folder.name);
    if (selectedFolder === folder.name) {
      setSelectedMessageKey(null);
      setBody(null);
    }
    await loadCachedFolders();
    setStatus(`Deleted folder ${folderLabel(folder)}`);
  });

  const handleEmptyFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Empty folder",
      message: `Permanently delete all messages in "${folderLabel(folder)}"? This cannot be undone.`,
      confirmLabel: "Empty",
      danger: true,
    });
    if (!confirmed) return;
    const deleted = await mutationSessionRef.current.execute(JSON.stringify(["empty", folder.name]), [],
      (id) => mailDeleteMessages(info, folder.name, [], true, id),
      (done) => removeMessagesLocally(folder.name, done, messages.filter((m) => m.folder === folder.name && done.includes(m.uid) && isUnread(m)).length),
      reportMutationProgress);
    if (selectedFolder === folder.name) {
      setMessages([]);
      setSelectedMessageKey(null);
      setBody(null);
      setCheckedMessageKeys(new Set());
    }
    setFolders((current) => current.map((entry) => (
      entry.name === folder.name
        ? { ...entry, total: 0, unread: 0, updatedAt: Math.floor(Date.now() / 1000) }
        : entry
    )));
    setStatus(`Emptied ${deleted} message${deleted === 1 ? "" : "s"} from ${folderLabel(folder)}`);
  });

  /** A pending read receipt request of `message` (not yet answered, not mine). */
  const receiptRequest = (message: MailMessageHeader | null | undefined): string | null => {
    if (!message?.receiptTo) return null;
    if (message.flags.some((flag) => flag.toLowerCase() === MAIL_MDN_SENT.toLowerCase())) return null;
    const own = [info.emailAddress, ...(info.identities ?? []).map((identity) => identity.email)]
      .map((address) => address?.trim().toLowerCase())
      .filter(Boolean);
    if (own.includes(message.from?.address?.trim().toLowerCase() ?? "")) return null;
    if (resolveSpecialFolder("sent") === message.folder) return null;
    return message.receiptTo;
  };

  const answerReceipt = async (message: MailMessageHeader, send: boolean, automatic = false) => {
    setReceiptBusy(true);
    try {
      if (send) {
        const result = await mailSendReceipt(info, message.folder, message.uid, automatic);
        setStatus(`Read receipt sent to ${result.sentTo}`);
      } else {
        await mailSetFlags(info, message.folder, [message.uid], [MAIL_MDN_SENT], []);
        setStatus("Read receipt declined");
      }
      applyFlagsLocally(message.folder, [message.uid], [MAIL_MDN_SENT], [], 0);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setReceiptBusy(false);
    }
  };

  const renderReceiptBanner = (message: MailMessageHeader) => {
    const address = receiptRequest(message);
    if (!address || (info.receiptPolicy ?? "ask") !== "ask") return null;
    return (
      <div
        className="mx-4 mt-3 px-3 py-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] flex flex-wrap items-center gap-2 text-[12px]"
        data-testid="mail-receipt-banner"
      >
        <span className="min-w-0 flex-1">The sender asked for a read receipt to {address}.</span>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-send" disabled={receiptBusy} onClick={() => void answerReceipt(message, true)}>
          Send receipt
        </button>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-ignore" disabled={receiptBusy} onClick={() => void answerReceipt(message, false)}>
          Ignore
        </button>
      </div>
    );
  };

  /** In-app composer for `mailto:` links (reader links, List-Unsubscribe). */
  const openComposeFromMailto = (href: string) => {
    const fields = parseMailto(href);
    if (!fields) return;
    const body = fields.body.trim();
    openCompose({
      to: parseRecipientsText(fields.to.join(", ")),
      cc: parseRecipientsText(fields.cc.join(", ")),
      bcc: parseRecipientsText(fields.bcc.join(", ")),
      subject: fields.subject,
      ...(body ? { textBody: fields.body, htmlBody: plainTextToMailHtml(fields.body) } : {}),
    }, !body);
  };

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
      openComposeFromMailto(mailto);
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

  /** DEC-14: put the invitation (with my reply) into the CalDAV calendar. */
  const addInviteToCalendar = async (message: MailMessageHeader, partstat?: string) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, calendar: "adding", calendarError: undefined } : current));
    try {
      const written = await mailAddInviteToCalendar(info, message.folder, message.uid, partstat);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: "added" } : current));
      setAgendaRevision((value) => value + 1);
      setStatus(written.created ? "Added to your calendar" : "Updated in your calendar");
    } catch (e) {
      const calendarError = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: undefined, calendarError } : current));
    }
  };

  /** AC-62: Accept / Tentative / Decline sends an iTIP REPLY to the organizer. */
  const handleRespondInvite = async (message: MailMessageHeader, response: MailInviteReply) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, responding: response, error: undefined } : current));
    try {
      const result = await mailRespondInvite(info, message.folder, message.uid, response);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, responded: result.partstat } : current));
      setStatus(`Invitation reply (${result.partstat.toLowerCase()}) sent to ${result.sentTo}`);
      if (info.caldav && response !== "decline") await addInviteToCalendar(message, result.partstat);
    } catch (e) {
      const error = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, error } : current));
    }
  };

  const renderInviteCard = (message: MailMessageHeader) => {
    const view = inviteView;
    if (!view || view.key !== messageKey(message)) return null;
    if (view.loading) {
      return (
        <div className="mx-4 mt-3 flex items-center gap-2 text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-invite-loading">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading calendar invitation…
        </div>
      );
    }
    const invite = view.invite;
    if (!invite) {
      return view.error ? (
        <div className="mx-4 mt-3 text-[12px] text-red-500" data-testid="mail-invite-error">{view.error}</div>
      ) : null;
    }
    const cancelled = invite.method === "CANCEL" || invite.status === "CANCELLED";
    const canRespond = invite.method === "REQUEST" && !cancelled && !!invite.organizer;
    const current = view.responded ?? myPartstat(invite, info.emailAddress);
    const calendarIndex = visibleAttachments.findIndex((attachment) => hasCalendarPart([attachment]));
    const replies: Array<{ response: MailInviteReply; label: string; partstat: string }> = [
      { response: "accept", label: "Accept", partstat: "ACCEPTED" },
      { response: "tentative", label: "Tentative", partstat: "TENTATIVE" },
      { response: "decline", label: "Decline", partstat: "DECLINED" },
    ];
    return (
      <div
        className="mx-4 mt-3 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-3 text-[12px]"
        data-testid="mail-invite-card"
        data-method={invite.method}
        data-partstat={current ?? undefined}
      >
        <div className="flex items-start gap-2">
          <CalendarDays className="w-4 h-4 mt-0.5 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold break-words" data-testid="mail-invite-summary">
              {cancelled ? "Cancelled: " : invite.method === "REPLY" ? "Reply: " : ""}{invite.summary || "(untitled event)"}
            </div>
            <div className="mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5">
              <span className="text-[var(--taomni-text-muted)]">When</span>
              <span data-testid="mail-invite-when">{formatInviteRange(invite) || "(not specified)"}</span>
              {invite.location && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Where</span>
                  <span className="break-words">{invite.location}</span>
                </>
              )}
              {invite.organizer && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Organizer</span>
                  <span className="truncate">{invite.organizer.name ? `${invite.organizer.name} <${invite.organizer.email}>` : invite.organizer.email}</span>
                </>
              )}
              {invite.attendees.length > 0 && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Attendees</span>
                  <span className="break-words">
                    {invite.attendees.map((attendee) => `${attendee.name || attendee.email} (${attendee.partstat.toLowerCase()})`).join(", ")}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canRespond && replies.map((reply) => (
            <button
              key={reply.response}
              type="button"
              className={`taomni-btn h-6 px-2 text-[11px] ${current === reply.partstat ? "text-[var(--taomni-accent)] border-[var(--taomni-accent)]" : ""}`}
              data-testid={`mail-invite-${reply.response}`}
              aria-pressed={current === reply.partstat}
              disabled={!!view.responding}
              onClick={() => void handleRespondInvite(message, reply.response)}
            >
              {view.responding === reply.response ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {reply.label}
            </button>
          ))}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-export"
              title="Save the event as an .ics file"
              onClick={() => void handleDownloadAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <Download className="w-3 h-3" /> Export .ics
            </button>
          )}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-open"
              title="Open in the system calendar app"
              onClick={() => void handleOpenAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <ExternalLink className="w-3 h-3" /> Open in calendar
            </button>
          )}
          {info.caldav && invite.method === "REQUEST" && !cancelled && view.calendar !== "added" && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              data-testid="mail-invite-add-calendar"
              disabled={view.calendar === "adding"}
              onClick={() => void addInviteToCalendar(message, view.responded)}
            >
              {view.calendar === "adding" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarDays className="w-3 h-3" />} Add to calendar
            </button>
          )}
          {view.responded && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-responded">
              Reply sent ({view.responded.toLowerCase()})
            </span>
          )}
          {view.calendar === "added" && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-in-calendar">In your calendar</span>
          )}
        </div>
        {view.error && <div className="mt-1 text-red-500" data-testid="mail-invite-error">{view.error}</div>}
        {view.calendarError && <div className="mt-1 text-red-500" data-testid="mail-invite-calendar-error">{view.calendarError}</div>}
      </div>
    );
  };

  const handleExportMbox = (folder: MailFolder) => runMailAction(async () => {
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

  const handleImportMessages = (folder: MailFolder) => runMailAction(async () => {
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
    await runFolderSync(folder.name, { maxSteps: 20 }).catch(() => undefined);
    await reloadVisibleFromCache(folder.name);
  });

  /** AC-44: show the server certificate so the user can add an exception. */
  const openCertReview = async (protocol: "imap" | "smtp") => {
    setCertReview({ protocol, loading: true });
    try {
      const cert = await mailProbeCertificate(info, protocol);
      setCertReview({ protocol, loading: false, info: cert });
    } catch (e) {
      setCertReview({ protocol, loading: false, error: mailClientErrorMessage(e) });
    }
  };

  const trustReviewedCertificate = async () => {
    const review = certReview;
    if (!review?.info) return;
    const der = review.info.derBase64;
    const key = review.protocol === "smtp" ? "mailSmtpTrustedCert" : "mailImapTrustedCert";
    // Persist on the saved session (quick-connect tabs keep it in memory).
    const store = useSessionStore.getState();
    const session = store.sessions.find((entry) => entry.id === info.sessionId);
    if (session) {
      let options: Record<string, unknown> = {};
      try {
        options = JSON.parse(session.options_json || "{}") as Record<string, unknown>;
      } catch {
        options = {};
      }
      options[key] = der;
      try {
        await store.updateSession({ ...session, options_json: JSON.stringify(options) });
      } catch (e) {
        setError(mailClientErrorMessage(e));
        return;
      }
    }
    useAppStore.setState((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || !tab.mail) return tab;
        const mail = review.protocol === "smtp"
          ? { ...tab.mail, smtp: { ...tab.mail.smtp, trustedCert: der } }
          : { ...tab.mail, imap: { ...tab.mail.imap, trustedCert: der } };
        return { ...tab, mail };
      }),
    }));
    setCertReview(null);
    setError(null);
    setStatus(session
      ? "Certificate trusted for this account; reconnecting…"
      : "Certificate trusted until this tab closes (save the account to keep it); reconnecting…");
    retryAfterTrustRef.current = true;
  };

  const openExternalUrl = async (url: string) => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const folderTargetChildren = (
    targets: MailMessageHeader[],
    action: (targets: MailMessageHeader[], target: string) => void,
  ): MenuItem[] => {
    const sources = new Set(targets.map((message) => message.folder));
    const options = displayFolders.filter(
      (folder) => !(sources.size === 1 && sources.has(folder.name)),
    );
    if (options.length === 0) return [{ label: "No other folders", disabled: true }];
    return options.map((folder) => ({
      label: folderLabel(folder),
      icon: folderIcon(folder),
      onClick: () => action(targets, folder.name),
    }));
  };

  const messageMenuItems = (message: MailMessageHeader): MenuItem[] => {
    const targets = checkedMessageKeys.has(messageKey(message)) && checkedMessages.length > 0
      ? checkedMessages
      : [message];
    const count = dedupeMessages(targets).length;
    const suffix = count > 1 ? ` (${count})` : "";
    const many = count > 1;
    const allFlagged = targets.every(isFlagged);
    const anyUnread = targets.some(isUnread);
    const allUnread = targets.every(isUnread);
    return [
      { label: "Open", icon: <MailOpen className="w-3.5 h-3.5" />, onClick: () => selectMessage(message, "mailbox") },
      { label: "Open in mail tab", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => openMessageTab(message) },
      { label: "Open in popup window", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => openMessagePopup(message) },
      { label: "", separator: true },
      { label: "Reply", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => openReply(message) },
      { label: "Reply all", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => openReplyAll(message) },
      { label: "Forward", icon: <Forward className="w-3.5 h-3.5" />, onClick: () => openForward(message) },
      { label: "", separator: true },
      {
        label: `Mark as read${suffix}`,
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        disabled: !anyUnread || markingRead || busyAction,
        onClick: () => void (many ? handleMarkSelectedRead() : handleMarkSingleRead(message)),
      },
      {
        label: `Mark as unread${suffix}`,
        icon: <MailIcon className="w-3.5 h-3.5" />,
        disabled: allUnread || busyAction,
        onClick: () => void handleMarkUnread(targets),
      },
      {
        label: allFlagged ? `Remove star${suffix}` : `Add star${suffix}`,
        icon: <Star className="w-3.5 h-3.5" />,
        disabled: busyAction,
        onClick: () => void handleToggleFlagged(targets),
      },
      {
        label: `Tag${suffix}`,
        icon: <Tag className="w-3.5 h-3.5" />,
        testId: "mail-menu-tag",
        openOnClick: true,
        children: [
          ...MAIL_TAGS.map((tag) => ({
            label: tag.label,
            testId: `mail-menu-tag-${tag.keyword.replace("$", "")}`,
            checked: targets.every((target) => messageTags(target).some((entry) => entry.keyword === tag.keyword)),
            icon: <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tag.color }} />,
            disabled: busyAction,
            onClick: () => void handleToggleKeyword(targets, tag.keyword, tag.label),
          })),
          { label: "", separator: true },
          { label: "Remove all tags", disabled: busyAction, onClick: () => void handleClearTags(targets) },
        ],
      },
      { label: "Mark folder read", icon: <MailOpen className="w-3.5 h-3.5" />, disabled: markingRead, onClick: () => void handleMarkFolderRead(message.folder) },
      { label: "", separator: true },
      { label: `Archive${suffix}`, icon: <Archive className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleArchiveMessages(targets) },
      { label: `Move to${suffix}`, icon: <FolderInput className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleMoveMessages(t, folder)) },
      { label: `Copy to${suffix}`, icon: <FolderSymlink className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleCopyMessages(t, folder)) },
      { label: `Mark as junk${suffix}`, icon: <Ban className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleJunkMessages(targets) },
      { label: `Not junk${suffix}`, icon: <Inbox className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleNotJunkMessages(targets) },
      { label: `Delete${suffix}`, icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, disabled: busyAction, onClick: () => void handleDeleteMessages(targets) },
      { label: "", separator: true },
      { label: "Create filter from message…", icon: <FilterIcon className="w-3.5 h-3.5" />, testId: "mail-menu-create-filter", onClick: () => openFilterFromMessage(message) },
      { label: "Add sender to address book…", icon: <BookUser className="w-3.5 h-3.5" />, testId: "mail-menu-add-contact", disabled: !message.from?.address, onClick: () => openContactFromMessage(message) },
      { label: "Save as .eml", icon: <Save className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleSaveEml(message) },
      { label: "View source", icon: <Code className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleViewSource(message) },
      { label: "Print", icon: <Printer className="w-3.5 h-3.5" />, onClick: () => handlePrintMessage(message) },
      { label: "", separator: true },
      { label: "Copy subject", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => copyText("subject", message.subject || "(no subject)") },
      { label: "Copy sender", icon: <MailIcon className="w-3.5 h-3.5" />, onClick: () => copyText("sender", addressLabel(message.from)) },
      { label: "Copy recipients", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("recipients", message.to.map(addressLabel).filter(Boolean).join(", ")) },
    ];
  };


  shortcutRef.current = (action: MailShortcutAction): boolean => {
    // Dialogs and the composer own the keyboard.
    if (composeOpen || draftsOpen || subscriptionsOpen) return false;
    const rows = listRows.map((row) => row.message);
    const current = selectedMessage;
    const index = current ? rows.findIndex((message) => messageKey(message) === messageKey(current)) : -1;
    const go = (message: MailMessageHeader | undefined) => {
      if (!message) return false;
      selectListMessage(message);
      document.querySelector<HTMLElement>(
        `[data-testid="mail-message-row"][data-uid="${message.uid}"]`,
      )?.scrollIntoView?.({ block: "nearest" });
      return true;
    };
    switch (action) {
      case "next":
        return go(index < 0 ? rows[0] : rows[index + 1]);
      case "prev":
        return go(index < 0 ? rows[0] : rows[index - 1]);
      case "nextUnread":
        return go(rows.slice(index + 1).find(isUnread) ?? rows.slice(0, Math.max(index, 0)).find(isUnread));
      case "focusSearch":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return true;
      default:
        break;
    }
    const targets = checkedMessages.length > 0 ? checkedMessages : current ? [current] : [];
    if (targets.length === 0 || busyAction) return false;
    switch (action) {
      case "reply":
        openReply(targets[0]);
        return true;
      case "replyAll":
        openReplyAll(targets[0]);
        return true;
      case "forward":
        openForward(targets[0]);
        return true;
      case "toggleRead":
        if (targets.some(isUnread)) {
          void (checkedMessages.length > 0 ? handleMarkSelectedRead() : handleMarkSingleRead(targets[0]));
        } else {
          void handleMarkUnread(targets);
        }
        return true;
      case "star":
        void handleToggleFlagged(targets);
        return true;
      case "archive":
        void handleArchiveMessages(targets);
        return true;
      case "junk":
        void handleJunkMessages(targets);
        return true;
      case "notJunk":
        void handleNotJunkMessages(targets);
        return true;
      case "delete":
        void handleDeleteMessages(targets);
        return true;
      default:
        return false;
    }
  };

  const dragTargetsFor = (message: MailMessageHeader): MailMessageHeader[] =>
    checkedMessageKeys.has(messageKey(message)) && checkedMessages.length > 0 ? checkedMessages : [message];

  const folderMenuItems = (folder: MailFolder): MenuItem[] => {
    const isTrashLike = folderMatchesSpecial(folder, "trash", info.specialFolders)
      || folderMatchesSpecial(folder, "junk", info.specialFolders);
    return [
      { label: "Open folder", icon: folderIcon(folder), onClick: () => handleFolderSelect(folder) },
      { label: "Search in this folder", icon: <Search className="w-3.5 h-3.5" />, onClick: () => handleSearchInFolder(folder) },
      {
        label: "Sync all folders",
        icon: <RefreshCw className="w-3.5 h-3.5" />,
        disabled: syncing,
        onClick: () => void syncAllFolders(false, { limit: batchSize, includeBodies: false, indicator: "sync" }),
      },
      {
        label: "Mark folder read",
        icon: <MailOpen className="w-3.5 h-3.5" />,
        disabled: markingRead || (folder.unread ?? 0) === 0,
        onClick: () => void handleMarkFolderRead(folder.name),
      },
      { label: "", separator: true },
      { label: "New subfolder…", icon: <FolderPlus className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleCreateFolder(folder) },
      { label: "Rename folder…", icon: <PenLine className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleRenameFolder(folder) },
      { label: "Export as mbox…", icon: <Download className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleExportMbox(folder) },
      { label: "Import messages (mbox/.eml)…", icon: <FolderInput className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleImportMessages(folder) },
      {
        label: isTrashLike ? "Empty folder" : "Delete folder",
        icon: isTrashLike ? <Trash2 className="w-3.5 h-3.5" /> : <FolderX className="w-3.5 h-3.5" />,
        danger: true,
        disabled: busyAction,
        onClick: () => void (isTrashLike ? handleEmptyFolder(folder) : handleDeleteFolder(folder)),
      },
      { label: "", separator: true },
      { label: "Copy folder name", icon: <Folder className="w-3.5 h-3.5" />, onClick: () => copyText("folder name", folder.name) },
    ];
  };

  const messageListMenuItems = (): MenuItem[] => [
    {
      label: "Sync all folders",
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      disabled: syncing,
      onClick: () => void syncAllFolders(false, {
        limit: batchSize,
        includeBodies: false,
        indicator: "sync",
      }),
    },
    {
      label: "Mark folder read",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      disabled: markingRead || Math.max(activeFolder?.unread ?? 0, visibleUnreadCount) === 0,
      onClick: () => void handleMarkFolderRead(),
    },
    {
      label: allFilteredMessagesChecked ? "Clear visible selection" : "Select visible messages",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      disabled: filteredMessages.length === 0,
      onClick: () => toggleFilteredMessagesChecked(!allFilteredMessagesChecked),
    },
  ];

  const showReaderMenu = (event: ReactMouseEvent, message: MailMessageHeader | null) => {
    const targetEl = event.target as HTMLElement | null;
    const anchor = targetEl?.closest("a") as HTMLAnchorElement | null;
    const image = (targetEl?.tagName === "IMG" ? targetEl : targetEl?.closest("img")) as HTMLImageElement | null;
    const selection = typeof window !== "undefined" ? (window.getSelection()?.toString().trim() ?? "") : "";
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const items: MenuItem[] = [];
    if (selection) {
      items.push({ label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("selection", selection) });
    }
    if (anchor?.href) {
      const href = anchor.href;
      items.push({ label: "Copy link address", icon: <LinkIcon className="w-3.5 h-3.5" />, onClick: () => copyText("link", href) });
      items.push({ label: "Open link in browser", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => void openExternalUrl(href) });
    }
    if (image) {
      const src = image.getAttribute("src") || image.src;
      if (src) items.push({ label: "Copy image address", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("image address", src) });
    }
    if (currentBody?.html && message) {
      const key = messageKey(message);
      items.push({
        label: messageAllowsRemote(key) ? "Block remote images" : "Load remote images",
        icon: <ImageOff className="w-3.5 h-3.5" />,
        onClick: () => toggleRemoteForMessage(key),
      });
    }
    if (items.length > 0) items.push({ label: "", separator: true });
    items.push(...(message ? messageMenuItems(message) : messageListMenuItems()));
    mailMenu.show(event, items);
  };

  const activeFolder = displayFolders.find((folder) => folder.name === selectedFolder) ?? displayFolders[0];
  const cacheLine = info.cache.enabled
    ? `${info.cache.headerRetentionDays > 0 ? `${info.cache.headerRetentionDays}d` : "all"} headers, ${info.cache.bodyRecentLimit} recent bodies`
    : "cache off";
  const renderReaderSurface = (message: MailMessageHeader | null, popup = false) => {
    const currentBody = message
      ? bodyCache.get(messageKey(message)) ?? (bodyMatchesMessage(body, message) ? body : null)
      : null;
    const currentKey = message ? messageKey(message) : null;
    const currentHasRemoteImages = mailHtmlHasRemoteImages(currentBody?.html);
    const currentAllowsRemote = messageAllowsRemote(currentKey);
    const currentAttachments = currentBody?.attachments.length ? currentBody.attachments : message?.attachments ?? [];
    const loadingThisBody = !!message && bodyLoadingKey === messageKey(message);

    return (
      <main
        className="h-full min-w-0 flex flex-col"
        onContextMenu={(event) => showReaderMenu(event, message)}
      >
        <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
          <span className="text-[12px] font-semibold min-w-0 truncate">
            {message?.subject || "Message"}
          </span>
          {loadingThisBody && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReply(message)}
              disabled={!message}
              title="Reply"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply
            </button>
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReplyAll(message)}
              disabled={!message}
              title="Reply all"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply all
            </button>
            {!popup && (
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                onClick={() => message && openMessagePopup(message)}
                disabled={!message}
                title="Open message in popup window"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Popup
              </button>
            )}
          </div>
        </div>

        {!message ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
            Select a message
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 py-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <h2 className="text-[17px] font-semibold leading-6 mb-1 break-words">
                {message.subject || "(no subject)"}
              </h2>
              <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
                <span className="text-[var(--taomni-text-muted)]">From</span>
                <span className="truncate" title={addressLabel(message.from)}>{addressLabel(message.from) || "(unknown)"}</span>
                <span className="text-[var(--taomni-text-muted)]">To</span>
                <span className="truncate" title={message.to.map(addressLabel).join(", ")}>
                  {message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}
                </span>
                {message.cc.length > 0 && (
                  <>
                    <span className="text-[var(--taomni-text-muted)]">Cc</span>
                    <span className="truncate" title={message.cc.map(addressLabel).join(", ")}>
                      {message.cc.map(addressLabel).filter(Boolean).join(", ")}
                    </span>
                  </>
                )}
                <span className="text-[var(--taomni-text-muted)]">Date</span>
                <span>{formatFullDate(message.dateTs) || "(unknown)"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
                <span>{currentBody?.source === "cache" ? "cached body" : currentBody?.source === "remote" ? "remote body" : "header cached"}</span>
                {message.rawSize ? <span>{formatBytes(message.rawSize)}</span> : null}
                {currentHasRemoteImages && currentKey && (
                  <button
                    type="button"
                    className="taomni-btn h-5 px-2 text-[10px]"
                    data-testid="mail-remote-images-header-toggle"
                    onClick={() => toggleRemoteForMessage(currentKey)}
                  >
                    {currentAllowsRemote ? "Block remote images" : "Load remote images"}
                  </button>
                )}
                {renderUnsubscribe(message)}
              </div>
              {currentAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {currentAttachments.length > 1 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                      title="Save all attachments"
                      onClick={() => void handleSaveAllAttachments(message, currentAttachments)}
                      disabled={downloadingAttachmentIndex !== null}
                    >
                      {downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      <span>Save all</span>
                    </button>
                  )}
                  {currentAttachments.map((attachment, index) => {
                    const downloading = downloadingAttachmentIndex === index;
                    const savingAll = downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX;
                    const name = attachment.name || `attachment-${index + 1}`;
                    return (
                      <button
                        key={`${name}-${index}`}
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                        title={`Double-click to open ${name}; right-click to save`}
                        onDoubleClick={() => void handleOpenAttachment(message, attachment, index)}
                        onContextMenu={(event) => handleAttachmentContextMenu(event, message, currentAttachments, attachment, index)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          void handleOpenAttachment(message, attachment, index);
                        }}
                        disabled={downloading || savingAll}
                      >
                        {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                        <span className="max-w-[360px] truncate">{name}</span>
                        {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <RemoteImagesBanner
              visible={currentHasRemoteImages}
              allowRemoteImages={currentAllowsRemote}
              onAllowThisMessage={() => currentKey && allowRemoteForMessage(currentKey)}
              onAllowAllInTab={() => setAllowRemoteAllInTab(true)}
              onBlock={() => currentKey && blockRemoteForMessage(currentKey)}
            />

            <div className="p-3 sm:p-4">
              <MailMessageBodyView
                html={currentBody?.html}
                text={currentBody?.text}
                snippet={message.snippet}
                allowRemoteImages={currentAllowsRemote}
                preferDark={preferDarkReader}
                fontSize={mailFontSize}
                title={message.subject || "Message body"}
                loading={loadingThisBody && !currentBody}
                onMailtoLink={openComposeFromMailto}
              />
            </div>
          </div>
        )}
      </main>
    );
  };

  const rowActions: MailRowActions = {
    selectListMessage, openMessageTab, toggleMessageChecked, toggleThreadExpanded,
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

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
      style={mailAppearance}
      data-testid="mail-client-tab"
      data-active={visible ? "true" : "false"}
    >
      <MailArchivePanel info={info} />
      <MailToolbar
  openCompose={openCompose}
  setDraftsOpen={setDraftsOpen}
  refreshDrafts={refreshDrafts}
  outboxCount={outboxCount}
  syncAllFolders={syncAllFolders}
  batchSize={batchSize}
  syncing={syncing}
  idleEnabled={idleEnabled}
  idleState={idleState}
  handleMarkSelectedRead={handleMarkSelectedRead}
  markingRead={markingRead}
  checkedUnreadCount={checkedUnreadCount}
  handleMarkFolderRead={handleMarkFolderRead}
  activeFolder={activeFolder}
  visibleUnreadCount={visibleUnreadCount}
  handleTest={handleTest}
  testing={testing}
  searchInputRef={searchInputRef}
  searchScope={searchScope}
  query={query}
  setQuery={setQuery}
  runServerSearch={runServerSearch}
  searchField={searchField}
  setSearchField={setSearchField}
  setSearchScope={setSearchScope}
  searchActive={searchActive}
  serverSearching={serverSearching}
  quickFilters={quickFilters}
  setQuickFilters={setQuickFilters}
  tagFilter={tagFilter}
  setTagFilter={setTagFilter}
  decreaseFontSize={decreaseFontSize}
  increaseFontSize={increaseFontSize}
  openTabChat={openTabChat}
  tabId={tabId}
  handleClearCache={handleClearCache}
  clearing={clearing}
  info={info}
/>

      {messageTabs.length > 0 && (
        <div className="h-8 shrink-0 flex items-end gap-1 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] overflow-x-auto">
          <button
            type="button"
            className={`h-7 max-w-[220px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${mailViewKey === "mailbox" ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
            style={{ borderColor: "var(--taomni-divider)" }}
            onClick={() => setMailViewKey("mailbox")}
          >
            <Inbox className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Mailbox</span>
          </button>
          {messageTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`h-7 max-w-[280px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${mailViewKey === tab.key ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
              style={{ borderColor: "var(--taomni-divider)" }}
              title={tab.message.subject || "(no subject)"}
              onClick={() => selectMessage(tab.message, tab.key)}
              onContextMenu={(event) => mailMenu.show(event, messageMenuItems(tab.message))}
            >
              <MailOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.message.subject || "(no subject)"}</span>
              <X
                className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                onClick={(event) => {
                  event.stopPropagation();
                  closeMessageTab(tab.key);
                }}
              />
            </button>
          ))}
        </div>
      )}

      {sentCopyNotice && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--taomni-divider)] text-[12px]" data-testid="mail-sent-copy-status" role="status">
          {sentCopyNotice.error ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />}
          <span className={`min-w-0 flex-1 break-words ${sentCopyNotice.error ? "text-red-500" : "text-[var(--taomni-text-muted)]"}`}>{sentCopyNotice.text}</span>
          <button type="button" className="taomni-btn h-6 w-6 p-0 shrink-0 inline-flex items-center justify-center" aria-label="Dismiss Sent copy status" onClick={() => setSentCopyNotice(null)}><X className="w-3 h-3" /></button>
        </div>
      )}
      {/* Reserve the status strip so transient progress never moves the toolbar or message rows. */}
      <div className="h-7 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[11px] bg-[var(--taomni-sidebar-bg)]">
        {(mutationFailure?.message || error || status) && (
          <>
            {(mutationFailure?.message || error) ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
            <span
              className={`min-w-0 flex-1 truncate ${(mutationFailure?.message || error) ? "text-red-500" : "text-[var(--taomni-text-muted)]"}`}
              title={(mutationFailure?.message || error) ?? status ?? undefined}
            >
              {(mutationFailure?.message || error) ?? status}
            </span>
            {mutationFailure?.retryable && (
              <button type="button" className="taomni-btn h-5 px-2 shrink-0" data-testid="mail-mutation-retry"
                disabled={busyAction} onClick={() => { if (retryMailActionRef.current) void runMailAction(retryMailActionRef.current, true); }}>
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
                className="ml-auto h-5 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
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
                className="ml-auto h-5 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
                onClick={() => onEditSession(info.sessionId)}
              >
                <ShieldCheck className="w-3 h-3" />
                Reauthorize
              </button>
            )}
          </>
        )}
        <div className="ml-auto min-w-0 flex items-center gap-2 overflow-x-auto">
          {mutationProgress && (
            <span className="shrink-0" role="status" data-testid="mail-mutation-progress" aria-busy={busyAction}>{mutationProgress}</span>
          )}
          {syncProgress && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-sync-progress"
              data-folder={syncProgress.folder}
              title={`Catching up ${syncProgress.folder}`}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Catching up {syncProgress.fetched}
              {syncProgress.remaining > 0 ? ` / ${syncProgress.fetched + syncProgress.remaining}` : ""}
            </span>
          )}
          {backfillProgress && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-backfill-progress"
              data-folder={backfillProgress.folder}
              title={`Downloading older headers of ${backfillProgress.folder}`}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              History {backfillProgress.cached}/{backfillProgress.total}
            </span>
          )}
          {bodyWarming.active && (
            <span
              className="h-5 shrink-0 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
              data-testid="mail-body-warming-progress"
              title={bodyWarming.folder ? `Warming ${bodyWarming.folder}` : "Warming recent message bodies"}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Bodies {bodyWarming.total > 0 ? `${bodyWarming.done}/${bodyWarming.total}` : "warming"}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {mailboxCollapsed && (
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
            onClick={expandMailboxPanel}
          >
            <ChevronDown className="w-3.5 h-3.5 -rotate-90" />
            <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
              Mailbox
            </span>
          </button>
        )}
        {mailViewKey !== "mailbox" && activeMessageTab ? (
          <div className="h-full min-h-0 border-l border-[var(--taomni-divider)]">
            {renderReaderSurface(selectedMessage ?? activeMessageTab.message)}
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
  foldersPanelRef={foldersPanelRef}
  handleMailboxResize={handleMailboxResize}
  mailboxCollapsed={mailboxCollapsed}
  loadingFolders={loadingFolders}
  setSubscriptionsOpen={setSubscriptionsOpen}
  setContactDraft={setContactDraft}
  setAddressBookOpen={setAddressBookOpen}
  info={info}
  setAgendaOpen={setAgendaOpen}
  filterErrors={filterErrors}
  setFilterDraft={setFilterDraft}
  setFiltersOpen={setFiltersOpen}
  treeFolders={treeFolders}
  selectedFolder={selectedFolder}
  dropFolder={dropFolder}
  draggedMessagesRef={draggedMessagesRef}
  setDropFolder={setDropFolder}
  handleCopyMessages={handleCopyMessages}
  handleMoveMessages={handleMoveMessages}
  handleFolderSelect={handleFolderSelect}
  mailMenu={mailMenu}
  folderMenuItems={folderMenuItems}
  cacheLine={cacheLine}
/>

          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

          <MailMessagesPane
  allFilteredMessagesChecked={allFilteredMessagesChecked}
  filteredMessages={filteredMessages}
  toggleFilteredMessagesChecked={toggleFilteredMessagesChecked}
  activeFolder={activeFolder}
  threadView={threadView}
  setThreadView={setThreadView}
  messages={messages}
  hasMoreMessages={hasMoreMessages}
  loadingMessages={loadingMessages}
  query={query}
  busyAction={busyAction}
  checkedMessages={checkedMessages}
  handleDeleteMessages={handleDeleteMessages}
  setCheckedMessageKeys={setCheckedMessageKeys}
  handleMessageListScroll={handleMessageListScroll}
  mailMenu={mailMenu}
  messageListMenuItems={messageListMenuItems}
  quickFilterActive={quickFilterActive}
  listRows={listRows}
  selectedMessageKey={selectedMessageKey}
  checkedMessageKeys={checkedMessageKeys}
  selectedFolder={selectedFolder}
  displayFolders={displayFolders}
  rowActionsRef={rowActionsRef}
  loadingMoreMessages={loadingMoreMessages}
  loadMoreMessages={loadMoreMessages}
/>

          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

          <MailReaderPane
  showReaderMenu={showReaderMenu}
  selectedMessage={selectedMessage}
  bodyLoadingKey={bodyLoadingKey}
  openReply={openReply}
  openReplyAll={openReplyAll}
  openMessagePopup={openMessagePopup}
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
  preferDarkReader={preferDarkReader}
  mailFontSize={mailFontSize}
  openComposeFromMailto={openComposeFromMailto}
/>
        </PanelGroup>
        )}
      </div>

      {attachmentMenu.render}
      {mailMenu.render}
      {confirmDialog.render}
      {textInputDialog.render}

      {composePrompt && (
        <MailComposePrompt
          prompt={composePrompt}
          onClose={() => setComposePrompt(null)}
          onAttach={() => {
            setComposePrompt(null);
            void handleAddDraftAttachments();
          }}
          onSendAnyway={() => {
            setComposePrompt(null);
            void handleSendDraft(true);
          }}
        />
      )}

      {sourceView && (
        <div className="absolute inset-0 z-[140] bg-black/35 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={`Source — ${sourceView.subject}`}
            icon={<Code className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Message source"
            minWidth={560}
            minHeight={360}
            className="w-[min(1000px,92vw)] h-[min(720px,86vh)] min-h-[420px]"
            onClose={() => setSourceView(null)}
            headerActions={(
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px]"
                onClick={() => copyText("message source", sourceView.content)}
              >
                Copy all
              </button>
            )}
          >
            <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-bg)]">
              <pre className="p-3 text-[12px] leading-5 whitespace-pre-wrap break-words taomni-mono">
                {sourceView.content}
              </pre>
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {popupMessage && (
        <div className="absolute inset-0 z-[130] bg-black/35 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={popupMessage.subject || "(no subject)"}
            icon={<MailOpen className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel={popupMessage.subject || "Mail message"}
            minWidth={640}
            minHeight={420}
            className="w-[min(1120px,92vw)] h-[min(780px,86vh)] min-h-[480px]"
            onClose={() => setPopupMessageKey(null)}
            headerActions={(
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px]"
                onClick={() => openMessageTab(popupMessage)}
              >
                Open tab
              </button>
            )}
          >
            <div className="flex-1 min-h-0">
              {renderReaderSurface(popupMessage, true)}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {certReview && (
        <div className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={`${certReview.protocol.toUpperCase()} server certificate`}
            icon={<ShieldCheck className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Server certificate"
            minWidth={420}
            minHeight={260}
            className="w-[min(620px,92vw)] min-h-[280px]"
            onClose={() => setCertReview(null)}
          >
            <div className="flex-1 min-h-0 overflow-auto p-3 text-[12px] flex flex-col gap-2" data-testid="mail-cert-dialog">
              {certReview.loading && (
                <div className="flex items-center gap-2 text-[var(--taomni-text-muted)]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching the certificate…
                </div>
              )}
              {certReview.error && <div className="text-red-500">{certReview.error}</div>}
              {certReview.info && (
                <>
                  <div className="text-[var(--taomni-warning,#d97706)]">
                    {certReview.info.trustedBySystem
                      ? "This certificate is trusted by the system."
                      : `Not trusted by the system: ${certReview.info.verifyError ?? "unknown issuer"}`}
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-x-2 gap-y-1">
                    <span className="text-[var(--taomni-text-muted)]">Server</span>
                    <span>{certReview.info.host}:{certReview.info.port}</span>
                    <span className="text-[var(--taomni-text-muted)]">Subject</span>
                    <span className="break-all">{certReview.info.subject || "(none)"}</span>
                    <span className="text-[var(--taomni-text-muted)]">Issuer</span>
                    <span className="break-all">{certReview.info.issuer || "(none)"}</span>
                    <span className="text-[var(--taomni-text-muted)]">Valid</span>
                    <span>{certReview.info.notBefore} – {certReview.info.notAfter}</span>
                    <span className="text-[var(--taomni-text-muted)]">SHA-256</span>
                    <code className="break-all font-mono text-[11px]" data-testid="mail-cert-fingerprint">
                      {certReview.info.sha256}
                    </code>
                  </div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)]">
                    Compare the fingerprint with the one your mail administrator gave you. Only this exact
                    certificate will be accepted for this server; if it changes you will be asked again.
                  </div>
                </>
              )}
            </div>
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={() => setCertReview(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-3 text-[12px]"
                data-primary="true"
                data-testid="mail-cert-trust"
                disabled={!certReview.info}
                onClick={() => void trustReviewedCertificate()}
              >
                Trust for this account
              </button>
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {undoSend && (
        <div
          className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[160] h-9 px-3 rounded shadow-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] flex items-center gap-3 text-[12px]"
          role="status"
          data-testid="mail-undo-send"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Sending in {Math.max(0, Math.ceil(undoSend.until - undoNow / 1000))}s…
          <button type="button" className="taomni-btn h-7 px-2" data-testid="mail-undo-send-button" onClick={() => void handleUndoSend()}>
            Undo
          </button>
        </div>
      )}

      {agendaOpen && info.caldav && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Agenda"
            icon={<CalendarDays className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Agenda"
            closeTestId="mail-agenda-close"
            minWidth={380}
            minHeight={300}
            className="w-[min(560px,92vw)] h-[min(520px,80vh)] min-h-[320px]"
            onClose={() => setAgendaOpen(false)}
          >
            <MailAgendaPanel
              info={info}
              revision={agendaRevision}
              onStatus={setStatus}
              onChanged={onAgendaChanged}
            />
          </MailDraggableDialog>
        </div>
      )}

      {addressBookOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Address book"
            icon={<BookUser className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Address book"
            closeTestId="mail-address-book-close"
            minWidth={420}
            minHeight={320}
            className="w-[min(640px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
            onClose={() => setAddressBookOpen(false)}
          >
            <MailAddressBookPanel
              info={info}
              initialDraft={contactDraft}
              onStatus={setStatus}
              onCompose={(entry) => {
                setAddressBookOpen(false);
                openCompose({ to: parseRecipientsText(entry.displayName ? `${entry.displayName} <${entry.emails[0]}>` : entry.emails[0]) });
              }}
            />
          </MailDraggableDialog>
        </div>
      )}

      {filtersOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Message filters"
            icon={<FilterIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Message filters"
            closeTestId="mail-filters-close"
            minWidth={460}
            minHeight={320}
            className="w-[min(720px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
            onClose={() => {
              setFiltersOpen(false);
              setFilterErrors([]);
            }}
          >
            <MailFiltersPanel
              recentErrors={filterErrors}
              accountId={info.sessionId}
              folders={displayFolders.filter(isSelectable).map((folder) => ({ name: folder.name, label: folderLabel(folder) }))}
              currentFolder={{
                name: selectedFolder,
                label: folderLabel(displayFolders.find((folder) => folder.name === selectedFolder) ?? { name: selectedFolder, displayName: selectedFolder } as MailFolder),
              }}
              initialDraft={filterDraft}
              onRun={runFiltersOnFolder}
              onStatus={setStatus}
            />
          </MailDraggableDialog>
        </div>
      )}

      {subscriptionsOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Folder subscriptions"
            icon={<ListChecks className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Folder subscriptions"
            minWidth={360}
            minHeight={280}
            className="w-[min(520px,90vw)] h-[min(520px,78vh)] min-h-[300px]"
            onClose={() => setSubscriptionsOpen(false)}
          >
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={subscribedOnly}
                  data-testid="mail-subscribed-only"
                  onChange={(event) => setSubscribedOnly(event.target.checked)}
                />
                Show only subscribed folders
              </label>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-subscriptions-dialog">
              {displayFolders.filter(isSelectable).map((folder) => {
                const subscribed = isSubscribed(folder);
                const inbox = folder.name.toUpperCase() === "INBOX";
                return (
                  <label
                    key={folder.name}
                    className="h-7 px-2 flex items-center gap-2 rounded text-[12px] hover:bg-[var(--taomni-hover)]"
                    style={{ paddingLeft: `${8 + Math.min(folderDepth(folder), 6) * 14}px` }}
                    data-testid="mail-subscription-row"
                    data-folder-name={folder.name}
                    data-subscribed={subscribed ? "true" : "false"}
                  >
                    <input
                      type="checkbox"
                      checked={subscribed}
                      disabled={inbox || subscriptionBusy != null}
                      aria-label={`Subscribe to ${folderLabel(folder)}`}
                      data-testid="mail-subscription-toggle"
                      onChange={(event) => void toggleSubscription(folder, event.target.checked)}
                    />
                    <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                    <span className="min-w-0 flex-1 truncate">{folderLabel(folder)}</span>
                    {subscriptionBusy === folder.name && <Loader2 className="w-3 h-3 animate-spin" />}
                  </label>
                );
              })}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {draftsOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={draftsTab === "drafts" ? "Drafts" : draftsTab === "templates" ? "Templates" : "Outbox"}
            icon={<FileText className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Drafts and templates"
            minWidth={420}
            minHeight={300}
            className="w-[min(680px,90vw)] h-[min(520px,78vh)] min-h-[340px]"
            onClose={() => setDraftsOpen(false)}
          >
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
              <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={() => void refreshDrafts()} disabled={draftsLoading}>
                {draftsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
              <div className="flex items-center gap-1" role="tablist" aria-label="Drafts and templates">
                {(["drafts", "templates", "outbox"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={draftsTab === tab}
                    data-testid={`mail-drafts-tab-${tab}`}
                    className={`taomni-btn h-7 px-2 text-[12px] ${draftsTab === tab ? "text-[var(--taomni-accent)]" : ""}`}
                    onClick={() => setDraftsTab(tab)}
                  >
                    {tab === "drafts" ? "Drafts" : tab === "templates" ? "Templates" : `Outbox${outboxCount > 0 ? ` (${outboxCount})` : ""}`}
                  </button>
                ))}
              </div>
              <span className="text-[12px] text-[var(--taomni-text-muted)]">
                {visibleDrafts.length} {draftsTab === "drafts" ? "draft" : draftsTab === "templates" ? "template" : "queued message"}{visibleDrafts.length === 1 ? "" : "s"}
              </span>
              {draftsTab === "outbox" && (
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-[12px] ml-auto inline-flex items-center gap-1.5"
                  data-testid="mail-outbox-send-all"
                  disabled={visibleDrafts.length === 0}
                  onClick={() => void processOutbox(true)}
                  title="Send every queued message now"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send all
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-drafts-dialog">
              {visibleDrafts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  {draftsTab === "drafts"
                    ? "No saved drafts"
                    : draftsTab === "templates"
                      ? "No templates. Use \"Save as template\" in the composer."
                      : "The Outbox is empty. Queued and scheduled messages send while this tab is open."}
                </div>
              ) : visibleDrafts.map((saved) => (
                <div
                  key={saved.id}
                  className="min-h-14 px-2 py-1.5 rounded border border-transparent hover:border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-2"
                  data-testid={isOutbox(saved) ? "mail-outbox-row" : isTemplate(saved) ? "mail-template-row" : "mail-draft-row"}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (isTemplate(saved) ? openFromTemplate(saved) : openSavedDraft(saved))}
                  >
                    <div className="text-[12px] font-semibold truncate">{saved.subject || "(no subject)"}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                      {[...saved.to, ...saved.cc, ...saved.bcc].join(", ") || "(no recipients)"}
                    </div>
                    {isOutbox(saved) && (() => {
                      const state = outboxState(saved)!;
                      const at = outboxNextAttemptAt(state);
                      return (
                        <div className="text-[10px] text-[var(--taomni-text-muted)]" data-testid="mail-outbox-state">
                          {at ? `Sends ${new Date(at * 1000).toLocaleString()}` : "Waiting for Send now"}
                          {state.lastError ? ` · attempt ${state.attempts} failed: ${state.lastError}` : ""}
                        </div>
                      );
                    })()}
                    <div className="text-[10px] text-[var(--taomni-text-muted)]">
                      {formatShortDate(saved.updatedAt)}
                      {saved.attachments.length > 0 ? ` · ${saved.attachments.length} attachment${saved.attachments.length === 1 ? "" : "s"}` : ""}
                    </div>
                  </button>
                  {isOutbox(saved) && (
                    <button
                      type="button"
                      className="taomni-btn h-7 px-2 text-[12px] inline-flex items-center gap-1"
                      data-testid="mail-outbox-send"
                      title="Send this message now"
                      onClick={() => void sendOutboxItem(saved, true)}
                    >
                      <Send className="w-3.5 h-3.5" />
                      Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                    title="Delete draft"
                    onClick={() => void deleteSavedDraft(saved)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {composeOpen && (
        <MailComposer
  composeRootRef={composeRootRef}
  sending={sending}
  setComposeDragActive={setComposeDragActive}
  addDraftAttachmentPaths={addDraftAttachmentPaths}
  handleDropComposeFiles={handleDropComposeFiles}
  draft={draft}
  setComposeOpen={setComposeOpen}
  setComposePrompt={setComposePrompt}
  saveCurrentDraft={saveCurrentDraft}
  savingDraft={savingDraft}
  handleAddDraftAttachments={handleAddDraftAttachments}
  setDraft={setDraft}
  attachProgress={attachProgress}
  tabId={tabId}
  identityById={identityById}
  identities={identities}
  recipientSuggestionsFor={recipientSuggestionsFor}
  defaultMailDomain={defaultMailDomain}
  recipientSearch={recipientSearch}
  handleRecipientQueryChange={handleRecipientQueryChange}
  composeDragActive={composeDragActive}
  handleInsertInlineImage={handleInsertInlineImage}
  handlePasteImages={handlePasteImages}
  removeDraftAttachment={removeDraftAttachment}
  saveCurrentAsTemplate={saveCurrentAsTemplate}
  discardCurrentDraft={discardCurrentDraft}
  setSendLaterAt={setSendLaterAt}
  setSendLaterOpen={setSendLaterOpen}
  sendLaterOpen={sendLaterOpen}
  sendLaterAt={sendLaterAt}
  handleSendLater={handleSendLater}
  handleSendDraft={handleSendDraft}
/>
      )}
    </div>
  );
}
