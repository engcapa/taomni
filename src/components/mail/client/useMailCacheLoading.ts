import { useCallback } from "react";
import { createFetchBodyForMessage, createLoadBody, createLoadCachedFolders, createLoadCachedMessages, createRememberBody, createWarmRecentBodies } from "./messageLoading";
import { useMailCacheState } from "./useMailCacheState";
import { useMailSearch } from "./useMailSearch";
import { useMailSelection } from "./useMailSelection";

export interface UseMailCacheLoadingContext {
  cacheOwner: ReturnType<typeof useMailCacheState>;
  setError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  pageSize: number;
  setStatus: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  searchOwner: ReturnType<typeof useMailSearch>;
  selectionOwner: ReturnType<typeof useMailSelection>;
}

export function useMailCacheLoading(context: UseMailCacheLoadingContext) {
  const { cacheOwner, setError, info, pageSize, setStatus, searchOwner, selectionOwner } = context;

  const loadCachedFolders = useCallback(createLoadCachedFolders({
    visibleRef: cacheOwner.visibleRef,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    setLoadingFolders: cacheOwner.setLoadingFolders,
    setError,
    info,
    foldersRef: cacheOwner.foldersRef,
    setFolders: cacheOwner.setFolders,
    updateSelectedFolder: cacheOwner.updateSelectedFolder,
  }), [info.sessionId, cacheOwner.updateSelectedFolder]);

  const loadCachedMessages = useCallback(createLoadCachedMessages({
    visibleRef: cacheOwner.visibleRef,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    setLoadingMoreMessages: cacheOwner.setLoadingMoreMessages,
    setLoadingMessages: cacheOwner.setLoadingMessages,
    setHasMoreMessages: cacheOwner.setHasMoreMessages,
    setError,
    pageSize,
    cacheRemovalVersionsRef: cacheOwner.cacheRemovalVersionsRef,
    info,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    foldersRef: cacheOwner.foldersRef,
    messagesRef: cacheOwner.messagesRef,
    setMessages: cacheOwner.setMessages,
    setStatus,
  }), [info.sessionId, pageSize]);

  const rememberBody = useCallback(createRememberBody({
    bodyCacheRef: cacheOwner.bodyCacheRef,
    visibleRef: cacheOwner.visibleRef,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    setBodyCache: cacheOwner.setBodyCache,
    setBody: cacheOwner.setBody,
    setMessages: cacheOwner.setMessages,
    setSearchResults: searchOwner.setSearchResults,
    setMessageTabs: selectionOwner.setMessageTabs,
  }), []);

  const fetchBodyForMessage = useCallback(createFetchBodyForMessage({
    bodyCacheRef: cacheOwner.bodyCacheRef,
    rememberBody,
    bodyRequestsRef: cacheOwner.bodyRequestsRef,
    info,
  }), [info, rememberBody]);

  const warmRecentBodies = useCallback(createWarmRecentBodies({
    info,
    setBodyWarming: cacheOwner.setBodyWarming,
    visibleRef: cacheOwner.visibleRef,
    pendingCacheRefreshRef: cacheOwner.pendingCacheRefreshRef,
    bodyWarmSeqRef: cacheOwner.bodyWarmSeqRef,
    bodyCacheRef: cacheOwner.bodyCacheRef,
  }), [info]);

  /** Reload the visible list from the cache, keeping the loaded depth. */
  const reloadVisibleFromCache = useCallback(async (folder: string) => {
    if (!cacheOwner.visibleRef.current) {
      cacheOwner.pendingCacheRefreshRef.current = true;
      return;
    }
    if (cacheOwner.selectedFolderRef.current !== folder) return;
    const loaded = cacheOwner.messagesRef.current.filter((message) => message.folder === folder).length;
    await loadCachedMessages(folder, 0, false, true, Math.max(pageSize, loaded));
  }, [loadCachedMessages, pageSize]);

  const loadBody = useCallback(createLoadBody({
    bodyCacheRef: cacheOwner.bodyCacheRef,
    rememberBody,
    bodyLoadSeqRef: cacheOwner.bodyLoadSeqRef,
    setBodyLoadingKey: cacheOwner.setBodyLoadingKey,
    setError,
    fetchBodyForMessage,
    setStatus,
  }), [fetchBodyForMessage, rememberBody]);
  return { reloadVisibleFromCache, loadCachedFolders, loadCachedMessages, warmRecentBodies, loadBody };
}
