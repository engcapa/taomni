import type { MailAddress, MailContactSuggestion, MailMessageHeader } from "./mail";

export interface ComposeRecipient {
  name?: string | null;
  email: string;
}

export type RecipientSuggestionSource = MailContactSuggestion["source"] | "domain";

export interface RecipientSuggestion {
  name?: string | null;
  email: string;
  source: RecipientSuggestionSource;
  score: number;
  lastSeenAt?: number | null;
}

const EMAIL_RE = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;

export function normalizeRecipientEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isValidEmailAddress(value: string | null | undefined): boolean {
  return EMAIL_RE.test((value ?? "").trim());
}

export function recipientLabel(recipient: ComposeRecipient): string {
  const name = recipient.name?.trim();
  const email = recipient.email.trim();
  return name ? `${name} <${email}>` : email;
}

export function formatRecipientForSend(recipient: ComposeRecipient): string {
  return recipientLabel(recipient);
}

export function splitRecipientText(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"") {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (!inQuote && char === "<") {
      angleDepth += 1;
      current += char;
      continue;
    }
    if (!inQuote && char === ">" && angleDepth > 0) {
      angleDepth -= 1;
      current += char;
      continue;
    }
    if (!inQuote && angleDepth === 0 && (char === "," || char === ";" || char === "\n")) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

export function parseRecipientText(value: string): ComposeRecipient | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const bracketMatch = /^(?:"?([^"<>]*)"?\s*)?<([^<>@\s;,]+@[^<>\s;,]+)>$/.exec(trimmed);
  if (bracketMatch) {
    const name = bracketMatch[1]?.trim().replace(/^"|"$/g, "") || null;
    return { name, email: bracketMatch[2].trim() };
  }

  const bare = trimmed.replace(/^mailto:/i, "");
  return { name: null, email: bare };
}

export function parseRecipientsText(value: string): ComposeRecipient[] {
  return splitRecipientText(value)
    .map(parseRecipientText)
    .filter((recipient): recipient is ComposeRecipient => !!recipient);
}

export function addRecipientsUnique(
  current: readonly ComposeRecipient[],
  additions: readonly ComposeRecipient[],
): ComposeRecipient[] {
  const seen = new Set(current.map((recipient) => normalizeRecipientEmail(recipient.email)).filter(Boolean));
  const next = [...current];
  for (const recipient of additions) {
    const email = recipient.email.trim();
    const key = normalizeRecipientEmail(email);
    if (!email || seen.has(key)) continue;
    seen.add(key);
    next.push({ ...recipient, email });
  }
  return next;
}

export function extractDefaultMailDomain(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const address = (value ?? "").trim();
    const at = address.lastIndexOf("@");
    if (at <= 0 || at === address.length - 1) continue;
    const domain = address.slice(at + 1).toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z0-9.-]+$/.test(domain)) return domain;
  }
  return null;
}

function addressToSuggestion(address: MailAddress | null | undefined, score: number, lastSeenAt?: number | null): RecipientSuggestion | null {
  const email = address?.address?.trim();
  if (!email) return null;
  return {
    name: address?.name?.trim() || null,
    email,
    source: "history",
    score,
    lastSeenAt,
  };
}

export function searchCachedMessageContacts(
  messages: readonly MailMessageHeader[],
  query: string,
  selected: readonly ComposeRecipient[] = [],
  limit = 8,
): RecipientSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const selectedEmails = new Set(selected.map((recipient) => normalizeRecipientEmail(recipient.email)).filter(Boolean));
  const byEmail = new Map<string, RecipientSuggestion>();

  for (const message of messages) {
    const addresses = [
      addressToSuggestion(message.from, 20, message.dateTs),
      ...message.to.map((address) => addressToSuggestion(address, 8, message.dateTs)),
      ...message.cc.map((address) => addressToSuggestion(address, 5, message.dateTs)),
    ].filter((item): item is RecipientSuggestion => !!item);

    for (const suggestion of addresses) {
      const key = normalizeRecipientEmail(suggestion.email);
      if (!key || selectedEmails.has(key)) continue;
      const haystack = `${suggestion.name ?? ""} ${suggestion.email}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      const existing = byEmail.get(key);
      const recency = suggestion.lastSeenAt ? Math.min(20, Math.floor(suggestion.lastSeenAt / 86_400_000_000)) : 0;
      const score = suggestion.score + (suggestion.email.toLowerCase().startsWith(needle) ? 80 : 0) + (suggestion.name?.toLowerCase().startsWith(needle) ? 50 : 0) + recency;
      if (!existing || score > existing.score) {
        byEmail.set(key, { ...suggestion, score });
      }
    }
  }

  return Array.from(byEmail.values())
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, limit);
}

export function mergeRecipientSuggestions(
  primary: readonly RecipientSuggestion[],
  secondary: readonly RecipientSuggestion[],
  selected: readonly ComposeRecipient[],
  limit = 8,
): RecipientSuggestion[] {
  const selectedEmails = new Set(selected.map((recipient) => normalizeRecipientEmail(recipient.email)).filter(Boolean));
  const byEmail = new Map<string, RecipientSuggestion>();
  for (const suggestion of [...primary, ...secondary]) {
    const key = normalizeRecipientEmail(suggestion.email);
    if (!key || selectedEmails.has(key)) continue;
    const existing = byEmail.get(key);
    if (!existing || suggestion.score > existing.score) byEmail.set(key, suggestion);
  }
  return Array.from(byEmail.values())
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, limit);
}

export function currentDomainSuggestion(
  query: string,
  defaultDomain: string | null | undefined,
  selected: readonly ComposeRecipient[] = [],
): RecipientSuggestion | null {
  const domain = defaultDomain?.trim().toLowerCase();
  const token = query.trim().toLowerCase();
  if (!domain || !token) return null;
  const match = /^([^@\s<>;,]+)@([^@\s<>;,]*)$/.exec(token);
  if (!match) return null;
  const [, localPart, partialDomain] = match;
  if (!localPart || partialDomain === domain || !domain.startsWith(partialDomain)) return null;
  const email = `${localPart}@${domain}`;
  if (selected.some((recipient) => normalizeRecipientEmail(recipient.email) === email)) return null;
  return {
    name: null,
    email,
    source: "domain",
    score: 1,
    lastSeenAt: null,
  };
}
