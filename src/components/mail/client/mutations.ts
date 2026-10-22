import { MailMutationError, MailMutationSession } from "../../../lib/mailMutations";
import { type SetStateAction } from "react";
import { mailCopyMessages, mailDeleteMessages, mailMoveMessages, mailSetFlags, type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { filterFromMessage, mailApplyFilters, type MailFilter } from "../../../lib/mailFilters";
import { emptyAddressBookEntry, type MailAddressBookEntry } from "../../../lib/mailContacts";
import { folderLabel } from "../../../lib/mailFolders";
import { JUNK_KEYWORD, MAIL_TAGS, NOT_JUNK_KEYWORD, messageTags, toggleKeywordPlan } from "../../../lib/mailTags";
import { type OpenMailMessageTab } from "./types";
import { dedupeMessages, messageKey, mailClientErrorMessage, isFlagged, messageBatchesByFolder, withFlagsMutation } from "./messages";
import { isUnread, folderMatchesSpecial, type SpecialFolderKind } from "./folders";

export interface CreateMailMutationsContext {
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setSearchResults: import("react").Dispatch<SetStateAction<MailMessageHeader[] | null>>;
  setMessageTabs: import("react").Dispatch<SetStateAction<OpenMailMessageTab[]>>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
  cacheRemovalVersionsRef: import("react").RefObject<Map<string, number>>;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
  setMailViewKey: import("react").Dispatch<SetStateAction<string>>;
  setSelectedMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  setPopupMessageKey: import("react").Dispatch<SetStateAction<string | null>>;
  mutationSessionRef: import("react").RefObject<MailMutationSession>;
  setMutationProgress: import("react").Dispatch<SetStateAction<string | null>>;
  retryMailActionRef: import("react").RefObject<(() => Promise<void>) | null>;
  setMutationFailure: import("react").Dispatch<SetStateAction<{ message: string; retryable: boolean; detail: string | null; } | null>>;
  setBusyAction: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  displayFolders: MailFolder[];
  info: import("../../../types").MailTabInfo;
  incomingFiltersRef: import("react").RefObject<(() => Promise<void>) | null>;
  setFilterErrors: import("react").Dispatch<SetStateAction<string[]>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  reloadVisibleFromCache: (folder: string) => Promise<void>;
  selectedFolderRef: import("react").RefObject<string>;
  loadCachedFolders: () => Promise<void>;
  setContactDraft: import("react").Dispatch<SetStateAction<MailAddressBookEntry | null>>;
  setAddressBookOpen: import("react").Dispatch<SetStateAction<boolean>>;
  setFilterDraft: import("react").Dispatch<SetStateAction<MailFilter | null>>;
  setFiltersOpen: import("react").Dispatch<SetStateAction<boolean>>;
  confirmDialog: { confirm: (options: import("../../sidebar/ConfirmDialog").ConfirmDialogOptions) => Promise<boolean>; render: import("react").ReactNode; };
}

export function createMailMutations(context: CreateMailMutationsContext) {
  const {
    setMessages,
    setSearchResults,
    setMessageTabs,
    setFolders,
    cacheRemovalVersionsRef,
    setCheckedMessageKeys,
    setMailViewKey,
    setSelectedMessageKey,
    setPopupMessageKey,
    mutationSessionRef,
    setMutationProgress,
    retryMailActionRef,
    setMutationFailure,
    setBusyAction,
    setError,
    displayFolders,
    info,
    incomingFiltersRef,
    setFilterErrors,
    setStatus,
    reloadVisibleFromCache,
    selectedFolderRef,
    loadCachedFolders,
    setContactDraft,
    setAddressBookOpen,
    setFilterDraft,
    setFiltersOpen,
    confirmDialog,
  } = context;

  const applyFlagsLocally = (folder: string, uids: number[], add: string[], remove: string[], unreadDelta: number) => {
    const uidSet = new Set(uids);
    const applies = (message: MailMessageHeader) => message.folder === folder && uidSet.has(message.uid);
    setMessages((current) => current.map((message) => (applies(message) ? withFlagsMutation(message, add, remove) : message)));
    setSearchResults((current) => current?.map((message) => applies(message) ? withFlagsMutation(message, add, remove) : message) ?? null);
    setMessageTabs((current) => current.map((tab) => (applies(tab.message) ? { ...tab, message: withFlagsMutation(tab.message, add, remove) } : tab)));
    if (unreadDelta !== 0) {
      setFolders((current) => current.map((entry) => {
        if (entry.name !== folder || entry.unread === null || entry.unread === undefined) return entry;
        return { ...entry, unread: Math.max(0, entry.unread + unreadDelta), updatedAt: Math.floor(Date.now() / 1000) };
      }));
    }
  };

  const removeMessagesLocally = (folder: string, uids: number[], unreadRemoved: number) => {
    cacheRemovalVersionsRef.current.set(folder, (cacheRemovalVersionsRef.current.get(folder) ?? 0) + 1);
    const removedKeys = new Set(uids.map((uid) => `${folder}:${uid}`));
    setMessages((current) => current.filter((message) => !removedKeys.has(messageKey(message))));
    setSearchResults((current) => current?.filter((message) => !removedKeys.has(messageKey(message))) ?? null);
    setMessageTabs((current) => current.filter((tab) => !removedKeys.has(tab.key)));
    setCheckedMessageKeys((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const key of removedKeys) next.delete(key);
      return next.size === current.size ? current : next;
    });
    setMailViewKey((current) => (removedKeys.has(current) ? "mailbox" : current));
    setSelectedMessageKey((current) => (current && removedKeys.has(current) ? null : current));
    setPopupMessageKey((current) => (current && removedKeys.has(current) ? null : current));
    setFolders((current) => current.map((entry) => {
      if (entry.name !== folder) return entry;
      const nextTotal = entry.total !== null && entry.total !== undefined ? Math.max(0, entry.total - uids.length) : entry.total;
      const nextUnread = entry.unread !== null && entry.unread !== undefined ? Math.max(0, entry.unread - unreadRemoved) : entry.unread;
      return { ...entry, total: nextTotal, unread: nextUnread, updatedAt: Math.floor(Date.now() / 1000) };
    }));
  };

  const runMailAction = async (action: () => Promise<void>, retry = false) => {
    if (!retry) {
      mutationSessionRef.current = new MailMutationSession();
      setMutationProgress(null);
    }
    retryMailActionRef.current = action;
    setMutationFailure(null);
    setBusyAction(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(mailClientErrorMessage(e));
      if (mutationSessionRef.current.used) {
        setMutationFailure({ message: mailClientErrorMessage(e), retryable: !(e instanceof MailMutationError) || e.retryable,
          detail: e instanceof MailMutationError ? e.detail : null });
      }
    } finally {
      setBusyAction(false);
    }
  };

  const reportMutationProgress = (completed: number, total: number) => {
    setMutationProgress(`Processed ${completed}/${total} messages`);
  };

  const resolveSpecialFolder = (kind: SpecialFolderKind): string | null =>
    displayFolders.find((folder) => folderMatchesSpecial(folder, kind, info.specialFolders))?.name ?? null;

  const resolveInboxFolder = (): string =>
    displayFolders.find((folder) => folder.name.toUpperCase() === "INBOX")?.name
    ?? displayFolders.find((folder) => `${folder.name} ${folderLabel(folder)}`.toLowerCase().includes("inbox"))?.name
    ?? "INBOX";

  /** AC-40: run the incoming filters on new INBOX mail (tab open only, DEC-01). */
  incomingFiltersRef.current = async () => {
    try {
      const result = await mailApplyFilters(info, resolveInboxFolder(), "incoming", {
        trashFolder: resolveSpecialFolder("trash"),
      });
      if (result.errors.length > 0) {
        setFilterErrors(result.errors);
        setError(`Mail filter actions failed: ${result.errors.join("; ")}`);
      }
      if (result.matched > 0) {
        setStatus(`Filters handled ${result.matched} new message${result.matched === 1 ? "" : "s"}`);
        await reloadVisibleFromCache(selectedFolderRef.current);
        void loadCachedFolders();
      }
    } catch (e) {
      console.debug("incoming mail filters failed", e);
    }
  };

  /** AC-41: run filters by hand on the selected folder. */
  const runFiltersOnFolder = async (filterIds: string[] | undefined) => {
    const folder = selectedFolderRef.current;
    const result = await mailApplyFilters(info, folder, "manual", {
      filterIds,
      trashFolder: resolveSpecialFolder("trash"),
    });
    await reloadVisibleFromCache(folder);
    void loadCachedFolders();
    return result;
  };

  const openContactFromMessage = (message: MailMessageHeader) => {
    const address = message.from?.address?.trim() ?? "";
    setContactDraft(emptyAddressBookEntry({
      displayName: message.from?.name?.trim() || "",
      emails: [address],
    }));
    setAddressBookOpen(true);
  };

  const openFilterFromMessage = (message: MailMessageHeader) => {
    setFilterDraft(filterFromMessage(message));
    setFiltersOpen(true);
  };

  const handleToggleFlagged = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const allFlagged = unique.every(isFlagged);
    const add = allFlagged ? [] : ["\\Flagged"];
    const remove = allFlagged ? ["\\Flagged"] : [];
    for (const [folder, group] of messageBatchesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, add, remove);
      applyFlagsLocally(folder, uids, add, remove, 0);
    }
    setStatus(allFlagged ? "Removed star" : `Starred ${unique.length} message${unique.length === 1 ? "" : "s"}`);
  });

  const handleToggleKeyword = (targets: MailMessageHeader[], keyword: string, label: string) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const plan = toggleKeywordPlan(unique, keyword);
    for (const [folder, group] of messageBatchesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, plan.add, plan.remove);
      applyFlagsLocally(folder, uids, plan.add, plan.remove, 0);
    }
    setStatus(plan.enable ? `Tagged ${unique.length} as ${label}` : `Removed tag ${label}`);
  });

  const handleClearTags = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets).filter((message) => messageTags(message).length > 0);
    const remove = MAIL_TAGS.map((tag) => tag.keyword);
    for (const [folder, group] of messageBatchesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, [], remove);
      applyFlagsLocally(folder, uids, [], remove, 0);
    }
    setStatus("Removed tags");
  });

  /** Train the server's junk filter via $Junk/$NotJunk; unsupported keywords are not fatal. */
  const setJunkKeywords = async (targets: MailMessageHeader[], junk: boolean) => {
    const add = [junk ? JUNK_KEYWORD : NOT_JUNK_KEYWORD];
    const remove = [junk ? NOT_JUNK_KEYWORD : JUNK_KEYWORD];
    for (const [folder, group] of messageBatchesByFolder(dedupeMessages(targets))) {
      const uids = group.map((message) => message.uid);
      try {
        await mailSetFlags(info, folder, uids, add, remove);
        applyFlagsLocally(folder, uids, add, remove, 0);
      } catch (e) {
        console.debug("mail: junk keyword not accepted by the server", e);
      }
    }
  };

  const handleMarkUnread = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets).filter((message) => !isUnread(message));
    if (unique.length === 0) {
      setStatus("Selected messages are already unread");
      return;
    }
    for (const [folder, group] of messageBatchesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, [], ["\\Seen"]);
      applyFlagsLocally(folder, uids, [], ["\\Seen"], group.length);
    }
    setStatus(`Marked ${unique.length} message${unique.length === 1 ? "" : "s"} as unread`);
  });

  const moveTargetsTo = async (targets: MailMessageHeader[], target: string): Promise<number> => {
    const unique = dedupeMessages(targets).filter((message) => message.folder !== target);
    const operation = mutationSessionRef.current;
    operation.total = unique.length;
    reportMutationProgress(operation.completed, operation.total);
    let moved = 0;
    for (const [folder, group] of messageBatchesByFolder(unique, 50)) {
      const uids = group.map((message) => message.uid);
      moved += await operation.execute(JSON.stringify(["move", folder, target, uids]), uids,
        (id) => mailMoveMessages(info, folder, uids, target, id),
        (done) => removeMessagesLocally(folder, done, group.filter((m) => done.includes(m.uid) && isUnread(m)).length),
        reportMutationProgress);
    }
    return moved;
  };

  const handleMoveMessages = (targets: MailMessageHeader[], target: string) => runMailAction(async () => {
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to ${target}` : "Nothing to move");
  });

  const handleCopyMessages = (targets: MailMessageHeader[], target: string) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    const operation = mutationSessionRef.current;
    operation.total = unique.length;
    reportMutationProgress(operation.completed, operation.total);
    let copied = 0;
    for (const [folder, group] of messageBatchesByFolder(unique, 50)) {
      const uids = group.map((message) => message.uid);
      copied += await operation.execute(JSON.stringify(["copy", folder, target, uids]), uids,
        (id) => mailCopyMessages(info, folder, uids, target, id), () => {}, reportMutationProgress);
    }
    setStatus(copied > 0 ? `Copied ${copied} message${copied === 1 ? "" : "s"} to ${target}` : "Nothing to copy");
  });

  const handleArchiveMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveSpecialFolder("archive");
    if (!target) {
      setError("No Archive folder found for this account.");
      return;
    }
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Archived ${moved} message${moved === 1 ? "" : "s"}` : "Already archived");
  });

  const handleJunkMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveSpecialFolder("junk");
    if (!target) {
      setError("No Junk folder found for this account.");
      return;
    }
    await setJunkKeywords(targets, true);
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to Junk` : "Already in Junk");
  });

  const handleNotJunkMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveInboxFolder();
    await setJunkKeywords(targets, false);
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to Inbox` : "Already in Inbox");
  });

  const handleDeleteMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const trash = resolveSpecialFolder("trash");
    const allInTrash = trash !== null && unique.every((message) => message.folder === trash);
    if (!trash || allInTrash) {
      const confirmed = await confirmDialog.confirm({
        title: "Delete permanently",
        message: `Permanently delete ${unique.length} message${unique.length === 1 ? "" : "s"}? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      const operation = mutationSessionRef.current;
      operation.total = unique.length;
      reportMutationProgress(operation.completed, operation.total);
      for (const [folder, group] of messageBatchesByFolder(unique, 50)) {
        const uids = group.map((message) => message.uid);
        await operation.execute(JSON.stringify(["delete", folder, uids]), uids,
          (id) => mailDeleteMessages(info, folder, uids, false, id),
          (done) => removeMessagesLocally(folder, done, group.filter((m) => done.includes(m.uid) && isUnread(m)).length),
          reportMutationProgress);
      }
      setStatus(`Deleted ${unique.length} message${unique.length === 1 ? "" : "s"}`);
      return;
    }
    const moved = await moveTargetsTo(unique, trash);
    setStatus(`Moved ${moved} message${moved === 1 ? "" : "s"} to Trash`);
  });
  return {
    runMailAction,
    removeMessagesLocally,
    reportMutationProgress,
    resolveSpecialFolder,
    applyFlagsLocally,
    handleMarkUnread,
    handleToggleFlagged,
    handleToggleKeyword,
    handleClearTags,
    handleArchiveMessages,
    handleMoveMessages,
    handleCopyMessages,
    handleJunkMessages,
    handleNotJunkMessages,
    handleDeleteMessages,
    openFilterFromMessage,
    openContactFromMessage,
    runFiltersOnFolder,
  };
}
