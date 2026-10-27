import { type ReactNode } from "react";
import type { MailTabInfo } from "../../../types";
import { type MailContactSuggestion, type MailDraftAttachment, type MailDraftContext, type MailMessageHeader } from "../../../lib/mail";
import { type ComposeRecipient } from "../../../lib/mailRecipients";


export interface MailClientTabProps {
  tabId: string;
  info: MailTabInfo;
  visible: boolean;
  onEditSession?: (sessionId: string) => void;
}


export interface ComposeDraft {
  id?: string | null;
  to: ComposeRecipient[];
  cc: ComposeRecipient[];
  bcc: ComposeRecipient[];
  subject: string;
  htmlBody: string;
  textBody: string;
  attachments: MailDraftAttachment[];
  replyContext?: MailDraftContext | null;
  richFormatUsed: boolean;
  /** Sending identity (DEFAULT_IDENTITY_ID = account address). */
  identityId?: string | null;
  /** Ask for a read receipt (RFC 8098). */
  readReceipt?: boolean;
}


export type RecipientFieldKey = "to" | "cc" | "bcc";


export interface RecipientSearchState {
  field: RecipientFieldKey | null;
  query: string;
  suggestions: MailContactSuggestion[];
  loading: boolean;
}


export interface OpenMailMessageTab {
  key: string;
  message: MailMessageHeader;
}


export interface BodyWarmState {
  active: boolean;
  done: number;
  total: number;
  folder?: string | null;
}

export interface MailCachePageResult {
  page: MailMessageHeader[];
  hasMore: boolean;
  /** False when stale, hidden, removed or failed work did not own the list. */
  applied: boolean;
}


export interface MailDraggableDialogProps {
  title: string;
  icon: ReactNode;
  ariaLabel: string;
  minWidth: number;
  minHeight: number;
  className: string;
  children: ReactNode;
  headerActions?: ReactNode;
  closeTestId?: string;
  onClose: () => void;
}


export type ComposePromptState = {
  kind: "error" | "attachment";
  title: string;
  message: string;
};


export type AiAction = "summarize" | "reply" | "tasks";

export type SyncIndicator = "sync" | "more" | "none";


export interface SyncFolderOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
  append?: boolean;
  indicator?: SyncIndicator;
  /** Default true for open/manual sync; quiet polls pass false to skip LIST. */
  refreshFolders?: boolean;
}
