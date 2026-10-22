import { type SetStateAction } from "react";
import { mailGetMessageBody, mailPrefetchMessageBody, mailListCachedFolders, mailListCachedMessages, mailSyncFolder, mailSyncHeaders, type MailFolder, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { folderHasMoreToLoad, mergeSyncedMessages } from "../../../lib/mailSync";
import { type OpenMailMessageTab, type BodyWarmState } from "./types";
import { messageKey, sortMessages, mailClientErrorMessage, bodyMatchesMessage, mergeMessagePages, delay } from "./messages";


export interface LoadCachedFoldersContext {
  visibleRef: import("react").RefObject<boolean>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  setLoadingFolders: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  foldersRef: import("react").RefObject<MailFolder[]>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
}


export function createLoadCachedFolders(controllerContext: LoadCachedFoldersContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.visibleRef.current) {
      controllerContext.pendingCacheRefreshRef.current = true;
      return;
    }
    controllerContext.setLoadingFolders(true);
    controllerContext.setError(null);
    try {
      const cached = await mailListCachedFolders(controllerContext.info.sessionId);
      if (!controllerContext.visibleRef.current) {
        controllerContext.pendingCacheRefreshRef.current = true;
        return;
      }
      controllerContext.foldersRef.current = cached;
      controllerContext.setFolders(cached);
      controllerContext.updateSelectedFolder((current) =>
        cached.length > 0 && !cached.some((folder) => folder.name === current)
          ? cached[0].name
          : current,
      );
    } catch (e) {
      controllerContext.setError(mailClientErrorMessage(e));
    } finally {
      controllerContext.setLoadingFolders(false);
    }
  };
}



export interface LoadCachedMessagesContext {
  visibleRef: import("react").RefObject<boolean>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  setLoadingMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setLoadingMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setHasMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  pageSize: number;
  cacheRemovalVersionsRef: import("react").RefObject<Map<string, number>>;
  cacheRequestSeqRef: import("react").RefObject<number>;
  info: import("../../../types").MailTabInfo;
  selectedFolderRef: import("react").RefObject<string>;
  foldersRef: import("react").RefObject<MailFolder[]>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createLoadCachedMessages(controllerContext: LoadCachedMessagesContext): (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<{ page: MailMessageHeader[]; hasMore: boolean; }> {
  return async (
    folder: string,
    offset = 0,
    append = false,
    quiet = false,
    limitOverride?: number,
  ) => {
    if (!controllerContext.visibleRef.current) {
      controllerContext.pendingCacheRefreshRef.current = true;
      return { page: [] as MailMessageHeader[], hasMore: false };
    }
    const sequence = ++controllerContext.cacheRequestSeqRef.current;
    const current = () => controllerContext.cacheRequestSeqRef.current === sequence;
    if (append) {
      controllerContext.setLoadingMoreMessages(true);
    } else {
      if (!quiet) controllerContext.setLoadingMessages(true);
      controllerContext.setHasMoreMessages(false);
    }
    controllerContext.setError(null);
    try {
      const limit = Math.max(controllerContext.pageSize, limitOverride ?? controllerContext.pageSize);
      const removalVersion = controllerContext.cacheRemovalVersionsRef.current.get(folder) ?? 0;
      const cached = await mailListCachedMessages(controllerContext.info.sessionId, folder, limit + 1, offset);
      if (!controllerContext.visibleRef.current) {
        controllerContext.pendingCacheRefreshRef.current = true;
        return { page: [] as MailMessageHeader[], hasMore: false };
      }
      if (!current() || controllerContext.selectedFolderRef.current !== folder
        || (controllerContext.cacheRemovalVersionsRef.current.get(folder) ?? 0) !== removalVersion) {
        // A snapshot started before a successful move/delete can still contain
        // removed rows. Keep the current list until the next fresh query.
        return { page: [] as MailMessageHeader[], hasMore: false };
      }
      const page = cached.slice(0, limit);
      const loadedCount = offset + page.length;
      const hasMore = folderHasMoreToLoad(
        controllerContext.foldersRef.current.find((entry) => entry.name === folder),
        loadedCount,
        cached.length > limit,
      );
      controllerContext.setHasMoreMessages(hasMore);
      // Update the ref synchronously: concurrent sync steps merge against it.
      const next = append ? mergeMessagePages(controllerContext.messagesRef.current, page) : sortMessages(page);
      controllerContext.setMessages(next);
      if (!quiet) {
        controllerContext.setStatus(
          append
            ? page.length > 0 ? `Loaded ${page.length} older cached messages` : "No more cached messages"
            : page.length > 0 ? `Loaded ${page.length} cached messages` : "No cached messages",
        );
      }
      return { page, hasMore };
    } catch (e) {
      if (current()) controllerContext.setError(mailClientErrorMessage(e));
      return { page: [] as MailMessageHeader[], hasMore: false };
    } finally {
      // A newer snapshot owns the list and both loading indicators. A late
      // initial page must not replace post-sync rows or clear its loading state.
      if (current()) {
        controllerContext.setLoadingMoreMessages(false);
        controllerContext.setLoadingMessages(false);
      }
    }
  };
}



export interface RememberBodyContext {
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
  visibleRef: import("react").RefObject<boolean>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  setBodyCache: import("react").Dispatch<SetStateAction<Map<string, MailMessageBody>>>;
  setBody: import("react").Dispatch<SetStateAction<MailMessageBody | null>>;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setSearchResults: import("react").Dispatch<SetStateAction<MailMessageHeader[] | null>>;
  setMessageTabs: import("react").Dispatch<SetStateAction<OpenMailMessageTab[]>>;
}


export function createRememberBody(controllerContext: RememberBodyContext): (nextBody: MailMessageBody) => void {
  return (nextBody: MailMessageBody) => {
    const key = `${nextBody.folder}:${nextBody.uid}`;
    const nextCache = new Map(controllerContext.bodyCacheRef.current);
    nextCache.set(key, nextBody);
    controllerContext.bodyCacheRef.current = nextCache;
    if (!controllerContext.visibleRef.current) {
      controllerContext.pendingCacheRefreshRef.current = true;
      return;
    }
    controllerContext.setBodyCache(nextCache);
    controllerContext.setBody(nextBody);

    const enrichHeader = (message: MailMessageHeader): MailMessageHeader => {
      if (messageKey(message) !== key) return message;
      const attachmentCount = nextBody.attachments.length;
      return {
        ...message,
        messageId: nextBody.messageId ?? message.messageId,
        subject: nextBody.subject || message.subject,
        snippet: nextBody.snippet ?? message.snippet,
        rawSize: nextBody.rawSize ?? message.rawSize,
        bodyCached: true,
        hasAttachments: message.hasAttachments || attachmentCount > 0,
        attachmentCount: Math.max(message.attachmentCount, attachmentCount),
        attachments: attachmentCount > 0 ? nextBody.attachments : message.attachments,
      };
    };

    controllerContext.setMessages((current) => current.map(enrichHeader));
    controllerContext.setSearchResults((current) => current?.map(enrichHeader) ?? null);
    controllerContext.setMessageTabs((current) => current.map((tab) => ({
      ...tab,
      message: enrichHeader(tab.message),
    })));
  };
}



export interface FetchBodyForMessageContext {
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
  rememberBody: (nextBody: MailMessageBody) => void;
  bodyRequestsRef: import("react").RefObject<Map<string, Promise<MailMessageBody>>>;
  info: import("../../../types").MailTabInfo;
}


export function createFetchBodyForMessage(controllerContext: FetchBodyForMessageContext): (message: MailMessageHeader) => Promise<MailMessageBody> {
  return (message: MailMessageHeader): Promise<MailMessageBody> => {
    const key = messageKey(message);
    const cached = controllerContext.bodyCacheRef.current.get(key);
    if (cached && bodyMatchesMessage(cached, message)) {
      controllerContext.rememberBody(cached);
      return Promise.resolve(cached);
    }
    const inflight = controllerContext.bodyRequestsRef.current.get(key);
    if (inflight) return inflight;

    const request = mailGetMessageBody(controllerContext.info, message.folder, message.uid)
      .then((nextBody) => {
        controllerContext.rememberBody(nextBody);
        return nextBody;
      })
      .finally(() => {
        controllerContext.bodyRequestsRef.current.delete(key);
      });
    controllerContext.bodyRequestsRef.current.set(key, request);
    return request;
  };
}



export interface WarmRecentBodiesContext {
  info: import("../../../types").MailTabInfo;
  setBodyWarming: import("react").Dispatch<SetStateAction<BodyWarmState>>;
  visibleRef: import("react").RefObject<boolean>;
  pendingCacheRefreshRef: import("react").RefObject<boolean>;
  bodyWarmSeqRef: import("react").RefObject<number>;
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
}


export function createWarmRecentBodies(controllerContext: WarmRecentBodiesContext): (foldersToWarm: MailFolder[], preferredFolder: string) => Promise<void> {
  return async (foldersToWarm: MailFolder[], preferredFolder: string) => {
    if (!controllerContext.info.cache.enabled || controllerContext.info.cache.bodyRecentLimit <= 0) {
      controllerContext.setBodyWarming({ active: false, done: 0, total: 0 });
      return;
    }
    if (!controllerContext.visibleRef.current) {
      controllerContext.pendingCacheRefreshRef.current = true;
      return;
    }
    const seq = controllerContext.bodyWarmSeqRef.current + 1;
    controllerContext.bodyWarmSeqRef.current = seq;
    const limit = Math.max(1, Math.min(1000, controllerContext.info.cache.bodyRecentLimit));
    const orderedFolders = foldersToWarm.slice().sort((a, b) => {
      if (a.name === preferredFolder) return -1;
      if (b.name === preferredFolder) return 1;
      return 0;
    });
    const seen = new Set<string>();
    const candidates: MailMessageHeader[] = [];
    controllerContext.setBodyWarming({ active: true, done: 0, total: 0 });

    try {
      for (const folder of orderedFolders) {
        if (controllerContext.bodyWarmSeqRef.current !== seq || !controllerContext.visibleRef.current) return;
        const page = await mailListCachedMessages(controllerContext.info.sessionId, folder.name, limit, 0);
        if (controllerContext.bodyWarmSeqRef.current !== seq || !controllerContext.visibleRef.current) return;
        for (const message of page) {
          const key = messageKey(message);
          if (seen.has(key) || message.bodyCached || controllerContext.bodyCacheRef.current.has(key)) continue;
          seen.add(key);
          candidates.push(message);
        }
      }

      if (controllerContext.bodyWarmSeqRef.current !== seq || !controllerContext.visibleRef.current) return;
      if (candidates.length === 0) {
        controllerContext.setBodyWarming({ active: false, done: 0, total: 0 });
        return;
      }

      controllerContext.setBodyWarming({ active: true, done: 0, total: candidates.length, folder: candidates[0]?.folder ?? null });
      let done = 0;
      let lastProgressAt = Date.now();
      for (const message of candidates) {
        if (controllerContext.bodyWarmSeqRef.current !== seq || !controllerContext.visibleRef.current) return;
        try {
          // Warm only the native disk cache. Manual opens use the interactive
          // connection and must not join a request queued behind history sync.
          await mailPrefetchMessageBody(controllerContext.info, message.folder, message.uid);
        } catch {
          // Body warming is opportunistic; direct message open still reports errors.
        }
        done += 1;
        if (controllerContext.bodyWarmSeqRef.current !== seq || !controllerContext.visibleRef.current) return;
        const now = Date.now();
        if (done === candidates.length || now - lastProgressAt >= 250) {
          lastProgressAt = now;
          controllerContext.setBodyWarming({
            active: done < candidates.length,
            done,
            total: candidates.length,
            folder: message.folder,
          });
        }
        // Cached IPC can settle synchronously. Give input/paint a task turn
        // without rebuilding every visible row once per warmed body.
        if (done % 8 === 0) await delay(0);
      }
    } finally {
      if (controllerContext.bodyWarmSeqRef.current === seq) {
        controllerContext.setBodyWarming((current) => ({
          active: false,
          done: current.total > 0 ? current.done : 0,
          total: current.total,
          folder: current.folder,
        }));
      }
    }
  };
}



export interface LoadBodyContext {
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
  rememberBody: (nextBody: MailMessageBody) => void;
  bodyLoadSeqRef: import("react").RefObject<number>;
  setBodyLoadingKey: import("react").Dispatch<SetStateAction<string | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  fetchBodyForMessage: (message: MailMessageHeader) => Promise<MailMessageBody>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createLoadBody(controllerContext: LoadBodyContext): (message: MailMessageHeader) => Promise<MailMessageBody | null> {
  return async (message: MailMessageHeader) => {
    const key = messageKey(message);
    const cached = controllerContext.bodyCacheRef.current.get(key);
    if (cached && bodyMatchesMessage(cached, message)) {
      controllerContext.rememberBody(cached);
      return cached;
    }
    const seq = controllerContext.bodyLoadSeqRef.current + 1;
    controllerContext.bodyLoadSeqRef.current = seq;
    controllerContext.setBodyLoadingKey(key);
    controllerContext.setError(null);
    try {
      const nextBody = await controllerContext.fetchBodyForMessage(message);
      if (controllerContext.bodyLoadSeqRef.current === seq) {
        controllerContext.setStatus(nextBody.source === "cache" ? "Loaded body from cache" : "Loaded body from server");
      }
      return nextBody;
    } catch (e) {
      controllerContext.setError(mailClientErrorMessage(e));
      return null;
    } finally {
      controllerContext.setBodyLoadingKey((current) => (current === key ? null : current));
    }
  };
}



export interface LoadMoreMessagesContext {
  query: string;
  loadingMessages: boolean;
  loadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  selectedFolder: string;
  messages: MailMessageHeader[];
  info: import("../../../types").MailTabInfo;
  setLoadingMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  pageSize: number;
  selectedFolderRef: import("react").RefObject<string>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setHasMoreMessages: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  loadCachedMessages: (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<{ page: MailMessageHeader[]; hasMore: boolean; }>;
  foldersRef: import("react").RefObject<MailFolder[]>;
  syncInFlightRef: import("react").RefObject<boolean>;
  applySyncedFolder: (folder: MailFolder) => void;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createLoadMoreMessages(controllerContext: LoadMoreMessagesContext): () => Promise<void> {
  return async () => {
    if (controllerContext.query.trim() || controllerContext.loadingMessages || controllerContext.loadingMoreMessages || !controllerContext.hasMoreMessages) return;
    const folder = controllerContext.selectedFolder;
    const loaded = controllerContext.messages.length;
    if (!controllerContext.info.cache.enabled) {
      // No cache to page: fall back to server offset paging.
      controllerContext.setLoadingMoreMessages(true);
      try {
        const result = await mailSyncHeaders(controllerContext.info, folder, { limit: controllerContext.pageSize, offset: loaded, refreshFolders: false });
        const merged = mergeSyncedMessages(controllerContext.selectedFolderRef.current, folder, controllerContext.messagesRef.current, result.messages, sortMessages);
        if (merged) {
          controllerContext.setMessages(merged);
        }
        controllerContext.setHasMoreMessages(result.hasMore);
      } catch (e) {
        controllerContext.setError(mailClientErrorMessage(e));
      } finally {
        controllerContext.setLoadingMoreMessages(false);
      }
      return;
    }
    // Cache first; only when the cache is exhausted backfill older history.
    const { page } = await controllerContext.loadCachedMessages(folder, loaded, true);
    if (page.length > 0) return;
    const meta = controllerContext.foldersRef.current.find((entry) => entry.name === folder);
    if (!meta || meta.syncComplete || controllerContext.syncInFlightRef.current) {
      if (meta?.syncComplete) controllerContext.setHasMoreMessages(false);
      return;
    }
    controllerContext.syncInFlightRef.current = true;
    controllerContext.setLoadingMoreMessages(true);
    try {
      const result = await mailSyncFolder(controllerContext.info, folder, { mode: "backfill", limit: controllerContext.pageSize });
      controllerContext.applySyncedFolder(result.folder);
      await controllerContext.loadCachedMessages(folder, loaded, true);
      if (!result.more && result.fetched === 0) controllerContext.setStatus("No more messages");
    } catch (e) {
      controllerContext.setError(mailClientErrorMessage(e));
    } finally {
      controllerContext.syncInFlightRef.current = false;
      controllerContext.setLoadingMoreMessages(false);
    }
  };
}
