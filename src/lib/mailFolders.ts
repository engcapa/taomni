import type { MailFolder } from "./mail";

/** RFC 5258 attribute the backend adds for folders LSUB reports (TASK-10). */
export const SUBSCRIBED_FLAG = "\\Subscribed";

export type MailSpecialFolderKey = "sent" | "drafts" | "trash" | "junk" | "archive";

export const MAIL_SPECIAL_FOLDER_KEYS: MailSpecialFolderKey[] = ["sent", "drafts", "trash", "junk", "archive"];

function hasFlag(folder: MailFolder, wanted: string): boolean {
  const needle = wanted.toLowerCase();
  return folder.flags.some((flag) => flag.toLowerCase() === needle);
}

export function isInbox(folder: MailFolder): boolean {
  return folder.name.toUpperCase() === "INBOX";
}

export function isSubscribed(folder: MailFolder): boolean {
  return hasFlag(folder, SUBSCRIBED_FLAG);
}

/** Selectable folders (\Noselect is a pure hierarchy node). */
export function isSelectable(folder: MailFolder): boolean {
  return !folder.flags.some((flag) => flag.toLowerCase().includes("noselect"));
}

/**
 * Folders the tree shows. With `subscribedOnly`, unsubscribed folders are
 * hidden (INBOX always stays). A cache that carries no subscription data yet
 * (pre-TASK-10 rows, or a server without LSUB) shows everything.
 */
export function visibleFolders(folders: MailFolder[], subscribedOnly: boolean): MailFolder[] {
  if (!subscribedOnly || !folders.some(isSubscribed)) return folders;
  return folders.filter((folder) => isInbox(folder) || isSubscribed(folder));
}

const SUBSCRIBED_ONLY_KEY = "taomni.mail.subscribedOnly:";

/** Per-account "show only subscribed folders" preference (this browser only). */
export function loadSubscribedOnly(accountId: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(SUBSCRIBED_ONLY_KEY + accountId);
    return value == null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

export function saveSubscribedOnly(accountId: string, value: boolean): void {
  try {
    window.localStorage.setItem(SUBSCRIBED_ONLY_KEY + accountId, String(value));
  } catch {
    /* preference only */
  }
}

/** Parse the `mailSpecialFolders` session option (JSON object of key -> folder). */
export function parseSpecialFolders(raw: unknown): Partial<Record<MailSpecialFolderKey, string>> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<MailSpecialFolderKey, string>> = {};
  for (const key of MAIL_SPECIAL_FOLDER_KEYS) {
    const folder = (value as Record<string, unknown>)[key];
    if (typeof folder === "string" && folder.trim()) out[key] = folder.trim();
  }
  return out;
}
