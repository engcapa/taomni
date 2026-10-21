import { Archive, Folder, Inbox, Send, Trash2 } from "lucide-react";
import type { MailTabInfo } from "../../../types";
import { type MailFolder, type MailMessageHeader } from "../../../lib/mail";
import { folderLabel } from "../../../lib/mailFolders";


export const DEFAULT_FOLDER: MailFolder = {
  accountId: "",
  name: "INBOX",
  delimiter: "/",
  flags: [],
  uidValidity: null,
  uidNext: null,
  total: null,
  unread: null,
  updatedAt: 0,
};


export function folderDepth(folder: MailFolder): number {
  const delimiter = folder.delimiter?.trim();
  if (!delimiter) return 0;
  return Math.max(0, folder.name.split(delimiter).filter(Boolean).length - 1);
}


export function folderIcon(folder: MailFolder) {
  const name = `${folder.name} ${folderLabel(folder)}`.toLowerCase();
  if (name.includes("inbox") || name.includes("收件")) return <Inbox className="w-4 h-4" />;
  if (name.includes("sent") || name.includes("已发送") || name.includes("已傳送")) return <Send className="w-4 h-4" />;
  if (name.includes("trash") || name.includes("deleted") || name.includes("垃圾") || name.includes("已删除")) return <Trash2 className="w-4 h-4" />;
  if (name.includes("archive") || name.includes("归档") || name.includes("封存")) return <Archive className="w-4 h-4" />;
  return <Folder className="w-4 h-4" />;
}


export function isUnread(message: MailMessageHeader): boolean {
  return !message.flags.some((flag) => flag.toLowerCase().includes("seen"));
}


export function withSeenFlag(message: MailMessageHeader): MailMessageHeader {
  if (!isUnread(message)) return message;
  return { ...message, flags: [...message.flags, "\\Seen"] };
}


export type SpecialFolderKind = "trash" | "junk" | "archive" | "sent";


/** Drag payload marker for messages dragged onto the folder tree. */
export const MAIL_DRAG_TYPE = "application/x-taomni-mail";


/** Folders whose new arrivals never raise a new-mail alert. */
export const NEW_MAIL_EXCLUDED_KINDS: SpecialFolderKind[] = ["sent", "trash", "junk"];


export const SPECIAL_FOLDER_MATCHERS: Record<SpecialFolderKind, { flag: string; names: string[] }> = {
  trash: { flag: "trash", names: ["trash", "deleted", "已删除", "已刪除", "垃圾桶", "废件箱", "廢件匣"] },
  junk: { flag: "junk", names: ["junk", "spam", "bulk", "垃圾邮件", "垃圾郵件"] },
  archive: { flag: "archive", names: ["archive", "归档", "封存", "歸檔"] },
  sent: { flag: "sent", names: ["sent", "已发送", "已傳送", "寄件"] },
};


export function folderMatchesSpecial(
  folder: MailFolder,
  kind: SpecialFolderKind,
  overrides?: MailTabInfo["specialFolders"],
): boolean {
  // A manual choice in the account settings beats attributes and names.
  const manual = overrides?.[kind];
  if (manual) return folder.name === manual || folderLabel(folder) === manual;
  const matcher = SPECIAL_FOLDER_MATCHERS[kind];
  if (folder.flags.some((flag) => flag.toLowerCase().includes(matcher.flag))) return true;
  const haystack = `${folder.name} ${folderLabel(folder)}`.toLowerCase();
  return matcher.names.some((name) => haystack.includes(name));
}
