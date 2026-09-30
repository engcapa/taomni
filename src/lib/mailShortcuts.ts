/**
 * Thunderbird-style mail list shortcuts (TASK-22).
 *
 * Plain keys follow Thunderbird: F/B next/previous message, N next unread,
 * M toggle read, S star, A archive, J/Shift+J junk/not junk, Del delete.
 * Reply is R (and Ctrl/Cmd+R), reply all Shift+R (and Ctrl/Cmd+Shift+R),
 * forward Ctrl/Cmd+L, search Ctrl/Cmd+Shift+K. Ctrl+Shift+L stays the global
 * chat toggle and Ctrl+Shift+S the servers dialog.
 */

export type MailShortcutAction =
  | "next"
  | "prev"
  | "nextUnread"
  | "reply"
  | "replyAll"
  | "forward"
  | "delete"
  | "toggleRead"
  | "star"
  | "archive"
  | "junk"
  | "notJunk"
  | "focusSearch";

export interface MailShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function mailShortcutAction(event: MailShortcutKey): MailShortcutAction | null {
  if (event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const primary = event.ctrlKey || event.metaKey;
  if (primary) {
    if (key === "k" && event.shiftKey) return "focusSearch";
    if (key === "r") return event.shiftKey ? "replyAll" : "reply";
    if (key === "l" && !event.shiftKey) return "forward";
    return null;
  }
  if (key === "Delete") return "delete";
  if (event.shiftKey) {
    if (key === "r") return "replyAll";
    if (key === "j") return "notJunk";
    return null;
  }
  switch (key) {
    case "f":
      return "next";
    case "b":
      return "prev";
    case "n":
      return "nextUnread";
    case "r":
      return "reply";
    case "m":
      return "toggleRead";
    case "s":
      return "star";
    case "a":
      return "archive";
    case "j":
      return "junk";
    default:
      return null;
  }
}

/** Typing surfaces where list shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return Boolean(element.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], .cm-editor",
  ));
}
