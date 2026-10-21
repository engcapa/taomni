import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MailMessageHeader } from "../../../lib/mail";
import { buildMailThreads, flattenMailThreads, type MailThreadRow } from "../../../lib/mailThreads";
import { isUnread } from "./folders";
import { MAIL_THREAD_VIEW_STORAGE_KEY, dedupeMessages, messageKey } from "./messages";
import { type OpenMailMessageTab } from "./types";

export interface UseMailSelectionContext {
  query: string;
  searchResults: MailMessageHeader[] | null;
  messages: MailMessageHeader[];
  filteredMessages: MailMessageHeader[];
}

export function useMailSelection(context: UseMailSelectionContext) {
  const { query, searchResults, messages, filteredMessages } = context;
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
  const [mailViewKey, setMailViewKey] = useState("mailbox");
  const [messageTabs, setMessageTabs] = useState<OpenMailMessageTab[]>([]);
  const [popupMessageKey, setPopupMessageKey] = useState<string | null>(null);
  const [checkedMessageKeys, setCheckedMessageKeys] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [threadView, setThreadView] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MAIL_THREAD_VIEW_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());
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

  useEffect(() => {
    setCheckedMessageKeys((current) => {
      if (current.size === 0) return current;
      const liveKeys = new Set(availableMessages.map(messageKey));
      const next = new Set([...current].filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [availableMessages]);
  return { selectedMessage, setMessageTabs, checkedMessages, setCheckedMessageKeys, setSelectedMessageKey, setMailViewKey, selectionAnchorRef, mailViewKey, popupMessageKey, setPopupMessageKey, availableMessages, selectedMessageKey, messageTabs, checkedMessageKeys, listRows, visibleUnreadCount, allFilteredMessagesChecked, toggleFilteredMessagesChecked, toggleMessageChecked, toggleThreadExpanded, checkedUnreadCount, activeMessageTab, threadView, setThreadView, popupMessage };
}
