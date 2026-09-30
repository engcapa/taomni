// Browser-preview model of the address book (src-tauri/src/mail/contacts.rs).
// Local entries only: CardDAV sync reports that it needs the desktop app.
// Proves renderer orchestration; the Rust tests cover vCard and CardDAV.

import type { MailAddressBookEntry } from "../lib/mailContacts";

const books = new Map<string, MailAddressBookEntry[]>();
let counter = 0;

export function stubListAddressBook(accountId: string): MailAddressBookEntry[] {
  return (books.get(accountId) ?? [])
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function stubSaveAddressBookEntry(accountId: string, entry: MailAddressBookEntry): MailAddressBookEntry {
  const emails = entry.emails.map((email) => email.trim()).filter(Boolean);
  const name = entry.displayName.trim();
  if (!name && emails.length === 0) throw new Error("a contact needs a name or an email address");
  const bad = emails.find((email) => !email.includes("@") || /\s/.test(email));
  if (bad) throw new Error(`"${bad}" is not an email address`);
  counter += 1;
  const saved: MailAddressBookEntry = {
    ...entry,
    uid: entry.uid || `stub-contact-${counter}`,
    book: entry.book || "local",
    displayName: name || emails[0],
    emails,
    phones: entry.phones.map((phone) => phone.trim()).filter(Boolean),
    pendingSync: false,
  };
  const list = (books.get(accountId) ?? []).filter((item) => item.uid !== saved.uid);
  books.set(accountId, [...list, saved]);
  return { ...saved };
}

export function stubDeleteAddressBookEntry(accountId: string, uid: string): boolean {
  const list = books.get(accountId) ?? [];
  books.set(accountId, list.filter((item) => item.uid !== uid));
  return list.length !== (books.get(accountId) ?? []).length;
}

/** Autocomplete hits from the address book, in the backend's shape. */
export function stubAddressBookSuggestions(accountId: string, query: string, limit: number) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return (books.get(accountId) ?? [])
    .flatMap((entry) => entry.emails
      .filter((email) => email.toLowerCase().includes(needle) || entry.displayName.toLowerCase().includes(needle))
      .map((email) => ({
        name: entry.displayName !== email ? entry.displayName : null,
        email,
        source: "addressBook" as const,
        score: 600 + (email.toLowerCase().startsWith(needle) ? 260 : 0),
        lastSeenAt: null,
      })))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
