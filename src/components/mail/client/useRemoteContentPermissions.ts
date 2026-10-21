import { useCallback, useState } from "react";


export function useRemoteContentPermissions() {

  /** Thunderbird-style: allow remote content for specific messages, or the whole tab session. */
  const [allowRemoteAllInTab, setAllowRemoteAllInTab] = useState(false);
  const [remoteAllowedMessageKeys, setRemoteAllowedMessageKeys] = useState<Set<string>>(() => new Set());


  const messageAllowsRemote = useCallback((key: string | null | undefined) => {
    if (allowRemoteAllInTab) return true;
    if (!key) return false;
    return remoteAllowedMessageKeys.has(key);
  }, [allowRemoteAllInTab, remoteAllowedMessageKeys]);

  const allowRemoteForMessage = useCallback((key: string) => {
    setRemoteAllowedMessageKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const blockRemoteForMessage = useCallback((key: string) => {
    setAllowRemoteAllInTab(false);
    setRemoteAllowedMessageKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleRemoteForMessage = useCallback((key: string) => {
    if (messageAllowsRemote(key)) blockRemoteForMessage(key);
    else allowRemoteForMessage(key);
  }, [allowRemoteForMessage, blockRemoteForMessage, messageAllowsRemote]);
  return { messageAllowsRemote, toggleRemoteForMessage, allowRemoteForMessage, blockRemoteForMessage, allowRemoteAllInTab, setAllowRemoteAllInTab, remoteAllowedMessageKeys, setRemoteAllowedMessageKeys };
}
