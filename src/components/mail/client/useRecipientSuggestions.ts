import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mailIndexCachedContacts, mailSearchContacts, type MailMessageHeader } from "../../../lib/mail";
import { mergeRecipientSuggestions, searchCachedMessageContacts, type RecipientSuggestion } from "../../../lib/mailRecipients";
import { type ComposeDraft, type RecipientFieldKey, type RecipientSearchState } from "./types";

export interface UseRecipientSuggestionsContext {
  draft: ComposeDraft;
  messages: MailMessageHeader[];
  composeOpen: boolean;
  info: import("../../../types").MailTabInfo;
}

export function useRecipientSuggestions(context: UseRecipientSuggestionsContext) {
  const { draft, messages, composeOpen, info } = context;
  const [recipientSearch, setRecipientSearch] = useState<RecipientSearchState>({
    field: null,
    query: "",
    suggestions: [],
    loading: false,
  });
  const contactIndexAccountRef = useRef<string | null>(null);
  const contactSearchSeqRef = useRef(0);
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

    return () => {
      window.clearTimeout(timer);
      if (contactSearchSeqRef.current === seq) contactSearchSeqRef.current += 1;
    };
  }, [composeOpen, info.sessionId, recipientSearch.field, recipientSearch.query]);
  return { setRecipientSearch, recipientSuggestionsFor, recipientSearch, handleRecipientQueryChange };
}
