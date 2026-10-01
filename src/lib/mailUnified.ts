import type { MailTabInfo } from "../types";
import type { MailFolder, MailMessageHeader } from "./mail";

/** Unified folders across every saved mail account (TASK-16, DEC-12). */
export type MailUnifiedView = "inbox" | "sent" | "drafts" | "starred";

export const MAIL_UNIFIED_VIEWS: { value: MailUnifiedView; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "sent", label: "Sent" },
  { value: "drafts", label: "Drafts" },
  { value: "starred", label: "Starred" },
];

const MATCHERS: Record<"sent" | "drafts" | "trash", { flag: string; names: string[] }> = {
  sent: { flag: "sent", names: ["sent", "已发送", "已傳送", "寄件"] },
  drafts: { flag: "drafts", names: ["draft", "草稿"] },
  trash: { flag: "trash", names: ["trash", "deleted", "已删除", "已刪除", "垃圾桶", "废件箱", "廢件匣"] },
};

/** Account folder behind a unified view (manual override, SPECIAL-USE, then names). */
export function unifiedFolderFor(
  folders: MailFolder[],
  kind: "inbox" | "sent" | "drafts" | "trash",
  overrides?: MailTabInfo["specialFolders"],
): string | null {
  if (kind === "inbox") {
    return folders.find((folder) => folder.name.toUpperCase() === "INBOX")?.name ?? (folders.length ? null : "INBOX");
  }
  const manual = overrides?.[kind === "drafts" ? "drafts" : kind];
  if (manual) return folders.find((folder) => folder.name === manual || folder.displayName === manual)?.name ?? manual;
  const matcher = MATCHERS[kind];
  const byFlag = folders.find((folder) => folder.flags.some((flag) => flag.toLowerCase().includes(matcher.flag)));
  if (byFlag) return byFlag.name;
  return folders.find((folder) => {
    const haystack = `${folder.name} ${folder.displayName}`.toLowerCase();
    return matcher.names.some((name) => haystack.includes(name));
  })?.name ?? null;
}

export interface UnifiedMessage {
  accountId: string;
  message: MailMessageHeader;
}

export function unifiedKey(entry: UnifiedMessage): string {
  return `${entry.accountId}\u0000${entry.message.folder}\u0000${entry.message.uid}`;
}

/** Merge per-account lists newest first (AC-48); ties keep account order. */
export function mergeUnified(lists: UnifiedMessage[][], limit = 500): UnifiedMessage[] {
  return lists
    .flat()
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      (b.entry.message.dateTs ?? 0) - (a.entry.message.dateTs ?? 0)
      || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function isStarred(message: MailMessageHeader): boolean {
  return message.flags.some((flag) => flag.toLowerCase() === "\\flagged");
}

export function isUnreadMessage(message: MailMessageHeader): boolean {
  return !message.flags.some((flag) => flag.toLowerCase() === "\\seen");
}

/** Short account label for list badges. */
export function accountLabel(info: Pick<MailTabInfo, "displayName" | "emailAddress" | "sessionId">): string {
  return info.displayName?.trim() || info.emailAddress || info.sessionId;
}
