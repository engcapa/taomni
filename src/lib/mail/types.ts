import type { NetworkSettingsPayload } from "../networkSettings";
import type { MailOutboxState } from "../mailOutbox";

export interface MailAddress {
  name?: string | null;
  address?: string | null;
}

export interface MailAttachmentInfo {
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  /** IMAP section when listed from BODYSTRUCTURE (large messages). */
  section?: string | null;
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
  /** Contiguous cached UID span (gap-free sync watermark). */
  syncLowUid?: number | null;
  syncHighUid?: number | null;
  /** True when no older history remains to backfill. */
  syncComplete?: boolean;
  cachedCount?: number | null;
  /** Last sync error for this folder; cleared by the next successful sync. */
  lastError?: string | null;
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
  /** Parent message id (no angle brackets). */
  inReplyTo?: string | null;
  /** Thread ancestry, oldest first (no angle brackets). */
  references?: string[];
  /** The sender asked for a read receipt at this address (TASK-17). */
  receiptTo?: string | null;
  /** Mailing-list unsubscribe options (TASK-18). */
  listUnsubscribe?: MailListUnsubscribe | null;
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

export interface MailFolderError {
  name: string;
  error: string;
}

export interface MailSyncAllResult {
  accountId: string;
  folders: MailFolder[];
  fetchedMessages: number;
  /** New unseen mail across folders (never initial sync, repair or backfill). */
  newMessages?: number;
  newUnseenByFolder?: Record<string, number>;
  failedFolders?: MailFolderError[];
  /** Folders whose catch-up needs more steps (call mailSyncFolder). */
  pendingFolders?: string[];
  /** Folders a STATUS check proved unchanged (periodic scans only). */
  unchangedFolders?: string[];
  cachedBodies: number;
  syncedAt: number;
}

export type MailSyncRequestMode = "auto" | "catchup" | "backfill" | "reconcile" | "reconcileFull";

export type MailSyncMode =
  | "initial"
  | "repair"
  | "catchup"
  | "backfill"
  | "reconcile"
  | "reconcileFull"
  | "uncached";

export interface MailFolderSyncResult {
  accountId: string;
  folder: MailFolder;
  mode: MailSyncMode;
  messages: MailMessageHeader[];
  fetched: number;
  newUnseen: number;
  vanished: number;
  flagsUpdated: number;
  remainingNew: number;
  /** Call again to finish the requested work. */
  more: boolean;
  syncComplete: boolean;
  uidValidityReset: boolean;
  syncedAt: number;
}

export type MailSearchField = "all" | "subject" | "sender" | "recipients" | "body";

export interface MailSearchQuery {
  text: string;
  /** null searches every cached folder. */
  folder?: string | null;
  field?: MailSearchField;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  withAttachments?: boolean;
  keyword?: string | null;
  limit?: number;
}

export interface MailServerGuess {
  host: string;
  port: number;
  security: "TLS" | "STARTTLS" | "None";
}

export interface MailAutoconfig {
  source: "builtin" | "ispdb" | "provider" | "well-known" | "guess";
  provider: "gmail" | "outlook" | "custom";
  imap: MailServerGuess;
  smtp: MailServerGuess;
}

export interface MailCertificateInfo {
  host: string;
  port: number;
  sha256: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  derBase64: string;
  trustedBySystem: boolean;
  verifyError?: string | null;
}

export interface MailIdleEvent {
  accountId: string;
  folder: string;
  /** "ready" | "changed" | "unsupported" | "error" | "stopped" */
  kind: string;
  error?: string;
}

export interface MailSyncFolderOptions {
  mode?: MailSyncRequestMode;
  limit?: number;
  includeBodies?: boolean;
}

export interface MailSyncOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
  /**
   * When true (default), remote IMAP LIST refreshes the folder tree.
   * Quiet background polls pass false to skip LIST when local cache has folders.
   */
  refreshFolders?: boolean;
}

export interface MailMarkReadResult {
  folder: string;
  marked: number;
  /** Current server count after marking a whole IMAP folder. */
  unread?: number;
}

export interface MailFlagResult {
  folder: string;
  updated: number;
}

export interface MailMutationProgress {
  operationId: string;
  completedUids: number[];
  pendingUids: number[];
  uncertainUids: number[];
  error: string | null;
  detail: string | null;
  retryable: boolean;
  batchSize: number;
}

export interface MailMoveResult {
  folder: string;
  target: string;
  count: number;
  mutation?: MailMutationProgress | null;
}

export interface MailDeleteResult {
  folder: string;
  deleted: number;
  mutation?: MailMutationProgress | null;
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
  provider: "gmail" | "outlook";
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
  provider: "gmail" | "outlook";
  emailAddress: string;
  clientId: string;
  clientSecret?: string | null;
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
  inReplyTo?: string | null;
  references?: string[];
  /** Local draft whose server copy is removed after sending. */
  draftId?: string | null;
  /** `From:` of a non-default identity ("Name <addr>"); null = account address. */
  from?: string | null;
  replyTo?: string | null;
  /** Ask for a read receipt (Disposition-Notification-To). */
  requestReadReceipt?: boolean;
}

export interface MailListUnsubscribe {
  /** https/http/mailto URIs from `List-Unsubscribe`, in header order. */
  uris: string[];
  /** RFC 8058 one-click POST is offered. */
  oneClick: boolean;
}

export interface MailExportResult {
  path: string;
  count: number;
}

export interface MailImportResult {
  imported: number;
  failed: number;
  firstError?: string | null;
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
  /** Folder that received the stored copy (IMAP APPEND). */
  sentCopyFolder?: string | null;
  sentCopyError?: string | null;
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
  /** Thread ancestry of the replied-to message, oldest first. */
  references?: string[];
  /** Sending identity chosen in the composer. */
  identityId?: string | null;
  /** Present while the message waits in the local Outbox (TASK-17). */
  outbox?: MailOutboxState | null;
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

export interface MailInviteTime {
  /** Epoch seconds for UTC and all-day values; null for zoned wall-clock times. */
  epoch?: number | null;
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in the sender's zone. */
  local: string;
  tzid?: string | null;
  allDay: boolean;
}

export interface MailInviteAttendee {
  email: string;
  name?: string | null;
  partstat: string;
}

/** iTIP/iMIP calendar invitation carried by a message (TASK-20). */
export interface MailInvite {
  method: string;
  uid: string;
  sequence: number;
  summary: string;
  location?: string | null;
  description?: string | null;
  start?: MailInviteTime | null;
  end?: MailInviteTime | null;
  organizer?: MailInviteAttendee | null;
  attendees: MailInviteAttendee[];
  status?: string | null;
  ics: string;
}

export type MailInviteReply = "accept" | "tentative" | "decline";

export interface MailInviteResponse {
  partstat: string;
  sentTo: string;
}

export interface MailArchiveStatus {
  phase: "idle" | "connecting" | "headers" | "downloading" | "verifying" | "pausing" | "paused" | "completed" | "failed" | "shared";
  folder?: string | null;
  saved: number;
  headersSynced?: number;
  headersTotal?: number | null;
  total: number;
  bytes: number;
  totalBytes?: number | null;
  error?: string | null;
}

export interface MailArchiveEntry {
  folder: string;
  uid: number;
  uidValidity: number;
  subject: string;
  rawSize: number;
  storedSize: number;
  storedAt: number;
  from?: string;
  to?: string;
  dateTs?: number | null;
  hasAttachments?: boolean;
}

export interface MailArchiveQuery {
  text?: string;
  field?: "all" | "subject" | "from" | "to";
  folder?: string | null;
  hasAttachments?: boolean | null;
  dateFrom?: number | null;
  dateBefore?: number | null;
  storedFrom?: number | null;
  storedBefore?: number | null;
  minSize?: number | null;
  maxSize?: number | null;
  sort?: "savedNewest" | "savedOldest" | "dateNewest" | "dateOldest" | "largest" | "smallest";
}

export type MailArchiveKey = Pick<MailArchiveEntry, "folder" | "uid" | "uidValidity">;

export interface MailArchivePage { entries: MailArchiveEntry[]; total: number; storedBytes: number; folders: string[]; offset: number; }

export interface MailArchiveSelection { query?: MailArchiveQuery; keys?: MailArchiveKey[]; excluded?: MailArchiveKey[]; }

export interface MailCleanupPreview { token: string; count: number; storedBytes: number; reclaimableBytes: number; }
