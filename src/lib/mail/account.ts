import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import { withVaultLockedNotice } from "../ipc";
import {
  type MailSearchQuery,
  type MailMessageHeader,
  type MailAutoconfig,
  type MailCertificateInfo,
  type MailExportResult,
  type MailContactSuggestion,
  type MailTestConnectionResult,
} from "./types";

/** IMAP SEARCH in one server folder (mail whose body is not cached). */
export function mailSearchServer(config: MailTabInfo, folder: string, query: MailSearchQuery): Promise<MailMessageHeader[]> {
  return withVaultLockedNotice(() =>
    invoke<MailMessageHeader[]>("mail_search_server", { config, folder, query }),
  );
}

/** Discover IMAP/SMTP settings; `allowOnline` sends the domain to ISPDB. */
export function mailAutoconfig(email: string, allowOnline: boolean): Promise<MailAutoconfig | null> {
  return invoke<MailAutoconfig | null>("mail_autoconfig", { email, allowOnline });
}

/** Fetch the IMAP or SMTP server certificate for review (AC-44). */
export function mailProbeCertificate(config: MailTabInfo, protocol: "imap" | "smtp"): Promise<MailCertificateInfo> {
  return withVaultLockedNotice(() => invoke<MailCertificateInfo>("mail_probe_certificate", { config, protocol }));
}

/** Handshake errors the backend tagged as certificate problems. */
export function isMailCertificateError(message: string | null | undefined): boolean {
  return /untrusted server certificate|no longer matches the one you trusted/i.test(message ?? "");
}

/** Export a folder to an mbox file (mboxrd, Thunderbird-compatible). */
export function mailExportMbox(config: MailTabInfo, folder: string, path: string): Promise<MailExportResult> {
  return withVaultLockedNotice(() => invoke<MailExportResult>("mail_export_mbox", { config, folder, path }));
}

/** RFC 8058 one-click unsubscribe POST (https only). */
export function mailUnsubscribeOneClick(url: string): Promise<number> {
  return invoke<number>("mail_unsubscribe_one_click", { url });
}

export function mailIndexCachedContacts(accountId: string): Promise<number> {
  return invoke<number>("mail_index_cached_contacts", { accountId });
}

export function mailSearchContacts(
  accountId: string,
  query: string,
  limit = 8,
): Promise<MailContactSuggestion[]> {
  return invoke<MailContactSuggestion[]>("mail_search_contacts", { accountId, query, limit });
}

export function mailTestConnection(config: MailTabInfo): Promise<MailTestConnectionResult> {
  return withVaultLockedNotice(() =>
    invoke<MailTestConnectionResult>("mail_test_connection", { config }),
  );
}

export function mailClearCache(accountId: string): Promise<void> {
  return invoke("mail_clear_cache", { accountId });
}
