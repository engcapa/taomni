import type { MailTabInfo } from "../../../types";
import { type MailAddress, type MailMessageBody, type MailMessageHeader } from "../../../lib/mail";


export function isOAuthReauthRequired(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes("oauth authorization expired or was revoked")
    || normalized.includes("oauth2 authorization expired or was revoked")
    || normalized.includes("oauth2 refresh token is missing")
    || normalized.includes("invalid_grant")
    || normalized.includes("aadsts70008")
    || normalized.includes("aadsts700082");
}


export function mailClientErrorMessage(error: unknown): string {
  const message = String(error);
  if (isOAuthReauthRequired(message)) {
    return "OAuth authorization expired or was revoked. Reauthorize this mail account.";
  }
  return message;
}


export const MAIL_MESSAGE_PAGE_SIZE = 200;

export const MAIL_REFRESH_BATCH_SIZE = 50;

export function messageKey(message: MailMessageHeader): string {
  return `${message.folder}:${message.uid}`;
}


export function bodyMatchesMessage(
  body: MailMessageBody | null,
  message: MailMessageHeader | null | undefined,
): body is MailMessageBody {
  return !!body
    && !!message
    && body.accountId === message.accountId
    && body.folder === message.folder
    && body.uid === message.uid;
}


export function addressLabel(address: MailAddress | null | undefined): string {
  if (!address) return "";
  const name = address.name?.trim();
  const mail = address.address?.trim();
  if (name && mail) return `${name} <${mail}>`;
  return name || mail || "";
}


export function isFlagged(message: MailMessageHeader): boolean {
  return message.flags.some((flag) => flag.toLowerCase().includes("flagged"));
}


export function withFlagsMutation(
  message: MailMessageHeader,
  add: string[],
  remove: string[],
): MailMessageHeader {
  let flags = message.flags.filter(
    (flag) => !remove.some((candidate) => flag.toLowerCase() === candidate.toLowerCase()),
  );
  for (const candidate of add) {
    if (!flags.some((flag) => flag.toLowerCase() === candidate.toLowerCase())) {
      flags = [...flags, candidate];
    }
  }
  return { ...message, flags };
}


// Reuse ICU formatters across rows and progress updates. Constructing one per
// row repeatedly allocates locale data while large accounts are synchronizing.
export const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", timeStyle: "short",
});


export function formatShortDate(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return shortDateFormatter.format(date);
}


export function formatFullDate(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return fullDateFormatter.format(date);
}


export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}


export function messagePageSize(info: MailTabInfo): number {
  return Math.max(50, Math.min(500, info.sync.maxFetchPerSync || MAIL_MESSAGE_PAGE_SIZE));
}


export function refreshBatchSize(info: MailTabInfo): number {
  return Math.max(1, Math.min(MAIL_REFRESH_BATCH_SIZE, info.sync.maxFetchPerSync || MAIL_REFRESH_BATCH_SIZE));
}


export function sortMessages(messages: MailMessageHeader[]): MailMessageHeader[] {
  return messages.slice().sort((a, b) => {
    const date = (b.dateTs ?? 0) - (a.dateTs ?? 0);
    if (date !== 0) return date;
    return b.uid - a.uid;
  });
}


export function mergeMessagePages(current: MailMessageHeader[], next: MailMessageHeader[]): MailMessageHeader[] {
  const byKey = new Map<string, MailMessageHeader>();
  for (const message of current) byKey.set(messageKey(message), message);
  for (const message of next) byKey.set(messageKey(message), message);
  return sortMessages(Array.from(byKey.values()));
}


export const MAIL_THREAD_VIEW_STORAGE_KEY = "taomni.mail.threadView";


/** Headers per gap-free catch-up step (the loop repeats until caught up). */
export function catchupStepSize(info: MailTabInfo): number {
  return Math.max(20, Math.min(500, info.sync.maxFetchPerSync || 200));
}


export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


export function dedupeMessages(messages: readonly MailMessageHeader[]): MailMessageHeader[] {
  const seen = new Set<string>();
  const unique: MailMessageHeader[] = [];
  for (const message of messages) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }
  return unique;
}


export function* messageBatchesByFolder(messages: readonly MailMessageHeader[], batchSize = 250): Generator<[string, MailMessageHeader[]]> {
  const map = new Map<string, MailMessageHeader[]>();
  for (const message of messages) {
    const list = map.get(message.folder) ?? [];
    list.push(message);
    map.set(message.folder, list);
  }
  // Bound UID command length and update the UI after each successful batch.
  // An error leaves already completed batches removed and the rest selected.
  for (const [folder, group] of map) {
    for (let offset = 0; offset < group.length; offset += batchSize) {
      yield [folder, group.slice(offset, offset + batchSize)];
    }
  }
}


export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
