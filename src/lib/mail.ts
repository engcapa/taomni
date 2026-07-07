import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../types";
import type { NetworkSettingsPayload } from "./networkSettings";
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

export interface MailSyncAllResult {
  accountId: string;
  folders: MailFolder[];
  fetchedMessages: number;
  newMessages?: number;
  cachedBodies: number;
  syncedAt: number;
}

export interface MailSyncOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
}

export interface MailMarkReadResult {
  folder: string;
  marked: number;
}

export interface MailFlagResult {
  folder: string;
  updated: number;
}

export interface MailMoveResult {
  folder: string;
  target: string;
  count: number;
}

export interface MailDeleteResult {
  folder: string;
  deleted: number;
}

export interface MailTestConnectionResult {
  imapOk: boolean;
  smtpOk: boolean;
  folderCount: number;
}

export interface MailOAuthAuthorizeRequest {
  sessionId: string;
  provider: "gmail" | "outlook";
  emailAddress: string;
  clientId: string;
  clientSecret?: string | null;
  networkSettings?: NetworkSettingsPayload | null;
}

export interface MailOAuthAuthorizeResult {
  tokenRef: string;
  expiresAt?: number | null;
  scope?: string | null;
  tokenType?: string | null;
}

export interface MailOAuthDeviceStartRequest {
  sessionId: string;
  provider: "outlook";
  emailAddress: string;
  clientId: string;
  networkSettings?: NetworkSettingsPayload | null;
}

export interface MailOAuthDeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
  interval: number;
}

export interface MailOAuthDeviceCompleteRequest {
  sessionId: string;
  provider: "outlook";
  emailAddress: string;
  clientId: string;
  deviceCode: string;
  interval?: number | null;
  expiresIn?: number | null;
  networkSettings?: NetworkSettingsPayload | null;
}

export interface MailSendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody?: string | null;
  htmlBody?: string | null;
  attachments?: MailSendAttachment[];
}

export interface MailSendAttachment {
  path: string;
  name?: string | null;
  contentType?: string | null;
  inline?: boolean;
  contentId?: string | null;
}

export interface MailSendResult {
  accepted: boolean;
  response: string;
}

export interface MailContactSuggestion {
  name?: string | null;
  email: string;
  source: "history" | "sent" | "typed";
  score: number;
  lastSeenAt?: number | null;
}

export interface MailDownloadAttachmentResult {
  path: string;
  name?: string | null;
  contentType?: string | null;
  size: number;
}

export interface MailDraftAttachment {
  path: string;
  name?: string | null;
  contentType?: string | null;
  inline?: boolean;
  contentId?: string | null;
  size?: number | null;
  modifiedAt?: number | null;
}

export interface MailDraftContext {
  kind?: string | null;
  folder?: string | null;
  uid?: number | null;
  messageId?: string | null;
  subject?: string | null;
}

export interface MailDraft {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: MailDraftAttachment[];
  replyContext?: MailDraftContext | null;
  remoteDraftFolder?: string | null;
  remoteDraftUid?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MailDraftSaveRequest {
  id?: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: MailDraftAttachment[];
  replyContext?: MailDraftContext | null;
  remoteDraftFolder?: string | null;
  remoteDraftUid?: number | null;
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

export function mailSyncAllFolders(
  config: MailTabInfo,
  options: Pick<MailSyncOptions, "limit" | "includeBodies"> = {},
): Promise<MailSyncAllResult> {
  return withVaultLockedNotice(() =>
    invoke<MailSyncAllResult>("mail_sync_all_folders", {
      config,
      limit: options.limit ?? null,
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

export function mailListDrafts(accountId: string): Promise<MailDraft[]> {
  return invoke<MailDraft[]>("mail_list_drafts", { accountId });
}

export function mailSaveDraft(
  accountId: string,
  draft: MailDraftSaveRequest,
): Promise<MailDraft> {
  return invoke<MailDraft>("mail_save_draft", { accountId, draft });
}

export function mailDeleteDraft(accountId: string, draftId: string): Promise<void> {
  return invoke("mail_delete_draft", { accountId, draftId });
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

export function mailOAuthAuthorize(
  request: MailOAuthAuthorizeRequest,
): Promise<MailOAuthAuthorizeResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthAuthorizeResult>("mail_oauth_authorize", { request }),
  );
}

export function mailOAuthDeviceStart(
  request: MailOAuthDeviceStartRequest,
): Promise<MailOAuthDeviceStartResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthDeviceStartResult>("mail_oauth_device_start", { request }),
  );
}

export function mailOAuthDeviceComplete(
  request: MailOAuthDeviceCompleteRequest,
): Promise<MailOAuthAuthorizeResult> {
  return withVaultLockedNotice(() =>
    invoke<MailOAuthAuthorizeResult>("mail_oauth_device_complete", { request }),
  );
}

export function mailClearCache(accountId: string): Promise<void> {
  return invoke("mail_clear_cache", { accountId });
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
): Promise<MailMoveResult> {
  return withVaultLockedNotice(() =>
    invoke<MailMoveResult>("mail_move_messages", { config, folder, uids, targetFolder }),
  );
}

export function mailCopyMessages(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  targetFolder: string,
): Promise<MailMoveResult> {
  return withVaultLockedNotice(() =>
    invoke<MailMoveResult>("mail_copy_messages", { config, folder, uids, targetFolder }),
  );
}

export function mailDeleteMessages(
  config: MailTabInfo,
  folder: string,
  uids: number[],
  all = false,
): Promise<MailDeleteResult> {
  return withVaultLockedNotice(() =>
    invoke<MailDeleteResult>("mail_delete_messages", { config, folder, uids, all }),
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

export function mailCreateFolder(config: MailTabInfo, name: string): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_create_folder", { config, name }),
  );
}

export function mailRenameFolder(
  config: MailTabInfo,
  from: string,
  to: string,
): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_rename_folder", { config, from, to }),
  );
}

export function mailDeleteFolder(config: MailTabInfo, name: string): Promise<MailFolder[]> {
  return withVaultLockedNotice(() =>
    invoke<MailFolder[]>("mail_delete_folder", { config, name }),
  );
}
