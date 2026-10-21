import { useCallback, useEffect, useRef, useState } from "react";
import { mailMarkRead } from "../../../lib/mail";
import { isUnread } from "./folders";
import { mailClientErrorMessage, messageKey } from "./messages";
import { createHandleMarkFolderRead, createHandleMarkSelectedRead, createHandleMarkSingleRead, createMarkMessagesReadLocally } from "./readActions";
import { useMailCacheLoading } from "./useMailCacheLoading";
import { useMailCacheState } from "./useMailCacheState";
import { useMailSearch } from "./useMailSearch";
import { useMailSelection } from "./useMailSelection";

export interface UseMailReadingContext {
  cacheOwner: ReturnType<typeof useMailCacheState>;
  searchOwner: ReturnType<typeof useMailSearch>;
  selectionOwner: ReturnType<typeof useMailSelection>;
  setStatus: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  cacheLoadingOwner: ReturnType<typeof useMailCacheLoading>;
  visible: boolean;
  setAllowRemoteAllInTab: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setRemoteAllowedMessageKeys: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
  selectedBody: import("../../../lib/mail").MailMessageBody | null;
}

export function useMailReading(context: UseMailReadingContext) {
  const {
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
  } = context;
  const [markingRead, setMarkingRead] = useState(false);

  const markMessagesReadLocally = useCallback(createMarkMessagesReadLocally({
    setMessages: cacheOwner.setMessages,
    setSearchResults: searchOwner.setSearchResults,
    setMessageTabs: selectionOwner.setMessageTabs,
    setFolders: cacheOwner.setFolders,
  }), []);

  const handleMarkSelectedRead = useCallback(createHandleMarkSelectedRead({
    checkedMessages: selectionOwner.checkedMessages,
    setStatus,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
    setCheckedMessageKeys: selectionOwner.setCheckedMessageKeys,
  }), [selectionOwner.checkedMessages, info, markMessagesReadLocally]);

  const handleMarkFolderRead = useCallback(createHandleMarkFolderRead({
    selectedFolder: cacheOwner.selectedFolder,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
    loadCachedFolders: cacheLoadingOwner.loadCachedFolders,
    selectedFolderRef: cacheOwner.selectedFolderRef,
    loadCachedMessages: cacheLoadingOwner.loadCachedMessages,
    messagesRef: cacheOwner.messagesRef,
    setStatus,
  }), [info, cacheLoadingOwner.loadCachedFolders, cacheLoadingOwner.loadCachedMessages, markMessagesReadLocally, cacheOwner.selectedFolder]);

  const handleMarkSingleRead = useCallback(createHandleMarkSingleRead({
    setStatus,
    setMarkingRead,
    setError,
    info,
    markMessagesReadLocally,
  }), [info, markMessagesReadLocally]);

  const autoReadKeyRef = useRef<string | null>(null);
  const remoteImagesMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const selectedMessage = selectionOwner.selectedMessage;
    if (!selectedMessage) return;
    const key = messageKey(selectedMessage);
    let cancelled = false;
    if (remoteImagesMessageKeyRef.current !== key) {
      remoteImagesMessageKeyRef.current = key;
      setAllowRemoteAllInTab(false);
      setRemoteAllowedMessageKeys(new Set());
    }
    if (!selectedBody) {
      void cacheLoadingOwner.loadBody(selectedMessage);
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
  }, [info, cacheLoadingOwner.loadBody, markMessagesReadLocally, selectedBody, selectionOwner.selectedMessage, visible]);
  return { handleMarkSelectedRead, handleMarkSingleRead, markingRead, handleMarkFolderRead };
}
