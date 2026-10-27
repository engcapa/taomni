import { type SetStateAction } from "react";
import { mailMarkRead, type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { type OpenMailMessageTab } from "./types";
import { messageKey, mailClientErrorMessage, messageBatchesByFolder } from "./messages";
import { isUnread, withSeenFlag } from "./folders";



export interface MarkMessagesReadLocallyContext {
  setMessages: (next: SetStateAction<MailMessageHeader[]>) => void;
  setSearchResults: import("react").Dispatch<SetStateAction<MailMessageHeader[] | null>>;
  setMessageTabs: import("react").Dispatch<SetStateAction<OpenMailMessageTab[]>>;
  setFolders: import("react").Dispatch<SetStateAction<MailFolder[]>>;
}


export function createMarkMessagesReadLocally(controllerContext: MarkMessagesReadLocallyContext): (folder: string, uids: number[] | null, markedCount: number) => void {
  return (folder: string, uids: number[] | null, markedCount: number) => {
    if (markedCount <= 0) return;
    const uidSet = uids ? new Set(uids) : null;
    const shouldMark = (message: MailMessageHeader) =>
      message.folder === folder && (!uidSet || uidSet.has(message.uid));
    controllerContext.setMessages((current) => current.map((message) => {
      return shouldMark(message) ? withSeenFlag(message) : message;
    }));
    controllerContext.setSearchResults((current) => current?.map((message) => shouldMark(message) ? withSeenFlag(message) : message) ?? null);
    controllerContext.setMessageTabs((current) => current.map((tab) => {
      return shouldMark(tab.message) ? { ...tab, message: withSeenFlag(tab.message) } : tab;
    }));
    controllerContext.setFolders((current) => current.map((entry) => {
      if (entry.name !== folder || entry.unread === null || entry.unread === undefined) return entry;
      return { ...entry, unread: Math.max(0, entry.unread - markedCount), updatedAt: Math.floor(Date.now() / 1000) };
    }));
  };
}



export interface HandleMarkSelectedReadContext {
  checkedMessages: MailMessageHeader[];
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setMarkingRead: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  markMessagesReadLocally: (folder: string, uids: number[] | null, markedCount: number) => void;
  setCheckedMessageKeys: import("react").Dispatch<SetStateAction<Set<string>>>;
}


export function createHandleMarkSelectedRead(controllerContext: HandleMarkSelectedReadContext): () => Promise<void> {
  return async () => {
    const unread = controllerContext.checkedMessages.filter(isUnread);
    if (unread.length === 0) {
      controllerContext.setStatus("Selected messages are already read");
      return;
    }

    controllerContext.setMarkingRead(true);
    controllerContext.setError(null);
    try {
      let marked = 0;
      for (const [folder, group] of messageBatchesByFolder(unread)) {
        const uids = group.map((message) => message.uid);
        const result = await mailMarkRead(controllerContext.info, folder, uids, false);
        marked += result.marked;
        controllerContext.markMessagesReadLocally(folder, uids, result.marked);
        controllerContext.setCheckedMessageKeys((current) => {
          const next = new Set(current);
          for (const message of group) next.delete(messageKey(message));
          return next;
        });
      }
      controllerContext.setStatus(marked > 0 ? `Marked ${marked} selected messages as read` : "No selected unread messages");
    } catch (e) {
      controllerContext.setError(mailClientErrorMessage(e));
    } finally {
      controllerContext.setMarkingRead(false);
    }
  };
}



export interface HandleMarkFolderReadContext {
  selectedFolder: string;
  setMarkingRead: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  markMessagesReadLocally: (folder: string, uids: number[] | null, markedCount: number) => void;
  loadCachedFolders: () => Promise<void>;
  selectedFolderRef: import("react").RefObject<string>;
  loadCachedMessages: (folder: string, offset?: number, append?: boolean, quiet?: boolean, limitOverride?: number) => Promise<import("./types").MailCachePageResult>;
  messagesRef: import("react").RefObject<MailMessageHeader[]>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createHandleMarkFolderRead(controllerContext: HandleMarkFolderReadContext): (folderName?: string) => Promise<void> {
  return async (folderName = controllerContext.selectedFolder) => {
    controllerContext.setMarkingRead(true);
    controllerContext.setError(null);
    try {
      const result = await mailMarkRead(controllerContext.info, folderName, [], true);
      controllerContext.markMessagesReadLocally(folderName, null, result.marked);
      await controllerContext.loadCachedFolders();
      if (controllerContext.selectedFolderRef.current === folderName) {
        await controllerContext.loadCachedMessages(folderName, 0, false, true, controllerContext.messagesRef.current.length);
      }
      // Read flags do not change the user’s selection, including selections made
      // while this potentially long folder operation was running.
      controllerContext.setStatus(result.marked > 0 ? `Marked ${result.marked} messages as read` : "Folder is already read");
    } catch (e) {
      // Completed batches are committed even if a later STORE fails.
      await controllerContext.loadCachedFolders();
      if (controllerContext.selectedFolderRef.current === folderName) {
        await controllerContext.loadCachedMessages(folderName, 0, false, true, controllerContext.messagesRef.current.length);
      }
      controllerContext.setError(mailClientErrorMessage(e));
    } finally {
      controllerContext.setMarkingRead(false);
    }
  };
}



export interface HandleMarkSingleReadContext {
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setMarkingRead: import("react").Dispatch<SetStateAction<boolean>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  info: import("../../../types").MailTabInfo;
  markMessagesReadLocally: (folder: string, uids: number[] | null, markedCount: number) => void;
}


export function createHandleMarkSingleRead(controllerContext: HandleMarkSingleReadContext): (message: MailMessageHeader) => Promise<void> {
  return async (message: MailMessageHeader) => {
    if (!isUnread(message)) {
      controllerContext.setStatus("Message is already read");
      return;
    }
    controllerContext.setMarkingRead(true);
    controllerContext.setError(null);
    try {
      const result = await mailMarkRead(controllerContext.info, message.folder, [message.uid], false);
      controllerContext.markMessagesReadLocally(message.folder, [message.uid], result.marked);
      controllerContext.setStatus(result.marked > 0 ? "Marked message as read" : "Message was already read");
    } catch (e) {
      controllerContext.setError(mailClientErrorMessage(e));
    } finally {
      controllerContext.setMarkingRead(false);
    }
  };
}
