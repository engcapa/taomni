import { useCallback, useMemo, useRef, useState, type SetStateAction } from "react";
import { type MailFolder, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { type BodyWarmState } from "./types";
import { MailSubscriptionSnapshots } from "./subscriptionSnapshots";

export interface UseMailCacheStateContext {
  visible: boolean;
  accountId: string;
}

export function useMailCacheState(context: UseMailCacheStateContext) {
  const { visible, accountId } = context;
  const [folders, setFoldersState] = useState<MailFolder[]>([]);
  const folderSnapshots = useMemo(() => new MailSubscriptionSnapshots(), [accountId]);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [messages, setMessagesState] = useState<MailMessageHeader[]>([]);
  const [body, setBody] = useState<MailMessageBody | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [bodyCache, setBodyCache] = useState<Map<string, MailMessageBody>>(() => new Map());
  const [bodyLoadingKey, setBodyLoadingKey] = useState<string | null>(null);
  const [bodyWarming, setBodyWarming] = useState<BodyWarmState>({ active: false, done: 0, total: 0 });
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const visibleRef = useRef(visible);
  const pendingCacheRefreshRef = useRef(false);
  const bodyCacheRef = useRef<Map<string, MailMessageBody>>(new Map());
  const bodyRequestsRef = useRef<Map<string, Promise<MailMessageBody>>>(new Map());
  const bodyLoadSeqRef = useRef(0);
  const bodyWarmSeqRef = useRef(0);
  const foldersRef = useRef<MailFolder[]>([]);
  /** Tracks the live selected folder across awaits (folder switches ignore syncInFlight). */
  const selectedFolderRef = useRef(selectedFolder);
  const messagesRef = useRef<MailMessageHeader[]>([]);
  const cacheRemovalVersionsRef = useRef(new Map<string, number>());
  const cacheRequestSeqRef = useRef(0);
  // Sync batches and cache reloads can finish before React commits the prior
  // render. Publish one current list for both async work and rendering; a
  // delayed effect must never overwrite a newer cache reload with old rows.
  const setMessages = useCallback((next: SetStateAction<MailMessageHeader[]>) => {
    const value = typeof next === "function" ? next(messagesRef.current) : next;
    messagesRef.current = value;
    setMessagesState(value);
  }, []);

  const setFolders = useCallback((next: SetStateAction<MailFolder[]>) => {
    const value = typeof next === "function" ? next(foldersRef.current) : next;
    foldersRef.current = value;
    setFoldersState(value);
  }, []);

  /** Keep selectedFolderRef in sync immediately (folder switches can race quiet poll awaits). */
  const updateSelectedFolder = useCallback((next: string | ((prev: string) => string)) => {
    const value = typeof next === "function" ? next(selectedFolderRef.current) : next;
    selectedFolderRef.current = value;
    setSelectedFolder(value);
  }, []);
  return { folders, folderSnapshots, selectedFolder, selectedFolderRef, messages, visibleRef, bodyWarmSeqRef, bodyLoadSeqRef, setLoadingFolders, setLoadingMessages, setLoadingMoreMessages, setBodyLoadingKey, setBodyWarming, bodyCache, body, pendingCacheRefreshRef, foldersRef, setFolders, updateSelectedFolder, setHasMoreMessages, cacheRemovalVersionsRef, cacheRequestSeqRef, messagesRef, setMessages, bodyCacheRef, setBodyCache, setBody, bodyRequestsRef, loadingMessages, loadingMoreMessages, hasMoreMessages, bodyLoadingKey, bodyWarming, loadingFolders };
}
