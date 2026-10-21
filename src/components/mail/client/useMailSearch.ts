import { useRef, useState, useCallback, useEffect, useMemo, type SetStateAction } from "react";
import { mailSearchMessages, mailSearchServer, type MailMessageHeader, type MailSearchField } from "../../../lib/mail";
import { messageKey, sortMessages, mailClientErrorMessage, addressLabel, isFlagged } from "./messages";
import { isUnread } from "./folders";


export interface UseMailSearchContext {
  info: import("../../../types").MailTabInfo;
  selectedFolder: string;
  selectedFolderRef: import("react").RefObject<string>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  messages: MailMessageHeader[];
}

export function useMailSearch(context: UseMailSearchContext) {
  const { info, selectedFolder, selectedFolderRef, setError, setStatus, messages } = context;

  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"folder" | "all">("folder");
  const [searchField, setSearchField] = useState<MailSearchField>("all");
  const [quickFilters, setQuickFilters] = useState<{ unread: boolean; flagged: boolean; attachments: boolean; }>({
    unread: false,
    flagged: false,
    attachments: false,
  });
  const [tagFilter, setTagFilter] = useState<string>("");
  const [searchResults, setSearchResults] = useState<MailMessageHeader[] | null>(null);
  const [serverSearching, setServerSearching] = useState(false);
  const searchSeqRef = useRef(0);


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
  return { filteredMessages, runServerSearch, searchActive, quickFilterActive, query, setQuery, searchScope, setSearchScope, searchField, setSearchField, quickFilters, setQuickFilters, tagFilter, setTagFilter, searchResults, setSearchResults, serverSearching, setServerSearching, searchSeqRef };
}
