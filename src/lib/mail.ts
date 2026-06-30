import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../types";
import { withVaultLockedNotice } from "./ipc";

export interface MailAddress {
  name?: string | null;
  address?: string | null;
}

export interface MailAttachmentInfo {
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}

export interface MailFolder {
  accountId: string;
  name: string;
  displayName?: string | null;
  delimiter?: string | null;
  flags: string[];
  uidValidity?: number | null;
  uidNext?: number | null;
  total?: number | null;
  unread?: number | null;
  updatedAt: number;
}

export interface MailMessageHeader {
  accountId: string;
  folder: string;
  uid: number;
  messageId?: string | null;
  subject: string;
  from?: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  dateTs?: number | null;
  flags: string[];
  hasAttachments: boolean;
  attachmentCount: number;
  attachments: MailAttachmentInfo[];
  snippet?: string | null;
  rawSize?: number | null;
  bodyCached: boolean;
}

export interface MailMessageBody {
  accountId: string;
  folder: string;
  uid: number;
  messageId?: string | null;
  subject: string;
  text?: string | null;
  html?: string | null;
  snippet?: string | null;
  attachments: MailAttachmentInfo[];
  rawSize?: number | null;
  cachedAt?: number | null;
  source: string;
}

export interface MailSyncResult {
  accountId: string;
  folder: string;
  folders: MailFolder[];
  messages: MailMessageHeader[];
  fetchedMessages: number;
  cachedBodies: number;
  syncedAt: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface MailSyncOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
}

export interface MailTestConnectionResult {
  imapOk: boolean;
  smtpOk: boolean;
  folderCount: number;
}

export interface MailSendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody?: string | null;
  htmlBody?: string | null;
}

export interface MailSendResult {
  accepted: boolean;
  response: string;
}

export interface MailDownloadAttachmentResult {
  path: string;
  name?: string | null;
  contentType?: string | null;
  size: number;
}

export function mailListCachedFolders(accountId: string): Promise<MailFolder[]> {
  return invoke<MailFolder[]>("mail_list_cached_folders", { accountId });
}

export function mailListCachedMessages(
  accountId: string,
  folder: string,
  limit = 200,
  offset = 0,
): Promise<MailMessageHeader[]> {
  return invoke<MailMessageHeader[]>("mail_list_cached_messages", {
    accountId,
    folder,
    limit,
    offset,
  });
}

export function mailSyncHeaders(
  config: MailTabInfo,
  folder?: string | null,
  options: MailSyncOptions = {},
): Promise<MailSyncResult> {
  return withVaultLockedNotice(() =>
    invoke<MailSyncResult>("mail_sync_headers", {
      config,
      folder: folder ?? null,
      limit: options.limit ?? null,
      offset: options.offset ?? null,
      includeBodies: options.includeBodies ?? null,
    }),
  );
}

export function mailGetMessageBody(
  config: MailTabInfo,
  folder: string,
  uid: number,
): Promise<MailMessageBody> {
  return withVaultLockedNotice(() =>
    invoke<MailMessageBody>("mail_get_message_body", { config, folder, uid }),
  );
}

export function mailDownloadAttachment(
  config: MailTabInfo,
  folder: string,
  uid: number,
  attachmentIndex: number,
  targetPath: string,
): Promise<MailDownloadAttachmentResult> {
  return withVaultLockedNotice(() =>
    invoke<MailDownloadAttachmentResult>("mail_download_attachment", {
      config,
      folder,
      uid,
      attachmentIndex,
      targetPath,
    }),
  );
}

export function mailSendMessage(
  config: MailTabInfo,
  request: MailSendRequest,
): Promise<MailSendResult> {
  return withVaultLockedNotice(() =>
    invoke<MailSendResult>("mail_send_message", { config, request }),
  );
}

export function mailTestConnection(config: MailTabInfo): Promise<MailTestConnectionResult> {
  return withVaultLockedNotice(() =>
    invoke<MailTestConnectionResult>("mail_test_connection", { config }),
  );
}

export function mailClearCache(accountId: string): Promise<void> {
  return invoke("mail_clear_cache", { accountId });
}
