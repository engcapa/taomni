import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../../types";
import { withVaultLockedNotice } from "../ipc";
import {
  type MailSearchQuery,
  type MailMessageHeader,
  type MailImportResult,
  type MailSyncOptions,
  type MailSyncResult,
  type MailMessageBody,
  type MailMarkReadResult,
  type MailDownloadAttachmentResult,
  type MailSendRequest,
  type MailSendResult,
  type MailFlagResult,
  type MailMoveResult,
  type MailDeleteResult,
} from "./types";

/** Search the local full-text index (all cached headers, cached bodies). */
export function mailSearchMessages(accountId: string, query: MailSearchQuery): Promise<MailMessageHeader[]> {
  return invoke<MailMessageHeader[]>("mail_search_messages", { accountId, query });
}

/** Import an mbox or .eml file into a folder (IMAP APPEND). */
export function mailImportMessages(config: MailTabInfo, folder: string, path: string): Promise<MailImportResult> {
  return withVaultLockedNotice(() => invoke<MailImportResult>("mail_import_messages", { config, folder, path }));
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
      refreshFolders: options.refreshFolders ?? null,
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

/** Populate the native disk cache without returning a body to the renderer. */
export function mailPrefetchMessageBody(config: MailTabInfo, folder: string, uid: number): Promise<void> {
  return invoke<void>("mail_prefetch_message_body", { config, folder, uid });
}

export function mailMarkRead(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  all = false,
): Promise<MailMarkReadResult> {
  return withVaultLockedNotice(() =>
    invoke<MailMarkReadResult>("mail_mark_read", {
      config,
      folder,
      uids,
      all,
    }),
  );
}

export function mailDownloadAttachment(
  config: MailTabInfo,
  folder: string,
  uid: number,
  attachmentIndex: number,
  targetPath: string,
  /** IMAP section of a large message's attachment (fetches only that part). */
  section?: string | null,
): Promise<MailDownloadAttachmentResult> {
  return withVaultLockedNotice(() =>
    invoke<MailDownloadAttachmentResult>("mail_download_attachment", {
      config,
      folder,
      uid,
      attachmentIndex,
      targetPath,
      section: section ?? null,
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

export function mailSetFlags(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  add: string[],
  remove: string[],
): Promise<MailFlagResult> {
  return withVaultLockedNotice(() =>
    invoke<MailFlagResult>("mail_set_flags", { config, folder, uids, add, remove }),
  );
}

export function mailMoveMessages(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  targetFolder: string,
  operationId?: string,
): Promise<MailMoveResult> {
  return withVaultLockedNotice(() =>
    invoke<MailMoveResult>("mail_move_messages", { config, folder, uids, targetFolder, operationId }),
  );
}

export function mailCopyMessages(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  targetFolder: string,
  operationId?: string,
): Promise<MailMoveResult> {
  return withVaultLockedNotice(() =>
    invoke<MailMoveResult>("mail_copy_messages", { config, folder, uids, targetFolder, operationId }),
  );
}

export function mailDeleteMessages(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  all = false,
  operationId?: string,
): Promise<MailDeleteResult> {
  return withVaultLockedNotice(() =>
    invoke<MailDeleteResult>("mail_delete_messages", { config, folder, uids, all, operationId }),
  );
}

export function mailFetchRaw(
  config: MailTabInfo,
  folder: string,
  uid: number,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("mail_fetch_raw", { config, folder, uid }),
  );
}

export function mailSaveRaw(
  config: MailTabInfo,
  folder: string,
  uid: number,
  targetPath: string,
): Promise<MailDownloadAttachmentResult> {
  return withVaultLockedNotice(() =>
    invoke<MailDownloadAttachmentResult>("mail_save_raw", { config, folder, uid, targetPath }),
  );
}
