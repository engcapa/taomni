import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../types";
import { withVaultLockedNotice } from "./ipc";

/** Address book entry (TASK-19); mirrors src-tauri/src/mail/contacts.rs. */
export interface MailAddressBookEntry {
  uid: string;
  /** "local" or "carddav". */
  book: string;
  displayName: string;
  emails: string[];
  phones: string[];
  org?: string | null;
  note?: string | null;
  /** Local change not yet uploaded to the CardDAV server. */
  pendingSync?: boolean;
}

export interface MailCardDavSyncResult {
  collection: string;
  pulled: number;
  removed: number;
  pushed: number;
  conflicts: number;
  errors: string[];
}

export function emptyAddressBookEntry(partial: Partial<MailAddressBookEntry> = {}): MailAddressBookEntry {
  return { uid: "", book: "", displayName: "", emails: [""], phones: [], org: null, note: null, ...partial };
}

/** Case-insensitive match on name, email, phone or organization. */
export function addressBookMatches(entry: MailAddressBookEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.displayName, entry.org ?? "", ...entry.emails, ...entry.phones]
    .some((value) => value.toLowerCase().includes(needle));
}

export function syncSummary(result: MailCardDavSyncResult): string {
  const parts = [
    `${result.pulled} updated from the server`,
    `${result.pushed} uploaded`,
  ];
  if (result.removed) parts.push(`${result.removed} removed`);
  if (result.conflicts) parts.push(`${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} (server copy kept)`);
  if (result.errors.length) parts.push(`${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
  return `CardDAV sync: ${parts.join(", ")}`;
}

export function mailListAddressBook(accountId: string): Promise<MailAddressBookEntry[]> {
  return invoke<MailAddressBookEntry[]>("mail_list_address_book", { accountId });
}

export function mailSaveAddressBookEntry(config: MailTabInfo, entry: MailAddressBookEntry): Promise<MailAddressBookEntry> {
  return invoke<MailAddressBookEntry>("mail_save_address_book_entry", { config, entry });
}

export function mailDeleteAddressBookEntry(accountId: string, uid: string): Promise<boolean> {
  return invoke<boolean>("mail_delete_address_book_entry", { accountId, uid });
}

export function mailImportVcards(config: MailTabInfo, sourcePath: string): Promise<number> {
  return invoke<number>("mail_import_vcards", { config, sourcePath });
}

export function mailExportVcards(accountId: string, targetPath: string): Promise<number> {
  return invoke<number>("mail_export_vcards", { accountId, targetPath });
}

export function mailCardDavSync(config: MailTabInfo): Promise<MailCardDavSyncResult> {
  return withVaultLockedNotice(() => invoke<MailCardDavSyncResult>("mail_carddav_sync", { config }));
}
