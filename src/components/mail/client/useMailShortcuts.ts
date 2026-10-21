import { useEffect, useRef } from "react";
import { type MailMessageHeader } from "../../../lib/mail";
import { isEditableTarget, mailShortcutAction, type MailShortcutAction } from "../../../lib/mailShortcuts";
import { isUnread } from "./folders";
import { messageKey } from "./messages";
import { useMailComposer } from "./useMailComposer";

export interface UseMailShortcutsContext {
  visible: boolean;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  composerOwner: ReturnType<typeof useMailComposer>;
  subscriptionsOpen: boolean;
  listRows: import("../../../lib/mailThreads").MailThreadRow[];
  selectedMessage: MailMessageHeader | null;
  selectListMessage: (message: MailMessageHeader) => void;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
  checkedMessages: MailMessageHeader[];
  busyAction: boolean;
  handleMarkSelectedRead: () => Promise<void>;
  handleMarkSingleRead: (message: MailMessageHeader) => Promise<void>;
  handleMarkUnread: (targets: MailMessageHeader[]) => Promise<void>;
  handleToggleFlagged: (targets: MailMessageHeader[]) => Promise<void>;
  handleArchiveMessages: (targets: MailMessageHeader[]) => Promise<void>;
  handleJunkMessages: (targets: MailMessageHeader[]) => Promise<void>;
  handleNotJunkMessages: (targets: MailMessageHeader[]) => Promise<void>;
  handleDeleteMessages: (targets: MailMessageHeader[]) => Promise<void>;
}

export function useMailShortcuts(context: UseMailShortcutsContext) {
  const {
    visible,
    rootRef,
    composerOwner,
    subscriptionsOpen,
    listRows,
    selectedMessage,
    selectListMessage,
    searchInputRef,
    checkedMessages,
    busyAction,
    handleMarkSelectedRead,
    handleMarkSingleRead,
    handleMarkUnread,
    handleToggleFlagged,
    handleArchiveMessages,
    handleJunkMessages,
    handleNotJunkMessages,
    handleDeleteMessages,
  } = context;

  // Thunderbird-style list shortcuts (TASK-22); never inside inputs/editors.
  const shortcutRef = useRef<(action: MailShortcutAction) => boolean>(() => false);
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const action = mailShortcutAction(event);
      if (!action) return;
      const root = rootRef.current;
      const target = event.target as Node | null;
      const inTab = !target || target === document.body || Boolean(root?.contains(target));
      if (!inTab || isEditableTarget(event.target)) return;
      if (shortcutRef.current(action)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible]);

  shortcutRef.current = (action: MailShortcutAction): boolean => {
    // Dialogs and the composer own the keyboard.
    if (composerOwner.composeOpen || composerOwner.draftsOpen || subscriptionsOpen) return false;
    const rows = listRows.map((row) => row.message);
    const current = selectedMessage;
    const index = current ? rows.findIndex((message) => messageKey(message) === messageKey(current)) : -1;
    const go = (message: MailMessageHeader | undefined) => {
      if (!message) return false;
      selectListMessage(message);
      document.querySelector<HTMLElement>(
        `[data-testid="mail-message-row"][data-uid="${message.uid}"]`,
      )?.scrollIntoView?.({ block: "nearest" });
      return true;
    };
    switch (action) {
      case "next":
        return go(index < 0 ? rows[0] : rows[index + 1]);
      case "prev":
        return go(index < 0 ? rows[0] : rows[index - 1]);
      case "nextUnread":
        return go(rows.slice(index + 1).find(isUnread) ?? rows.slice(0, Math.max(index, 0)).find(isUnread));
      case "focusSearch":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return true;
      default:
        break;
    }
    const targets = checkedMessages.length > 0 ? checkedMessages : current ? [current] : [];
    if (targets.length === 0 || busyAction) return false;
    switch (action) {
      case "reply":
        composerOwner.openReply(targets[0]);
        return true;
      case "replyAll":
        composerOwner.openReplyAll(targets[0]);
        return true;
      case "forward":
        composerOwner.openForward(targets[0]);
        return true;
      case "toggleRead":
        if (targets.some(isUnread)) {
          void (checkedMessages.length > 0 ? handleMarkSelectedRead() : handleMarkSingleRead(targets[0]));
        } else {
          void handleMarkUnread(targets);
        }
        return true;
      case "star":
        void handleToggleFlagged(targets);
        return true;
      case "archive":
        void handleArchiveMessages(targets);
        return true;
      case "junk":
        void handleJunkMessages(targets);
        return true;
      case "notJunk":
        void handleNotJunkMessages(targets);
        return true;
      case "delete":
        void handleDeleteMessages(targets);
        return true;
      default:
        return false;
    }
  };
  return {};
}
