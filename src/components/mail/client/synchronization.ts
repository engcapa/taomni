import { type SetStateAction } from "react";
import { mailSyncAllFolders, mailSyncFolder, type MailFolder, type MailFolderSyncResult, type MailMessageHeader, type MailSyncRequestMode } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";
import { countNewMail, folderHasMoreToLoad, mergeSyncedMessages, runFolderSyncLoop } from "../../../lib/mailSync";
import { type SyncIndicator, type SyncFolderOptions } from "./types";
import { sortMessages, mailClientErrorMessage, delay } from "./messages";



export interface RunFolderSyncContext {
  syncGenerationRef: import("react").RefObject<number>;
  info: import("../../../types").MailTabInfo;
  catchupBatchSize: number;
  applySyncedFolder: (folder: MailFolder) => void;
  visibleRef: import("react").RefObject<boolean>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  selectedFolderRef: import("react").RefObject<string>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  pageSize: number;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setSyncProgress: import("react").Dispatch<SetStateAction<{ folder: string; fetched: number; remaining: number; } | null>>;
  reloadVisibleFromCache: (folder: string) => Promise<void>;
  incomingFiltersRef: import("react").RefObject<(() => Promise<void>) | null>;
}


export function createRunFolderSync(controllerContext: RunFolderSyncContext): (folder: string, options?: { mode?: MailSyncRequestMode; indicator?: SyncIndicator; maxSteps?: number; }) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult> {
  return async (folder: string, options: {
    mode?: MailSyncRequestMode;
    indicator?: SyncIndicator;
    maxSteps?: number;
  } = {}) => {
    const generation = controllerContext.syncGenerationRef.current;
    const indicator = options.indicator ?? "none";
    let changed = false;
    try {
      const loop = await runFolderSyncLoop({
        mode: options.mode ?? "auto",
        maxSteps: options.maxSteps ?? 40,
        isCancelled: () => controllerContext.syncGenerationRef.current !== generation,
        step: (mode) => mailSyncFolder(controllerContext.info, folder, { mode, limit: controllerContext.catchupBatchSize, includeBodies: false }),
        onStep: (result, progress) => {
          if (result.fetched > 0 || result.vanished > 0 || result.flagsUpdated > 0) changed = true;
          controllerContext.applySyncedFolder(result.folder);
          if (!controllerContext.visibleRef.current) {
            controllerContext.pendingCacheRefreshRef.current = true;
            return;
          }
          const merged = mergeSyncedMessages(
            controllerContext.selectedFolderRef.current,
            folder,
            controllerContext.messagesRef.current,
            result.messages,
            sortMessages,
            // Sync indexes all messages, but must not expand the rendered page.
            // Preserve explicitly loaded depth; older rows remain available via
            // Load older messages after the final cache refresh.
            Math.max(controllerContext.pageSize, controllerContext.messagesRef.current.length),
          );
          if (merged) {
            controllerContext.setMessages(merged);
          }
          if (result.uidValidityReset) {
            controllerContext.setStatus(`${folderLabel(result.folder)} was rebuilt on the server; resynced`);
          }
          if (indicator !== "none" && result.more) {
            controllerContext.setSyncProgress({ folder, fetched: progress.fetched, remaining: progress.remaining });
          }
        },
      });
      if (changed && controllerContext.info.cache.enabled) await controllerContext.reloadVisibleFromCache(folder);
      if (loop.fetched > 0 && folder.trim().toUpperCase() === "INBOX") {
        await controllerContext.incomingFiltersRef.current?.();
      }
      return loop;
    } finally {
      if (indicator !== "none" && controllerContext.visibleRef.current) controllerContext.setSyncProgress(null);
    }
  };
}



export interface QueueFolderCatchupsContext {
  pendingCatchupsRef: import("react").RefObject<{ folders: Map<string, { mode: MailSyncRequestMode; reconcile: MailSyncRequestMode; }>; running: boolean; disposed: boolean; }>;
  syncInFlightRef: import("react").RefObject<boolean>;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  runFolderSync: (folder: string, options?: { mode?: MailSyncRequestMode; indicator?: SyncIndicator; maxSteps?: number; }) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult>;
  isNewMailExcludedName: (name: string) => boolean;
  notifyNewMail: (count: number) => void;
  visibleRef: import("react").RefObject<boolean>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  loadCachedFolders: () => Promise<void>;
}


export function createQueueFolderCatchups(controllerContext: QueueFolderCatchupsContext): (names: string[], reconcile: MailSyncRequestMode) => void {
  return (names: string[], reconcile: MailSyncRequestMode) => {
    const queue = controllerContext.pendingCatchupsRef.current;
    for (const name of names) queue.folders.set(name, { mode: "auto", reconcile });
    if (queue.running || queue.disposed || queue.folders.size === 0) return;
    queue.running = true;
    void (async () => {
      try {
        while (!queue.disposed && queue.folders.size > 0) {
          if (controllerContext.syncInFlightRef.current || controllerContext.manualSyncPendingRef.current) {
            await delay(50);
            continue;
          }
          const [name, task] = queue.folders.entries().next().value!;
          queue.folders.delete(name);
          controllerContext.syncInFlightRef.current = true;
          try {
            const result = await controllerContext.runFolderSync(name, { mode: task.mode, maxSteps: 1 });
            if (queue.disposed) return;
            if (result.last?.more) queue.folders.set(name, task);
            else if (task.mode === "auto") {
              // A scan with a pending catch-up cannot reconcile the older range
              // yet. Do it after the final header batch, including remote deletes.
              queue.folders.set(name, { ...task, mode: task.reconcile });
            }
            if (!controllerContext.isNewMailExcludedName(name)) controllerContext.notifyNewMail(result.newUnseen);
          } catch (e) {
            // Do not spin indefinitely on an unavailable folder. Its durable
            // watermark survives, and the next scan/Retry resumes it.
            if (!queue.disposed && controllerContext.visibleRef.current) {
              controllerContext.setError(`${name}: ${mailClientErrorMessage(e)}`);
              void controllerContext.loadCachedFolders();
            }
          } finally {
            controllerContext.syncInFlightRef.current = false;
          }
          await delay(50);
        }
      } finally {
        queue.running = false;
      }
    })();
  };
}



export interface StartBackfillContext {
  foldersRef: import("react").RefObject<MailFolder[]>;
  info: import("../../../types").MailTabInfo;
  backfillSeqRef: import("react").RefObject<number>;
  visibleRef: import("react").RefObject<boolean>;
  selectedFolderRef: import("react").RefObject<string>;
  syncInFlightRef: import("react").RefObject<boolean>;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  catchupBatchSize: number;
  applySyncedFolder: (folder: MailFolder) => void;
  setBackfillProgress: import("react").Dispatch<SetStateAction<{ folder: string; cached: number; total: number; } | null>>;
  setHasMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
}


export function createStartBackfill(controllerContext: StartBackfillContext): (folder: string) => void {
  return (folder: string) => {
    const meta = controllerContext.foldersRef.current.find((entry) => entry.name === folder);
    if (!controllerContext.info.cache.enabled || !meta || meta.syncComplete || meta.syncHighUid == null) return;
    const seq = controllerContext.backfillSeqRef.current + 1;
    controllerContext.backfillSeqRef.current = seq;
    const active = () =>
      controllerContext.backfillSeqRef.current === seq && controllerContext.visibleRef.current && controllerContext.selectedFolderRef.current === folder;
    void (async () => {
      try {
        for (let round = 0; round < 1000; round += 1) {
          if (!active()) return;
          if (controllerContext.syncInFlightRef.current || controllerContext.manualSyncPendingRef.current) {
            await delay(800);
            continue;
          }
          controllerContext.syncInFlightRef.current = true;
          let result: MailFolderSyncResult;
          try {
            result = await mailSyncFolder(controllerContext.info, folder, { mode: "backfill", limit: controllerContext.catchupBatchSize });
          } finally {
            controllerContext.syncInFlightRef.current = false;
          }
          controllerContext.applySyncedFolder(result.folder);
          if (!active()) return;
          const cached = result.folder.cachedCount ?? 0;
          const total = result.folder.total ?? cached;
          if (!result.more) {
            controllerContext.setBackfillProgress(null);
            controllerContext.setHasMoreMessages(folderHasMoreToLoad(
              result.folder,
              controllerContext.messagesRef.current.filter((message) => message.folder === folder).length,
              false,
            ));
            return;
          }
          controllerContext.setBackfillProgress({ folder, cached, total });
          controllerContext.setHasMoreMessages(true);
          await delay(200);
        }
      } catch (e) {
        console.debug("mail history backfill paused", e);
      } finally {
        if (controllerContext.backfillSeqRef.current === seq && controllerContext.visibleRef.current) controllerContext.setBackfillProgress(null);
      }
    })();
  };
}



export interface SyncFolderNowContext {
  syncInFlightRef: import("react").RefObject<boolean>;
  visibleRef: import("react").RefObject<boolean>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  syncGenerationRef: import("react").RefObject<number>;
  setSyncing: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  runFolderSync: (folder: string, options?: { mode?: MailSyncRequestMode; indicator?: SyncIndicator; maxSteps?: number; }) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult>;
  isNewMailExcludedName: (name: string) => boolean;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  notifyNewMail: (count: number) => void;
  loadCachedFolders: () => Promise<void>;
}


export function createSyncFolderNow(controllerContext: SyncFolderNowContext): (folder: string, indicator?: SyncIndicator, notify?: boolean) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult | null> {
  return async (
    folder: string,
    indicator: SyncIndicator = "sync",
    notify = false,
  ) => {
    if (controllerContext.syncInFlightRef.current) {
      if (indicator !== "none" && controllerContext.visibleRef.current) controllerContext.setStatus("Mail sync already running");
      return null;
    }
    controllerContext.syncInFlightRef.current = true;
    controllerContext.syncGenerationRef.current += 1;
    if (indicator === "sync") controllerContext.setSyncing(true);
    if (indicator !== "none") controllerContext.setError(null);
    try {
      const primary = await controllerContext.runFolderSync(folder, { indicator });
      let fetched = primary.fetched;
      let newUnseen = controllerContext.isNewMailExcludedName(folder) ? 0 : primary.newUnseen;
      if (!controllerContext.manualSyncPendingRef.current && folder.trim().toUpperCase() !== "INBOX") {
        try {
          const inbox = await controllerContext.runFolderSync("INBOX");
          fetched += inbox.fetched;
          newUnseen += inbox.newUnseen;
        } catch (e) {
          console.debug("mail INBOX catch-up failed", e);
        }
      }
      if (notify) controllerContext.notifyNewMail(newUnseen);
      if (indicator !== "none" && controllerContext.visibleRef.current) {
        controllerContext.setStatus(fetched > 0 ? `Synced ${fetched} headers` : "Mailbox up to date");
      }
      return primary;
    } catch (e) {
      if (controllerContext.visibleRef.current) {
        if (indicator !== "none") controllerContext.setError(mailClientErrorMessage(e));
        // Surface the folder failure recorded by the backend.
        void controllerContext.loadCachedFolders();
      }
      return null;
    } finally {
      controllerContext.syncInFlightRef.current = false;
      if (indicator === "sync" && controllerContext.visibleRef.current) controllerContext.setSyncing(false);
    }
  };
}



export interface SyncSelectedFolderContext {
  folderSelectSeqRef: import("react").RefObject<number>;
  visibleRef: import("react").RefObject<boolean>;
  selectedFolderRef: import("react").RefObject<string>;
  syncInFlightRef: import("react").RefObject<boolean>;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  syncFolderNow: (folder: string, indicator?: SyncIndicator, notify?: boolean) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult | null>;
  startBackfill: (folder: string) => void;
}


export function createSyncSelectedFolder(controllerContext: SyncSelectedFolderContext): (folder: string) => Promise<void> {
  return async (folder: string) => {
    // A user folder switch must survive an existing poll/catch-up. Keep only
    // the latest selection eligible so rapid switches do not queue old work.
    const sequence = ++controllerContext.folderSelectSeqRef.current;
    const current = () => controllerContext.folderSelectSeqRef.current === sequence
      && controllerContext.visibleRef.current && controllerContext.selectedFolderRef.current === folder;
    while (controllerContext.syncInFlightRef.current || controllerContext.manualSyncPendingRef.current) {
      if (!current()) return;
      await delay(50);
    }
    if (!current()) return;
    await controllerContext.syncFolderNow(folder, "none");
    if (current()) controllerContext.startBackfill(folder);
  };
}



export interface QuietPollSelectedAndInboxContext {
  syncInFlightRef: import("react").RefObject<boolean>;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  selectedFolderRef: import("react").RefObject<string>;
  runFolderSync: (folder: string, options?: { mode?: MailSyncRequestMode; indicator?: SyncIndicator; maxSteps?: number; }) => Promise<import("../../../lib/mailSync").FolderSyncLoopResult>;
  isNewMailExcludedName: (name: string) => boolean;
  info: import("../../../types").MailTabInfo;
  notifyNewMail: (count: number) => void;
}


export function createQuietPollSelectedAndInbox(controllerContext: QuietPollSelectedAndInboxContext): () => Promise<void> {
  return async () => {
    if (controllerContext.syncInFlightRef.current || controllerContext.manualSyncPendingRef.current) return;
    controllerContext.syncInFlightRef.current = true;
    const activeFolder = controllerContext.selectedFolderRef.current;
    try {
      const selected = await controllerContext.runFolderSync(activeFolder, { maxSteps: 10 });
      let newUnseen = controllerContext.isNewMailExcludedName(activeFolder) ? 0 : selected.newUnseen;
      if (!controllerContext.manualSyncPendingRef.current && activeFolder.trim().toUpperCase() !== "INBOX") {
        try {
          newUnseen += (await controllerContext.runFolderSync("INBOX", { maxSteps: 10 })).newUnseen;
        } catch (e) {
          // Selected-folder refresh already succeeded; inbox is best-effort.
          console.debug("quiet INBOX poll failed", e);
        }
      }
      if (controllerContext.info.cache.enabled && !controllerContext.manualSyncPendingRef.current) {
        try {
          await controllerContext.runFolderSync(activeFolder, { mode: "reconcile", maxSteps: 3 });
        } catch (e) {
          console.debug("quiet mail reconcile failed", e);
        }
      }
      controllerContext.notifyNewMail(newUnseen);
    } catch (e) {
      console.debug("quiet mail poll failed", e);
    } finally {
      controllerContext.syncInFlightRef.current = false;
    }
  };
}



export interface SyncAllFoldersContext {
  batchSize: number;
  selectedFolderRef: import("react").RefObject<string>;
  manualSyncPendingRef: import("react").RefObject<boolean>;
  syncGenerationRef: import("react").RefObject<number>;
  syncInFlightRef: import("react").RefObject<boolean>;
  setSyncing: import("react").Dispatch<SetStateAction<boolean>>;
  visibleRef: import("react").RefObject<boolean>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  subscribedOnlyRef: import("react").RefObject<boolean>;
  foldersRef: import("react").RefObject<MailFolder[]>;
  isNewMailExcludedFolder: (folder: MailFolder) => boolean;
  queueFolderCatchups: (names: string[], reconcile: MailSyncRequestMode) => void;
  notifyNewMail: (count: number) => void;
  incomingFiltersRef: import("react").RefObject<(() => Promise<void>) | null>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  loadCachedMessages: (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<{ page: MailMessageHeader[]; hasMore: boolean; }>;
  pageSize: number;
  warmRecentBodies: (foldersToWarm: MailFolder[], preferredFolder: string) => Promise<void>;
  startBackfill: (folder: string) => void;
}


export function createSyncAllFolders(controllerContext: SyncAllFoldersContext): (quiet?: boolean, options?: Pick<SyncFolderOptions, "limit" | "includeBodies" | "indicator">) => Promise<import("../../../lib/mail").MailSyncAllResult | null> {
  return async (
    quiet = false,
    options: Pick<SyncFolderOptions, "limit" | "includeBodies" | "indicator"> = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const limit = Math.max(1, options.limit ?? controllerContext.batchSize);
    const includeBodies = options.includeBodies ?? false;
    const activeBeforeSync = controllerContext.selectedFolderRef.current;
    const manual = !quiet && indicator !== "none";
    if (manual) {
      controllerContext.manualSyncPendingRef.current = true;
      // Existing catch-up loops yield after their current bounded step.
      controllerContext.syncGenerationRef.current += 1;
    }

    if (controllerContext.syncInFlightRef.current) {
      // Background work (open catch-up, backfill, quiet poll) holds the lock.
      // Periodic scans just skip; a manual sync waits its turn instead of
      // being dropped, so a click always ends with fresh server state.
      if (quiet || indicator === "none") return null;
      if (indicator === "sync") controllerContext.setSyncing(true);
      if (controllerContext.visibleRef.current) controllerContext.setStatus("Waiting for current mail sync…");
      const deadline = Date.now() + 120_000;
      while (controllerContext.syncInFlightRef.current && Date.now() < deadline) {
        await delay(150);
      }
      if (controllerContext.syncInFlightRef.current) {
        controllerContext.manualSyncPendingRef.current = false;
        if (indicator === "sync" && controllerContext.visibleRef.current) controllerContext.setSyncing(false);
        if (controllerContext.visibleRef.current) controllerContext.setStatus("Mail sync already running");
        return null;
      }
    }
    controllerContext.syncInFlightRef.current = true;
    controllerContext.manualSyncPendingRef.current = false;

    if (indicator === "sync") {
      controllerContext.setSyncing(true);
    }
    if (!quiet && indicator !== "none") controllerContext.setStatus(null);
    if (indicator !== "none") controllerContext.setError(null);

    try {
      // Manual sync reconciles every cached message; periodic scans only the newest window.
      const result = await mailSyncAllFolders(
        { ...controllerContext.info, sync: { ...controllerContext.info.sync, subscribedOnly: controllerContext.subscribedOnlyRef.current } },
        { limit, includeBodies, fullReconcile: !quiet },
      );
      controllerContext.foldersRef.current = result.folders;
      const newMessages = countNewMail(result.newUnseenByFolder, result.folders, controllerContext.isNewMailExcludedFolder);
      const pending = (result.pendingFolders ?? [])
        .slice()
        .sort((a, b) => Number(b === activeBeforeSync) - Number(a === activeBeforeSync));
      controllerContext.queueFolderCatchups(pending, quiet ? "reconcile" : "reconcileFull");
      if (indicator === "none") controllerContext.notifyNewMail(newMessages);
      // New INBOX mail from the full scan goes through the incoming filters
      // (a cheap cache query when nothing is new or no filter is enabled).
      if (result.fetchedMessages > 0) await controllerContext.incomingFiltersRef.current?.();
      if (!controllerContext.visibleRef.current) {
        controllerContext.pendingCacheRefreshRef.current = true;
        return result;
      }
      controllerContext.setFolders(controllerContext.foldersRef.current);
      const currentFolder = controllerContext.selectedFolderRef.current;
      const nextFolder = controllerContext.foldersRef.current.some((folder) => folder.name === currentFolder)
        ? currentFolder
        : controllerContext.foldersRef.current[0]?.name ?? currentFolder;
      if (nextFolder !== currentFolder) {
        controllerContext.updateSelectedFolder(nextFolder);
      }
      const loaded = controllerContext.messagesRef.current.filter((message) => message.folder === nextFolder).length;
      await controllerContext.loadCachedMessages(nextFolder, 0, false, quiet || indicator === "none", Math.max(controllerContext.pageSize, loaded));
      const failed = result.failedFolders ?? [];
      if (indicator !== "none") {
        controllerContext.setStatus(
          `Synced ${result.fetchedMessages} new headers across ${result.folders.length} folders`
          + (failed.length > 0 ? `; ${failed.length} folder${failed.length === 1 ? "" : "s"} failed` : "")
          + (pending.length > 0 ? "; remaining headers syncing in background" : ""),
        );
      }
      void controllerContext.warmRecentBodies(controllerContext.foldersRef.current, nextFolder);
      controllerContext.startBackfill(nextFolder);
      return result;
    } catch (e) {
      if (indicator !== "none") controllerContext.setError(mailClientErrorMessage(e));
      return null;
    } finally {
      controllerContext.syncInFlightRef.current = false;
      if (indicator === "sync") {
        if (controllerContext.visibleRef.current) controllerContext.setSyncing(false);
      }
    }
  };
}
