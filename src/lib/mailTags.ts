import type { MailMessageHeader } from "./mail";

/**
 * Message tags stored as IMAP keywords, using Thunderbird's default keyword
 * names and colors so tags round-trip between the two clients.
 */
export interface MailTag {
  keyword: string;
  label: string;
  color: string;
}

export const MAIL_TAGS: readonly MailTag[] = [
  { keyword: "$label1", label: "Important", color: "#ff2600" },
  { keyword: "$label2", label: "Work", color: "#ff9900" },
  { keyword: "$label3", label: "Personal", color: "#009900" },
  { keyword: "$label4", label: "To Do", color: "#3333ff" },
  { keyword: "$label5", label: "Later", color: "#993399" },
];

export const JUNK_KEYWORD = "$Junk";
export const NOT_JUNK_KEYWORD = "$NotJunk";

function hasKeyword(message: MailMessageHeader, keyword: string): boolean {
  const wanted = keyword.toLowerCase();
  return message.flags.some((flag) => flag.toLowerCase() === wanted);
}

export function messageTags(message: MailMessageHeader): MailTag[] {
  return MAIL_TAGS.filter((tag) => hasKeyword(message, tag.keyword));
}

export function isJunk(message: MailMessageHeader): boolean {
  return hasKeyword(message, JUNK_KEYWORD) && !hasKeyword(message, NOT_JUNK_KEYWORD);
}

/** Flags to add/remove so every target ends up with (or without) `keyword`. */
export function toggleKeywordPlan(
  targets: readonly MailMessageHeader[],
  keyword: string,
): { add: string[]; remove: string[]; enable: boolean } {
  const enable = !targets.every((message) => hasKeyword(message, keyword));
  return enable ? { add: [keyword], remove: [], enable } : { add: [], remove: [keyword], enable };
}
