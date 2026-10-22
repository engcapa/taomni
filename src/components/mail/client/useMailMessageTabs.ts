import { useCallback, type SetStateAction } from "react";
import { type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";
import { bodyMatchesMessage, messageKey } from "./messages";

export interface UseMailMessageTabsContext {
  updateSelectedFolder: (next: string | ((prev: string) => string)) => void;
  setSelectedMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  setMailViewKey: import("react").Dispatch<SetStateAction<string>>;
  bodyCacheRef: import("react").RefObject<Map<string, MailMessageBody>>;
  setBody: import("react").Dispatch<SetStateAction<MailMessageBody | null>>;
  selectionAnchorRef: import("react").RefObject<string | null>;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
  setMessageTabs: import("react").Dispatch<SetStateAction<import("./types").OpenMailMessageTab[]>>;
  mailViewKey: string;
  popupMessageKey: string | null;
  setPopupMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
}

export function useMailMessageTabs(context: UseMailMessageTabsContext) {
  const {
    updateSelectedFolder,
    setSelectedMessageKey,
    setMailViewKey,
    bodyCacheRef,
    setBody,
    selectionAnchorRef,
    setCheckedMessageKeys,
    setMessageTabs,
    mailViewKey,
    popupMessageKey,
    setPopupMessageKey,
  } = context;

  const selectMessage = useCallback((message: MailMessageHeader, viewKey = "mailbox") => {
    const key = messageKey(message);
    updateSelectedFolder(message.folder);
    setSelectedMessageKey(key);
    setMailViewKey(viewKey);
    const cached = bodyCacheRef.current.get(key);
    setBody((current) => (
      cached && bodyMatchesMessage(cached, message)
        ? cached
        : bodyMatchesMessage(current, message) ? current : null
    ));
  }, [updateSelectedFolder]);

  const selectListMessage = useCallback((message: MailMessageHeader) => {
    const key = messageKey(message);
    selectionAnchorRef.current = key;
    setCheckedMessageKeys(new Set([key]));
    selectMessage(message, "mailbox");
  }, [selectMessage]);

  const openMessageTab = useCallback((message: MailMessageHeader) => {
    const key = messageKey(message);
    setMessageTabs((current) => {
      if (current.some((tab) => tab.key === key)) return current;
      return [...current, { key, message }];
    });
    selectMessage(message, key);
  }, [selectMessage]);

  const closeMessageTab = useCallback((key: string) => {
    setMessageTabs((current) => current.filter((tab) => tab.key !== key));
    if (mailViewKey === key) {
      setMailViewKey("mailbox");
      setBody(null);
    }
    if (popupMessageKey === key) {
      setPopupMessageKey(null);
    }
  }, [mailViewKey, popupMessageKey]);

  const openMessagePopup = useCallback((message: MailMessageHeader) => {
    selectMessage(message, mailViewKey === "mailbox" ? "mailbox" : messageKey(message));
    setPopupMessageKey(messageKey(message));
  }, [mailViewKey, selectMessage]);
  return { selectMessage, openMessageTab, openMessagePopup, selectListMessage, closeMessageTab };
}
