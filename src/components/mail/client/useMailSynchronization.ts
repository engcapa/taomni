import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { notifyDesktop } from "../../../lib/lanNotify";
import { mailListFolders, type MailFolder, type MailMessageHeader, type MailSyncRequestMode } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";
import { mergeFolderMeta } from "../../../lib/mailSync";
import { useTaoAlertStore } from "../../../stores/taoAlertStore";
import { NEW_MAIL_EXCLUDED_KINDS, folderMatchesSpecial } from "./folders";
import { catchupStepSize, refreshBatchSize } from "./messages";
import type { MailSubscriptionSnapshots } from "./subscriptionSnapshots";
import {
  createQueueFolderCatchups,
  createQuietPollSelectedAndInbox,
  createRunFolderSync,
  createStartBackfill,
  createSyncAllFolders,
  createSyncFolderNow,
  createSyncSelectedFolder,
} from "./synchronization";

export interface UseMailSynchronizationContext {
  folderSnapshots: MailSubscriptionSnapshots;
  info: import("../../../types").MailTabInfo;
  foldersRef: import("react").RefObject<MailFolder[]>;
  tabId: string;
  visibleRef: import("react").RefObject<boolean>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  selectedFolderRef: import("react").RefObject<string>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  pageSize: number;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setLoadingStatus: import("react").Dispatch<SetStateAction<string | null>>;
  reloadVisibleFromCache: (folder: string) => Promise<void>;
  incomingFiltersRef: import("react").RefObject<(() => Promise<void>) | null>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  loadCachedFolders: () => Promise<void>;
  setHasMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  subscribedOnlyRef: import("react").RefObject<boolean>;
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
  loadCachedMessages: (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<{ page: MailMessageHeader[]; hasMore: boolean; }>;
  warmRecentBodies: (foldersToWarm: MailFolder[], preferredFolder: string) => Promise<void>;
}

export function useMailSynchronization(context: UseMailSynchronizationContext) {
  const {
    info,
    folderSnapshots,
    foldersRef,
    tabId,
    visibleRef,
    setFolders,
    pendingCacheRefreshRef,
    selectedFolderRef,
    messagesRef,
    pageSize,
    setMessages,
    setStatus,
    setLoadingStatus,
    reloadVisibleFromCache,
    incomingFiltersRef,
    setError,
    loadCachedFolders,
    setHasMoreMessages,
    subscribedOnlyRef,
    updateSelectedFolder,
    loadCachedMessages,
    warmRecentBodies,
  } = context;
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ folder: string; fetched: number; remaining: number; } | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<{ folder: string; cached: number; total: number; } | null>(null);
  const initialSyncDoneRef = useRef(false);
  /** Bumped by user-driven syncs; stale catch-up loops stop at their next step. */
  const syncGenerationRef = useRef(0);
  const backfillSeqRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const manualSyncPendingRef = useRef(false);
  const pendingCatchupsRef = useRef({ folders: new Map<string, { mode: MailSyncRequestMode; reconcile: MailSyncRequestMode; }>(), running: false, disposed: false });
  useEffect(() => {
    const queue = { folders: new Map<string, { mode: MailSyncRequestMode; reconcile: MailSyncRequestMode; }>(), running: false, disposed: false };
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
  const pushMailNew = useTaoAlertStore((s) => s.pushMailNew);
  const batchSize = useMemo(() => refreshBatchSize(info), [info.sync.maxFetchPerSync]);
  const catchupBatchSize = useMemo(() => catchupStepSize(info), [info.sync.maxFetchPerSync]);

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

  const applySyncedFolder = useCallback((folder: MailFolder, readRevision: number) => {
    const next = folderSnapshots.merge(mergeFolderMeta(foldersRef.current, folder), readRevision);
    foldersRef.current = next;
    if (visibleRef.current) setFolders(next);
  }, [folderSnapshots]);

  /** Remote LIST on open so a new account shows every folder at once. */
  const refreshFolderTree = useCallback(async () => {
    const readRevision = folderSnapshots.capture();
    try {
      const listed = await mailListFolders(info);
      if (listed.length === 0) return;
      // Keep counts/watermarks a concurrent sync may have just updated.
      const byName = new Map(foldersRef.current.map((entry) => [entry.name, entry]));
      const next = folderSnapshots.merge(listed.map((entry) => {
        const known = byName.get(entry.name);
        return known ? { ...entry, ...known, flags: entry.flags } : entry;
      }), readRevision);
      foldersRef.current = next;
      if (visibleRef.current) setFolders(next);
    } catch (e) {
      console.debug("mail folder LIST failed", e);
    }
  }, [folderSnapshots, info]);

  /**
   * Run gap-free sync steps for one folder until the backend reports no more
   * work (bounded by maxSteps). New headers appear as each step lands; the
   * visible list is then reloaded from the cache so deletions and flag
   * changes from other clients show up too.
   */
  const runFolderSync = useCallback(createRunFolderSync({
    folderSnapshots,
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
    folderSnapshots,
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
    setLoadingStatus,
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
    folderSnapshots,
    batchSize,
    selectedFolderRef,
    manualSyncPendingRef,
    syncGenerationRef,
    syncInFlightRef,
    setSyncing,
    visibleRef,
    setStatus,
    setLoadingStatus,
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
  return { setSyncing, initialSyncDoneRef, syncFolderNow, refreshFolderTree, startBackfill, syncAllFolders, batchSize, quietPollSelectedAndInbox, syncInFlightRef, backfillSeqRef, setBackfillProgress, syncSelectedFolder, applySyncedFolder, runFolderSync, syncing, syncProgress, backfillProgress };
}
