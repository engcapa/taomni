import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { mailIdleStart, mailIdleStop, MAIL_IDLE_EVENT, type MailFolder, type MailIdleEvent, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { listen } from "@tauri-apps/api/event";
import { type OpenMailMessageTab, type BodyWarmState } from "./types";
import { messageKey } from "./messages";


export interface UseMailboxLifecycleContext {
  loadCachedMessages: (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<import("./types").MailCachePageResult>;
  initialSyncDoneRef: import("react").RefObject<boolean>;
  foldersRef: import("react").RefObject<MailFolder[]>;
  bodyWarmSeqRef: import("react").RefObject<number>;
  bodyLoadSeqRef: import("react").RefObject<number>;
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
  bodyRequestsRef: import("react").RefObject<Map<string, Promise<MailMessageBody>>>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setSelectedMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  setMailViewKey: import("react").Dispatch<SetStateAction<string>>;
  setMessageTabs: import("react").Dispatch<SetStateAction<OpenMailMessageTab[]>>;
  setPopupMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
  setBody: import("react").Dispatch<SetStateAction<MailMessageBody | null>>;
  setBodyCache: import("react").Dispatch<SetStateAction<Map<string, MailMessageBody>>>;
  setBodyLoadingKey: import("react").Dispatch<SetStateAction<string | null>>;
  setBodyWarming: import("react").Dispatch<SetStateAction<BodyWarmState>>;
  setHasMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setLoadingMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setDownloadingAttachmentIndex: import("react").Dispatch<SetStateAction<number | null>>;
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
  loadCachedFolders: () => Promise<void>;
  info: import("../../../types").MailTabInfo;
  selectedFolder: string;
  visible: boolean;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  syncFolderNow: (folder: string, indicator?: import("./types").SyncIndicator, notify?: boolean) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult | null>;
  refreshFolderTree: () => Promise<void>;
  startBackfill: (folder: string) => void;
  syncAllFolders: (quiet?: boolean, options?: Pick<import("./types").SyncFolderOptions, "limit" | "includeBodies" | "indicator">) => Promise<import("../../../lib/mail").MailSyncAllResult | null>;
  batchSize: number;
  quietPollSelectedAndInbox: () => Promise<void>;
  syncInFlightRef: import("react").RefObject<boolean>;
  availableMessages: MailMessageHeader[];
  selectedMessageKey: string | null;
  messageTabs: OpenMailMessageTab[];
}

export function useMailboxLifecycle(context: UseMailboxLifecycleContext) {
  const {
    loadCachedMessages,
    initialSyncDoneRef,
    foldersRef,
    bodyWarmSeqRef,
    bodyLoadSeqRef,
    bodyCacheRef,
    bodyRequestsRef,
    setFolders,
    setMessages,
    setSelectedMessageKey,
    setMailViewKey,
    setMessageTabs,
    setPopupMessageKey,
    setCheckedMessageKeys,
    setBody,
    setBodyCache,
    setBodyLoadingKey,
    setBodyWarming,
    setHasMoreMessages,
    setLoadingMoreMessages,
    setDownloadingAttachmentIndex,
    updateSelectedFolder,
    loadCachedFolders,
    info,
    selectedFolder,
    visible,
    pendingCacheRefreshRef,
    syncFolderNow,
    refreshFolderTree,
    startBackfill,
    syncAllFolders,
    batchSize,
    quietPollSelectedAndInbox,
    syncInFlightRef,
    availableMessages,
    selectedMessageKey,
    messageTabs,
  } = context;

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
    }).catch(() => { });
    void mailIdleStart(idleConfigRef.current, "INBOX").catch((e) => {
      console.debug("mail IDLE unavailable; polling only", e);
      if (!disposed) setIdleState("unsupported");
    });
    return () => {
      disposed = true;
      if (debounce != null) window.clearTimeout(debounce);
      unlisten?.();
      void mailIdleStop(accountId).catch(() => { });
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
  return { idleEnabled, idleState };
}
