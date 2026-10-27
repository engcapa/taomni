import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { mailSetFolderSubscription, type MailFolder } from "../../../lib/mail";
import { loadSubscribedOnly, saveSubscribedOnly } from "../../../lib/mailFolders";
import type { MailTabInfo } from "../../../types";
import { mailClientErrorMessage } from "./messages";
import type { MailSubscriptionSnapshots } from "./subscriptionSnapshots";

interface Context {
  info: MailTabInfo;
  foldersRef: RefObject<MailFolder[]>;
  setFolders: Dispatch<SetStateAction<MailFolder[]>>;
  folderSnapshots: MailSubscriptionSnapshots;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useMailSubscriptions({ info, foldersRef, setFolders, folderSnapshots, setError }: Context) {
  const [subscribedOnly, setSubscribedOnlyState] = useState(() => loadSubscribedOnly(info.sessionId, info.sync.subscribedOnly ?? false));
  const subscribedOnlyRef = useRef(subscribedOnly);
  subscribedOnlyRef.current = subscribedOnly;
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
  const [subscriptionBusy, setSubscriptionBusy] = useState<string | null>(null);
  const requestRef = useRef(0);
  useEffect(() => () => { requestRef.current += 1; }, [info.sessionId]);

  const setSubscribedOnly = useCallback((value: boolean) => {
    setSubscribedOnlyState(value);
    saveSubscribedOnly(info.sessionId, value);
  }, [info.sessionId]);

  const toggleSubscription = useCallback(async (folder: MailFolder, value: boolean) => {
    const request = ++requestRef.current;
    const readRevision = folderSnapshots.capture();
    setSubscriptionBusy(folder.name);
    setError(null);
    try {
      const listed = await mailSetFolderSubscription(info, folder.name, value);
      if (request !== requestRef.current) return;
      const changed = listed.find((entry) => entry.name === folder.name);
      // Use the actual server result, never an optimistic substitute for it.
      if (changed) folderSnapshots.confirm(changed);
      const byName = new Map(listed.map((entry) => [entry.name, entry]));
      const merged = foldersRef.current.map((entry) => {
        const remote = byName.get(entry.name);
        return remote ? { ...entry, flags: remote.flags } : entry;
      });
      setFolders(folderSnapshots.merge(merged, readRevision));
    } catch (error) {
      if (request === requestRef.current) setError(mailClientErrorMessage(error));
    } finally {
      if (request === requestRef.current) setSubscriptionBusy(null);
    }
  }, [folderSnapshots, foldersRef, info, setError, setFolders]);

  return { subscribedOnly, subscribedOnlyRef, setSubscribedOnly, subscriptionsOpen,
    setSubscriptionsOpen, subscriptionBusy, toggleSubscription };
}
