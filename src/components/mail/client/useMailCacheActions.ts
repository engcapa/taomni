import { useState } from "react";
import { mailClearCache, mailTestConnection } from "../../../lib/mail";
import { mailClientErrorMessage } from "./messages";
import { useMailCacheState } from "./useMailCacheState";
import { useMailSelection } from "./useMailSelection";

export interface UseMailCacheActionsContext {
  setError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  setStatus: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  cacheOwner: ReturnType<typeof useMailCacheState>;
  selectionOwner: ReturnType<typeof useMailSelection>;
}

export function useMailCacheActions(context: UseMailCacheActionsContext) {
  const { setError, info, setStatus, cacheOwner, selectionOwner } = context;
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await mailTestConnection(info);
      setStatus(`${info.incoming === "pop3" ? "POP3" : "IMAP"} ${result.imapOk ? "ok" : "failed"}, SMTP ${result.smtpOk ? "ok" : "failed"}, ${result.folderCount} folders`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      await mailClearCache(info.sessionId);
      cacheOwner.bodyWarmSeqRef.current += 1;
      cacheOwner.bodyLoadSeqRef.current += 1;
      cacheOwner.bodyCacheRef.current = new Map();
      cacheOwner.bodyRequestsRef.current.clear();
      cacheOwner.setFolders([]);
      cacheOwner.setMessages([]);
      cacheOwner.setBody(null);
      cacheOwner.setBodyCache(new Map());
      cacheOwner.setBodyLoadingKey(null);
      cacheOwner.setBodyWarming({ active: false, done: 0, total: 0 });
      selectionOwner.setSelectedMessageKey(null);
      selectionOwner.setMailViewKey("mailbox");
      selectionOwner.setMessageTabs([]);
      selectionOwner.setPopupMessageKey(null);
      selectionOwner.setCheckedMessageKeys(new Set());
      cacheOwner.setHasMoreMessages(false);
      cacheOwner.setLoadingMoreMessages(false);
      setStatus("Mail cache cleared");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setClearing(false);
    }
  };
  return { handleTest, testing, handleClearCache, clearing };
}
