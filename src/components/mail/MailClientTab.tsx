import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type UIEvent } from "react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  AlertTriangle,
  Archive,
  Ban,
  BookUser,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Filter as FilterIcon,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSymlink,
  FolderX,
  Forward,
  Image as ImageIcon,
  ImageOff,
  Inbox,
  Link as LinkIcon,
  ListChecks,
  Loader2,
  Mail as MailIcon,
  MailOpen,
  MessageSquareReply,
  Paperclip,
  PenLine,
  Printer,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MailIdentity, MailTabInfo } from "../../types";
import {
  mailClearCache,
  mailCopyMessages,
  mailCreateFolder,
  mailDeleteFolder,
  mailDeleteMessages,
  mailDownloadAttachment,
  mailExportMbox,
  isMailCertificateError,
  mailProbeCertificate,
  mailImportMessages,
  mailFetchRaw,
  mailSendReceipt,
  MAIL_MDN_SENT,
  mailGetInvite,
  mailRespondInvite,
  mailGetMessageBody,
  mailIdleStart,
  mailIdleStop,
  mailIndexCachedContacts,
  mailDeleteDraft,
  mailDiscardRemoteDraft,
  mailStoreRemoteDraft,
  mailListDrafts,
  mailListFolders,
  mailListCachedFolders,
  mailListCachedMessages,
  mailSaveDraft,
  mailMarkRead,
  mailMoveMessages,
  mailRenameFolder,
  mailSaveRaw,
  mailSendMessage,
  mailSetFlags,
  mailSetFolderSubscription,
  mailSearchContacts,
  mailSearchMessages,
  mailSearchServer,
  mailSyncAllFolders,
  mailSyncFolder,
  mailSyncHeaders,
  mailTestConnection,
  mailUnsubscribeOneClick,
  MAIL_IDLE_EVENT,
  type MailAddress,
  type MailAttachmentInfo,
  type MailContactSuggestion,
  type MailDraft,
  type MailDraftAttachment,
  type MailDraftContext,
  type MailFolder,
  type MailCertificateInfo,
  type MailFolderSyncResult,
  type MailIdleEvent,
  type MailInvite,
  type MailInviteReply,
  type MailMessageBody,
  type MailMessageHeader,
  type MailSearchField,
  type MailSendRequest,
  type MailSendResult,
  type MailSyncRequestMode,
} from "../../lib/mail";
import { listen } from "@tauri-apps/api/event";
import { notifyDesktop } from "../../lib/lanNotify";
import { formatInviteRange, hasCalendarPart, myPartstat } from "../../lib/mailInvite";
import { filterFromMessage, mailApplyFilters, type MailFilter } from "../../lib/mailFilters";
import { MailFiltersPanel } from "./MailFiltersPanel";
import { MailAddressBookPanel } from "./MailAddressBookPanel";
import { MailAgendaPanel } from "./MailAgendaPanel";
import {
  agendaKey,
  agendaTimeLabel,
  dueReminders,
  mailAddInviteToCalendar,
  mailCalDavSync,
  mailListAgenda,
  type MailAgendaEvent,
} from "../../lib/mailCalendar";
import { emptyAddressBookEntry, type MailAddressBookEntry } from "../../lib/mailContacts";
import {
  isSelectable,
  isSubscribed,
  loadSubscribedOnly,
  saveSubscribedOnly,
  visibleFolders,
} from "../../lib/mailFolders";
import {
  fromDateTimeLocal,
  isOutbox,
  isTransientSendError,
  outboxNextAttemptAt,
  outboxState,
  toDateTimeLocal,
  type MailOutboxState,
} from "../../lib/mailOutbox";
import { parseMailto } from "../../lib/mailto";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { mentionsAttachment } from "../../lib/mailAttachReminder";
import { isEditableTarget, mailShortcutAction, type MailShortcutAction } from "../../lib/mailShortcuts";
import { buildMailThreads, flattenMailThreads, type MailThreadRow } from "../../lib/mailThreads";
import {
  DEFAULT_IDENTITY_ID,
  identityFromHeader,
  identityLabel,
  mailIdentities,
  ownIdentityAddresses,
  pickReplyIdentity,
  swapSignature,
} from "../../lib/mailIdentities";
import {
  JUNK_KEYWORD,
  MAIL_TAGS,
  NOT_JUNK_KEYWORD,
  isJunk,
  messageTags,
  toggleKeywordPlan,
} from "../../lib/mailTags";
import {
  countNewMail,
  folderHasMoreToLoad,
  mergeFolderMeta,
  mergeSyncedMessages,
  runFolderSyncLoop,
} from "../../lib/mailSync";
import { RecipientField } from "./RecipientField";
import { RichMailEditor } from "./RichMailEditor";
import { MailMessageBodyView } from "./MailMessageBodyView";
import {
  extractDefaultMailDomain,
  formatRecipientForSend,
  isValidEmailAddress,
  mergeRecipientSuggestions,
  parseRecipientsText,
  recipientLabel,
  searchCachedMessageContacts,
  type ComposeRecipient,
  type RecipientSuggestion,
} from "../../lib/mailRecipients";
import {
  buildForwardHtml,
  buildInlineImageHtml,
  buildMailReaderSrcDoc,
  buildReplyHtml,
  hasRichMailFormatting,
  mailHtmlHasRemoteImages,
  mailHtmlToPlainText,
  plainTextToMailHtml,
  prepareMailHtmlForSend,
  quotePlainText,
  sanitizeMailComposeHtml,
  signatureToMailHtml,
} from "../../lib/mailHtml";
import { formatMailPlainTextHtml } from "../../lib/mailPlainText";
import {
  openLocalPath,
  readFileBytes,
  selectUploadFile,
  temporaryFilePath,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
} from "../../lib/ipc";
import {
  readClipboardImageFiles,
  readNativeClipboardImagePath,
} from "../../lib/clipboard";
import {
  droppedFilePaths,
  droppedFiles,
  isOsFileDrag,
  NATIVE_FILE_DROP_EVENT,
  preventDefaultForOsFileDrag,
  type NativeFileDropDetail,
} from "../../lib/osFileDrop";
import { useChatStore } from "../../stores/chatStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { DEFAULT_MAIL_TERMINAL_PROFILE, type TerminalProfile } from "../../lib/terminalProfile";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useAppTheme } from "../../lib/appTheme";
import { resolveMailTheme } from "../../lib/mailTheme";

interface MailClientTabProps {
  tabId: string;
  info: MailTabInfo;
  visible: boolean;
  onEditSession?: (sessionId: string) => void;
}

interface ComposeDraft {
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

type RecipientFieldKey = "to" | "cc" | "bcc";

interface RecipientSearchState {
  field: RecipientFieldKey | null;
  query: string;
  suggestions: MailContactSuggestion[];
  loading: boolean;
}

interface OpenMailMessageTab {
  key: string;
  message: MailMessageHeader;
}

interface BodyWarmState {
  active: boolean;
  done: number;
  total: number;
  folder?: string | null;
}

interface MailDraggableDialogProps {
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

type AiAction = "summarize" | "reply" | "tasks";
type SyncIndicator = "sync" | "more" | "none";

function isOAuthReauthRequired(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes("oauth authorization expired or was revoked")
    || normalized.includes("oauth2 authorization expired or was revoked")
    || normalized.includes("oauth2 refresh token is missing")
    || normalized.includes("invalid_grant")
    || normalized.includes("aadsts70008")
    || normalized.includes("aadsts700082");
}

function mailClientErrorMessage(error: unknown): string {
  const message = String(error);
  if (isOAuthReauthRequired(message)) {
    return "OAuth authorization expired or was revoked. Reauthorize this mail account.";
  }
  return message;
}

interface SyncFolderOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
  append?: boolean;
  indicator?: SyncIndicator;
  /** Default true for open/manual sync; quiet polls pass false to skip LIST. */
  refreshFolders?: boolean;
}

const DEFAULT_FOLDER: MailFolder = {
  accountId: "",
  name: "INBOX",
  delimiter: "/",
  flags: [],
  uidValidity: null,
  uidNext: null,
  total: null,
  unread: null,
  updatedAt: 0,
};

function emptyComposeDraft(): ComposeDraft {
  return {
    id: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    htmlBody: "<p><br></p>",
    textBody: "",
    attachments: [],
    replyContext: null,
    richFormatUsed: false,
  };
}

const EMPTY_DRAFT: ComposeDraft = {
  id: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  htmlBody: "<p><br></p>",
  textBody: "",
  attachments: [],
  replyContext: null,
  richFormatUsed: false,
};

const MAIL_MESSAGE_PAGE_SIZE = 200;
const MAIL_REFRESH_BATCH_SIZE = 50;
const MAILBOX_RIBBON_THRESHOLD = 7;
const MAILBOX_EXPANDED_SIZE = 14;
const MAIL_BASE_FONT_SIZE = DEFAULT_MAIL_TERMINAL_PROFILE.fontSize;
const MAIL_MIN_FONT_SIZE = 8;
const MAIL_MAX_FONT_SIZE = 32;
const ALL_ATTACHMENTS_INDEX = -1;
function messageKey(message: MailMessageHeader): string {
  return `${message.folder}:${message.uid}`;
}

function bodyMatchesMessage(
  body: MailMessageBody | null,
  message: MailMessageHeader | null | undefined,
): body is MailMessageBody {
  return !!body
    && !!message
    && body.accountId === message.accountId
    && body.folder === message.folder
    && body.uid === message.uid;
}

function clampMailFontSize(value: number): number {
  if (!Number.isFinite(value)) return MAIL_BASE_FONT_SIZE;
  return Math.min(MAIL_MAX_FONT_SIZE, Math.max(MAIL_MIN_FONT_SIZE, Math.round(value)));
}

function color(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const raw = match[1];
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function mixColor(foreground: string, background: string, amount: number): string {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return amount >= 50 ? foreground : background;
  const ratio = Math.max(0, Math.min(100, amount)) / 100;
  const mixed = fg.map((channel, index) => channel * ratio + bg[index] * (1 - ratio));
  return `#${hex(mixed[0])}${hex(mixed[1])}${hex(mixed[2])}`;
}

function colorLuminance(value: string): number | null {
  const rgb = parseHexColor(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mailAppearanceStyle(profile: TerminalProfile | undefined, fontSize: number, appPrefersDark: boolean): CSSProperties {
  const terminalProfile = profile ?? DEFAULT_MAIL_TERMINAL_PROFILE;
  const theme = resolveMailTheme(terminalProfile.theme, appPrefersDark);
  const background = color(theme.background, "#1d1f21");
  const foreground = color(theme.foreground, "#eaeaea");
  const accent = color(theme.blue ?? theme.cyan ?? theme.cursor, "#83a7d8");
  const darkBackground = (colorLuminance(background) ?? 0) < 0.5;
  const accentSoft = darkBackground
    ? mixColor(foreground, accent, 24)
    : mixColor(background, accent, 24);
  const divider = mixColor(foreground, background, 18);
  const buttonFrom = darkBackground
    ? mixColor(foreground, background, 12)
    : mixColor(foreground, background, 2);
  const buttonTo = darkBackground
    ? mixColor(foreground, background, 8)
    : mixColor(foreground, background, 7);
  const buttonHoverFrom = darkBackground
    ? mixColor(foreground, background, 18)
    : mixColor(foreground, background, 4);
  const buttonHoverTo = darkBackground
    ? mixColor(foreground, background, 13)
    : mixColor(foreground, background, 11);
  const buttonDisabled = darkBackground
    ? mixColor(foreground, background, 5)
    : mixColor(foreground, background, 6);
  return {
    "--taomni-color-scheme": darkBackground ? "dark" : "light",
    "--taomni-bg": background,
    "--taomni-panel-bg": mixColor(foreground, background, 5),
    "--taomni-sidebar-bg": mixColor(foreground, background, 8),
    "--taomni-chrome-bg": mixColor(foreground, background, 11),
    "--taomni-quick-bg": mixColor(foreground, background, 9),
    "--taomni-input-bg": mixColor(foreground, background, 6),
    "--taomni-input-border": divider,
    "--taomni-chrome-border": divider,
    "--taomni-divider": divider,
    "--taomni-hover": mixColor(accent, background, 16),
    "--taomni-selected": mixColor(accent, background, 26),
    "--taomni-accent": accent,
    "--taomni-accent-soft": accentSoft,
    "--taomni-button-from": buttonFrom,
    "--taomni-button-to": buttonTo,
    "--taomni-button-hover-from": buttonHoverFrom,
    "--taomni-button-hover-to": buttonHoverTo,
    "--taomni-button-disabled": buttonDisabled,
    "--taomni-text": foreground,
    "--taomni-text-muted": mixColor(foreground, background, 62),
    colorScheme: darkBackground ? "dark" : "light",
    fontFamily: terminalProfile.fontFamily || DEFAULT_MAIL_TERMINAL_PROFILE.fontFamily,
    zoom: clampMailFontSize(fontSize) / MAIL_BASE_FONT_SIZE,
  } as CSSProperties;
}

function MailDraggableDialog({
  title,
  icon,
  ariaLabel,
  minWidth,
  minHeight,
  className,
  children,
  headerActions,
  closeTestId,
  onClose,
}: MailDraggableDialogProps) {
  const { containerRef, handleRef } = useModalDraggableAndResizable({ minWidth, minHeight });

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col rounded-md border shadow-2xl overflow-hidden ${className}`}
      style={{
        background: "var(--taomni-bg)",
        borderColor: "var(--taomni-divider)",
        color: "var(--taomni-text)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={handleRef}
        className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] select-none"
      >
        {icon}
        <span className="text-[12px] font-semibold min-w-0 flex-1 truncate">
          {title}
        </span>
        {headerActions}
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={onClose}
          aria-label="Close dialog"
          title="Close"
          data-testid={closeTestId}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

function addressLabel(address: MailAddress | null | undefined): string {
  if (!address) return "";
  const name = address.name?.trim();
  const mail = address.address?.trim();
  if (name && mail) return `${name} <${mail}>`;
  return name || mail || "";
}

function decodeImapModifiedUtf7(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "&") {
      out += value[index];
      index += 1;
      continue;
    }
    const end = value.indexOf("-", index + 1);
    if (end === -1) {
      out += value.slice(index);
      break;
    }
    const encoded = value.slice(index + 1, end);
    if (!encoded) {
      out += "&";
      index = end + 1;
      continue;
    }
    const decoded = decodeImapModifiedUtf7Segment(encoded);
    out += decoded ?? value.slice(index, end + 1);
    index = end + 1;
  }
  return out;
}

function decodeImapModifiedUtf7Segment(encoded: string): string | null {
  if (typeof atob === "undefined") return null;
  try {
    let b64 = encoded.replace(/,/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const binary = atob(b64);
    if (binary.length % 2 !== 0) return null;
    let result = "";
    for (let i = 0; i < binary.length; i += 2) {
      result += String.fromCharCode((binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1));
    }
    return result;
  } catch {
    return null;
  }
}

function folderLabel(folder: MailFolder): string {
  const displayName = folder.displayName?.trim();
  if (displayName) return displayName;
  const name = folder.name || "INBOX";
  return decodeImapModifiedUtf7(name) || name;
}

function folderDepth(folder: MailFolder): number {
  const delimiter = folder.delimiter?.trim();
  if (!delimiter) return 0;
  return Math.max(0, folder.name.split(delimiter).filter(Boolean).length - 1);
}

function folderIcon(folder: MailFolder) {
  const name = `${folder.name} ${folderLabel(folder)}`.toLowerCase();
  if (name.includes("inbox") || name.includes("收件")) return <Inbox className="w-4 h-4" />;
  if (name.includes("sent") || name.includes("已发送") || name.includes("已傳送")) return <Send className="w-4 h-4" />;
  if (name.includes("trash") || name.includes("deleted") || name.includes("垃圾") || name.includes("已删除")) return <Trash2 className="w-4 h-4" />;
  if (name.includes("archive") || name.includes("归档") || name.includes("封存")) return <Archive className="w-4 h-4" />;
  return <Folder className="w-4 h-4" />;
}

function isUnread(message: MailMessageHeader): boolean {
  return !message.flags.some((flag) => flag.toLowerCase().includes("seen"));
}

function withSeenFlag(message: MailMessageHeader): MailMessageHeader {
  if (!isUnread(message)) return message;
  return { ...message, flags: [...message.flags, "\\Seen"] };
}

type SpecialFolderKind = "trash" | "junk" | "archive" | "sent";

/** Drag payload marker for messages dragged onto the folder tree. */
const MAIL_DRAG_TYPE = "application/x-taomni-mail";

/** Folders whose new arrivals never raise a new-mail alert. */
const NEW_MAIL_EXCLUDED_KINDS: SpecialFolderKind[] = ["sent", "trash", "junk"];

const SPECIAL_FOLDER_MATCHERS: Record<SpecialFolderKind, { flag: string; names: string[] }> = {
  trash: { flag: "trash", names: ["trash", "deleted", "已删除", "已刪除", "垃圾桶", "废件箱", "廢件匣"] },
  junk: { flag: "junk", names: ["junk", "spam", "bulk", "垃圾邮件", "垃圾郵件"] },
  archive: { flag: "archive", names: ["archive", "归档", "封存", "歸檔"] },
  sent: { flag: "sent", names: ["sent", "已发送", "已傳送", "寄件"] },
};

function folderMatchesSpecial(
  folder: MailFolder,
  kind: SpecialFolderKind,
  overrides?: MailTabInfo["specialFolders"],
): boolean {
  // A manual choice in the account settings beats attributes and names.
  const manual = overrides?.[kind];
  if (manual) return folder.name === manual || folderLabel(folder) === manual;
  const matcher = SPECIAL_FOLDER_MATCHERS[kind];
  if (folder.flags.some((flag) => flag.toLowerCase().includes(matcher.flag))) return true;
  const haystack = `${folder.name} ${folderLabel(folder)}`.toLowerCase();
  return matcher.names.some((name) => haystack.includes(name));
}

function isFlagged(message: MailMessageHeader): boolean {
  return message.flags.some((flag) => flag.toLowerCase().includes("flagged"));
}

function withFlagsMutation(
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

function formatShortDate(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatFullDate(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function messagePageSize(info: MailTabInfo): number {
  return Math.max(50, Math.min(500, info.sync.maxFetchPerSync || MAIL_MESSAGE_PAGE_SIZE));
}

function refreshBatchSize(info: MailTabInfo): number {
  return Math.max(1, Math.min(MAIL_REFRESH_BATCH_SIZE, info.sync.maxFetchPerSync || MAIL_REFRESH_BATCH_SIZE));
}

function sortMessages(messages: MailMessageHeader[]): MailMessageHeader[] {
  return messages.slice().sort((a, b) => {
    const date = (b.dateTs ?? 0) - (a.dateTs ?? 0);
    if (date !== 0) return date;
    return b.uid - a.uid;
  });
}

function mergeMessagePages(current: MailMessageHeader[], next: MailMessageHeader[]): MailMessageHeader[] {
  const byKey = new Map<string, MailMessageHeader>();
  for (const message of current) byKey.set(messageKey(message), message);
  for (const message of next) byKey.set(messageKey(message), message);
  return sortMessages(Array.from(byKey.values()));
}

const MAIL_THREAD_VIEW_STORAGE_KEY = "taomni.mail.threadView";

/** Headers per gap-free catch-up step (the loop repeats until caught up). */
function catchupStepSize(info: MailTabInfo): number {
  return Math.max(20, Math.min(500, info.sync.maxFetchPerSync || 200));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replyContextFor(
  kind: "reply" | "replyAll" | "forward",
  target: MailMessageHeader,
): MailDraftContext {
  const references = [...(target.references ?? [])];
  if (target.inReplyTo && !references.includes(target.inReplyTo)) references.push(target.inReplyTo);
  return {
    kind,
    folder: target.folder,
    uid: target.uid,
    messageId: target.messageId,
    subject: target.subject,
    references,
  };
}

/** In-Reply-To / References for a reply; forwards start a new thread. */
function threadHeadersFor(context: MailDraftContext | null | undefined): { inReplyTo: string | null; references: string[] } {
  if (!context || context.kind === "forward" || !context.messageId) return { inReplyTo: null, references: [] };
  return { inReplyTo: context.messageId, references: context.references ?? [] };
}

function decodeFolderLabel(name: string, folders: readonly MailFolder[]): string {
  const folder = folders.find((entry) => entry.name === name);
  return folder ? folderLabel(folder) : name;
}

const TEMPLATE_KIND = "template";

function isTemplate(saved: MailDraft): boolean {
  return saved.replyContext?.kind === TEMPLATE_KIND;
}

function draftContextWithIdentity(draft: ComposeDraft): MailDraftContext | null {
  const identityId = draft.identityId && draft.identityId !== DEFAULT_IDENTITY_ID ? draft.identityId : null;
  if (!draft.replyContext && !identityId) return null;
  return { ...(draft.replyContext ?? {}), identityId };
}

function identitySendFields(identity: MailIdentity): { from: string | null; replyTo: string | null } {
  if (identity.id === DEFAULT_IDENTITY_ID) return { from: null, replyTo: null };
  return { from: identityFromHeader(identity), replyTo: identity.replyTo ?? null };
}

function draftWithSignature(draft: Partial<ComposeDraft>, signature: string | null | undefined): ComposeDraft {
  const base = { ...emptyComposeDraft(), ...draft };
  if (!signature?.trim()) return base;
  const signatureHtml = signatureToMailHtml(signature);
  const signatureText = `\n\n-- \n${signature.trimEnd()}`;
  const htmlBody = base.htmlBody?.trim() && base.htmlBody !== "<p><br></p>"
    ? base.htmlBody
    : `<p><br></p>${signatureHtml}`;
  const textBody = base.textBody?.trim() ? base.textBody : signatureText.trimStart();
  return { ...base, htmlBody, textBody };
}

function draftHasContent(draft: ComposeDraft): boolean {
  return !!(
    draft.to.length ||
    draft.cc.length ||
    draft.bcc.length ||
    draft.subject.trim() ||
    draft.textBody.trim() ||
    mailHtmlToPlainText(draft.htmlBody).trim() ||
    draft.attachments.length
  );
}

function serializeDraftContent(draft: ComposeDraft): string {
  return JSON.stringify({
    to: draft.to.map(formatRecipientForSend),
    cc: draft.cc.map(formatRecipientForSend),
    bcc: draft.bcc.map(formatRecipientForSend),
    subject: draft.subject,
    textBody: draft.textBody,
    htmlBody: draft.htmlBody,
    attachments: draft.attachments,
    replyContext: draft.replyContext ?? null,
  });
}

/** Reply context without the Outbox queue state (editing leaves the Outbox). */
function withoutOutbox(context: MailDraftContext | null | undefined): MailDraftContext | null {
  if (!context) return null;
  const { outbox: _outbox, ...rest } = context;
  return rest;
}

function draftFromSaved(saved: MailDraft): ComposeDraft {
  return {
    readReceipt: outboxState(saved)?.readReceipt ?? false,
    id: saved.id,
    to: parseRecipientsText(saved.to.join(", ")),
    cc: parseRecipientsText(saved.cc.join(", ")),
    bcc: parseRecipientsText(saved.bcc.join(", ")),
    subject: saved.subject,
    htmlBody: saved.htmlBody || plainTextToMailHtml(saved.textBody),
    textBody: saved.textBody,
    attachments: saved.attachments ?? [],
    replyContext: withoutOutbox(saved.replyContext),
    richFormatUsed: hasRichMailFormatting(saved.htmlBody),
    identityId: saved.replyContext?.identityId ?? null,
  };
}

function suggestedAttachmentName(attachment: MailAttachmentInfo, index: number, subject?: string): string {
  const raw = attachment.name?.trim() || `${subject?.trim() || "attachment"}-${index + 1}`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || `attachment-${index + 1}`).slice(0, 160);
}

function splitAttachmentName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function uniqueAttachmentName(name: string, usedNames: Set<string>): string {
  const { stem, ext } = splitAttachmentName(name);
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem} (${suffix})${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function joinLocalPath(dir: string, name: string): string {
  const base = dir.trim();
  if (!base) return name;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  if (/^[A-Za-z]:$/.test(base)) return `${base}\\${name}`;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${sep}${name}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || "attachment";
}

function makeInlineImageContentId(name: string): string {
  const stem = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "image";
  const random = Math.random().toString(36).slice(2, 10);
  return `taomni-${stem}-${Date.now()}-${random}@inline.local`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guessContentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "pdf") return "application/pdf";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "csv") return "text/csv";
  if (ext === "json") return "application/json";
  if (ext === "txt" || ext === "log" || ext === "md") return "text/plain";
  return "application/octet-stream";
}

function dedupeMessages(messages: readonly MailMessageHeader[]): MailMessageHeader[] {
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

function groupMessagesByFolder(messages: readonly MailMessageHeader[]): Map<string, MailMessageHeader[]> {
  const map = new Map<string, MailMessageHeader[]>();
  for (const message of messages) {
    const list = map.get(message.folder) ?? [];
    list.push(message);
    map.set(message.folder, list);
  }
  return map;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed || "(no subject)"}`;
}

function normalizedMailAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function appendUniqueAddress(target: string[], seen: Set<string>, address: MailAddress | null | undefined, ownAddresses: Set<string>) {
  const label = addressLabel(address);
  const mail = normalizedMailAddress(address?.address ?? label);
  if (!label || !mail || ownAddresses.has(mail) || seen.has(mail)) return;
  seen.add(mail);
  target.push(label);
}

async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  let handleId: string | null = null;
  try {
    handleId = await writeStreamOpen(path);
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      await writeStreamAppend(handleId, bytes.subarray(offset, end));
    }
    await writeStreamClose(handleId);
  } catch (err) {
    if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
    throw err;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("bmp")) return "bmp";
  if (lower.includes("svg")) return "svg";
  return "bin";
}

function RemoteImagesBanner({
  visible,
  allowRemoteImages,
  onAllowThisMessage,
  onAllowAllInTab,
  onBlock,
}: {
  visible: boolean;
  allowRemoteImages: boolean;
  onAllowThisMessage: () => void;
  onAllowAllInTab: () => void;
  onBlock: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      className="mx-4 mt-3 mb-0 flex flex-wrap items-center gap-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] px-3 py-2 text-[12px]"
      data-testid="mail-remote-images-banner"
    >
      <ImageOff className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      <span className="flex-1 text-[var(--taomni-text-muted)]">
        {allowRemoteImages
          ? "Remote images are shown for this message."
          : "To protect your privacy, remote images in this message have been blocked."}
      </span>
      {allowRemoteImages ? (
        <button
          type="button"
          className="taomni-btn h-6 px-2 text-[11px]"
          data-testid="mail-remote-images-toggle"
          onClick={onBlock}
        >
          Block remote content
        </button>
      ) : (
        <>
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            data-testid="mail-remote-images-toggle"
            onClick={onAllowThisMessage}
          >
            Show for this message
          </button>
          <button
            type="button"
            className="taomni-btn h-6 px-2 text-[11px]"
            data-testid="mail-remote-images-allow-all"
            onClick={onAllowAllInTab}
            title="Allow remote images for all messages in this tab until closed"
          >
            Allow all in tab
          </button>
        </>
      )}
    </div>
  );
}

function htmlToText(html: string): string {
  return mailHtmlToPlainText(html);
}

function bodyTextForAi(body: MailMessageBody): string {
  const text = body.text?.trim() || (body.html ? htmlToText(body.html) : "") || body.snippet || "";
  return text.length > 12000 ? `${text.slice(0, 12000)}\n\n[truncated]` : text;
}

function aiPrompt(action: AiAction, message: MailMessageHeader, body: MailMessageBody): string {
  const from = addressLabel(message.from) || "(unknown sender)";
  const to = message.to.map(addressLabel).filter(Boolean).join(", ");
  const bodyText = bodyTextForAi(body);
  const header = [
    `Subject: ${message.subject || "(no subject)"}`,
    `From: ${from}`,
    to ? `To: ${to}` : "",
    message.dateTs ? `Date: ${formatFullDate(message.dateTs)}` : "",
  ].filter(Boolean).join("\n");

  if (action === "reply") {
    return `Draft a concise, professional reply for this email. Keep the reply actionable and do not invent facts.\n\n${header}\n\nEmail body:\n${bodyText}`;
  }
  if (action === "tasks") {
    return `Extract action items, deadlines, owners, and unresolved questions from this email. Return a compact checklist.\n\n${header}\n\nEmail body:\n${bodyText}`;
  }
  return `Summarize this email for a busy operator. Include the purpose, key facts, urgency, and suggested next step.\n\n${header}\n\nEmail body:\n${bodyText}`;
}

export function MailClientTab({ tabId, info, visible, onEditSession }: MailClientTabProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [messages, setMessages] = useState<MailMessageHeader[]>([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
  const [mailViewKey, setMailViewKey] = useState("mailbox");
  const [messageTabs, setMessageTabs] = useState<OpenMailMessageTab[]>([]);
  const [popupMessageKey, setPopupMessageKey] = useState<string | null>(null);
  const [checkedMessageKeys, setCheckedMessageKeys] = useState<Set<string>>(() => new Set());
  const [body, setBody] = useState<MailMessageBody | null>(null);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"folder" | "all">("folder");
  const [searchField, setSearchField] = useState<MailSearchField>("all");
  const [quickFilters, setQuickFilters] = useState<{ unread: boolean; flagged: boolean; attachments: boolean }>({
    unread: false,
    flagged: false,
    attachments: false,
  });
  const [tagFilter, setTagFilter] = useState<string>("");
  const [searchResults, setSearchResults] = useState<MailMessageHeader[] | null>(null);
  const [serverSearching, setServerSearching] = useState(false);
  const searchSeqRef = useRef(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bodyCache, setBodyCache] = useState<Map<string, MailMessageBody>>(() => new Map());
  const [bodyLoadingKey, setBodyLoadingKey] = useState<string | null>(null);
  const [bodyWarming, setBodyWarming] = useState<BodyWarmState>({ active: false, done: 0, total: 0 });
  const [threadView, setThreadView] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MAIL_THREAD_VIEW_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());
  const [syncProgress, setSyncProgress] = useState<{ folder: string; fetched: number; remaining: number } | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<{ folder: string; cached: number; total: number } | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [draftsTab, setDraftsTab] = useState<"drafts" | "templates" | "outbox">("drafts");
  const visibleDrafts = useMemo(
    () => drafts.filter((saved) => {
      if (draftsTab === "outbox") return isOutbox(saved);
      if (isOutbox(saved)) return false;
      return isTemplate(saved) === (draftsTab === "templates");
    }),
    [drafts, draftsTab],
  );
  const outboxCount = useMemo(() => drafts.filter(isOutbox).length, [drafts]);
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  const [attachReminder, setAttachReminder] = useState(false);
  const [sendLaterAt, setSendLaterAt] = useState("");
  const [undoSend, setUndoSend] = useState<{ draftId: string; until: number } | null>(null);
  const [undoNow, setUndoNow] = useState(() => Date.now());
  const undoTimerRef = useRef<number | null>(null);
  const outboxBusyIdsRef = useRef(new Set<string>());
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState<RecipientSearchState>({
    field: null,
    query: "",
    suggestions: [],
    loading: false,
  });
  const [sending, setSending] = useState(false);
  const [downloadingAttachmentIndex, setDownloadingAttachmentIndex] = useState<number | null>(null);
  /** Thunderbird-style: allow remote content for specific messages, or the whole tab session. */
  const [allowRemoteAllInTab, setAllowRemoteAllInTab] = useState(false);
  const [remoteAllowedMessageKeys, setRemoteAllowedMessageKeys] = useState<Set<string>>(() => new Set());
  const [composeDragActive, setComposeDragActive] = useState(false);
  const [attachProgress, setAttachProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const composeRootRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const pendingCacheRefreshRef = useRef(false);
  const initialSyncDoneRef = useRef(false);
  /** Bumped by user-driven syncs; stale catch-up loops stop at their next step. */
  const syncGenerationRef = useRef(0);
  const backfillSeqRef = useRef(0);
  const contactIndexAccountRef = useRef<string | null>(null);
  const contactSearchSeqRef = useRef(0);
  const bodyCacheRef = useRef<Map<string, MailMessageBody>>(new Map());
  const bodyRequestsRef = useRef<Map<string, Promise<MailMessageBody>>>(new Map());
  const bodyLoadSeqRef = useRef(0);
  const bodyWarmSeqRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastSavedDraftJsonRef = useRef("");
  const foldersRef = useRef<MailFolder[]>([]);
  /** Tracks the live selected folder across awaits (folder switches ignore syncInFlight). */
  const selectedFolderRef = useRef(selectedFolder);
  const messagesRef = useRef<MailMessageHeader[]>([]);
  const foldersPanelRef = useRef<PanelImperativeHandle>(null);
  const [mailboxCollapsed, setMailboxCollapsed] = useState(false);
  const [mailboxPaneSize, setMailboxPaneSize] = useState(MAILBOX_EXPANDED_SIZE);
  const profileFontSize = clampMailFontSize(info.terminalProfile?.fontSize ?? DEFAULT_MAIL_TERMINAL_PROFILE.fontSize);
  const [mailFontSize, setMailFontSize] = useState(profileFontSize);
  const attachmentMenu = useContextMenu();
  const mailMenu = useContextMenu();
  const confirmDialog = useConfirmDialog();
  const textInputDialog = useTextInputDialog();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sourceView, setSourceView] = useState<{ subject: string; content: string } | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const { resolvedTheme } = useAppTheme();
  const appPrefersDark = resolvedTheme === "dark";

  const openTabChat = useChatStore((s) => s.openTabChat);
  const sendMessageToAi = useChatStore((s) => s.sendMessage);
  const pushMailNew = useTaoAlertStore((s) => s.pushMailNew);

  const displayFolders = folders.length > 0 ? folders : [{ ...DEFAULT_FOLDER, accountId: info.sessionId }];
  // TASK-10: "show only subscribed folders" (per account, this browser).
  const [subscribedOnly, setSubscribedOnlyState] = useState(
    () => loadSubscribedOnly(info.sessionId, info.sync.subscribedOnly ?? false),
  );
  const subscribedOnlyRef = useRef(subscribedOnly);
  subscribedOnlyRef.current = subscribedOnly;
  const treeFolders = useMemo(() => visibleFolders(displayFolders, subscribedOnly), [displayFolders, subscribedOnly]);
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(false);
  const draggedMessagesRef = useRef<MailMessageHeader[]>([]);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [unsubscribeArmed, setUnsubscribeArmed] = useState<string | null>(null);
  /** Message filters dialog (TASK-13); the draft pre-fills "Create filter from message". */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<MailFilter | null>(null);
  /** Failed actions of the last incoming filter run (AC-42), kept until the dialog is opened. */
  const [filterErrors, setFilterErrors] = useState<string[]>([]);
  const incomingFiltersRef = useRef<(() => Promise<void>) | null>(null);
  /** Address book dialog (TASK-19); the draft pre-fills "Add sender to address book". */
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [contactDraft, setContactDraft] = useState<MailAddressBookEntry | null>(null);
  /** CalDAV agenda (DEC-14): dialog, cache revision and reminder bookkeeping. */
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaRevision, setAgendaRevision] = useState(0);
  const agendaEventsRef = useRef<MailAgendaEvent[]>([]);
  const remindedRef = useRef<Set<string>>(new Set());
  /** Read receipt answered for these messages in this session (TASK-17). */
  const [receiptBusy, setReceiptBusy] = useState(false);
  const autoReceiptRef = useRef<Set<string>>(new Set());
  /** Calendar invitation of the open message (TASK-20), keyed by message. */
  const [inviteView, setInviteView] = useState<{
    key: string;
    invite: MailInvite | null;
    loading: boolean;
    responding?: MailInviteReply;
    responded?: string;
    error?: string;
    /** CalDAV write of the invitation (TASK-20 phase 2). */
    calendar?: "adding" | "added";
    calendarError?: string;
  } | null>(null);
  const [certReview, setCertReview] = useState<{
    protocol: "imap" | "smtp";
    loading: boolean;
    info?: MailCertificateInfo;
    error?: string;
  } | null>(null);
  const retryAfterTrustRef = useRef(false);
  const [subscriptionBusy, setSubscriptionBusy] = useState<string | null>(null);
  const oauthReauthRequired = isOAuthReauthRequired(error);
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const batchSize = useMemo(() => refreshBatchSize(info), [info.sync.maxFetchPerSync]);
  const catchupBatchSize = useMemo(() => catchupStepSize(info), [info.sync.maxFetchPerSync]);
  const identities = useMemo(() => mailIdentities(info), [info]);
  const identityById = useCallback(
    (id: string | null | undefined) => identities.find((identity) => identity.id === id) ?? identities[0],
    [identities],
  );
  const defaultMailDomain = useMemo(
    () => extractDefaultMailDomain([info.emailAddress, info.imap.username, info.smtp.username]),
    [info.emailAddress, info.imap.username, info.smtp.username],
  );
  const mailAppearance = useMemo(
    () => mailAppearanceStyle(info.terminalProfile, mailFontSize, appPrefersDark),
    [info.terminalProfile, mailFontSize, appPrefersDark],
  );
  const preferDarkReader = useMemo(() => {
    const scheme = String((mailAppearance as Record<string, string | number | undefined>)["--taomni-color-scheme"] ?? "");
    return scheme === "dark";
  }, [mailAppearance]);

  const messageAllowsRemote = useCallback((key: string | null | undefined) => {
    if (allowRemoteAllInTab) return true;
    if (!key) return false;
    return remoteAllowedMessageKeys.has(key);
  }, [allowRemoteAllInTab, remoteAllowedMessageKeys]);

  const allowRemoteForMessage = useCallback((key: string) => {
    setRemoteAllowedMessageKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const blockRemoteForMessage = useCallback((key: string) => {
    setAllowRemoteAllInTab(false);
    setRemoteAllowedMessageKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleRemoteForMessage = useCallback((key: string) => {
    if (messageAllowsRemote(key)) blockRemoteForMessage(key);
    else allowRemoteForMessage(key);
  }, [allowRemoteForMessage, blockRemoteForMessage, messageAllowsRemote]);
  const selectedMessage = useMemo(
    () =>
      messages.find((message) => messageKey(message) === selectedMessageKey)
      ?? messageTabs.find((tab) => tab.key === selectedMessageKey)?.message
      ?? null,
    [messageTabs, messages, selectedMessageKey],
  );
  const activeMessageTab = useMemo(
    () => messageTabs.find((tab) => tab.key === mailViewKey) ?? null,
    [mailViewKey, messageTabs],
  );
  const popupMessage = useMemo(
    () =>
      popupMessageKey
        ? messages.find((message) => messageKey(message) === popupMessageKey)
          ?? messageTabs.find((tab) => tab.key === popupMessageKey)?.message
          ?? null
        : null,
    [messageTabs, messages, popupMessageKey],
  );
  const checkedMessages = useMemo(
    () => messages.filter((message) => checkedMessageKeys.has(messageKey(message))),
    [checkedMessageKeys, messages],
  );
  const checkedUnreadCount = useMemo(
    () => checkedMessages.filter(isUnread).length,
    [checkedMessages],
  );
  const visibleUnreadCount = useMemo(
    () => messages.filter(isUnread).length,
    [messages],
  );

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  useEffect(() => {
    selectedFolderRef.current = selectedFolder;
  }, [selectedFolder]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Keep selectedFolderRef in sync immediately (folder switches can race quiet poll awaits). */
  const updateSelectedFolder = useCallback((next: string | ((prev: string) => string)) => {
    setSelectedFolder((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      selectedFolderRef.current = value;
      return value;
    });
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) return;
    bodyWarmSeqRef.current += 1;
    bodyLoadSeqRef.current += 1;
    setSyncing(false);
    setLoadingFolders(false);
    setLoadingMessages(false);
    setLoadingMoreMessages(false);
    setBodyLoadingKey(null);
    setBodyWarming((current) => (
      current.active
        ? { active: false, done: current.done, total: current.total, folder: current.folder }
        : current
    ));
  }, [visible]);

  const quickFilterActive = quickFilters.unread || quickFilters.flagged || quickFilters.attachments || Boolean(tagFilter);
  const searchActive = query.trim().length > 0;

  // Local full-text search over the whole cached index (not just loaded rows).
  useEffect(() => {
    const text = query.trim();
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    if (!text || !info.cache.enabled) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void mailSearchMessages(info.sessionId, {
        text,
        folder: searchScope === "folder" ? selectedFolder : null,
        field: searchField,
        unreadOnly: quickFilters.unread,
        flaggedOnly: quickFilters.flagged,
        withAttachments: quickFilters.attachments,
        keyword: tagFilter || null,
        limit: 1000,
      })
        .then((results) => {
          if (searchSeqRef.current === seq) setSearchResults(results);
        })
        .catch((e) => {
          if (searchSeqRef.current === seq) {
            setSearchResults(null);
            console.debug("mail local search failed", e);
          }
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [info.cache.enabled, info.sessionId, query, quickFilters, searchField, searchScope, selectedFolder, tagFilter]);

  const runServerSearch = useCallback(async () => {
    const text = query.trim();
    if (!text) return;
    const folder = selectedFolderRef.current;
    const seq = searchSeqRef.current;
    setServerSearching(true);
    setError(null);
    try {
      const results = await mailSearchServer(info, folder, {
        text,
        field: searchField,
        unreadOnly: quickFilters.unread,
        flaggedOnly: quickFilters.flagged,
        limit: 200,
      });
      if (searchSeqRef.current !== seq) return;
      setSearchResults((current) => {
        const byKey = new Map<string, MailMessageHeader>();
        for (const message of current ?? []) byKey.set(messageKey(message), message);
        for (const message of results) byKey.set(messageKey(message), message);
        return sortMessages(Array.from(byKey.values()));
      });
      setStatus(`Server search found ${results.length} message${results.length === 1 ? "" : "s"} in ${folder}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setServerSearching(false);
    }
  }, [info, query, quickFilters.flagged, quickFilters.unread, searchField]);

  const filteredMessages = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: MailMessageHeader[];
    if (q && searchResults) {
      base = searchResults;
    } else if (q) {
      // Cache disabled (or index not ready): filter the loaded rows.
      base = messages.filter((message) => {
        const haystack = [
          message.subject,
          addressLabel(message.from),
          message.snippet ?? "",
          ...message.to.map(addressLabel),
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    } else {
      base = messages;
    }
    if (!quickFilterActive) return base;
    return base.filter((message) =>
      (!quickFilters.unread || isUnread(message))
      && (!quickFilters.flagged || isFlagged(message))
      && (!quickFilters.attachments || message.hasAttachments)
      && (!tagFilter || message.flags.some((flag) => flag.toLowerCase() === tagFilter.toLowerCase())));
  }, [messages, query, quickFilterActive, quickFilters, searchResults, tagFilter]);
  const listRows = useMemo<MailThreadRow[]>(() => {
    if (threadView) return flattenMailThreads(buildMailThreads(filteredMessages), expandedThreads);
    return filteredMessages.map((message) => ({
      message,
      threadKey: messageKey(message),
      depth: 0,
      isRoot: true,
      threadSize: 1,
      threadUnread: isUnread(message) ? 1 : 0,
      expanded: false,
    }));
  }, [expandedThreads, filteredMessages, threadView]);
  const toggleThreadExpanded = useCallback((key: string) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const allFilteredMessagesChecked = filteredMessages.length > 0
    && filteredMessages.every((message) => checkedMessageKeys.has(messageKey(message)));
  const selectedBody = useMemo(() => {
    if (!selectedMessage) return null;
    const cached = bodyCache.get(messageKey(selectedMessage));
    if (cached && bodyMatchesMessage(cached, selectedMessage)) return cached;
    return bodyMatchesMessage(body, selectedMessage) ? body : null;
  }, [body, bodyCache, selectedMessage]);

  const selectedHasRemoteImages = useMemo(
    () => mailHtmlHasRemoteImages(selectedBody?.html),
    [selectedBody?.html],
  );
  const selectedMessageRemoteKey = selectedMessage ? messageKey(selectedMessage) : null;
  const selectedAllowsRemote = messageAllowsRemote(selectedMessageRemoteKey);

  const visibleAttachments = useMemo(
    () => (selectedBody?.attachments.length ? selectedBody.attachments : selectedMessage?.attachments ?? []),
    [selectedBody?.attachments, selectedMessage?.attachments],
  );
  // AC-62: parse the invitation once the body shows a calendar part.
  const inviteInfoRef = useRef(info);
  inviteInfoRef.current = info;
  const selectedInviteKey = selectedMessage && hasCalendarPart(visibleAttachments)
    ? messageKey(selectedMessage)
    : null;
  useEffect(() => {
    if (!selectedInviteKey || !selectedMessage) {
      setInviteView(null);
      return;
    }
    let cancelled = false;
    const { folder, uid } = selectedMessage;
    setInviteView({ key: selectedInviteKey, invite: null, loading: true });
    mailGetInvite(inviteInfoRef.current, folder, uid)
      .then((invite) => {
        if (!cancelled) setInviteView({ key: selectedInviteKey, invite, loading: false });
      })
      .catch((e) => {
        if (!cancelled) {
          setInviteView({ key: selectedInviteKey, invite: null, loading: false, error: mailClientErrorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
    // selectedMessage is identified by selectedInviteKey.
  }, [selectedInviteKey]);

  // TASK-17: "always" answers a read receipt request when the message is shown.
  const selectedReceiptKey = selectedMessage?.receiptTo ? messageKey(selectedMessage) : null;
  useEffect(() => {
    if (!selectedReceiptKey || !selectedMessage || (info.receiptPolicy ?? "ask") !== "always") return;
    if (autoReceiptRef.current.has(selectedReceiptKey) || !receiptRequest(selectedMessage)) return;
    autoReceiptRef.current.add(selectedReceiptKey);
    void answerReceipt(selectedMessage, true, true);
    // selectedMessage is identified by selectedReceiptKey.
  }, [selectedReceiptKey, info.receiptPolicy]);

  // DEC-14: reminders for CalDAV events while this tab is open (DEC-01).
  const caldavUrl = info.caldav?.url ?? "";
  const onAgendaChanged = useCallback((events: MailAgendaEvent[]) => {
    agendaEventsRef.current = events;
  }, []);
  useEffect(() => {
    if (!caldavUrl) return;
    let cancelled = false;
    const refresh = async (sync: boolean) => {
      try {
        if (sync) await mailCalDavSync(inviteInfoRef.current);
        const events = await mailListAgenda(inviteInfoRef.current.sessionId, 2);
        if (!cancelled) agendaEventsRef.current = events;
      } catch (e) {
        console.debug("mail agenda refresh failed", e);
      }
    };
    void refresh(false);
    const firstSync = window.setTimeout(() => void refresh(true), 5_000);
    const syncTimer = window.setInterval(() => void refresh(true), 15 * 60_000);
    const reminderTimer = window.setInterval(() => {
      for (const event of dueReminders(agendaEventsRef.current, Date.now(), remindedRef.current)) {
        remindedRef.current.add(agendaKey(event));
        const when = agendaTimeLabel(event);
        setStatus(`Reminder: ${event.summary || "event"} at ${when}`);
        void notifyDesktop(
          `Reminder: ${event.summary || "Event"}`,
          event.location ? `${when} · ${event.location}` : when,
        );
      }
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstSync);
      window.clearInterval(syncTimer);
      window.clearInterval(reminderTimer);
    };
  }, [caldavUrl]);
  useEffect(() => {
    if (!caldavUrl || agendaRevision === 0) return;
    void mailListAgenda(inviteInfoRef.current.sessionId, 2)
      .then((events) => {
        agendaEventsRef.current = events;
      })
      .catch(() => undefined);
  }, [agendaRevision, caldavUrl]);
  const activeRecipientSuggestions = useMemo<RecipientSuggestion[]>(() => {
    const { field, query: recipientQuery, suggestions } = recipientSearch;
    if (!field || !recipientQuery.trim()) return [];
    const selected = draft[field];
    const remote = suggestions.map((suggestion) => ({ ...suggestion }));
    const local = searchCachedMessageContacts(messages, recipientQuery, selected, 8);
    return mergeRecipientSuggestions(remote, local, selected, 8);
  }, [draft, messages, recipientSearch]);

  const recipientSuggestionsFor = useCallback((field: RecipientFieldKey): RecipientSuggestion[] => {
    return recipientSearch.field === field ? activeRecipientSuggestions : [];
  }, [activeRecipientSuggestions, recipientSearch.field]);

  const handleRecipientQueryChange = useCallback((field: RecipientFieldKey, nextQuery: string) => {
    setRecipientSearch((current) => {
      if (current.field === field && current.query === nextQuery) return current;
      return {
        field,
        query: nextQuery,
        suggestions: [],
        loading: !!nextQuery.trim(),
      };
    });
  }, []);

  const increaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size + 1));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size - 1));
  }, []);

  const resetFontSize = useCallback(() => {
    setMailFontSize(profileFontSize);
  }, [profileFontSize]);

  useEffect(() => {
    setMailFontSize(profileFontSize);
  }, [info.sessionId, profileFontSize]);

  useEffect(() => {
    if (!composeOpen || contactIndexAccountRef.current === info.sessionId) return;
    contactIndexAccountRef.current = info.sessionId;
    mailIndexCachedContacts(info.sessionId).catch(() => undefined);
  }, [composeOpen, info.sessionId]);

  useEffect(() => {
    const field = recipientSearch.field;
    const recipientQuery = recipientSearch.query.trim();
    if (!composeOpen || !field || !recipientQuery) {
      setRecipientSearch((current) => (
        current.loading || current.suggestions.length > 0
          ? { ...current, suggestions: [], loading: false }
          : current
      ));
      return;
    }

    const seq = contactSearchSeqRef.current + 1;
    contactSearchSeqRef.current = seq;
    const timer = window.setTimeout(() => {
      mailSearchContacts(info.sessionId, recipientQuery, 8)
        .then((suggestions) => {
          if (contactSearchSeqRef.current !== seq) return;
          setRecipientSearch((current) => (
            current.field === field && current.query.trim() === recipientQuery
              ? { ...current, suggestions, loading: false }
              : current
          ));
        })
        .catch(() => {
          if (contactSearchSeqRef.current !== seq) return;
          setRecipientSearch((current) => (
            current.field === field && current.query.trim() === recipientQuery
              ? { ...current, suggestions: [], loading: false }
              : current
          ));
        });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [composeOpen, info.sessionId, recipientSearch.field, recipientSearch.query]);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        increaseFontSize();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        decreaseFontSize();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetFontSize();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [decreaseFontSize, increaseFontSize, resetFontSize, visible]);

  // Thunderbird-style list shortcuts (TASK-22); never inside inputs/editors.
  const shortcutRef = useRef<(action: MailShortcutAction) => boolean>(() => false);
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const action = mailShortcutAction(event);
      if (!action) return;
      const root = rootRef.current;
      const target = event.target as Node | null;
      const inTab = !target || target === document.body || Boolean(root?.contains(target));
      if (!inTab || isEditableTarget(event.target)) return;
      if (shortcutRef.current(action)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const root = rootRef.current;
    if (!root) return;

    const handleWheel = (event: WheelEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    root.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, visible]);

  const expandMailboxPanel = useCallback(() => {
    foldersPanelRef.current?.resize(`${MAILBOX_EXPANDED_SIZE}%`);
    setMailboxPaneSize(MAILBOX_EXPANDED_SIZE);
    setMailboxCollapsed(false);
  }, []);

  const handleMailboxResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    setMailboxPaneSize(percentage);
    setMailboxCollapsed(percentage === 0);
  }, []);

  useEffect(() => {
    if (mailboxPaneSize > 0 && mailboxPaneSize <= MAILBOX_RIBBON_THRESHOLD) {
      setMailboxCollapsed(true);
      window.requestAnimationFrame(() => foldersPanelRef.current?.resize("0%"));
    }
  }, [mailboxPaneSize]);

  const loadCachedFolders = useCallback(async () => {
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return;
    }
    setLoadingFolders(true);
    setError(null);
    try {
      const cached = await mailListCachedFolders(info.sessionId);
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return;
      }
      foldersRef.current = cached;
      setFolders(cached);
      updateSelectedFolder((current) =>
        cached.length > 0 && !cached.some((folder) => folder.name === current)
          ? cached[0].name
          : current,
      );
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setLoadingFolders(false);
    }
  }, [info.sessionId, updateSelectedFolder]);

  const loadCachedMessages = useCallback(async (
    folder: string,
    offset = 0,
    append = false,
    quiet = false,
    limitOverride?: number,
  ) => {
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return { page: [] as MailMessageHeader[], hasMore: false };
    }
    if (append) {
      setLoadingMoreMessages(true);
    } else {
      if (!quiet) setLoadingMessages(true);
      setHasMoreMessages(false);
    }
    setError(null);
    try {
      const limit = Math.max(pageSize, limitOverride ?? pageSize);
      const cached = await mailListCachedMessages(info.sessionId, folder, limit + 1, offset);
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return { page: [] as MailMessageHeader[], hasMore: false };
      }
      const page = cached.slice(0, limit);
      const loadedCount = offset + page.length;
      const hasMore = folderHasMoreToLoad(
        foldersRef.current.find((entry) => entry.name === folder),
        loadedCount,
        cached.length > limit,
      );
      setHasMoreMessages(hasMore);
      // Update the ref synchronously: concurrent sync steps merge against it.
      const next = append ? mergeMessagePages(messagesRef.current, page) : sortMessages(page);
      messagesRef.current = next;
      setMessages(next);
      if (!quiet) {
        setStatus(
          append
            ? page.length > 0 ? `Loaded ${page.length} older cached messages` : "No more cached messages"
            : page.length > 0 ? `Loaded ${page.length} cached messages` : "No cached messages",
        );
      }
      return { page, hasMore };
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return { page: [] as MailMessageHeader[], hasMore: false };
    } finally {
      if (append) {
        setLoadingMoreMessages(false);
      } else {
        if (!quiet) setLoadingMessages(false);
      }
    }
  }, [info.sessionId, pageSize]);

  const rememberBody = useCallback((nextBody: MailMessageBody) => {
    const key = `${nextBody.folder}:${nextBody.uid}`;
    const nextCache = new Map(bodyCacheRef.current);
    nextCache.set(key, nextBody);
    bodyCacheRef.current = nextCache;
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return;
    }
    setBodyCache(nextCache);
    setBody(nextBody);

    const enrichHeader = (message: MailMessageHeader): MailMessageHeader => {
      if (messageKey(message) !== key) return message;
      const attachmentCount = nextBody.attachments.length;
      return {
        ...message,
        messageId: nextBody.messageId ?? message.messageId,
        subject: nextBody.subject || message.subject,
        snippet: nextBody.snippet ?? message.snippet,
        rawSize: nextBody.rawSize ?? message.rawSize,
        bodyCached: true,
        hasAttachments: message.hasAttachments || attachmentCount > 0,
        attachmentCount: Math.max(message.attachmentCount, attachmentCount),
        attachments: attachmentCount > 0 ? nextBody.attachments : message.attachments,
      };
    };

    setMessages((current) => current.map(enrichHeader));
    setMessageTabs((current) => current.map((tab) => ({
      ...tab,
      message: enrichHeader(tab.message),
    })));
  }, []);

  const fetchBodyForMessage = useCallback((message: MailMessageHeader): Promise<MailMessageBody> => {
    const key = messageKey(message);
    const cached = bodyCacheRef.current.get(key);
    if (cached && bodyMatchesMessage(cached, message)) {
      rememberBody(cached);
      return Promise.resolve(cached);
    }
    const inflight = bodyRequestsRef.current.get(key);
    if (inflight) return inflight;

    const request = mailGetMessageBody(info, message.folder, message.uid)
      .then((nextBody) => {
        rememberBody(nextBody);
        return nextBody;
      })
      .finally(() => {
        bodyRequestsRef.current.delete(key);
      });
    bodyRequestsRef.current.set(key, request);
    return request;
  }, [info, rememberBody]);

  const warmRecentBodies = useCallback(async (foldersToWarm: MailFolder[], preferredFolder: string) => {
    if (!info.cache.enabled || info.cache.bodyRecentLimit <= 0) {
      setBodyWarming({ active: false, done: 0, total: 0 });
      return;
    }
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return;
    }
    const seq = bodyWarmSeqRef.current + 1;
    bodyWarmSeqRef.current = seq;
    const limit = Math.max(1, Math.min(1000, info.cache.bodyRecentLimit));
    const orderedFolders = foldersToWarm.slice().sort((a, b) => {
      if (a.name === preferredFolder) return -1;
      if (b.name === preferredFolder) return 1;
      return 0;
    });
    const seen = new Set<string>();
    const candidates: MailMessageHeader[] = [];
    setBodyWarming({ active: true, done: 0, total: 0 });

    try {
      for (const folder of orderedFolders) {
        if (bodyWarmSeqRef.current !== seq || !visibleRef.current) return;
        const page = await mailListCachedMessages(info.sessionId, folder.name, limit, 0);
        if (bodyWarmSeqRef.current !== seq || !visibleRef.current) return;
        for (const message of page) {
          const key = messageKey(message);
          if (seen.has(key) || message.bodyCached || bodyCacheRef.current.has(key)) continue;
          seen.add(key);
          candidates.push(message);
        }
      }

      if (bodyWarmSeqRef.current !== seq || !visibleRef.current) return;
      if (candidates.length === 0) {
        setBodyWarming({ active: false, done: 0, total: 0 });
        return;
      }

      setBodyWarming({ active: true, done: 0, total: candidates.length, folder: candidates[0]?.folder ?? null });
      let done = 0;
      for (const message of candidates) {
        if (bodyWarmSeqRef.current !== seq || !visibleRef.current) return;
        try {
          await fetchBodyForMessage(message);
        } catch {
          // Body warming is opportunistic; direct message open still reports errors.
        }
        done += 1;
        if (bodyWarmSeqRef.current !== seq || !visibleRef.current) return;
        setBodyWarming({
          active: done < candidates.length,
          done,
          total: candidates.length,
          folder: message.folder,
        });
      }
    } finally {
      if (bodyWarmSeqRef.current === seq) {
        setBodyWarming((current) => ({
          active: false,
          done: current.total > 0 ? current.done : 0,
          total: current.total,
          folder: current.folder,
        }));
      }
    }
  }, [fetchBodyForMessage, info.cache.bodyRecentLimit, info.cache.enabled, info.sessionId]);

  const isNewMailExcludedFolder = useCallback((folder: MailFolder) =>
    NEW_MAIL_EXCLUDED_KINDS.some((kind) => folderMatchesSpecial(folder, kind, info.specialFolders))
    || /draft|草稿/i.test(`${folder.name} ${folderLabel(folder)}`), [info.specialFolders]);

  const isNewMailExcludedName = useCallback((name: string) => {
    const folder = foldersRef.current.find((entry) => entry.name === name);
    return folder ? isNewMailExcludedFolder(folder) : false;
  }, [isNewMailExcludedFolder]);

  const notifyNewMail = useCallback((count: number) => {
    if (count <= 0) return;
    const title = info.displayName?.trim() || info.emailAddress || info.sessionId;
    pushMailNew(tabId, info.sessionId, title, count);
    // Only while the tab is open (DEC-01); opt-in per account.
    if (info.sync.desktopNotify) {
      void notifyDesktop(title, count === 1 ? "1 new message" : `${count} new messages`);
    }
  }, [info.displayName, info.emailAddress, info.sessionId, info.sync.desktopNotify, pushMailNew, tabId]);

  const applySyncedFolder = useCallback((folder: MailFolder) => {
    const next = mergeFolderMeta(foldersRef.current, folder);
    foldersRef.current = next;
    if (visibleRef.current) setFolders(next);
  }, []);

  /** Remote LIST on open so a new account shows every folder at once. */
  const refreshFolderTree = useCallback(async () => {
    try {
      const listed = await mailListFolders(info);
      if (listed.length === 0) return;
      // Keep counts/watermarks a concurrent sync may have just updated.
      const byName = new Map(foldersRef.current.map((entry) => [entry.name, entry]));
      const next = listed.map((entry) => {
        const known = byName.get(entry.name);
        return known ? { ...entry, ...known, flags: entry.flags } : entry;
      });
      foldersRef.current = next;
      if (visibleRef.current) setFolders(next);
    } catch (e) {
      console.debug("mail folder LIST failed", e);
    }
  }, [info]);

  const setSubscribedOnly = useCallback((value: boolean) => {
    setSubscribedOnlyState(value);
    saveSubscribedOnly(info.sessionId, value);
  }, [info.sessionId]);

  const toggleSubscription = useCallback(async (folder: MailFolder, subscribed: boolean) => {
    setSubscriptionBusy(folder.name);
    setError(null);
    try {
      const listed = await mailSetFolderSubscription(info, folder.name, subscribed);
      // Only the attributes change; keep cached counts and watermarks.
      const merged = foldersRef.current.map((entry) => {
        const remote = listed.find((candidate) => candidate.name === entry.name);
        return remote ? { ...entry, flags: remote.flags } : entry;
      });
      foldersRef.current = merged;
      setFolders(merged);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setSubscriptionBusy(null);
    }
  }, [info]);

  /** Reload the visible list from the cache, keeping the loaded depth. */
  const reloadVisibleFromCache = useCallback(async (folder: string) => {
    if (!visibleRef.current) {
      pendingCacheRefreshRef.current = true;
      return;
    }
    if (selectedFolderRef.current !== folder) return;
    const loaded = messagesRef.current.filter((message) => message.folder === folder).length;
    await loadCachedMessages(folder, 0, false, true, Math.max(pageSize, loaded));
  }, [loadCachedMessages, pageSize]);

  /**
   * Run gap-free sync steps for one folder until the backend reports no more
   * work (bounded by maxSteps). New headers appear as each step lands; the
   * visible list is then reloaded from the cache so deletions and flag
   * changes from other clients show up too.
   */
  const runFolderSync = useCallback(async (folder: string, options: {
    mode?: MailSyncRequestMode;
    indicator?: SyncIndicator;
    maxSteps?: number;
  } = {}) => {
    const generation = syncGenerationRef.current;
    const indicator = options.indicator ?? "none";
    let changed = false;
    try {
      const loop = await runFolderSyncLoop({
        mode: options.mode ?? "auto",
        maxSteps: options.maxSteps ?? 40,
        isCancelled: () => syncGenerationRef.current !== generation,
        step: (mode) => mailSyncFolder(info, folder, { mode, limit: catchupBatchSize, includeBodies: false }),
        onStep: (result, progress) => {
          if (result.fetched > 0 || result.vanished > 0 || result.flagsUpdated > 0) changed = true;
          applySyncedFolder(result.folder);
          if (!visibleRef.current) {
            pendingCacheRefreshRef.current = true;
            return;
          }
          const merged = mergeSyncedMessages(
            selectedFolderRef.current,
            folder,
            messagesRef.current,
            result.messages,
            sortMessages,
          );
          if (merged) {
            messagesRef.current = merged;
            setMessages(merged);
          }
          if (result.uidValidityReset) {
            setStatus(`${folderLabel(result.folder)} was rebuilt on the server; resynced`);
          }
          if (indicator !== "none" && result.more) {
            setSyncProgress({ folder, fetched: progress.fetched, remaining: progress.remaining });
          }
        },
      });
      if (changed && info.cache.enabled) await reloadVisibleFromCache(folder);
      if (loop.fetched > 0 && folder.trim().toUpperCase() === "INBOX") {
        await incomingFiltersRef.current?.();
      }
      return loop;
    } finally {
      if (indicator !== "none" && visibleRef.current) setSyncProgress(null);
    }
  }, [applySyncedFolder, catchupBatchSize, info, reloadVisibleFromCache]);

  /**
   * Fetch older history for the selected folder in the background (full
   * header index). Yields to user-triggered syncs and stops on folder switch,
   * tab hide or unmount; the next open resumes from the stored watermark.
   */
  const startBackfill = useCallback((folder: string) => {
    const meta = foldersRef.current.find((entry) => entry.name === folder);
    if (!info.cache.enabled || !meta || meta.syncComplete || meta.syncHighUid == null) return;
    const seq = backfillSeqRef.current + 1;
    backfillSeqRef.current = seq;
    const active = () =>
      backfillSeqRef.current === seq && visibleRef.current && selectedFolderRef.current === folder;
    void (async () => {
      try {
        for (let round = 0; round < 1000; round += 1) {
          if (!active()) return;
          if (syncInFlightRef.current) {
            await delay(800);
            continue;
          }
          syncInFlightRef.current = true;
          let result: MailFolderSyncResult;
          try {
            result = await mailSyncFolder(info, folder, { mode: "backfill", limit: catchupBatchSize });
          } finally {
            syncInFlightRef.current = false;
          }
          applySyncedFolder(result.folder);
          if (!active()) return;
          const cached = result.folder.cachedCount ?? 0;
          const total = result.folder.total ?? cached;
          if (!result.more) {
            setBackfillProgress(null);
            setHasMoreMessages(folderHasMoreToLoad(
              result.folder,
              messagesRef.current.filter((message) => message.folder === folder).length,
              false,
            ));
            return;
          }
          setBackfillProgress({ folder, cached, total });
          setHasMoreMessages(true);
          await delay(200);
        }
      } catch (e) {
        console.debug("mail history backfill paused", e);
      } finally {
        if (backfillSeqRef.current === seq && visibleRef.current) setBackfillProgress(null);
      }
    })();
  }, [applySyncedFolder, catchupBatchSize, info]);

  /**
   * Open / folder-select sync: catch the folder (and INBOX) up completely,
   * however long the tab was closed.
   */
  const syncFolderNow = useCallback(async (
    folder: string,
    indicator: SyncIndicator = "sync",
    notify = false,
  ) => {
    if (syncInFlightRef.current) {
      if (indicator !== "none" && visibleRef.current) setStatus("Mail sync already running");
      return null;
    }
    syncInFlightRef.current = true;
    syncGenerationRef.current += 1;
    if (indicator === "sync") setSyncing(true);
    if (indicator !== "none") setError(null);
    try {
      const primary = await runFolderSync(folder, { indicator });
      let fetched = primary.fetched;
      let newUnseen = isNewMailExcludedName(folder) ? 0 : primary.newUnseen;
      if (folder.trim().toUpperCase() !== "INBOX") {
        try {
          const inbox = await runFolderSync("INBOX");
          fetched += inbox.fetched;
          newUnseen += inbox.newUnseen;
        } catch (e) {
          console.debug("mail INBOX catch-up failed", e);
        }
      }
      if (notify) notifyNewMail(newUnseen);
      if (indicator !== "none" && visibleRef.current) {
        setStatus(fetched > 0 ? `Synced ${fetched} headers` : "Mailbox up to date");
      }
      return primary;
    } catch (e) {
      if (visibleRef.current) {
        if (indicator !== "none") setError(mailClientErrorMessage(e));
        // Surface the folder failure recorded by the backend.
        void loadCachedFolders();
      }
      return null;
    } finally {
      syncInFlightRef.current = false;
      if (indicator === "sync" && visibleRef.current) setSyncing(false);
    }
  }, [isNewMailExcludedName, loadCachedFolders, notifyNewMail, runFolderSync]);

  /** Quiet background poll: catch up the selected folder and INBOX, reconcile flags. */
  const quietPollSelectedAndInbox = useCallback(async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    const activeFolder = selectedFolderRef.current;
    try {
      const selected = await runFolderSync(activeFolder, { maxSteps: 10 });
      let newUnseen = isNewMailExcludedName(activeFolder) ? 0 : selected.newUnseen;
      if (activeFolder.trim().toUpperCase() !== "INBOX") {
        try {
          newUnseen += (await runFolderSync("INBOX", { maxSteps: 10 })).newUnseen;
        } catch (e) {
          // Selected-folder refresh already succeeded; inbox is best-effort.
          console.debug("quiet INBOX poll failed", e);
        }
      }
      if (info.cache.enabled) {
        try {
          await runFolderSync(activeFolder, { mode: "reconcile", maxSteps: 3 });
        } catch (e) {
          console.debug("quiet mail reconcile failed", e);
        }
      }
      notifyNewMail(newUnseen);
    } catch (e) {
      console.debug("quiet mail poll failed", e);
    } finally {
      syncInFlightRef.current = false;
    }
  }, [info.cache.enabled, isNewMailExcludedName, notifyNewMail, runFolderSync]);

  const syncAllFolders = useCallback(async (
    quiet = false,
    options: Pick<SyncFolderOptions, "limit" | "includeBodies" | "indicator"> = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const limit = Math.max(1, options.limit ?? batchSize);
    const includeBodies = options.includeBodies ?? false;
    const activeBeforeSync = selectedFolderRef.current;

    if (syncInFlightRef.current) {
      // Background work (open catch-up, backfill, quiet poll) holds the lock.
      // Periodic scans just skip; a manual sync waits its turn instead of
      // being dropped, so a click always ends with fresh server state.
      if (quiet || indicator === "none") return null;
      if (indicator === "sync") setSyncing(true);
      if (visibleRef.current) setStatus("Waiting for current mail sync…");
      const deadline = Date.now() + 120_000;
      while (syncInFlightRef.current && Date.now() < deadline) {
        await delay(150);
      }
      if (syncInFlightRef.current) {
        if (indicator === "sync" && visibleRef.current) setSyncing(false);
        if (visibleRef.current) setStatus("Mail sync already running");
        return null;
      }
    }
    syncInFlightRef.current = true;

    if (indicator === "sync") {
      setSyncing(true);
    }
    if (!quiet && indicator !== "none") setStatus(null);
    if (indicator !== "none") setError(null);

    try {
      // Manual sync reconciles every cached message; periodic scans only the newest window.
      const result = await mailSyncAllFolders(
        { ...info, sync: { ...info.sync, subscribedOnly: subscribedOnlyRef.current } },
        { limit, includeBodies, fullReconcile: !quiet },
      );
      foldersRef.current = result.folders;
      let newMessages = countNewMail(result.newUnseenByFolder, result.folders, isNewMailExcludedFolder);
      const pending = (result.pendingFolders ?? [])
        .slice()
        .sort((a, b) => Number(b === activeBeforeSync) - Number(a === activeBeforeSync))
        .slice(0, 6);
      for (const name of pending) {
        try {
          const loop = await runFolderSync(name, { maxSteps: 20 });
          if (!isNewMailExcludedName(name)) newMessages += loop.newUnseen;
        } catch (e) {
          console.debug(`mail catch-up for ${name} failed`, e);
        }
      }
      if (indicator === "none") notifyNewMail(newMessages);
      // New INBOX mail from the full scan goes through the incoming filters
      // (a cheap cache query when nothing is new or no filter is enabled).
      if (result.fetchedMessages > 0) await incomingFiltersRef.current?.();
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return result;
      }
      setFolders(foldersRef.current);
      const nextFolder = foldersRef.current.some((folder) => folder.name === activeBeforeSync)
        ? activeBeforeSync
        : foldersRef.current[0]?.name ?? activeBeforeSync;
      if (nextFolder !== activeBeforeSync) {
        updateSelectedFolder(nextFolder);
      }
      const loaded = messagesRef.current.filter((message) => message.folder === nextFolder).length;
      await loadCachedMessages(nextFolder, 0, false, quiet || indicator === "none", Math.max(pageSize, loaded));
      const failed = result.failedFolders ?? [];
      if (indicator !== "none") {
        setStatus(
          `Synced ${result.fetchedMessages} new headers across ${result.folders.length} folders`
          + (failed.length > 0 ? `; ${failed.length} folder${failed.length === 1 ? "" : "s"} failed` : ""),
        );
      }
      void warmRecentBodies(foldersRef.current, nextFolder);
      startBackfill(nextFolder);
      return result;
    } catch (e) {
      if (indicator !== "none") setError(mailClientErrorMessage(e));
      return null;
    } finally {
      syncInFlightRef.current = false;
      if (indicator === "sync") {
        if (visibleRef.current) setSyncing(false);
      }
    }
  }, [
    batchSize,
    info,
    isNewMailExcludedFolder,
    isNewMailExcludedName,
    loadCachedMessages,
    notifyNewMail,
    pageSize,
    runFolderSync,
    startBackfill,
    updateSelectedFolder,
    warmRecentBodies,
  ]);

  const loadBody = useCallback(async (message: MailMessageHeader) => {
    const key = messageKey(message);
    const cached = bodyCacheRef.current.get(key);
    if (cached && bodyMatchesMessage(cached, message)) {
      rememberBody(cached);
      return cached;
    }
    const seq = bodyLoadSeqRef.current + 1;
    bodyLoadSeqRef.current = seq;
    setBodyLoadingKey(key);
    setError(null);
    try {
      const nextBody = await fetchBodyForMessage(message);
      if (bodyLoadSeqRef.current === seq) {
        setStatus(nextBody.source === "cache" ? "Loaded body from cache" : "Loaded body from server");
      }
      return nextBody;
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    } finally {
      setBodyLoadingKey((current) => (current === key ? null : current));
    }
  }, [fetchBodyForMessage, rememberBody]);

  const markMessagesReadLocally = useCallback((folder: string, uids: number[] | null, markedCount: number) => {
    if (markedCount <= 0) return;
    const uidSet = uids ? new Set(uids) : null;
    const shouldMark = (message: MailMessageHeader) =>
      message.folder === folder && (!uidSet || uidSet.has(message.uid));
    setMessages((current) => current.map((message) => {
      return shouldMark(message) ? withSeenFlag(message) : message;
    }));
    setMessageTabs((current) => current.map((tab) => {
      return shouldMark(tab.message) ? { ...tab, message: withSeenFlag(tab.message) } : tab;
    }));
    setFolders((current) => current.map((entry) => {
      if (entry.name !== folder || entry.unread === null || entry.unread === undefined) return entry;
      return { ...entry, unread: Math.max(0, entry.unread - markedCount), updatedAt: Math.floor(Date.now() / 1000) };
    }));
  }, []);

  const handleMarkSelectedRead = useCallback(async () => {
    const unread = checkedMessages.filter(isUnread);
    if (unread.length === 0) {
      setStatus("Selected messages are already read");
      return;
    }

    setMarkingRead(true);
    setError(null);
    try {
      let marked = 0;
      const byFolder = new Map<string, number[]>();
      for (const message of unread) {
        const folderUids = byFolder.get(message.folder) ?? [];
        folderUids.push(message.uid);
        byFolder.set(message.folder, folderUids);
      }
      for (const [folder, uids] of byFolder) {
        const result = await mailMarkRead(info, folder, uids, false);
        marked += result.marked;
        markMessagesReadLocally(folder, uids, result.marked);
      }
      setCheckedMessageKeys((current) => {
        const next = new Set(current);
        for (const message of unread) next.delete(messageKey(message));
        return next;
      });
      setStatus(marked > 0 ? `Marked ${marked} selected messages as read` : "No selected unread messages");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setMarkingRead(false);
    }
  }, [checkedMessages, info, markMessagesReadLocally]);

  const handleMarkFolderRead = useCallback(async (folderName = selectedFolder) => {
    setMarkingRead(true);
    setError(null);
    try {
      const result = await mailMarkRead(info, folderName, [], true);
      markMessagesReadLocally(folderName, null, result.marked);
      setCheckedMessageKeys(new Set());
      setStatus(result.marked > 0 ? `Marked ${result.marked} cached messages as read` : "No unread cached messages");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setMarkingRead(false);
    }
  }, [info, markMessagesReadLocally, selectedFolder]);

  const toggleMessageChecked = useCallback((message: MailMessageHeader, checked: boolean) => {
    const key = messageKey(message);
    setCheckedMessageKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const toggleFilteredMessagesChecked = useCallback((checked: boolean) => {
    setCheckedMessageKeys((current) => {
      const next = new Set(current);
      for (const message of filteredMessages) {
        const key = messageKey(message);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, [filteredMessages]);

  const selectMessage = useCallback((message: MailMessageHeader, viewKey = "mailbox") => {
    const key = messageKey(message);
    updateSelectedFolder(message.folder);
    setSelectedMessageKey(key);
    setMailViewKey(viewKey);
    const cached = bodyCacheRef.current.get(key);
    setBody((current) => (
      cached && bodyMatchesMessage(cached, message)
        ? cached
        : bodyMatchesMessage(current, message) ? current : null
    ));
  }, [updateSelectedFolder]);

  const openMessageTab = useCallback((message: MailMessageHeader) => {
    const key = messageKey(message);
    setMessageTabs((current) => {
      if (current.some((tab) => tab.key === key)) return current;
      return [...current, { key, message }];
    });
    selectMessage(message, key);
  }, [selectMessage]);

  const closeMessageTab = useCallback((key: string) => {
    setMessageTabs((current) => current.filter((tab) => tab.key !== key));
    if (mailViewKey === key) {
      setMailViewKey("mailbox");
      setBody(null);
    }
    if (popupMessageKey === key) {
      setPopupMessageKey(null);
    }
  }, [mailViewKey, popupMessageKey]);

  const openMessagePopup = useCallback((message: MailMessageHeader) => {
    selectMessage(message, mailViewKey === "mailbox" ? "mailbox" : messageKey(message));
    setPopupMessageKey(messageKey(message));
  }, [mailViewKey, selectMessage]);

  const handleMarkSingleRead = useCallback(async (message: MailMessageHeader) => {
    if (!isUnread(message)) {
      setStatus("Message is already read");
      return;
    }
    setMarkingRead(true);
    setError(null);
    try {
      const result = await mailMarkRead(info, message.folder, [message.uid], false);
      markMessagesReadLocally(message.folder, [message.uid], result.marked);
      setStatus(result.marked > 0 ? "Marked message as read" : "Message was already read");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setMarkingRead(false);
    }
  }, [info, markMessagesReadLocally]);

  const loadInitialMessages = useCallback(async (folder: string) => {
    await loadCachedMessages(folder);
  }, [loadCachedMessages]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
    foldersRef.current = [];
    bodyWarmSeqRef.current += 1;
    bodyLoadSeqRef.current += 1;
    bodyCacheRef.current = new Map();
    bodyRequestsRef.current.clear();
    setFolders([]);
    setMessages([]);
    setSelectedMessageKey(null);
    setMailViewKey("mailbox");
    setMessageTabs([]);
    setPopupMessageKey(null);
    setCheckedMessageKeys(new Set());
    setBody(null);
    setBodyCache(new Map());
    setBodyLoadingKey(null);
    setBodyWarming({ active: false, done: 0, total: 0 });
    setHasMoreMessages(false);
    setLoadingMoreMessages(false);
    setDownloadingAttachmentIndex(null);
    updateSelectedFolder("INBOX");
    void loadCachedFolders();
  }, [info.sessionId, loadCachedFolders, updateSelectedFolder]);

  useEffect(() => {
    void loadInitialMessages(selectedFolder);
  }, [loadInitialMessages, selectedFolder]);

  useEffect(() => {
    if (!visible || !pendingCacheRefreshRef.current) return;
    pendingCacheRefreshRef.current = false;
    if (bodyCacheRef.current.size > 0) {
      setBodyCache(new Map(bodyCacheRef.current));
    }
    void loadCachedFolders();
    void loadCachedMessages(selectedFolder, 0, false, true);
  }, [loadCachedFolders, loadCachedMessages, selectedFolder, visible]);

  useEffect(() => {
    if (!visible || !info.sync.onOpen || initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    const folder = selectedFolder;
    // Catch up everything that arrived while the tab was closed, then keep
    // backfilling older history for the full local header index.
    void syncFolderNow(folder, "sync", true)
      .then(() => refreshFolderTree())
      .then(() => startBackfill(folder));
  }, [info.sync.onOpen, refreshFolderTree, selectedFolder, startBackfill, syncFolderNow, visible]);

  // Quiet background poll: most ticks refresh selected folder (+ INBOX when
  // different) without remote LIST. Every 6th tick does a full-folder scan for
  // badges / new-mail notifications across the account.
  const pollTickRef = useRef(0);
  useEffect(() => {
    pollTickRef.current = 0;
    if (info.sync.intervalMinutes <= 0) return;
    const intervalMs = Math.max(1, info.sync.intervalMinutes) * 60 * 1000;
    const id = window.setInterval(() => {
      pollTickRef.current += 1;
      const fullScan = pollTickRef.current % 6 === 0;
      if (fullScan) {
        void syncAllFolders(true, {
          limit: batchSize,
          includeBodies: false,
          indicator: "none",
        });
      } else {
        void quietPollSelectedAndInbox();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [batchSize, info.sync.intervalMinutes, quietPollSelectedAndInbox, syncAllFolders]);

  // IMAP IDLE push (TASK-12): while the tab is open a dedicated connection
  // waits on INBOX; each change runs the normal gap-free quiet catch-up, so a
  // lost push only delays mail until the next poll. Stopped on close (DEC-01).
  const quietPollRef = useRef(quietPollSelectedAndInbox);
  quietPollRef.current = quietPollSelectedAndInbox;
  const idleConfigRef = useRef(info);
  idleConfigRef.current = info;
  const [idleState, setIdleState] = useState<string | null>(null);
  const idleEnabled = info.sync.idle !== false;
  useEffect(() => {
    if (!idleEnabled) return;
    const accountId = info.sessionId;
    let disposed = false;
    let debounce: number | null = null;
    let unlisten: (() => void) | null = null;
    const schedulePoll = (waitMs = 400) => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        if (disposed) return;
        // The quiet poll skips while another sync (open catch-up, backfill)
        // holds the lock; keep the push pending instead of dropping it.
        if (syncInFlightRef.current) {
          schedulePoll(500);
          return;
        }
        void quietPollRef.current();
      }, waitMs);
    };
    void listen<MailIdleEvent>(MAIL_IDLE_EVENT, (event) => {
      const payload = event.payload;
      if (disposed || payload?.accountId !== accountId) return;
      // "stopped" may come from a previous watcher replaced by this tab's.
      if (payload.kind === "stopped") return;
      setIdleState(payload.kind);
      if (payload.kind === "changed") schedulePoll();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    void mailIdleStart(idleConfigRef.current, "INBOX").catch((e) => {
      console.debug("mail IDLE unavailable; polling only", e);
      if (!disposed) setIdleState("unsupported");
    });
    return () => {
      disposed = true;
      if (debounce != null) window.clearTimeout(debounce);
      unlisten?.();
      void mailIdleStop(accountId).catch(() => {});
    };
  }, [idleEnabled, info.sessionId]);

  useEffect(() => {
    if (messages.length === 0) {
      if (!selectedMessageKey || !messageTabs.some((tab) => tab.key === selectedMessageKey)) {
        setSelectedMessageKey(null);
      }
      setBody(null);
      return;
    }
    if (
      !selectedMessageKey
      || (
        !messages.some((message) => messageKey(message) === selectedMessageKey)
        && !messageTabs.some((tab) => tab.key === selectedMessageKey)
      )
    ) {
      setSelectedMessageKey(messageKey(messages[0]));
      setBody(null);
    }
  }, [messageTabs, messages, selectedMessageKey]);

  const autoReadKeyRef = useRef<string | null>(null);
  const remoteImagesMessageKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    if (!selectedMessage) return;
    const key = messageKey(selectedMessage);
    let cancelled = false;
    if (remoteImagesMessageKeyRef.current !== key) {
      remoteImagesMessageKeyRef.current = key;
      setAllowRemoteAllInTab(false);
      setRemoteAllowedMessageKeys(new Set());
    }
    if (!selectedBody) {
      void loadBody(selectedMessage);
    }
    if (autoReadKeyRef.current === key || !isUnread(selectedMessage)) {
      return () => {
        cancelled = true;
      };
    }
    autoReadKeyRef.current = key;
    void (async () => {
      try {
        const result = await mailMarkRead(info, selectedMessage.folder, [selectedMessage.uid], false);
        if (!cancelled && result.marked > 0) {
          markMessagesReadLocally(selectedMessage.folder, [selectedMessage.uid], result.marked);
        }
      } catch (e) {
        if (!cancelled) setError(mailClientErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, loadBody, markMessagesReadLocally, selectedBody, selectedMessage, visible]);

  useEffect(() => {
    setCheckedMessageKeys((current) => {
      if (current.size === 0) return current;
      const liveKeys = new Set(messages.map(messageKey));
      const next = new Set([...current].filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [messages]);

  const handleFolderSelect = (folder: MailFolder) => {
    const changed = folder.name !== selectedFolderRef.current;
    updateSelectedFolder(folder.name);
    if (changed) {
      backfillSeqRef.current += 1;
      setBackfillProgress(null);
      void syncFolderNow(folder.name, "none").then(() => startBackfill(folder.name));
    }
    setSelectedMessageKey(null);
    setCheckedMessageKeys(new Set());
    setBody(null);
    setHasMoreMessages(false);
    setLoadingMoreMessages(false);
    setQuery("");
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await mailTestConnection(info);
      setStatus(`${info.incoming === "pop3" ? "POP3" : "IMAP"} ${result.imapOk ? "ok" : "failed"}, SMTP ${result.smtpOk ? "ok" : "failed"}, ${result.folderCount} folders`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      await mailClearCache(info.sessionId);
      bodyWarmSeqRef.current += 1;
      bodyLoadSeqRef.current += 1;
      bodyCacheRef.current = new Map();
      bodyRequestsRef.current.clear();
      setFolders([]);
      setMessages([]);
      setBody(null);
      setBodyCache(new Map());
      setBodyLoadingKey(null);
      setBodyWarming({ active: false, done: 0, total: 0 });
      setSelectedMessageKey(null);
      setMailViewKey("mailbox");
      setMessageTabs([]);
      setPopupMessageKey(null);
      setCheckedMessageKeys(new Set());
      setHasMoreMessages(false);
      setLoadingMoreMessages(false);
      setStatus("Mail cache cleared");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setClearing(false);
    }
  };

  const loadMoreMessages = useCallback(async () => {
    if (query.trim() || loadingMessages || loadingMoreMessages || !hasMoreMessages) return;
    const folder = selectedFolder;
    const loaded = messages.length;
    if (!info.cache.enabled) {
      // No cache to page: fall back to server offset paging.
      setLoadingMoreMessages(true);
      try {
        const result = await mailSyncHeaders(info, folder, { limit: pageSize, offset: loaded, refreshFolders: false });
        const merged = mergeSyncedMessages(selectedFolderRef.current, folder, messagesRef.current, result.messages, sortMessages);
        if (merged) {
          messagesRef.current = merged;
          setMessages(merged);
        }
        setHasMoreMessages(result.hasMore);
      } catch (e) {
        setError(mailClientErrorMessage(e));
      } finally {
        setLoadingMoreMessages(false);
      }
      return;
    }
    // Cache first; only when the cache is exhausted backfill older history.
    const { page } = await loadCachedMessages(folder, loaded, true);
    if (page.length > 0) return;
    const meta = foldersRef.current.find((entry) => entry.name === folder);
    if (!meta || meta.syncComplete || syncInFlightRef.current) {
      if (meta?.syncComplete) setHasMoreMessages(false);
      return;
    }
    syncInFlightRef.current = true;
    setLoadingMoreMessages(true);
    try {
      const result = await mailSyncFolder(info, folder, { mode: "backfill", limit: pageSize });
      applySyncedFolder(result.folder);
      await loadCachedMessages(folder, loaded, true);
      if (!result.more && result.fetched === 0) setStatus("No more messages");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      syncInFlightRef.current = false;
      setLoadingMoreMessages(false);
    }
  }, [
    applySyncedFolder,
    hasMoreMessages,
    info,
    loadCachedMessages,
    loadingMessages,
    loadingMoreMessages,
    messages.length,
    pageSize,
    query,
    selectedFolder,
  ]);

  const handleMessageListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 96) {
      void loadMoreMessages();
    }
  }, [loadMoreMessages]);

  const refreshDrafts = async () => {
    setDraftsLoading(true);
    try {
      setDrafts(await mailListDrafts(info.sessionId));
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDraftsLoading(false);
    }
  };

  const openCompose = (nextDraft: Partial<ComposeDraft> = {}, includeSignature = true) => {
    const identity = identityById(nextDraft.identityId);
    const withIdentity = { ...nextDraft, identityId: identity.id };
    const next = includeSignature ? draftWithSignature(withIdentity, identity.signature) : { ...emptyComposeDraft(), ...withIdentity };
    setDraft(next);
    lastSavedDraftJsonRef.current = serializeDraftContent(next);
    setRecipientSearch({ field: null, query: "", suggestions: [], loading: false });
    setComposeOpen(true);
  };

  const saveCurrentDraft = async (mode: "manual" | "auto" = "manual") => {
    if (!draftHasContent(draft)) return null;
    const serialized = serializeDraftContent(draft);
    if (mode === "auto" && serialized === lastSavedDraftJsonRef.current) return null;
    setSavingDraft(true);
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: draft.id ?? null,
        to: draft.to.map(formatRecipientForSend),
        cc: draft.cc.map(formatRecipientForSend),
        bcc: draft.bcc.map(formatRecipientForSend),
        subject: draft.subject,
        textBody: draft.textBody || mailHtmlToPlainText(draft.htmlBody),
        htmlBody: sanitizeMailComposeHtml(draft.htmlBody),
        attachments: draft.attachments,
        replyContext: draftContextWithIdentity(draft),
      });
      lastSavedDraftJsonRef.current = serialized;
      setDraft((current) => ({ ...current, id: saved.id }));
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      if (mode === "manual") {
        setStatus("Draft saved");
        // Mirror explicit saves to the server Drafts folder (autosave stays local).
        void mailStoreRemoteDraft(info, saved.id)
          .then((stored) => {
            setDrafts((current) => current.map((item) => (item.id === stored.id ? stored : item)));
            if (stored.remoteDraftFolder) setStatus(`Draft saved to ${stored.remoteDraftFolder}`);
          })
          .catch((e) => setStatus(`Draft saved locally; server copy failed: ${mailClientErrorMessage(e)}`));
      }
      return saved;
    } catch (e) {
      if (mode === "manual") setError(mailClientErrorMessage(e));
      return null;
    } finally {
      setSavingDraft(false);
    }
  };

  /** Templates are local drafts tagged kind "template"; each save adds one. */
  const saveCurrentAsTemplate = async () => {
    if (!draftHasContent(draft)) return;
    setSavingDraft(true);
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: null,
        to: draft.to.map(formatRecipientForSend),
        cc: draft.cc.map(formatRecipientForSend),
        bcc: draft.bcc.map(formatRecipientForSend),
        subject: draft.subject,
        textBody: draft.textBody || mailHtmlToPlainText(draft.htmlBody),
        htmlBody: sanitizeMailComposeHtml(draft.htmlBody),
        attachments: draft.attachments,
        replyContext: { kind: TEMPLATE_KIND, identityId: draftContextWithIdentity(draft)?.identityId ?? null },
      });
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setStatus("Template saved");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setSavingDraft(false);
    }
  };

  const openFromTemplate = (template: MailDraft) => {
    const next = draftFromSaved(template);
    openCompose({
      ...next,
      id: null,
      replyContext: null,
      identityId: template.replyContext?.identityId ?? null,
    }, false);
    setDraftsOpen(false);
  };

  const openSavedDraft = (saved: MailDraft) => {
    const next = draftFromSaved(saved);
    if (isOutbox(saved)) {
      // Editing a queued message takes it out of the Outbox (Thunderbird).
      void mailSaveDraft(info.sessionId, {
        id: saved.id,
        to: saved.to,
        cc: saved.cc,
        bcc: saved.bcc,
        subject: saved.subject,
        textBody: saved.textBody,
        htmlBody: saved.htmlBody,
        attachments: saved.attachments,
        replyContext: withoutOutbox(saved.replyContext),
      }).then((plain) => setDrafts((current) => current.map((item) => (item.id === plain.id ? plain : item))))
        .catch((e) => console.debug("mail: could not move draft out of the Outbox", e));
    }
    setDraft(next);
    lastSavedDraftJsonRef.current = serializeDraftContent(next);
    setRecipientSearch({ field: null, query: "", suggestions: [], loading: false });
    setDraftsOpen(false);
    setComposeOpen(true);
  };

  const deleteSavedDraft = async (saved: MailDraft) => {
    try {
      if (saved.remoteDraftUid) {
        await mailDiscardRemoteDraft(info, saved.id).catch((e) => {
          console.debug("mail: discarding server draft failed", e);
        });
      }
      await mailDeleteDraft(info.sessionId, saved.id);
      setDrafts((current) => current.filter((item) => item.id !== saved.id));
      if (draft.id === saved.id) setDraft(emptyComposeDraft());
      setStatus("Draft deleted");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const fallbackBodyFor = (target: MailMessageHeader): MailMessageBody => ({
    accountId: target.accountId,
    folder: target.folder,
    uid: target.uid,
    messageId: target.messageId,
    subject: target.subject,
    text: target.snippet ?? "",
    html: null,
    snippet: target.snippet,
    attachments: [],
    rawSize: target.rawSize,
    cachedAt: null,
    source: "header",
  });

  const replyDraftBody = (target: MailMessageHeader, currentBody: MailMessageBody, signature: string | null | undefined) => {
    const intro = `On ${formatFullDate(target.dateTs) || "an unknown date"}, ${addressLabel(target.from) || "(unknown sender)"} wrote:`;
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildReplyHtml(intro, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}${intro}\n${quotePlainText(originalText)}`,
    };
  };

  const openReply = (target = selectedMessage) => {
    if (!target) return;
    const from = target.from?.address ?? addressLabel(target.from);
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(from),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("reply", target),
      richFormatUsed: true,
    }, false);
  };

  const openReplyAll = (target = selectedMessage) => {
    if (!target) return;
    const ownAddresses = new Set([
      normalizedMailAddress(info.emailAddress),
      normalizedMailAddress(info.imap.username),
      normalizedMailAddress(info.smtp.username),
      ...ownIdentityAddresses(identities),
    ].filter(Boolean));
    const to: string[] = [];
    const cc: string[] = [];
    const seenTo = new Set<string>();
    const seenCc = new Set<string>();
    appendUniqueAddress(to, seenTo, target.from, ownAddresses);
    for (const recipient of target.to) appendUniqueAddress(to, seenTo, recipient, ownAddresses);
    for (const recipient of target.cc) {
      const mail = normalizedMailAddress(recipient.address ?? addressLabel(recipient));
      if (seenTo.has(mail)) continue;
      appendUniqueAddress(cc, seenCc, recipient, ownAddresses);
    }
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const identity = pickReplyIdentity(identities, target);
    const replyBodyDraft = replyDraftBody(target, replyBody, identity.signature);
    openCompose({
      identityId: identity.id,
      to: parseRecipientsText(to.join(", ")),
      cc: parseRecipientsText(cc.join(", ")),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: replyContextFor("replyAll", target),
      richFormatUsed: true,
    }, false);
  };

  /** MIME request for a composer draft, or an error to show. */
  const buildSendRequest = (source: ComposeDraft): MailSendRequest | string => {
    // Convert compose-time data-URL previews (data-taomni-cid) to cid: for MIME.
    const htmlBody = prepareMailHtmlForSend(source.htmlBody);
    const textBody = source.textBody.trim() || mailHtmlToPlainText(htmlBody);
    const sendHtml = source.richFormatUsed || hasRichMailFormatting(htmlBody);
    const recipients = [...source.to, ...source.cc, ...source.bcc];
    if (recipients.length === 0) return "At least one recipient is required.";
    const invalidRecipient = recipients.find((recipient) => !isValidEmailAddress(recipient.email));
    if (invalidRecipient) return `Invalid recipient: ${recipientLabel(invalidRecipient)}`;
    return {
      to: source.to.map(formatRecipientForSend),
      cc: source.cc.map(formatRecipientForSend),
      bcc: source.bcc.map(formatRecipientForSend),
      subject: source.subject.trim(),
      textBody,
      htmlBody: sendHtml ? htmlBody : null,
      attachments: source.attachments.map((attachment) => ({
        path: attachment.path,
        name: attachment.name ?? null,
        contentType: attachment.contentType ?? null,
        inline: attachment.inline ?? false,
        contentId: attachment.contentId ?? null,
      })),
      ...threadHeadersFor(source.replyContext),
      draftId: source.id ?? null,
      ...identitySendFields(identityById(source.identityId)),
      requestReadReceipt: source.readReceipt === true,
    };
  };

  const sentStatus = (result: MailSendResult) => {
    if (!result.accepted) {
      setStatus(result.response || "SMTP send returned no acceptance");
    } else if (result.sentCopyError) {
      setStatus("Message sent");
      setError(`Message sent, but saving the Sent copy failed: ${result.sentCopyError}`);
    } else {
      setStatus(result.sentCopyFolder ? `Message sent; copy saved to ${result.sentCopyFolder}` : "Message sent");
    }
  };

  /** Save a composer draft into the local Outbox (TASK-17). */
  const queueToOutbox = async (
    source: ComposeDraft,
    queue: Pick<MailOutboxState, "sendAt"> & Partial<MailOutboxState>,
  ): Promise<MailDraft | null> => {
    const outbox: MailOutboxState = {
      queuedAt: Math.floor(Date.now() / 1000),
      attempts: 0,
      lastError: null,
      readReceipt: source.readReceipt === true,
      ...queue,
    };
    try {
      const saved = await mailSaveDraft(info.sessionId, {
        id: source.id ?? null,
        to: source.to.map(formatRecipientForSend),
        cc: source.cc.map(formatRecipientForSend),
        bcc: source.bcc.map(formatRecipientForSend),
        subject: source.subject,
        textBody: source.textBody || mailHtmlToPlainText(source.htmlBody),
        htmlBody: sanitizeMailComposeHtml(source.htmlBody),
        attachments: source.attachments,
        replyContext: { ...(draftContextWithIdentity(source) ?? {}), outbox },
      });
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      return saved;
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    }
  };

  const closeComposer = () => {
    setComposeOpen(false);
    setSendLaterOpen(false);
    setAttachReminder(false);
    setDraft(emptyComposeDraft());
  };

  /** Send one queued message; failures stay queued with a retry backoff. */
  const sendOutboxItem = async (saved: MailDraft, manual = false): Promise<boolean> => {
    const state = outboxState(saved);
    if (!state || outboxBusyIdsRef.current.has(saved.id)) return false;
    const built = buildSendRequest(draftFromSaved(saved));
    if (typeof built === "string") {
      if (manual) setError(built);
      return false;
    }
    outboxBusyIdsRef.current.add(saved.id);
    try {
      const result = await mailSendMessage(info, { ...built, draftId: saved.id });
      await mailDeleteDraft(info.sessionId, saved.id).catch(() => undefined);
      setDrafts((current) => current.filter((item) => item.id !== saved.id));
      sentStatus(result);
      return true;
    } catch (e) {
      const message = mailClientErrorMessage(e);
      const next: MailOutboxState = { ...state, attempts: state.attempts + 1, lastError: message };
      try {
        const updated = await mailSaveDraft(info.sessionId, {
          id: saved.id,
          to: saved.to,
          cc: saved.cc,
          bcc: saved.bcc,
          subject: saved.subject,
          textBody: saved.textBody,
          htmlBody: saved.htmlBody,
          attachments: saved.attachments,
          replyContext: { ...(saved.replyContext ?? {}), outbox: next },
        });
        setDrafts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } catch (saveError) {
        console.debug("mail: outbox retry state not saved", saveError);
      }
      if (manual) setError(`Sending "${saved.subject || "(no subject)"}" failed: ${message}`);
      return false;
    } finally {
      outboxBusyIdsRef.current.delete(saved.id);
    }
  };

  /** Send every due (or, when `all`, every) queued message. */
  const processOutbox = async (all = false) => {
    let list: MailDraft[];
    try {
      list = await mailListDrafts(info.sessionId);
    } catch (e) {
      console.debug("mail: outbox list failed", e);
      return;
    }
    setDrafts(list);
    const now = Math.floor(Date.now() / 1000);
    const pendingUndo = undoSendRef.current?.draftId;
    const editing = composeDraftIdRef.current;
    const due = list.filter((saved) => {
      const state = outboxState(saved);
      // Skip the undo-window message and one reopened in the composer.
      if (!state || saved.id === pendingUndo || saved.id === editing) return false;
      if (all) return true;
      const at = outboxNextAttemptAt(state);
      return at != null && at <= now;
    });
    let sent = 0;
    for (const saved of due) {
      if (await sendOutboxItem(saved, all)) sent += 1;
    }
    if (all && due.length > 0) {
      setStatus(sent === due.length ? `Sent ${sent} queued message${sent === 1 ? "" : "s"}` : `Sent ${sent} of ${due.length} queued messages`);
    }
  };
  const processOutboxRef = useRef(processOutbox);
  processOutboxRef.current = processOutbox;
  const undoSendRef = useRef(undoSend);
  undoSendRef.current = undoSend;
  const composeDraftIdRef = useRef<string | null>(null);
  composeDraftIdRef.current = composeOpen ? draft.id ?? null : null;

  useEffect(() => {
    if (!retryAfterTrustRef.current) return;
    retryAfterTrustRef.current = false;
    void syncFolderNow(selectedFolderRef.current, "sync", true);
  }, [info.imap.trustedCert, info.smtp.trustedCert]);

  // Outbox: send due messages only while the tab is open (DEC-01).
  useEffect(() => {
    const first = window.setTimeout(() => void processOutboxRef.current(), 3000);
    const id = window.setInterval(() => void processOutboxRef.current(), 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [info.sessionId]);

  useEffect(() => {
    if (!undoSend) return;
    const id = window.setInterval(() => setUndoNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [undoSend]);

  // A pending undo survives unmount in the Outbox and goes out on next open.
  useEffect(() => () => {
    if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
  }, []);

  const handleSendDraft = async (skipAttachReminder = false) => {
    const built = buildSendRequest(draft);
    if (typeof built === "string") {
      setError(built);
      return;
    }
    // Thunderbird's attachment reminder: text mentions one, none attached.
    if (!skipAttachReminder && draft.attachments.length === 0
      && mentionsAttachment(draft.subject, draft.textBody, draft.htmlBody)) {
      setAttachReminder(true);
      return;
    }
    setAttachReminder(false);
    setError(null);
    const undoSeconds = Math.max(0, Math.floor(info.undoSendSeconds ?? 0));
    if (undoSeconds > 0) {
      // Undo window: the message waits in the Outbox until the timer fires.
      const until = Math.floor(Date.now() / 1000) + undoSeconds;
      const queued = await queueToOutbox(draft, { sendAt: until });
      if (!queued) return;
      closeComposer();
      setUndoSend({ draftId: queued.id, until });
      setUndoNow(Date.now());
      if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(() => {
        undoTimerRef.current = null;
        setUndoSend(null);
        void sendOutboxItem(queued, true);
      }, undoSeconds * 1000);
      return;
    }
    setSending(true);
    try {
      const result = await mailSendMessage(info, built);
      if (draft.id) {
        await mailDeleteDraft(info.sessionId, draft.id).catch(() => undefined);
        setDrafts((current) => current.filter((item) => item.id !== draft.id));
      }
      sentStatus(result);
      closeComposer();
    } catch (e) {
      const message = mailClientErrorMessage(e);
      // Offline / unreachable server: keep the message in the Outbox (AC-49).
      if (isTransientSendError(message)) {
        const now = Math.floor(Date.now() / 1000);
        const queued = await queueToOutbox(draft, { sendAt: now, attempts: 1, lastError: message });
        if (queued) {
          closeComposer();
          setStatus("Could not reach the mail server; the message is in the Outbox and retries while this tab is open");
          return;
        }
      }
      setError(message);
    } finally {
      setSending(false);
    }
  };

  const handleSendLater = async () => {
    const built = buildSendRequest(draft);
    if (typeof built === "string") {
      setError(built);
      return;
    }
    const at = fromDateTimeLocal(sendLaterAt);
    const queued = await queueToOutbox(draft, { sendAt: at });
    if (!queued) return;
    closeComposer();
    setStatus(at
      ? `Scheduled for ${new Date(at * 1000).toLocaleString()} (sends while this tab is open)`
      : "Saved to Outbox; use Send now in Drafts > Outbox");
  };

  const handleUndoSend = async () => {
    const pending = undoSend;
    if (!pending) return;
    if (undoTimerRef.current != null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoSend(null);
    const saved = drafts.find((item) => item.id === pending.draftId)
      ?? (await mailListDrafts(info.sessionId).catch(() => [] as MailDraft[])).find((item) => item.id === pending.draftId);
    if (!saved) return;
    const restored = draftFromSaved(saved);
    // Back to a plain draft, then reopen it for editing.
    await mailSaveDraft(info.sessionId, {
      id: saved.id,
      to: saved.to,
      cc: saved.cc,
      bcc: saved.bcc,
      subject: saved.subject,
      textBody: saved.textBody,
      htmlBody: saved.htmlBody,
      attachments: saved.attachments,
      replyContext: withoutOutbox(saved.replyContext),
    }).then((plain) => setDrafts((current) => current.map((item) => (item.id === plain.id ? plain : item))))
      .catch((e) => console.debug("mail: undo could not clear outbox state", e));
    setDraft(restored);
    lastSavedDraftJsonRef.current = serializeDraftContent(restored);
    setComposeOpen(true);
    setStatus("Sending cancelled");
  };

  const addDraftAttachmentPaths = useCallback(async (paths: string[]) => {
    const unique = paths.map((path) => path.trim()).filter(Boolean);
    if (unique.length === 0) return;
    setAttachProgress({ done: 0, total: unique.length, label: "Attaching files…" });
    try {
      setDraft((current) => {
        const existing = new Set(current.attachments.map((attachment) => attachment.path));
        const nextAttachments = unique
          .filter((path) => !existing.has(path))
          .map((path) => {
            const name = basename(path);
            return {
              path,
              name,
              contentType: guessContentType(name),
              size: null,
              modifiedAt: null,
            } satisfies MailDraftAttachment;
          });
        return { ...current, attachments: [...current.attachments, ...nextAttachments] };
      });
      setAttachProgress({ done: unique.length, total: unique.length, label: "Attachments ready" });
      setStatus(
        unique.length === 1
          ? `Attached ${basename(unique[0])}`
          : `Attached ${unique.length} files`,
      );
      window.setTimeout(() => setAttachProgress(null), 1200);
    } catch (e) {
      setAttachProgress(null);
      setError(mailClientErrorMessage(e));
    }
  }, []);

  const handleAddDraftAttachments = async () => {
    try {
      const paths = await selectUploadFile();
      if (!paths.length) return;
      await addDraftAttachmentPaths(paths);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const insertInlineImageFromPath = useCallback(async (path: string): Promise<string | null> => {
    const name = basename(path);
    const contentType = guessContentType(name);
    if (!contentType.toLowerCase().startsWith("image/")) {
      setError("Inline image must be a local image file.");
      return null;
    }
    const bytes = await readFileBytes(path);
    const dataUrl = `data:${contentType};base64,${uint8ToBase64(bytes)}`;
    const contentId = makeInlineImageContentId(name);
    const attachment: MailDraftAttachment = {
      path,
      name,
      contentType,
      inline: true,
      contentId,
      size: bytes.byteLength,
      modifiedAt: null,
    };
    setDraft((current) => ({
      ...current,
      richFormatUsed: true,
      attachments: [...current.attachments, attachment],
    }));
    return buildInlineImageHtml({ contentId, dataUrl, alt: name });
  }, []);

  const insertInlineImageFromFile = useCallback(async (file: File): Promise<string | null> => {
    const mime = file.type || "image/png";
    if (!mime.toLowerCase().startsWith("image/")) {
      setError("Inline image must be an image file.");
      return null;
    }
    const ext = extensionForMime(mime);
    const name = (file.name?.trim() || `pasted-image.${ext}`).replace(/[\\/]/g, "_");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = await temporaryFilePath(name);
    await writeBytesToPath(path, bytes);
    const dataUrl = `data:${mime};base64,${uint8ToBase64(bytes)}`;
    const contentId = makeInlineImageContentId(name);
    const attachment: MailDraftAttachment = {
      path,
      name,
      contentType: mime,
      inline: true,
      contentId,
      size: bytes.byteLength,
      modifiedAt: null,
    };
    setDraft((current) => ({
      ...current,
      richFormatUsed: true,
      attachments: [...current.attachments, attachment],
    }));
    return buildInlineImageHtml({ contentId, dataUrl, alt: name });
  }, []);

  const handleInsertInlineImage = async (): Promise<string | null> => {
    try {
      const paths = await selectUploadFile();
      const path = paths[0];
      if (!path) return null;
      return await insertInlineImageFromPath(path);
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    }
  };

  const handlePasteImages = useCallback(async (files: File[]): Promise<string[]> => {
    const snippets: string[] = [];
    // Prefer files from the paste event when present (multi-image). When the
    // webview omits image/* (common on Linux WebKitGTK for screenshots), fall
    // back to native arboard, then the async Clipboard API.
    let imageFiles = files.filter((file) => (file.type || "").startsWith("image/"));
    if (imageFiles.length === 0) {
      const nativePath = await readNativeClipboardImagePath();
      if (nativePath) {
        setAttachProgress({ done: 0, total: 1, label: "Inserting images…" });
        try {
          const html = await insertInlineImageFromPath(nativePath);
          if (html) {
            setAttachProgress({ done: 1, total: 1, label: "Images inserted" });
            setStatus("Image pasted");
            window.setTimeout(() => setAttachProgress(null), 1200);
            return [html];
          }
        } catch (e) {
          setAttachProgress(null);
          setError(mailClientErrorMessage(e));
          return [];
        }
      }
      imageFiles = await readClipboardImageFiles();
    }
    if (imageFiles.length === 0) return [];

    setAttachProgress({ done: 0, total: imageFiles.length, label: "Inserting images…" });
    try {
      for (let i = 0; i < imageFiles.length; i += 1) {
        const html = await insertInlineImageFromFile(imageFiles[i]);
        if (html) snippets.push(html);
        setAttachProgress({ done: i + 1, total: imageFiles.length, label: "Inserting images…" });
      }
      setAttachProgress({ done: imageFiles.length, total: imageFiles.length, label: "Images inserted" });
      if (snippets.length > 0) {
        setStatus(snippets.length === 1 ? "Image pasted" : `${snippets.length} images pasted`);
      }
      window.setTimeout(() => setAttachProgress(null), 1200);
      return snippets;
    } catch (e) {
      setAttachProgress(null);
      setError(mailClientErrorMessage(e));
      return snippets;
    }
  }, [insertInlineImageFromFile, insertInlineImageFromPath]);

  const handleDropComposeFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setAttachProgress({ done: 0, total: files.length, label: "Attaching files…" });
    try {
      const paths: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const name = (file.name?.trim() || `attachment-${i + 1}`).replace(/[\\/]/g, "_");
        const path = await temporaryFilePath(name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeBytesToPath(path, bytes);
        paths.push(path);
        setAttachProgress({ done: i + 1, total: files.length, label: "Attaching files…" });
      }
      await addDraftAttachmentPaths(paths);
    } catch (e) {
      setAttachProgress(null);
      setError(mailClientErrorMessage(e));
    }
  }, [addDraftAttachmentPaths]);

  const removeDraftAttachment = (index: number) => {
    setDraft((current) => {
      const removed = current.attachments[index];
      const attachments = current.attachments.filter((_, i) => i !== index);
      if (!removed?.inline || !removed.contentId) {
        return { ...current, attachments };
      }
      const cid = escapeRegExp(removed.contentId);
      const htmlBody = current.htmlBody
        .replace(new RegExp(`<img\\b[^>]*\\bdata-taomni-cid=["']${cid}["'][^>]*>`, "gi"), "")
        .replace(new RegExp(`<img\\b[^>]*\\bsrc=["']cid:${cid}["'][^>]*>`, "gi"), "");
      return {
        ...current,
        attachments,
        htmlBody,
        textBody: mailHtmlToPlainText(htmlBody),
      };
    });
  };

  useEffect(() => {
    if (!composeOpen) {
      setComposeDragActive(false);
      return;
    }
    const handleNativeFileDrop = (event: Event) => {
      if (sending) return;
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;
      const root = composeRootRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!root || !target || !root.contains(target)) return;
      setComposeDragActive(false);
      void addDraftAttachmentPaths(detail.paths);
    };
    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [addDraftAttachmentPaths, composeOpen, sending]);

  const discardCurrentDraft = async () => {
    const draftId = draft.id;
    setComposeOpen(false);
    setDraft(emptyComposeDraft());
    lastSavedDraftJsonRef.current = "";
    if (!draftId) return;
    try {
      await mailDeleteDraft(info.sessionId, draftId);
      setDrafts((current) => current.filter((item) => item.id !== draftId));
      setStatus("Draft discarded");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  useEffect(() => {
    if (!composeOpen || sending || savingDraft || !draftHasContent(draft)) return;
    const serialized = serializeDraftContent(draft);
    if (serialized === lastSavedDraftJsonRef.current) return;
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft("auto");
    }, 1800);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [composeOpen, draft, savingDraft, sending]);

  if (!visible) {
    return (
      <div
        ref={rootRef}
        className="h-full min-h-0 bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
        style={mailAppearance}
        data-testid="mail-client-tab"
        data-account-id={info.sessionId}
        aria-hidden="true"
      />
    );
  }

  const handleAiAction = async (action: AiAction) => {
    if (!selectedMessage) return;
    if (!info.ai.enabled) {
      setError("AI actions are disabled for this mail account.");
      return;
    }
    let currentBody = body;
    if (!currentBody || currentBody.uid !== selectedMessage.uid || currentBody.folder !== selectedMessage.folder) {
      currentBody = await loadBody(selectedMessage);
    }
    if (!currentBody) return;
    if (!info.ai.skipBodyConfirm) {
      const confirmed = window.confirm("Send this email body to the configured Taomni AI provider?");
      if (!confirmed) return;
    }
    try {
      await openTabChat(tabId);
      const threadId = useChatStore.getState().activeThreadId;
      if (!threadId) throw new Error("No AI chat thread is available.");
      await sendMessageToAi(threadId, aiPrompt(action, selectedMessage, currentBody));
      setStatus("Sent mail context to AI");
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const handleDownloadAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      const targetPath = await save({
        title: "Save attachment",
        defaultPath,
      });
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        setStatus("Attachment save cancelled");
        return;
      }
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath, attachment.section);
      setStatus(`Saved attachment to ${result.path}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleOpenAttachment = async (message: MailMessageHeader, attachment: MailAttachmentInfo, index: number) => {
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const defaultPath = suggestedAttachmentName(attachment, index, message.subject);
      const targetPath = await temporaryFilePath(defaultPath);
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath, attachment.section);
      await openLocalPath(result.path);
      setStatus(`Opened attachment ${result.name || defaultPath}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleSaveAllAttachments = async (message: MailMessageHeader, attachments: MailAttachmentInfo[]) => {
    if (attachments.length === 0) return;
    setDownloadingAttachmentIndex(ALL_ATTACHMENTS_INDEX);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const targetDir = await open({
        title: "Save all attachments",
        directory: true,
        multiple: false,
      });
      if (typeof targetDir !== "string" || !targetDir.trim()) {
        setStatus("Save all attachments cancelled");
        return;
      }
      const usedNames = new Set<string>();
      let saved = 0;
      for (const [index, attachment] of attachments.entries()) {
        const fileName = uniqueAttachmentName(
          suggestedAttachmentName(attachment, index, message.subject),
          usedNames,
        );
        await mailDownloadAttachment(info, message.folder, message.uid, index, joinLocalPath(targetDir, fileName), attachment.section);
        saved += 1;
      }
      setStatus(`Saved ${saved} attachment${saved === 1 ? "" : "s"} to ${targetDir}`);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const attachmentMenuItems = (
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ): MenuItem[] => {
    const busy = downloadingAttachmentIndex !== null;
    const items: MenuItem[] = [
      {
        label: "Open with default app",
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleOpenAttachment(message, attachment, index),
      },
      {
        label: "Save attachment as...",
        icon: <Download className="w-3.5 h-3.5" />,
        disabled: busy,
        onClick: () => void handleDownloadAttachment(message, attachment, index),
      },
    ];
    if (attachments.length > 1) {
      items.push(
        { label: "", separator: true },
        {
          label: "Save all attachments...",
          icon: <Download className="w-3.5 h-3.5" />,
          disabled: busy,
          onClick: () => void handleSaveAllAttachments(message, attachments),
        },
      );
    }
    return items;
  };

  const handleAttachmentContextMenu = (
    event: ReactMouseEvent,
    message: MailMessageHeader,
    attachments: MailAttachmentInfo[],
    attachment: MailAttachmentInfo,
    index: number,
  ) => {
    attachmentMenu.show(event, attachmentMenuItems(message, attachments, attachment, index));
  };

  const copyText = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => setStatus(`Copied ${label}`))
      .catch((e) => setError(mailClientErrorMessage(e)));
  };

  const applyFlagsLocally = (folder: string, uids: number[], add: string[], remove: string[], unreadDelta: number) => {
    const uidSet = new Set(uids);
    const applies = (message: MailMessageHeader) => message.folder === folder && uidSet.has(message.uid);
    setMessages((current) => current.map((message) => (applies(message) ? withFlagsMutation(message, add, remove) : message)));
    setMessageTabs((current) => current.map((tab) => (applies(tab.message) ? { ...tab, message: withFlagsMutation(tab.message, add, remove) } : tab)));
    if (unreadDelta !== 0) {
      setFolders((current) => current.map((entry) => {
        if (entry.name !== folder || entry.unread === null || entry.unread === undefined) return entry;
        return { ...entry, unread: Math.max(0, entry.unread + unreadDelta), updatedAt: Math.floor(Date.now() / 1000) };
      }));
    }
  };

  const removeMessagesLocally = (folder: string, uids: number[], unreadRemoved: number) => {
    const removedKeys = new Set(uids.map((uid) => `${folder}:${uid}`));
    setMessages((current) => current.filter((message) => !removedKeys.has(messageKey(message))));
    setMessageTabs((current) => current.filter((tab) => !removedKeys.has(tab.key)));
    setCheckedMessageKeys((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const key of removedKeys) next.delete(key);
      return next.size === current.size ? current : next;
    });
    setMailViewKey((current) => (removedKeys.has(current) ? "mailbox" : current));
    setSelectedMessageKey((current) => (current && removedKeys.has(current) ? null : current));
    setPopupMessageKey((current) => (current && removedKeys.has(current) ? null : current));
    setFolders((current) => current.map((entry) => {
      if (entry.name !== folder) return entry;
      const nextTotal = entry.total !== null && entry.total !== undefined ? Math.max(0, entry.total - uids.length) : entry.total;
      const nextUnread = entry.unread !== null && entry.unread !== undefined ? Math.max(0, entry.unread - unreadRemoved) : entry.unread;
      return { ...entry, total: nextTotal, unread: nextUnread, updatedAt: Math.floor(Date.now() / 1000) };
    }));
  };

  const runMailAction = async (action: () => Promise<void>) => {
    setBusyAction(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setBusyAction(false);
    }
  };

  const resolveSpecialFolder = (kind: SpecialFolderKind): string | null =>
    displayFolders.find((folder) => folderMatchesSpecial(folder, kind, info.specialFolders))?.name ?? null;

  const resolveInboxFolder = (): string =>
    displayFolders.find((folder) => folder.name.toUpperCase() === "INBOX")?.name
    ?? displayFolders.find((folder) => `${folder.name} ${folderLabel(folder)}`.toLowerCase().includes("inbox"))?.name
    ?? "INBOX";

  /** AC-40: run the incoming filters on new INBOX mail (tab open only, DEC-01). */
  incomingFiltersRef.current = async () => {
    try {
      const result = await mailApplyFilters(info, resolveInboxFolder(), "incoming", {
        trashFolder: resolveSpecialFolder("trash"),
      });
      if (result.errors.length > 0) {
        setFilterErrors(result.errors);
        setError(`Mail filter actions failed: ${result.errors.join("; ")}`);
      }
      if (result.matched > 0) {
        setStatus(`Filters handled ${result.matched} new message${result.matched === 1 ? "" : "s"}`);
        await reloadVisibleFromCache(selectedFolderRef.current);
        void loadCachedFolders();
      }
    } catch (e) {
      console.debug("incoming mail filters failed", e);
    }
  };

  /** AC-41: run filters by hand on the selected folder. */
  const runFiltersOnFolder = async (filterIds: string[] | undefined) => {
    const folder = selectedFolderRef.current;
    const result = await mailApplyFilters(info, folder, "manual", {
      filterIds,
      trashFolder: resolveSpecialFolder("trash"),
    });
    await reloadVisibleFromCache(folder);
    void loadCachedFolders();
    return result;
  };

  const openContactFromMessage = (message: MailMessageHeader) => {
    const address = message.from?.address?.trim() ?? "";
    setContactDraft(emptyAddressBookEntry({
      displayName: message.from?.name?.trim() || "",
      emails: [address],
    }));
    setAddressBookOpen(true);
  };

  const openFilterFromMessage = (message: MailMessageHeader) => {
    setFilterDraft(filterFromMessage(message));
    setFiltersOpen(true);
  };

  const handleToggleFlagged = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const allFlagged = unique.every(isFlagged);
    const add = allFlagged ? [] : ["\\Flagged"];
    const remove = allFlagged ? ["\\Flagged"] : [];
    for (const [folder, group] of groupMessagesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, add, remove);
      applyFlagsLocally(folder, uids, add, remove, 0);
    }
    setStatus(allFlagged ? "Removed star" : `Starred ${unique.length} message${unique.length === 1 ? "" : "s"}`);
  });

  const handleToggleKeyword = (targets: MailMessageHeader[], keyword: string, label: string) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const plan = toggleKeywordPlan(unique, keyword);
    for (const [folder, group] of groupMessagesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, plan.add, plan.remove);
      applyFlagsLocally(folder, uids, plan.add, plan.remove, 0);
    }
    setStatus(plan.enable ? `Tagged ${unique.length} as ${label}` : `Removed tag ${label}`);
  });

  const handleClearTags = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets).filter((message) => messageTags(message).length > 0);
    const remove = MAIL_TAGS.map((tag) => tag.keyword);
    for (const [folder, group] of groupMessagesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, [], remove);
      applyFlagsLocally(folder, uids, [], remove, 0);
    }
    setStatus("Removed tags");
  });

  /** Train the server's junk filter via $Junk/$NotJunk; unsupported keywords are not fatal. */
  const setJunkKeywords = async (targets: MailMessageHeader[], junk: boolean) => {
    const add = [junk ? JUNK_KEYWORD : NOT_JUNK_KEYWORD];
    const remove = [junk ? NOT_JUNK_KEYWORD : JUNK_KEYWORD];
    for (const [folder, group] of groupMessagesByFolder(dedupeMessages(targets))) {
      const uids = group.map((message) => message.uid);
      try {
        await mailSetFlags(info, folder, uids, add, remove);
        applyFlagsLocally(folder, uids, add, remove, 0);
      } catch (e) {
        console.debug("mail: junk keyword not accepted by the server", e);
      }
    }
  };

  const handleMarkUnread = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets).filter((message) => !isUnread(message));
    if (unique.length === 0) {
      setStatus("Selected messages are already unread");
      return;
    }
    for (const [folder, group] of groupMessagesByFolder(unique)) {
      const uids = group.map((message) => message.uid);
      await mailSetFlags(info, folder, uids, [], ["\\Seen"]);
      applyFlagsLocally(folder, uids, [], ["\\Seen"], group.length);
    }
    setStatus(`Marked ${unique.length} message${unique.length === 1 ? "" : "s"} as unread`);
  });

  const moveTargetsTo = async (targets: MailMessageHeader[], target: string): Promise<number> => {
    let moved = 0;
    for (const [folder, group] of groupMessagesByFolder(dedupeMessages(targets))) {
      if (folder === target) continue;
      const uids = group.map((message) => message.uid);
      await mailMoveMessages(info, folder, uids, target);
      removeMessagesLocally(folder, uids, group.filter(isUnread).length);
      moved += uids.length;
    }
    return moved;
  };

  const handleMoveMessages = (targets: MailMessageHeader[], target: string) => runMailAction(async () => {
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to ${target}` : "Nothing to move");
  });

  const handleCopyMessages = (targets: MailMessageHeader[], target: string) => runMailAction(async () => {
    let copied = 0;
    for (const [folder, group] of groupMessagesByFolder(dedupeMessages(targets))) {
      const uids = group.map((message) => message.uid);
      await mailCopyMessages(info, folder, uids, target);
      copied += uids.length;
    }
    setStatus(copied > 0 ? `Copied ${copied} message${copied === 1 ? "" : "s"} to ${target}` : "Nothing to copy");
  });

  const handleArchiveMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveSpecialFolder("archive");
    if (!target) {
      setError("No Archive folder found for this account.");
      return;
    }
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Archived ${moved} message${moved === 1 ? "" : "s"}` : "Already archived");
  });

  const handleJunkMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveSpecialFolder("junk");
    if (!target) {
      setError("No Junk folder found for this account.");
      return;
    }
    await setJunkKeywords(targets, true);
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to Junk` : "Already in Junk");
  });

  const handleNotJunkMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveInboxFolder();
    await setJunkKeywords(targets, false);
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to Inbox` : "Already in Inbox");
  });

  const handleDeleteMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const unique = dedupeMessages(targets);
    if (unique.length === 0) return;
    const trash = resolveSpecialFolder("trash");
    const allInTrash = trash !== null && unique.every((message) => message.folder === trash);
    if (!trash || allInTrash) {
      const confirmed = await confirmDialog.confirm({
        title: "Delete permanently",
        message: `Permanently delete ${unique.length} message${unique.length === 1 ? "" : "s"}? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      for (const [folder, group] of groupMessagesByFolder(unique)) {
        const uids = group.map((message) => message.uid);
        await mailDeleteMessages(info, folder, uids, false);
        removeMessagesLocally(folder, uids, group.filter(isUnread).length);
      }
      setStatus(`Deleted ${unique.length} message${unique.length === 1 ? "" : "s"}`);
      return;
    }
    const moved = await moveTargetsTo(unique, trash);
    setStatus(`Moved ${moved} message${moved === 1 ? "" : "s"} to Trash`);
  });

  const buildForwardBody = (
    target: MailMessageHeader,
    signature: string | null | undefined = info.signature,
  ): { htmlBody: string; textBody: string } => {
    const currentBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const headerLines = [
      `From: ${addressLabel(target.from) || "(unknown sender)"}`,
      target.dateTs ? `Date: ${formatFullDate(target.dateTs)}` : "",
      `Subject: ${target.subject || "(no subject)"}`,
      `To: ${target.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}`,
    ].filter(Boolean);
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildForwardHtml(headerLines, { html: currentBody.html, text: originalText }, signature),
      textBody: `\n\n${signature?.trim() ? `-- \n${signature.trimEnd()}\n\n` : ""}---------- Forwarded message ----------\n${headerLines.join("\n")}\n\n${originalText}`,
    };
  };

  const openForward = (target = selectedMessage) => {
    if (!target) return;
    const identity = pickReplyIdentity(identities, target);
    const forwardBody = buildForwardBody(target, identity.signature);
    openCompose({
      identityId: identity.id,
      subject: forwardSubject(target.subject),
      htmlBody: forwardBody.htmlBody,
      textBody: forwardBody.textBody,
      replyContext: replyContextFor("forward", target),
      richFormatUsed: true,
    }, false);
  };

  const handlePrintMessage = (message = selectedMessage) => {
    if (!message) return;
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const headerHtml = `
      <div class="taomni-print-header" style="font-family:system-ui,sans-serif;padding:0 0 12px;margin:0 0 12px;border-bottom:1px solid #ccc;color:#111">
        <h2 style="margin:0 0 8px">${escapeHtml(message.subject || "(no subject)")}</h2>
        <div style="font-size:12px;color:#555;margin-bottom:4px">From: ${escapeHtml(addressLabel(message.from) || "(unknown)")}</div>
        <div style="font-size:12px;color:#555;margin-bottom:4px">To: ${escapeHtml(message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)")}</div>
        <div style="font-size:12px;color:#555">Date: ${escapeHtml(formatFullDate(message.dateTs) || "(unknown)")}</div>
      </div>`;
    const printHtml = currentBody?.html
      ? buildMailReaderSrcDoc(currentBody.html, {
        allowRemoteImages: true,
        fontSize: mailFontSize,
        preferDark: false,
      }).replace(
        /<body([^>]*)>/i,
        (_full, attrs: string) => `<body${attrs}>${headerHtml}`,
      )
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(message.subject || "Message")}</title>
<style>
.mail-quote{border-left:2px solid #729fcf;padding-left:.55em;margin:.1em 0}
.mail-quote-1{color:#1d4ed8}.mail-quote-2{color:#047857}.mail-quote-3{color:#6d28d9}
.mail-line{white-space:pre-wrap;min-height:1.35em}
</style>
</head><body style="font-family:system-ui,sans-serif;padding:24px;color:#111">${headerHtml}${formatMailPlainTextHtml(currentBody?.text ?? message.snippet ?? "")}</body></html>`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      setError("Unable to prepare the message for printing.");
      return;
    }
    doc.open();
    doc.write(printHtml);
    doc.close();
    const cleanup = () => {
      window.setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 500);
    };
    window.setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (e) {
        setError(mailClientErrorMessage(e));
      } finally {
        cleanup();
      }
    }, 150);
  };

  const handleViewSource = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const raw = await mailFetchRaw(info, message.folder, message.uid);
    setSourceView({ subject: message.subject || "(no subject)", content: raw });
  });

  const handleSaveEml = (message = selectedMessage) => runMailAction(async () => {
    if (!message) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = suggestedAttachmentName({ name: `${message.subject || "message"}.eml` }, 0, message.subject);
    const defaultPath = base.toLowerCase().endsWith(".eml") ? base : `${base}.eml`;
    const targetPath = await save({ title: "Save message as .eml", defaultPath });
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      setStatus("Save cancelled");
      return;
    }
    const result = await mailSaveRaw(info, message.folder, message.uid, targetPath);
    setStatus(`Saved message to ${result.path}`);
  });

  const handleSearchInFolder = (folder: MailFolder) => {
    handleFolderSelect(folder);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleCreateFolder = (parent?: MailFolder) => runMailAction(async () => {
    const name = await textInputDialog.promptText({
      title: parent ? `New subfolder in ${folderLabel(parent)}` : "New folder",
      label: "Folder name",
      placeholder: "Folder name",
    });
    if (!name || !name.trim()) return;
    const delimiter = parent?.delimiter || "/";
    const fullName = parent ? `${parent.name}${delimiter}${name.trim()}` : name.trim();
    await mailCreateFolder(info, fullName);
    await loadCachedFolders();
    setStatus(`Created folder ${name.trim()}`);
  });

  const handleRenameFolder = (folder: MailFolder) => runMailAction(async () => {
    const label = folderLabel(folder);
    const next = await textInputDialog.promptText({
      title: `Rename ${label}`,
      label: "New folder name",
      initialValue: label,
    });
    const trimmed = next?.trim();
    if (!trimmed || trimmed === label) return;
    const delimiter = folder.delimiter || "/";
    const idx = folder.name.lastIndexOf(delimiter);
    const parentPath = idx >= 0 ? folder.name.slice(0, idx + delimiter.length) : "";
    const target = `${parentPath}${trimmed}`;
    await mailRenameFolder(info, folder.name, target);
    if (selectedFolder === folder.name) updateSelectedFolder(target);
    await loadCachedFolders();
    setStatus(`Renamed folder to ${trimmed}`);
  });

  const handleDeleteFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Delete folder",
      message: `Delete folder "${folderLabel(folder)}" and its cached messages? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    await mailDeleteFolder(info, folder.name);
    if (selectedFolder === folder.name) {
      setSelectedMessageKey(null);
      setBody(null);
    }
    await loadCachedFolders();
    setStatus(`Deleted folder ${folderLabel(folder)}`);
  });

  const handleEmptyFolder = (folder: MailFolder) => runMailAction(async () => {
    const confirmed = await confirmDialog.confirm({
      title: "Empty folder",
      message: `Permanently delete all messages in "${folderLabel(folder)}"? This cannot be undone.`,
      confirmLabel: "Empty",
      danger: true,
    });
    if (!confirmed) return;
    const result = await mailDeleteMessages(info, folder.name, [], true);
    if (selectedFolder === folder.name) {
      setMessages([]);
      setSelectedMessageKey(null);
      setBody(null);
      setCheckedMessageKeys(new Set());
    }
    setFolders((current) => current.map((entry) => (
      entry.name === folder.name
        ? { ...entry, total: 0, unread: 0, updatedAt: Math.floor(Date.now() / 1000) }
        : entry
    )));
    setStatus(`Emptied ${result.deleted} message${result.deleted === 1 ? "" : "s"} from ${folderLabel(folder)}`);
  });

  /** A pending read receipt request of `message` (not yet answered, not mine). */
  const receiptRequest = (message: MailMessageHeader | null | undefined): string | null => {
    if (!message?.receiptTo) return null;
    if (message.flags.some((flag) => flag.toLowerCase() === MAIL_MDN_SENT.toLowerCase())) return null;
    const own = [info.emailAddress, ...(info.identities ?? []).map((identity) => identity.email)]
      .map((address) => address?.trim().toLowerCase())
      .filter(Boolean);
    if (own.includes(message.from?.address?.trim().toLowerCase() ?? "")) return null;
    if (resolveSpecialFolder("sent") === message.folder) return null;
    return message.receiptTo;
  };

  const answerReceipt = async (message: MailMessageHeader, send: boolean, automatic = false) => {
    setReceiptBusy(true);
    try {
      if (send) {
        const result = await mailSendReceipt(info, message.folder, message.uid, automatic);
        setStatus(`Read receipt sent to ${result.sentTo}`);
      } else {
        await mailSetFlags(info, message.folder, [message.uid], [MAIL_MDN_SENT], []);
        setStatus("Read receipt declined");
      }
      applyFlagsLocally(message.folder, [message.uid], [MAIL_MDN_SENT], [], 0);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setReceiptBusy(false);
    }
  };

  const renderReceiptBanner = (message: MailMessageHeader) => {
    const address = receiptRequest(message);
    if (!address || (info.receiptPolicy ?? "ask") !== "ask") return null;
    return (
      <div
        className="mx-4 mt-3 px-3 py-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] flex flex-wrap items-center gap-2 text-[12px]"
        data-testid="mail-receipt-banner"
      >
        <span className="min-w-0 flex-1">The sender asked for a read receipt to {address}.</span>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-send" disabled={receiptBusy} onClick={() => void answerReceipt(message, true)}>
          Send receipt
        </button>
        <button type="button" className="taomni-btn h-6 px-2 text-[11px]" data-testid="mail-receipt-ignore" disabled={receiptBusy} onClick={() => void answerReceipt(message, false)}>
          Ignore
        </button>
      </div>
    );
  };

  /** In-app composer for `mailto:` links (reader links, List-Unsubscribe). */
  const openComposeFromMailto = (href: string) => {
    const fields = parseMailto(href);
    if (!fields) return;
    const body = fields.body.trim();
    openCompose({
      to: parseRecipientsText(fields.to.join(", ")),
      cc: parseRecipientsText(fields.cc.join(", ")),
      bcc: parseRecipientsText(fields.bcc.join(", ")),
      subject: fields.subject,
      ...(body ? { textBody: fields.body, htmlBody: plainTextToMailHtml(fields.body) } : {}),
    }, !body);
  };

  const handleUnsubscribe = async (message: MailMessageHeader) => {
    const list = message.listUnsubscribe;
    if (!list) return;
    const key = messageKey(message);
    const https = list.uris.find((uri) => /^https:/i.test(uri));
    const mailto = list.uris.find((uri) => /^mailto:/i.test(uri));
    if (list.oneClick && https) {
      // RFC 8058: confirm first, then POST without opening a browser.
      if (unsubscribeArmed !== key) {
        setUnsubscribeArmed(key);
        return;
      }
      setUnsubscribeArmed(null);
      try {
        await mailUnsubscribeOneClick(https);
        setStatus("Unsubscribe request sent");
      } catch (e) {
        setError(mailClientErrorMessage(e));
      }
      return;
    }
    if (mailto) {
      openComposeFromMailto(mailto);
      return;
    }
    const web = list.uris.find((uri) => /^https?:/i.test(uri));
    if (web) void openExternalUrl(web);
  };

  const renderUnsubscribe = (message: MailMessageHeader) => {
    if (!message.listUnsubscribe || message.listUnsubscribe.uris.length === 0) return null;
    const armed = unsubscribeArmed === messageKey(message);
    return (
      <button
        type="button"
        className="taomni-btn h-5 px-2 text-[10px]"
        data-testid="mail-unsubscribe"
        data-armed={armed ? "true" : undefined}
        title={message.listUnsubscribe.uris.join("\n")}
        onClick={() => void handleUnsubscribe(message)}
      >
        {armed ? "Confirm unsubscribe" : "Unsubscribe"}
      </button>
    );
  };

  /** DEC-14: put the invitation (with my reply) into the CalDAV calendar. */
  const addInviteToCalendar = async (message: MailMessageHeader, partstat?: string) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, calendar: "adding", calendarError: undefined } : current));
    try {
      const written = await mailAddInviteToCalendar(info, message.folder, message.uid, partstat);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: "added" } : current));
      setAgendaRevision((value) => value + 1);
      setStatus(written.created ? "Added to your calendar" : "Updated in your calendar");
    } catch (e) {
      const calendarError = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, calendar: undefined, calendarError } : current));
    }
  };

  /** AC-62: Accept / Tentative / Decline sends an iTIP REPLY to the organizer. */
  const handleRespondInvite = async (message: MailMessageHeader, response: MailInviteReply) => {
    const key = messageKey(message);
    setInviteView((current) => (current?.key === key ? { ...current, responding: response, error: undefined } : current));
    try {
      const result = await mailRespondInvite(info, message.folder, message.uid, response);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, responded: result.partstat } : current));
      setStatus(`Invitation reply (${result.partstat.toLowerCase()}) sent to ${result.sentTo}`);
      if (info.caldav && response !== "decline") await addInviteToCalendar(message, result.partstat);
    } catch (e) {
      const error = mailClientErrorMessage(e);
      setInviteView((current) => (current?.key === key ? { ...current, responding: undefined, error } : current));
    }
  };

  const renderInviteCard = (message: MailMessageHeader) => {
    const view = inviteView;
    if (!view || view.key !== messageKey(message)) return null;
    if (view.loading) {
      return (
        <div className="mx-4 mt-3 flex items-center gap-2 text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-invite-loading">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading calendar invitation…
        </div>
      );
    }
    const invite = view.invite;
    if (!invite) {
      return view.error ? (
        <div className="mx-4 mt-3 text-[12px] text-red-500" data-testid="mail-invite-error">{view.error}</div>
      ) : null;
    }
    const cancelled = invite.method === "CANCEL" || invite.status === "CANCELLED";
    const canRespond = invite.method === "REQUEST" && !cancelled && !!invite.organizer;
    const current = view.responded ?? myPartstat(invite, info.emailAddress);
    const calendarIndex = visibleAttachments.findIndex((attachment) => hasCalendarPart([attachment]));
    const replies: Array<{ response: MailInviteReply; label: string; partstat: string }> = [
      { response: "accept", label: "Accept", partstat: "ACCEPTED" },
      { response: "tentative", label: "Tentative", partstat: "TENTATIVE" },
      { response: "decline", label: "Decline", partstat: "DECLINED" },
    ];
    return (
      <div
        className="mx-4 mt-3 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-3 text-[12px]"
        data-testid="mail-invite-card"
        data-method={invite.method}
        data-partstat={current ?? undefined}
      >
        <div className="flex items-start gap-2">
          <CalendarDays className="w-4 h-4 mt-0.5 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold break-words" data-testid="mail-invite-summary">
              {cancelled ? "Cancelled: " : invite.method === "REPLY" ? "Reply: " : ""}{invite.summary || "(untitled event)"}
            </div>
            <div className="mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5">
              <span className="text-[var(--taomni-text-muted)]">When</span>
              <span data-testid="mail-invite-when">{formatInviteRange(invite) || "(not specified)"}</span>
              {invite.location && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Where</span>
                  <span className="break-words">{invite.location}</span>
                </>
              )}
              {invite.organizer && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Organizer</span>
                  <span className="truncate">{invite.organizer.name ? `${invite.organizer.name} <${invite.organizer.email}>` : invite.organizer.email}</span>
                </>
              )}
              {invite.attendees.length > 0 && (
                <>
                  <span className="text-[var(--taomni-text-muted)]">Attendees</span>
                  <span className="break-words">
                    {invite.attendees.map((attendee) => `${attendee.name || attendee.email} (${attendee.partstat.toLowerCase()})`).join(", ")}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canRespond && replies.map((reply) => (
            <button
              key={reply.response}
              type="button"
              className={`taomni-btn h-6 px-2 text-[11px] ${current === reply.partstat ? "text-[var(--taomni-accent)] border-[var(--taomni-accent)]" : ""}`}
              data-testid={`mail-invite-${reply.response}`}
              aria-pressed={current === reply.partstat}
              disabled={!!view.responding}
              onClick={() => void handleRespondInvite(message, reply.response)}
            >
              {view.responding === reply.response ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {reply.label}
            </button>
          ))}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-export"
              title="Save the event as an .ics file"
              onClick={() => void handleDownloadAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <Download className="w-3 h-3" /> Export .ics
            </button>
          )}
          {calendarIndex >= 0 && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              data-testid="mail-invite-open"
              title="Open in the system calendar app"
              onClick={() => void handleOpenAttachment(message, visibleAttachments[calendarIndex], calendarIndex)}
            >
              <ExternalLink className="w-3 h-3" /> Open in calendar
            </button>
          )}
          {info.caldav && invite.method === "REQUEST" && !cancelled && view.calendar !== "added" && (
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              data-testid="mail-invite-add-calendar"
              disabled={view.calendar === "adding"}
              onClick={() => void addInviteToCalendar(message, view.responded)}
            >
              {view.calendar === "adding" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarDays className="w-3 h-3" />} Add to calendar
            </button>
          )}
          {view.responded && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-responded">
              Reply sent ({view.responded.toLowerCase()})
            </span>
          )}
          {view.calendar === "added" && (
            <span className="text-[var(--taomni-text-muted)]" data-testid="mail-invite-in-calendar">In your calendar</span>
          )}
        </div>
        {view.error && <div className="mt-1 text-red-500" data-testid="mail-invite-error">{view.error}</div>}
        {view.calendarError && <div className="mt-1 text-red-500" data-testid="mail-invite-calendar-error">{view.calendarError}</div>}
      </div>
    );
  };

  const handleExportMbox = (folder: MailFolder) => runMailAction(async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const safe = folderLabel(folder).replace(/[\\/:*?"<>|]+/g, "_") || "folder";
    const targetPath = await save({ title: `Export ${folderLabel(folder)} as mbox`, defaultPath: `${safe}.mbox` });
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      setStatus("Export cancelled");
      return;
    }
    setStatus(`Exporting ${folderLabel(folder)}…`);
    const result = await mailExportMbox(info, folder.name, targetPath);
    setStatus(`Exported ${result.count} message${result.count === 1 ? "" : "s"} to ${result.path}`);
  });

  const handleImportMessages = (folder: MailFolder) => runMailAction(async () => {
    const paths = await selectUploadFile();
    if (!paths.length) {
      setStatus("Import cancelled");
      return;
    }
    let imported = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const path of paths) {
      const result = await mailImportMessages(info, folder.name, path);
      imported += result.imported;
      failed += result.failed;
      firstError = firstError ?? result.firstError ?? null;
    }
    setStatus(`Imported ${imported} message${imported === 1 ? "" : "s"} into ${folderLabel(folder)}${failed ? `; ${failed} failed` : ""}`);
    if (firstError) setError(`Import failed for some messages: ${firstError}`);
    // Pull the appended mail into the cache and list.
    await runFolderSync(folder.name, { maxSteps: 20 }).catch(() => undefined);
    await reloadVisibleFromCache(folder.name);
  });

  /** AC-44: show the server certificate so the user can add an exception. */
  const openCertReview = async (protocol: "imap" | "smtp") => {
    setCertReview({ protocol, loading: true });
    try {
      const cert = await mailProbeCertificate(info, protocol);
      setCertReview({ protocol, loading: false, info: cert });
    } catch (e) {
      setCertReview({ protocol, loading: false, error: mailClientErrorMessage(e) });
    }
  };

  const trustReviewedCertificate = async () => {
    const review = certReview;
    if (!review?.info) return;
    const der = review.info.derBase64;
    const key = review.protocol === "smtp" ? "mailSmtpTrustedCert" : "mailImapTrustedCert";
    // Persist on the saved session (quick-connect tabs keep it in memory).
    const store = useSessionStore.getState();
    const session = store.sessions.find((entry) => entry.id === info.sessionId);
    if (session) {
      let options: Record<string, unknown> = {};
      try {
        options = JSON.parse(session.options_json || "{}") as Record<string, unknown>;
      } catch {
        options = {};
      }
      options[key] = der;
      try {
        await store.updateSession({ ...session, options_json: JSON.stringify(options) });
      } catch (e) {
        setError(mailClientErrorMessage(e));
        return;
      }
    }
    useAppStore.setState((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId || !tab.mail) return tab;
        const mail = review.protocol === "smtp"
          ? { ...tab.mail, smtp: { ...tab.mail.smtp, trustedCert: der } }
          : { ...tab.mail, imap: { ...tab.mail.imap, trustedCert: der } };
        return { ...tab, mail };
      }),
    }));
    setCertReview(null);
    setError(null);
    setStatus(session
      ? "Certificate trusted for this account; reconnecting…"
      : "Certificate trusted until this tab closes (save the account to keep it); reconnecting…");
    retryAfterTrustRef.current = true;
  };

  const openExternalUrl = async (url: string) => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const folderTargetChildren = (
    targets: MailMessageHeader[],
    action: (targets: MailMessageHeader[], target: string) => void,
  ): MenuItem[] => {
    const sources = new Set(targets.map((message) => message.folder));
    const options = displayFolders.filter(
      (folder) => !(sources.size === 1 && sources.has(folder.name)),
    );
    if (options.length === 0) return [{ label: "No other folders", disabled: true }];
    return options.map((folder) => ({
      label: folderLabel(folder),
      icon: folderIcon(folder),
      onClick: () => action(targets, folder.name),
    }));
  };

  const messageMenuItems = (message: MailMessageHeader): MenuItem[] => {
    const targets = checkedMessageKeys.has(messageKey(message)) && checkedMessages.length > 0
      ? checkedMessages
      : [message];
    const count = dedupeMessages(targets).length;
    const suffix = count > 1 ? ` (${count})` : "";
    const many = count > 1;
    const allFlagged = targets.every(isFlagged);
    const anyUnread = targets.some(isUnread);
    const allUnread = targets.every(isUnread);
    return [
      { label: "Open", icon: <MailOpen className="w-3.5 h-3.5" />, onClick: () => selectMessage(message, "mailbox") },
      { label: "Open in mail tab", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => openMessageTab(message) },
      { label: "Open in popup window", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => openMessagePopup(message) },
      { label: "", separator: true },
      { label: "Reply", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => openReply(message) },
      { label: "Reply all", icon: <MessageSquareReply className="w-3.5 h-3.5" />, onClick: () => openReplyAll(message) },
      { label: "Forward", icon: <Forward className="w-3.5 h-3.5" />, onClick: () => openForward(message) },
      { label: "", separator: true },
      {
        label: `Mark as read${suffix}`,
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        disabled: !anyUnread || markingRead || busyAction,
        onClick: () => void (many ? handleMarkSelectedRead() : handleMarkSingleRead(message)),
      },
      {
        label: `Mark as unread${suffix}`,
        icon: <MailIcon className="w-3.5 h-3.5" />,
        disabled: allUnread || busyAction,
        onClick: () => void handleMarkUnread(targets),
      },
      {
        label: allFlagged ? `Remove star${suffix}` : `Add star${suffix}`,
        icon: <Star className="w-3.5 h-3.5" />,
        disabled: busyAction,
        onClick: () => void handleToggleFlagged(targets),
      },
      {
        label: `Tag${suffix}`,
        icon: <Tag className="w-3.5 h-3.5" />,
        testId: "mail-menu-tag",
        openOnClick: true,
        children: [
          ...MAIL_TAGS.map((tag) => ({
            label: tag.label,
            testId: `mail-menu-tag-${tag.keyword.replace("$", "")}`,
            checked: targets.every((target) => messageTags(target).some((entry) => entry.keyword === tag.keyword)),
            icon: <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: tag.color }} />,
            disabled: busyAction,
            onClick: () => void handleToggleKeyword(targets, tag.keyword, tag.label),
          })),
          { label: "", separator: true },
          { label: "Remove all tags", disabled: busyAction, onClick: () => void handleClearTags(targets) },
        ],
      },
      { label: "Mark folder read", icon: <MailOpen className="w-3.5 h-3.5" />, disabled: markingRead, onClick: () => void handleMarkFolderRead(message.folder) },
      { label: "", separator: true },
      { label: `Archive${suffix}`, icon: <Archive className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleArchiveMessages(targets) },
      { label: `Move to${suffix}`, icon: <FolderInput className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleMoveMessages(t, folder)) },
      { label: `Copy to${suffix}`, icon: <FolderSymlink className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleCopyMessages(t, folder)) },
      { label: `Mark as junk${suffix}`, icon: <Ban className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleJunkMessages(targets) },
      { label: `Not junk${suffix}`, icon: <Inbox className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleNotJunkMessages(targets) },
      { label: `Delete${suffix}`, icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, disabled: busyAction, onClick: () => void handleDeleteMessages(targets) },
      { label: "", separator: true },
      { label: "Create filter from message…", icon: <FilterIcon className="w-3.5 h-3.5" />, testId: "mail-menu-create-filter", onClick: () => openFilterFromMessage(message) },
      { label: "Add sender to address book…", icon: <BookUser className="w-3.5 h-3.5" />, testId: "mail-menu-add-contact", disabled: !message.from?.address, onClick: () => openContactFromMessage(message) },
      { label: "Save as .eml", icon: <Save className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleSaveEml(message) },
      { label: "View source", icon: <Code className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleViewSource(message) },
      { label: "Print", icon: <Printer className="w-3.5 h-3.5" />, onClick: () => handlePrintMessage(message) },
      { label: "", separator: true },
      { label: "Copy subject", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => copyText("subject", message.subject || "(no subject)") },
      { label: "Copy sender", icon: <MailIcon className="w-3.5 h-3.5" />, onClick: () => copyText("sender", addressLabel(message.from)) },
      { label: "Copy recipients", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("recipients", message.to.map(addressLabel).filter(Boolean).join(", ")) },
    ];
  };


  shortcutRef.current = (action: MailShortcutAction): boolean => {
    // Dialogs and the composer own the keyboard.
    if (composeOpen || draftsOpen || subscriptionsOpen) return false;
    const rows = listRows.map((row) => row.message);
    const current = selectedMessage;
    const index = current ? rows.findIndex((message) => messageKey(message) === messageKey(current)) : -1;
    const go = (message: MailMessageHeader | undefined) => {
      if (!message) return false;
      selectMessage(message, "mailbox");
      document.querySelector<HTMLElement>(
        `[data-testid="mail-message-row"][data-uid="${message.uid}"]`,
      )?.scrollIntoView?.({ block: "nearest" });
      return true;
    };
    switch (action) {
      case "next":
        return go(index < 0 ? rows[0] : rows[index + 1]);
      case "prev":
        return go(index < 0 ? rows[0] : rows[index - 1]);
      case "nextUnread":
        return go(rows.slice(index + 1).find(isUnread) ?? rows.slice(0, Math.max(index, 0)).find(isUnread));
      case "focusSearch":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return true;
      default:
        break;
    }
    const targets = checkedMessages.length > 0 ? checkedMessages : current ? [current] : [];
    if (targets.length === 0 || busyAction) return false;
    switch (action) {
      case "reply":
        openReply(targets[0]);
        return true;
      case "replyAll":
        openReplyAll(targets[0]);
        return true;
      case "forward":
        openForward(targets[0]);
        return true;
      case "toggleRead":
        if (targets.some(isUnread)) {
          void (checkedMessages.length > 0 ? handleMarkSelectedRead() : handleMarkSingleRead(targets[0]));
        } else {
          void handleMarkUnread(targets);
        }
        return true;
      case "star":
        void handleToggleFlagged(targets);
        return true;
      case "archive":
        void handleArchiveMessages(targets);
        return true;
      case "junk":
        void handleJunkMessages(targets);
        return true;
      case "notJunk":
        void handleNotJunkMessages(targets);
        return true;
      case "delete":
        void handleDeleteMessages(targets);
        return true;
      default:
        return false;
    }
  };

  const dragTargetsFor = (message: MailMessageHeader): MailMessageHeader[] =>
    checkedMessageKeys.has(messageKey(message)) && checkedMessages.length > 0 ? checkedMessages : [message];

  const folderMenuItems = (folder: MailFolder): MenuItem[] => {
    const isTrashLike = folderMatchesSpecial(folder, "trash", info.specialFolders)
      || folderMatchesSpecial(folder, "junk", info.specialFolders);
    return [
      { label: "Open folder", icon: folderIcon(folder), onClick: () => handleFolderSelect(folder) },
      { label: "Search in this folder", icon: <Search className="w-3.5 h-3.5" />, onClick: () => handleSearchInFolder(folder) },
      {
        label: "Sync all folders",
        icon: <RefreshCw className="w-3.5 h-3.5" />,
        disabled: syncing,
        onClick: () => void syncAllFolders(false, { limit: batchSize, includeBodies: false, indicator: "sync" }),
      },
      {
        label: "Mark folder read",
        icon: <MailOpen className="w-3.5 h-3.5" />,
        disabled: markingRead || (folder.unread ?? 0) === 0,
        onClick: () => void handleMarkFolderRead(folder.name),
      },
      { label: "", separator: true },
      { label: "New subfolder…", icon: <FolderPlus className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleCreateFolder(folder) },
      { label: "Rename folder…", icon: <PenLine className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleRenameFolder(folder) },
      { label: "Export as mbox…", icon: <Download className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleExportMbox(folder) },
      { label: "Import messages (mbox/.eml)…", icon: <FolderInput className="w-3.5 h-3.5" />, disabled: busyAction || !isSelectable(folder), onClick: () => void handleImportMessages(folder) },
      {
        label: isTrashLike ? "Empty folder" : "Delete folder",
        icon: isTrashLike ? <Trash2 className="w-3.5 h-3.5" /> : <FolderX className="w-3.5 h-3.5" />,
        danger: true,
        disabled: busyAction,
        onClick: () => void (isTrashLike ? handleEmptyFolder(folder) : handleDeleteFolder(folder)),
      },
      { label: "", separator: true },
      { label: "Copy folder name", icon: <Folder className="w-3.5 h-3.5" />, onClick: () => copyText("folder name", folder.name) },
    ];
  };

  const messageListMenuItems = (): MenuItem[] => [
    {
      label: "Sync all folders",
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      disabled: syncing,
      onClick: () => void syncAllFolders(false, {
        limit: batchSize,
        includeBodies: false,
        indicator: "sync",
      }),
    },
    {
      label: "Mark folder read",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      disabled: markingRead || Math.max(activeFolder?.unread ?? 0, visibleUnreadCount) === 0,
      onClick: () => void handleMarkFolderRead(),
    },
    {
      label: allFilteredMessagesChecked ? "Clear visible selection" : "Select visible messages",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      disabled: filteredMessages.length === 0,
      onClick: () => toggleFilteredMessagesChecked(!allFilteredMessagesChecked),
    },
  ];

  const showReaderMenu = (event: ReactMouseEvent, message: MailMessageHeader | null) => {
    const targetEl = event.target as HTMLElement | null;
    const anchor = targetEl?.closest("a") as HTMLAnchorElement | null;
    const image = (targetEl?.tagName === "IMG" ? targetEl : targetEl?.closest("img")) as HTMLImageElement | null;
    const selection = typeof window !== "undefined" ? (window.getSelection()?.toString().trim() ?? "") : "";
    const currentBody = bodyMatchesMessage(body, message) ? body : null;
    const items: MenuItem[] = [];
    if (selection) {
      items.push({ label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("selection", selection) });
    }
    if (anchor?.href) {
      const href = anchor.href;
      items.push({ label: "Copy link address", icon: <LinkIcon className="w-3.5 h-3.5" />, onClick: () => copyText("link", href) });
      items.push({ label: "Open link in browser", icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => void openExternalUrl(href) });
    }
    if (image) {
      const src = image.getAttribute("src") || image.src;
      if (src) items.push({ label: "Copy image address", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("image address", src) });
    }
    if (currentBody?.html && message) {
      const key = messageKey(message);
      items.push({
        label: messageAllowsRemote(key) ? "Block remote images" : "Load remote images",
        icon: <ImageOff className="w-3.5 h-3.5" />,
        onClick: () => toggleRemoteForMessage(key),
      });
    }
    if (items.length > 0) items.push({ label: "", separator: true });
    items.push(...(message ? messageMenuItems(message) : messageListMenuItems()));
    mailMenu.show(event, items);
  };

  const activeFolder = displayFolders.find((folder) => folder.name === selectedFolder) ?? displayFolders[0];
  const cacheLine = info.cache.enabled
    ? `${info.cache.headerRetentionDays > 0 ? `${info.cache.headerRetentionDays}d` : "all"} headers, ${info.cache.bodyRecentLimit} recent bodies`
    : "cache off";
  const renderReaderSurface = (message: MailMessageHeader | null, popup = false) => {
    const currentBody = message
      ? bodyCache.get(messageKey(message)) ?? (bodyMatchesMessage(body, message) ? body : null)
      : null;
    const currentKey = message ? messageKey(message) : null;
    const currentHasRemoteImages = mailHtmlHasRemoteImages(currentBody?.html);
    const currentAllowsRemote = messageAllowsRemote(currentKey);
    const currentAttachments = currentBody?.attachments.length ? currentBody.attachments : message?.attachments ?? [];
    const loadingThisBody = !!message && bodyLoadingKey === messageKey(message);

    return (
      <main
        className="h-full min-w-0 flex flex-col"
        onContextMenu={(event) => showReaderMenu(event, message)}
      >
        <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
          <span className="text-[12px] font-semibold min-w-0 truncate">
            {message?.subject || "Message"}
          </span>
          {loadingThisBody && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReply(message)}
              disabled={!message}
              title="Reply"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply
            </button>
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
              onClick={() => openReplyAll(message)}
              disabled={!message}
              title="Reply all"
            >
              <MessageSquareReply className="w-3.5 h-3.5" />
              Reply all
            </button>
            {!popup && (
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                onClick={() => message && openMessagePopup(message)}
                disabled={!message}
                title="Open message in popup window"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Popup
              </button>
            )}
          </div>
        </div>

        {!message ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
            Select a message
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="px-4 py-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <h2 className="text-[17px] font-semibold leading-6 mb-1 break-words">
                {message.subject || "(no subject)"}
              </h2>
              <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
                <span className="text-[var(--taomni-text-muted)]">From</span>
                <span className="truncate" title={addressLabel(message.from)}>{addressLabel(message.from) || "(unknown)"}</span>
                <span className="text-[var(--taomni-text-muted)]">To</span>
                <span className="truncate" title={message.to.map(addressLabel).join(", ")}>
                  {message.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}
                </span>
                {message.cc.length > 0 && (
                  <>
                    <span className="text-[var(--taomni-text-muted)]">Cc</span>
                    <span className="truncate" title={message.cc.map(addressLabel).join(", ")}>
                      {message.cc.map(addressLabel).filter(Boolean).join(", ")}
                    </span>
                  </>
                )}
                <span className="text-[var(--taomni-text-muted)]">Date</span>
                <span>{formatFullDate(message.dateTs) || "(unknown)"}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
                <span>{currentBody?.source === "cache" ? "cached body" : currentBody?.source === "remote" ? "remote body" : "header cached"}</span>
                {message.rawSize ? <span>{formatBytes(message.rawSize)}</span> : null}
                {currentHasRemoteImages && currentKey && (
                  <button
                    type="button"
                    className="taomni-btn h-5 px-2 text-[10px]"
                    data-testid="mail-remote-images-header-toggle"
                    onClick={() => toggleRemoteForMessage(currentKey)}
                  >
                    {currentAllowsRemote ? "Block remote images" : "Load remote images"}
                  </button>
                )}
                {renderUnsubscribe(message)}
              </div>
              {currentAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {currentAttachments.length > 1 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                      title="Save all attachments"
                      onClick={() => void handleSaveAllAttachments(message, currentAttachments)}
                      disabled={downloadingAttachmentIndex !== null}
                    >
                      {downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      <span>Save all</span>
                    </button>
                  )}
                  {currentAttachments.map((attachment, index) => {
                    const downloading = downloadingAttachmentIndex === index;
                    const savingAll = downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX;
                    const name = attachment.name || `attachment-${index + 1}`;
                    return (
                      <button
                        key={`${name}-${index}`}
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                        title={`Double-click to open ${name}; right-click to save`}
                        onDoubleClick={() => void handleOpenAttachment(message, attachment, index)}
                        onContextMenu={(event) => handleAttachmentContextMenu(event, message, currentAttachments, attachment, index)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          void handleOpenAttachment(message, attachment, index);
                        }}
                        disabled={downloading || savingAll}
                      >
                        {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                        <span className="max-w-[360px] truncate">{name}</span>
                        {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <RemoteImagesBanner
              visible={currentHasRemoteImages}
              allowRemoteImages={currentAllowsRemote}
              onAllowThisMessage={() => currentKey && allowRemoteForMessage(currentKey)}
              onAllowAllInTab={() => setAllowRemoteAllInTab(true)}
              onBlock={() => currentKey && blockRemoteForMessage(currentKey)}
            />

            <div className="p-3 sm:p-4">
              <MailMessageBodyView
                html={currentBody?.html}
                text={currentBody?.text}
                snippet={message.snippet}
                allowRemoteImages={currentAllowsRemote}
                preferDark={preferDarkReader}
                fontSize={mailFontSize}
                title={message.subject || "Message body"}
                loading={loadingThisBody && !currentBody}
                onMailtoLink={openComposeFromMailto}
              />
            </div>
          </div>
        )}
      </main>
    );
  };

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
      style={mailAppearance}
      data-testid="mail-client-tab"
      data-account-id={info.sessionId}
    >
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5" data-testid="mail-compose-open" onClick={() => openCompose()}>
          <MailIcon className="w-3.5 h-3.5" />
          Compose
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          data-testid="mail-drafts-open"
          onClick={() => {
            setDraftsOpen(true);
            void refreshDrafts();
          }}
          title="Open local drafts"
        >
          <FileText className="w-3.5 h-3.5" />
          Drafts
          {outboxCount > 0 && (
            <span
              className="ml-0.5 rounded px-1 text-[10px] leading-4 bg-[var(--taomni-accent)] text-white"
              data-testid="mail-outbox-count"
              data-count={outboxCount}
              title={`${outboxCount} message${outboxCount === 1 ? "" : "s"} in the Outbox`}
            >
              {outboxCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={() => void syncAllFolders(false, {
            limit: batchSize,
            includeBodies: false,
            indicator: "sync",
          })}
          disabled={syncing}
          data-testid="mail-sync-button"
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Sync
        </button>
        {idleEnabled && idleState && (
          <span
            className="h-7 px-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]"
            data-testid="mail-idle-status"
            data-state={idleState}
            data-active={idleState === "ready" || idleState === "changed" ? "true" : "false"}
            title={idleState === "ready" || idleState === "changed"
              ? "Instant push (IMAP IDLE) active"
              : "Instant push unavailable; polling"}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${idleState === "ready" || idleState === "changed"
                ? "bg-[var(--taomni-success,#22c55e)]"
                : "bg-[var(--taomni-text-muted)]"}`}
            />
            {idleState === "ready" || idleState === "changed" ? "Push" : "Poll"}
          </span>
        )}
        {syncProgress && (
          <span
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
            data-testid="mail-sync-progress"
            data-folder={syncProgress.folder}
            title={`Catching up ${syncProgress.folder}`}
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Catching up {syncProgress.fetched}
            {syncProgress.remaining > 0 ? ` / ${syncProgress.fetched + syncProgress.remaining}` : ""}
          </span>
        )}
        {backfillProgress && (
          <span
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
            data-testid="mail-backfill-progress"
            data-folder={backfillProgress.folder}
            title={`Downloading older headers of ${backfillProgress.folder}`}
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            History {backfillProgress.cached}/{backfillProgress.total}
          </span>
        )}
        {bodyWarming.active && (
          <span
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]"
            data-testid="mail-body-warming-progress"
            title={bodyWarming.folder ? `Warming ${bodyWarming.folder}` : "Warming recent message bodies"}
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            Bodies {bodyWarming.total > 0 ? `${bodyWarming.done}/${bodyWarming.total}` : "warming"}
          </span>
        )}
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={() => void handleMarkSelectedRead()}
          disabled={markingRead || checkedUnreadCount === 0}
          title="Mark selected unread messages as read"
        >
          {markingRead ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MailOpen className="w-3.5 h-3.5" />}
          Selected read
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={() => void handleMarkFolderRead()}
          disabled={markingRead || Math.max(activeFolder?.unread ?? 0, visibleUnreadCount) === 0}
          title="Mark all cached messages in this folder as read"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          All read
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={handleTest}
          disabled={testing}
          title="Test IMAP and SMTP"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          Test
        </button>
        <div className="relative w-[320px] max-w-[40vw]">
          <Search className="pointer-events-none w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            ref={searchInputRef}
            type="search"
            className="taomni-input h-7 w-full pl-7 text-[12px]"
            placeholder={searchScope === "all" ? "Search all folders" : "Search this folder"}
            aria-label="Search mail"
            data-testid="mail-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                void runServerSearch();
              }
            }}
          />
        </div>
        <select
          className="taomni-input h-7 text-[12px] w-[92px]"
          value={searchField}
          aria-label="Search field"
          data-testid="mail-search-field"
          onChange={(event) => setSearchField(event.target.value as MailSearchField)}
        >
          <option value="all">All text</option>
          <option value="subject">Subject</option>
          <option value="sender">From</option>
          <option value="recipients">To/Cc</option>
          <option value="body">Body</option>
        </select>
        <select
          className="taomni-input h-7 text-[12px] w-[96px]"
          value={searchScope}
          aria-label="Search scope"
          data-testid="mail-search-scope"
          onChange={(event) => setSearchScope(event.target.value === "all" ? "all" : "folder")}
        >
          <option value="folder">This folder</option>
          <option value="all">All folders</option>
        </select>
        {searchActive && (
          <button
            type="button"
            className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5 text-[12px]"
            data-testid="mail-search-server"
            onClick={() => void runServerSearch()}
            disabled={serverSearching}
            title="Search the current folder on the server (Shift+Enter)"
          >
            {serverSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Server
          </button>
        )}
        <div className="flex items-center gap-0.5" role="group" aria-label="Quick filter" data-testid="mail-quick-filter">
          {([
            ["unread", "Unread", MailOpen],
            ["flagged", "Starred", Star],
            ["attachments", "Attachments", Paperclip],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              className={`taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center ${quickFilters[key] ? "text-[var(--taomni-accent)]" : ""}`}
              aria-pressed={quickFilters[key]}
              aria-label={`Show only ${label.toLowerCase()}`}
              title={`Show only ${label.toLowerCase()}`}
              data-testid={`mail-quick-filter-${key}`}
              onClick={() => setQuickFilters((current) => ({ ...current, [key]: !current[key] }))}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}
          <select
            className="taomni-input h-7 text-[12px] w-[92px] ml-0.5"
            value={tagFilter}
            aria-label="Filter by tag"
            data-testid="mail-quick-filter-tag"
            onChange={(event) => setTagFilter(event.target.value)}
          >
            <option value="">Any tag</option>
            {MAIL_TAGS.map((tag) => (
              <option key={tag.keyword} value={tag.keyword}>{tag.label}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
            onClick={decreaseFontSize}
            title="Zoom out (Ctrl+-)"
            aria-label="Zoom out mail view"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
            onClick={increaseFontSize}
            title="Zoom in (Ctrl++)"
            aria-label="Zoom in mail view"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5" onClick={() => void openTabChat(tabId)}>
          <Bot className="w-3.5 h-3.5" />
          AI
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={handleClearCache}
          disabled={clearing}
          title="Clear this account cache"
        >
          {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          Cache
        </button>
        <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[240px]" title={info.emailAddress || info.imap.username || info.imap.host}>
          {info.emailAddress || info.imap.username || info.imap.host}
        </div>
      </div>

      {messageTabs.length > 0 && (
        <div className="h-8 shrink-0 flex items-end gap-1 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] overflow-x-auto">
          <button
            type="button"
            className={`h-7 max-w-[220px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${mailViewKey === "mailbox" ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
            style={{ borderColor: "var(--taomni-divider)" }}
            onClick={() => setMailViewKey("mailbox")}
          >
            <Inbox className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Mailbox</span>
          </button>
          {messageTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`h-7 max-w-[280px] px-2 rounded-t border border-b-0 inline-flex items-center gap-1.5 text-[12px] ${mailViewKey === tab.key ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]" : "bg-[var(--taomni-chrome-bg)] text-[var(--taomni-text-muted)]"}`}
              style={{ borderColor: "var(--taomni-divider)" }}
              title={tab.message.subject || "(no subject)"}
              onClick={() => selectMessage(tab.message, tab.key)}
              onContextMenu={(event) => mailMenu.show(event, messageMenuItems(tab.message))}
            >
              <MailOpen className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.message.subject || "(no subject)"}</span>
              <X
                className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                onClick={(event) => {
                  event.stopPropagation();
                  closeMessageTab(tab.key);
                }}
              />
            </button>
          ))}
        </div>
      )}

      {(error || status) && (
        <div className="h-7 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[11px] bg-[var(--taomni-sidebar-bg)]">
          {error ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
          <span
            className={error ? "text-red-500 truncate" : "text-[var(--taomni-text-muted)] truncate"}
            title={error ?? status ?? undefined}
          >
            {error ?? status}
          </span>
          {error && isMailCertificateError(error) && (
            <button
              type="button"
              className="ml-auto h-5 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
              data-testid="mail-cert-review"
              onClick={() => void openCertReview(/smtp/i.test(error) ? "smtp" : "imap")}
            >
              <ShieldCheck className="w-3 h-3" />
              Review certificate
            </button>
          )}
          {error && oauthReauthRequired && onEditSession && (
            <button
              type="button"
              className="ml-auto h-5 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)]"
              onClick={() => onEditSession(info.sessionId)}
            >
              <ShieldCheck className="w-3 h-3" />
              Reauthorize
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {mailboxCollapsed && (
          <button
            type="button"
            className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
            style={{
              background: "var(--taomni-panel-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text-muted)",
            }}
            title="Show mailbox"
            aria-label="Show mailbox"
            onClick={expandMailboxPanel}
          >
            <ChevronDown className="w-3.5 h-3.5 -rotate-90" />
            <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
              Mailbox
            </span>
          </button>
        )}
        {mailViewKey !== "mailbox" && activeMessageTab ? (
          <div className="h-full min-h-0 border-l border-[var(--taomni-divider)]">
            {renderReaderSurface(selectedMessage ?? activeMessageTab.message)}
          </div>
        ) : (
        <PanelGroup
          orientation="horizontal"
          id={`mail-client-${info.sessionId}`}
          defaultLayout={loadResizableLayout(`mail-client-${info.sessionId}`, ["folders", "messages", "reader"])}
          onLayoutChanged={saveResizableLayout(`mail-client-${info.sessionId}`)}
          className="h-full min-h-0"
        >
          <Panel
            id="folders"
            panelRef={foldersPanelRef}
            defaultSize={`${MAILBOX_EXPANDED_SIZE}%`}
            minSize="0%"
            maxSize="35%"
            collapsible
            collapsedSize={0}
            className="min-w-0"
            onResize={handleMailboxResize}
          >
            {!mailboxCollapsed && (
              <aside className="h-full min-w-0 bg-[var(--taomni-sidebar-bg)] flex flex-col">
                <div className="h-8 shrink-0 flex items-center px-3 text-[12px] font-semibold border-b border-[var(--taomni-divider)]">
                  Mailbox
                  {loadingFolders && <Loader2 className="w-3.5 h-3.5 ml-auto animate-spin text-[var(--taomni-text-muted)]" />}
                  <button
                    type="button"
                    className={`${loadingFolders ? "ml-1" : "ml-auto"} h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]`}
                    title="Manage folder subscriptions"
                    aria-label="Manage folder subscriptions"
                    data-testid="mail-subscriptions-open"
                    onClick={() => setSubscriptionsOpen(true)}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                    title="Address book"
                    aria-label="Address book"
                    data-testid="mail-address-book-open"
                    onClick={() => {
                      setContactDraft(null);
                      setAddressBookOpen(true);
                    }}
                  >
                    <BookUser className="w-3.5 h-3.5" />
                  </button>
                  {info.caldav && (
                    <button
                      type="button"
                      className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                      title="Agenda"
                      aria-label="Agenda"
                      data-testid="mail-agenda-open"
                      onClick={() => setAgendaOpen(true)}
                    >
                      <CalendarDays className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="ml-1 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                    title="Message filters"
                    aria-label="Message filters"
                    data-testid="mail-filters-open"
                    data-errors={filterErrors.length || undefined}
                    onClick={() => {
                      setFilterDraft(null);
                      setFiltersOpen(true);
                    }}
                  >
                    <FilterIcon className="w-3.5 h-3.5" />
                    {filterErrors.length > 0 && (
                      <AlertTriangle className="w-2.5 h-2.5 -ml-1 -mt-2 text-amber-500" data-testid="mail-filters-error-badge" />
                    )}
                  </button>
                </div>
                <div className="flex-1 min-h-0 py-1 overflow-auto">
                  {treeFolders.map((folder) => {
                    const active = folder.name === selectedFolder;
                    const label = folderLabel(folder);
                    return (
                      <button
                        key={folder.name}
                        type="button"
                        className={`w-full h-7 pr-3 flex items-center gap-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] ${active ? "bg-[var(--taomni-selected)] font-semibold" : ""} ${dropFolder === folder.name ? "outline outline-1 outline-[var(--taomni-accent)] -outline-offset-1" : ""}`}
                        style={{ paddingLeft: `${12 + Math.min(folderDepth(folder), 6) * 14}px` }}
                        data-active={active || undefined}
                        data-testid="mail-folder-row"
                        data-folder-name={folder.name}
                        data-unread={folder.unread ?? 0}
                        data-sync-error={folder.lastError ? "true" : undefined}
                        data-drop-target={dropFolder === folder.name ? "true" : undefined}
                        onDragOver={(event) => {
                          if (!event.dataTransfer.types.includes(MAIL_DRAG_TYPE) || !isSelectable(folder)) return;
                          const dragged = draggedMessagesRef.current;
                          if (dragged.length === 0 || dragged.every((m) => m.folder === folder.name)) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? "copy" : "move";
                          if (dropFolder !== folder.name) setDropFolder(folder.name);
                        }}
                        onDragLeave={() => {
                          if (dropFolder === folder.name) setDropFolder(null);
                        }}
                        onDrop={(event) => {
                          const dragged = draggedMessagesRef.current;
                          if (!event.dataTransfer.types.includes(MAIL_DRAG_TYPE) || dragged.length === 0) return;
                          event.preventDefault();
                          setDropFolder(null);
                          draggedMessagesRef.current = [];
                          // Move by default; Ctrl (Option on macOS) copies, like Thunderbird.
                          if (event.ctrlKey || event.altKey) void handleCopyMessages(dragged, folder.name);
                          else void handleMoveMessages(dragged, folder.name);
                        }}
                        onClick={() => handleFolderSelect(folder)}
                        onContextMenu={(event) => mailMenu.show(event, folderMenuItems(folder))}
                      >
                        <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                        <span className="min-w-0 flex-1 truncate" title={label === folder.name ? folder.name : `${label} (${folder.name})`}>{label}</span>
                        {folder.lastError && (
                          <span
                            className="text-[var(--taomni-warning,#d97706)]"
                            data-testid="mail-folder-sync-error"
                            title={`Sync failed: ${folder.lastError}`}
                            aria-label={`Sync failed: ${folder.lastError}`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {folder.unread !== null && folder.unread !== undefined && folder.unread > 0 && (
                          <span className="text-[11px] text-[var(--taomni-accent)]">{folder.unread}</span>
                        )}
                        {folder.total !== null && folder.total !== undefined && (
                          <span className="text-[11px] text-[var(--taomni-text-muted)]">{folder.total}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="shrink-0 border-t border-[var(--taomni-divider)] px-3 py-2 text-[11px] text-[var(--taomni-text-muted)] leading-5">
                  <div className="truncate" title={`${info.imap.host}:${info.imap.port}`}>
                    {info.incoming === "pop3" ? "POP3" : "IMAP"} {info.imap.host}:{info.imap.port}
                  </div>
                  <div className="truncate" title={`${info.smtp.host}:${info.smtp.port}`}>
                    SMTP {info.smtp.host}:{info.smtp.port}
                  </div>
                  <div className="truncate" title={cacheLine}>{cacheLine}</div>
                </div>
              </aside>
            )}
          </Panel>

          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

          <Panel id="messages" defaultSize="34%" minSize="18%" maxSize="55%" className="min-w-0">
            <section className="h-full min-w-0 flex flex-col">
              <div className="h-8 shrink-0 px-3 flex items-center justify-between border-b border-[var(--taomni-divider)]">
                <div className="min-w-0 flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="taomni-checkbox shrink-0"
                    aria-label="Select all visible messages"
                    checked={allFilteredMessagesChecked}
                    disabled={filteredMessages.length === 0}
                    onChange={(event) => toggleFilteredMessagesChecked(event.target.checked)}
                  />
                  <span className="text-[12px] font-semibold truncate" title={activeFolder?.name}>{folderLabel(activeFolder)}</span>
                  <button
                    type="button"
                    className={`taomni-btn h-6 px-1.5 text-[11px] inline-flex items-center gap-1 ${threadView ? "text-[var(--taomni-accent)]" : ""}`}
                    data-testid="mail-thread-view-toggle"
                    aria-pressed={threadView}
                    title={threadView ? "Show messages unthreaded" : "Group messages into conversations"}
                    onClick={() => {
                      const next = !threadView;
                      setThreadView(next);
                      try {
                        window.localStorage.setItem(MAIL_THREAD_VIEW_STORAGE_KEY, String(next));
                      } catch {
                        // Per-viewer convenience only.
                      }
                    }}
                  >
                    <MessageSquareReply className="w-3 h-3" />
                    Threads
                  </button>
                </div>
                <span
                  className="text-[11px] text-[var(--taomni-text-muted)]"
                  data-testid="mail-message-count"
                  data-count={messages.length}
                  data-has-more={hasMoreMessages ? "true" : "false"}
                >
                  {loadingMessages ? "Loading" : `${filteredMessages.length}/${messages.length}${!query.trim() && hasMoreMessages ? "+" : ""}`}
                </span>
              </div>
              <div
                className="flex-1 min-h-0 overflow-auto"
                onScroll={handleMessageListScroll}
                onContextMenu={(event) => mailMenu.show(event, messageListMenuItems())}
              >
                {loadingMessages && messages.length === 0 ? (
                  <div className="h-20 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading cached headers
                  </div>
                ) : filteredMessages.length === 0 ? (
                  <div className="h-28 flex items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
                    {query || quickFilterActive ? "No messages match the search or filter." : "No cached messages. Run Sync to refresh all folders."}
                  </div>
                ) : (
                  <>
                    {listRows.map((row) => {
                      const { message } = row;
                      const active = messageKey(message) === selectedMessageKey;
                      const unread = isUnread(message);
                      return (
                        <div
                          key={messageKey(message)}
                          data-thread-key={threadView ? row.threadKey : undefined}
                          data-thread-depth={threadView ? row.depth : undefined}
                          style={{
                            // Offscreen rows skip layout/paint (TASK-22) while
                            // staying in the DOM for find, a11y and selection.
                            contentVisibility: "auto",
                            containIntrinsicSize: "auto 82px",
                            ...(threadView && row.depth > 0 ? { paddingLeft: `${12 + row.depth * 16}px` } : {}),
                          }}
                          draggable
                          onDragStart={(event) => {
                            draggedMessagesRef.current = dragTargetsFor(message);
                            event.dataTransfer.effectAllowed = "copyMove";
                            event.dataTransfer.setData(MAIL_DRAG_TYPE, String(draggedMessagesRef.current.length));
                          }}
                          onDragEnd={() => {
                            draggedMessagesRef.current = [];
                            setDropFolder(null);
                          }}
                          role="button"
                          tabIndex={0}
                          aria-pressed={active}
                          data-testid="mail-message-row"
                          data-uid={message.uid}
                          data-unread={unread ? "true" : "false"}
                          data-flagged={isFlagged(message) ? "true" : "false"}
                          className={`w-full min-h-[82px] px-3 py-2.5 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] cursor-pointer ${active ? "bg-[var(--taomni-selected)]" : ""}`}
                          onClick={() => selectMessage(message, "mailbox")}
                          onDoubleClick={() => openMessageTab(message)}
                          onContextMenu={(event) => mailMenu.show(event, messageMenuItems(message))}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            selectMessage(message, "mailbox");
                          }}
                        >
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="taomni-checkbox mt-1 shrink-0"
                              aria-label={`Select ${message.subject || "message"}`}
                              checked={checkedMessageKeys.has(messageKey(message))}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => toggleMessageChecked(message, event.target.checked)}
                            />
                            {threadView && row.isRoot && row.threadSize > 1 && (
                              <button
                                type="button"
                                className="mt-0.5 shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
                                data-testid="mail-thread-expand"
                                aria-expanded={row.expanded}
                                aria-label={`${row.expanded ? "Collapse" : "Expand"} conversation of ${row.threadSize} messages`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleThreadExpanded(row.threadKey);
                                }}
                              >
                                <ChevronDown className={`w-3 h-3 transition-transform ${row.expanded ? "" : "-rotate-90"}`} />
                                <span data-testid="mail-thread-size">{row.threadSize}</span>
                                {row.threadUnread > 0 && !row.expanded && (
                                  <span className="text-[var(--taomni-accent)]">({row.threadUnread})</span>
                                )}
                              </button>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="min-w-0 flex items-center gap-1.5">
                                {isJunk(message) && (
                                  <span title="Junk" data-testid="mail-message-junk" className="shrink-0 text-[var(--taomni-text-muted)]">
                                    <Ban className="w-3 h-3" />
                                  </span>
                                )}
                                <div className={`min-w-0 text-[14px] leading-5 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "font-medium text-[var(--taomni-text-muted)]"}`}>
                                  {message.subject || "(no subject)"}
                                </div>
                                {messageTags(message).map((tag) => (
                                  <span
                                    key={tag.keyword}
                                    className="shrink-0 inline-block w-2 h-2 rounded-full"
                                    style={{ background: tag.color }}
                                    title={tag.label}
                                    data-testid="mail-message-tag"
                                    data-tag={tag.keyword}
                                  />
                                ))}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4">
                                <span className={`min-w-0 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "text-[var(--taomni-text-muted)]"}`}>
                                  {addressLabel(message.from) || "(unknown)"}
                                </span>
                                {message.folder !== selectedFolder && (
                                  <span
                                    className="shrink-0 rounded border border-[var(--taomni-divider)] px-1 text-[10px] text-[var(--taomni-text-muted)]"
                                    data-testid="mail-message-folder"
                                  >
                                    {decodeFolderLabel(message.folder, displayFolders)}
                                  </span>
                                )}
                                {message.hasAttachments && <Paperclip className="w-3 h-3 text-[var(--taomni-text-muted)] shrink-0" />}
                                {message.bodyCached && <FileText className="w-3 h-3 text-[var(--taomni-accent)] shrink-0" />}
                              </div>
                              <div className="text-[11px] text-[var(--taomni-text-muted)] line-clamp-2 mt-1.5">
                                {message.snippet || "No preview"}
                              </div>
                            </div>
                            <span className="text-[11px] text-[var(--taomni-text-muted)] shrink-0 leading-5">{formatShortDate(message.dateTs)}</span>
                          </div>
                        </div>
                      );
                    })}
                    {!query.trim() && !quickFilterActive && (hasMoreMessages || loadingMoreMessages) && (
                      <div className="p-2">
                        <button
                          type="button"
                          className="taomni-btn h-7 w-full inline-flex items-center justify-center gap-1.5 text-[12px]"
                          onClick={() => void loadMoreMessages()}
                          disabled={loadingMoreMessages}
                          data-testid="mail-load-more"
                        >
                          {loadingMoreMessages ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          Load older messages
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          </Panel>

          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

          <Panel id="reader" defaultSize="52%" minSize="25%" className="min-w-0">
            <main
              className="h-full min-w-0 flex flex-col"
              onContextMenu={(event) => showReaderMenu(event, selectedMessage)}
            >
              <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
                <span className="text-[12px] font-semibold min-w-0 truncate">
                  {selectedMessage?.subject || "Message"}
                </span>
                {selectedMessage && bodyLoadingKey === messageKey(selectedMessage) && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => openReply()}
                    disabled={!selectedMessage}
                    title="Reply"
                  >
                    <MessageSquareReply className="w-3.5 h-3.5" />
                    Reply
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => openReplyAll()}
                    disabled={!selectedMessage}
                    title="Reply all"
                  >
                    <MessageSquareReply className="w-3.5 h-3.5" />
                    Reply all
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => selectedMessage && openMessagePopup(selectedMessage)}
                    disabled={!selectedMessage}
                    title="Open message in popup window"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Popup
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("summarize")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Summarize with AI"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Summary
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("reply")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Draft reply with AI"
                  >
                    <Bot className="w-3.5 h-3.5" />
                    Draft
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={() => void handleAiAction("tasks")}
                    disabled={!selectedMessage || !info.ai.enabled}
                    title="Extract tasks with AI"
                  >
                    <MailOpen className="w-3.5 h-3.5" />
                    Tasks
                  </button>
                </div>
              </div>

              {!selectedMessage ? (
                <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  Select a message
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="px-4 py-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
                    <h2 className="text-[17px] font-semibold leading-6 mb-1 break-words">
                      {selectedMessage.subject || "(no subject)"}
                    </h2>
                    <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-[12px]">
                      <span className="text-[var(--taomni-text-muted)]">From</span>
                      <span className="truncate" title={addressLabel(selectedMessage.from)}>{addressLabel(selectedMessage.from) || "(unknown)"}</span>
                      <span className="text-[var(--taomni-text-muted)]">To</span>
                      <span className="truncate" title={selectedMessage.to.map(addressLabel).join(", ")}>
                        {selectedMessage.to.map(addressLabel).filter(Boolean).join(", ") || "(none)"}
                      </span>
                      {selectedMessage.cc.length > 0 && (
                        <>
                          <span className="text-[var(--taomni-text-muted)]">Cc</span>
                          <span className="truncate" title={selectedMessage.cc.map(addressLabel).join(", ")}>
                            {selectedMessage.cc.map(addressLabel).filter(Boolean).join(", ")}
                          </span>
                        </>
                      )}
                      <span className="text-[var(--taomni-text-muted)]">Date</span>
                      <span>{formatFullDate(selectedMessage.dateTs) || "(unknown)"}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
                      <span>{selectedBody?.source === "cache" ? "cached body" : selectedBody?.source === "remote" ? "remote body" : "header cached"}</span>
                      {selectedMessage.rawSize ? <span>{formatBytes(selectedMessage.rawSize)}</span> : null}
                      {info.ai.enabled && <span>AI confirm {info.ai.skipBodyConfirm ? "skipped" : "required"}</span>}
                      {selectedHasRemoteImages && selectedMessageRemoteKey && (
                        <button
                          type="button"
                          className="taomni-btn h-5 px-2 text-[10px]"
                          data-testid="mail-remote-images-header-toggle"
                          onClick={() => toggleRemoteForMessage(selectedMessageRemoteKey)}
                        >
                          {selectedAllowsRemote ? "Block remote images" : "Load remote images"}
                        </button>
                      )}
                      {renderUnsubscribe(selectedMessage)}
                    </div>
                    {visibleAttachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {visibleAttachments.length > 1 && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                            title="Save all attachments"
                            onClick={() => void handleSaveAllAttachments(selectedMessage, visibleAttachments)}
                            disabled={downloadingAttachmentIndex !== null}
                          >
                            {downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                            <span>Save all</span>
                          </button>
                        )}
                        {visibleAttachments.map((attachment, index) => {
                          const downloading = downloadingAttachmentIndex === index;
                          const savingAll = downloadingAttachmentIndex === ALL_ATTACHMENTS_INDEX;
                          const name = attachment.name || `attachment-${index + 1}`;
                          return (
                            <button
                              key={`${name}-${index}`}
                              type="button"
                              className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                              title={`Double-click to open ${name}; right-click to save`}
                              onDoubleClick={() => void handleOpenAttachment(selectedMessage, attachment, index)}
                              onContextMenu={(event) => handleAttachmentContextMenu(event, selectedMessage, visibleAttachments, attachment, index)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                void handleOpenAttachment(selectedMessage, attachment, index);
                              }}
                              disabled={downloading || savingAll}
                            >
                              {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                              <span className="max-w-[260px] truncate">{name}</span>
                              {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  {renderInviteCard(selectedMessage)}
                  {renderReceiptBanner(selectedMessage)}

                  <RemoteImagesBanner
                    visible={selectedHasRemoteImages}
                    allowRemoteImages={selectedAllowsRemote}
                    onAllowThisMessage={() => selectedMessageRemoteKey && allowRemoteForMessage(selectedMessageRemoteKey)}
                    onAllowAllInTab={() => setAllowRemoteAllInTab(true)}
                    onBlock={() => selectedMessageRemoteKey && blockRemoteForMessage(selectedMessageRemoteKey)}
                  />

                  <div className="p-3 sm:p-4">
                    <MailMessageBodyView
                      html={selectedBody?.html}
                      text={selectedBody?.text}
                      snippet={selectedMessage.snippet}
                      allowRemoteImages={selectedAllowsRemote}
                      preferDark={preferDarkReader}
                      fontSize={mailFontSize}
                      title={selectedMessage.subject || "Message body"}
                      loading={!!selectedMessage && bodyLoadingKey === messageKey(selectedMessage) && !selectedBody}
                      onMailtoLink={openComposeFromMailto}
                    />
                  </div>
                </div>
              )}
            </main>
          </Panel>
        </PanelGroup>
        )}
      </div>

      {attachmentMenu.render}
      {mailMenu.render}
      {confirmDialog.render}
      {textInputDialog.render}

      {sourceView && (
        <div className="absolute inset-0 z-[140] bg-black/35 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={`Source — ${sourceView.subject}`}
            icon={<Code className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Message source"
            minWidth={560}
            minHeight={360}
            className="w-[min(1000px,92vw)] h-[min(720px,86vh)] min-h-[420px]"
            onClose={() => setSourceView(null)}
            headerActions={(
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px]"
                onClick={() => copyText("message source", sourceView.content)}
              >
                Copy all
              </button>
            )}
          >
            <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-bg)]">
              <pre className="p-3 text-[12px] leading-5 whitespace-pre-wrap break-words taomni-mono">
                {sourceView.content}
              </pre>
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {popupMessage && (
        <div className="absolute inset-0 z-[130] bg-black/35 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={popupMessage.subject || "(no subject)"}
            icon={<MailOpen className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel={popupMessage.subject || "Mail message"}
            minWidth={640}
            minHeight={420}
            className="w-[min(1120px,92vw)] h-[min(780px,86vh)] min-h-[480px]"
            onClose={() => setPopupMessageKey(null)}
            headerActions={(
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px]"
                onClick={() => openMessageTab(popupMessage)}
              >
                Open tab
              </button>
            )}
          >
            <div className="flex-1 min-h-0">
              {renderReaderSurface(popupMessage, true)}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {certReview && (
        <div className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={`${certReview.protocol.toUpperCase()} server certificate`}
            icon={<ShieldCheck className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Server certificate"
            minWidth={420}
            minHeight={260}
            className="w-[min(620px,92vw)] min-h-[280px]"
            onClose={() => setCertReview(null)}
          >
            <div className="flex-1 min-h-0 overflow-auto p-3 text-[12px] flex flex-col gap-2" data-testid="mail-cert-dialog">
              {certReview.loading && (
                <div className="flex items-center gap-2 text-[var(--taomni-text-muted)]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching the certificate…
                </div>
              )}
              {certReview.error && <div className="text-red-500">{certReview.error}</div>}
              {certReview.info && (
                <>
                  <div className="text-[var(--taomni-warning,#d97706)]">
                    {certReview.info.trustedBySystem
                      ? "This certificate is trusted by the system."
                      : `Not trusted by the system: ${certReview.info.verifyError ?? "unknown issuer"}`}
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-x-2 gap-y-1">
                    <span className="text-[var(--taomni-text-muted)]">Server</span>
                    <span>{certReview.info.host}:{certReview.info.port}</span>
                    <span className="text-[var(--taomni-text-muted)]">Subject</span>
                    <span className="break-all">{certReview.info.subject || "(none)"}</span>
                    <span className="text-[var(--taomni-text-muted)]">Issuer</span>
                    <span className="break-all">{certReview.info.issuer || "(none)"}</span>
                    <span className="text-[var(--taomni-text-muted)]">Valid</span>
                    <span>{certReview.info.notBefore} – {certReview.info.notAfter}</span>
                    <span className="text-[var(--taomni-text-muted)]">SHA-256</span>
                    <code className="break-all font-mono text-[11px]" data-testid="mail-cert-fingerprint">
                      {certReview.info.sha256}
                    </code>
                  </div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)]">
                    Compare the fingerprint with the one your mail administrator gave you. Only this exact
                    certificate will be accepted for this server; if it changes you will be asked again.
                  </div>
                </>
              )}
            </div>
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={() => setCertReview(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-3 text-[12px]"
                data-primary="true"
                data-testid="mail-cert-trust"
                disabled={!certReview.info}
                onClick={() => void trustReviewedCertificate()}
              >
                Trust for this account
              </button>
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {undoSend && (
        <div
          className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[160] h-9 px-3 rounded shadow-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] flex items-center gap-3 text-[12px]"
          role="status"
          data-testid="mail-undo-send"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Sending in {Math.max(0, Math.ceil(undoSend.until - undoNow / 1000))}s…
          <button type="button" className="taomni-btn h-7 px-2" data-testid="mail-undo-send-button" onClick={() => void handleUndoSend()}>
            Undo
          </button>
        </div>
      )}

      {agendaOpen && info.caldav && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Agenda"
            icon={<CalendarDays className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Agenda"
            closeTestId="mail-agenda-close"
            minWidth={380}
            minHeight={300}
            className="w-[min(560px,92vw)] h-[min(520px,80vh)] min-h-[320px]"
            onClose={() => setAgendaOpen(false)}
          >
            <MailAgendaPanel
              info={info}
              revision={agendaRevision}
              onStatus={setStatus}
              onChanged={onAgendaChanged}
            />
          </MailDraggableDialog>
        </div>
      )}

      {addressBookOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Address book"
            icon={<BookUser className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Address book"
            closeTestId="mail-address-book-close"
            minWidth={420}
            minHeight={320}
            className="w-[min(640px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
            onClose={() => setAddressBookOpen(false)}
          >
            <MailAddressBookPanel
              info={info}
              initialDraft={contactDraft}
              onStatus={setStatus}
              onCompose={(entry) => {
                setAddressBookOpen(false);
                openCompose({ to: parseRecipientsText(entry.displayName ? `${entry.displayName} <${entry.emails[0]}>` : entry.emails[0]) });
              }}
            />
          </MailDraggableDialog>
        </div>
      )}

      {filtersOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Message filters"
            icon={<FilterIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Message filters"
            closeTestId="mail-filters-close"
            minWidth={460}
            minHeight={320}
            className="w-[min(720px,92vw)] h-[min(560px,80vh)] min-h-[340px]"
            onClose={() => {
              setFiltersOpen(false);
              setFilterErrors([]);
            }}
          >
            <MailFiltersPanel
              recentErrors={filterErrors}
              accountId={info.sessionId}
              folders={displayFolders.filter(isSelectable).map((folder) => ({ name: folder.name, label: folderLabel(folder) }))}
              currentFolder={{
                name: selectedFolder,
                label: folderLabel(displayFolders.find((folder) => folder.name === selectedFolder) ?? { name: selectedFolder, displayName: selectedFolder } as MailFolder),
              }}
              initialDraft={filterDraft}
              onRun={runFiltersOnFolder}
              onStatus={setStatus}
            />
          </MailDraggableDialog>
        </div>
      )}

      {subscriptionsOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Folder subscriptions"
            icon={<ListChecks className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Folder subscriptions"
            minWidth={360}
            minHeight={280}
            className="w-[min(520px,90vw)] h-[min(520px,78vh)] min-h-[300px]"
            onClose={() => setSubscriptionsOpen(false)}
          >
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={subscribedOnly}
                  data-testid="mail-subscribed-only"
                  onChange={(event) => setSubscribedOnly(event.target.checked)}
                />
                Show only subscribed folders
              </label>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-subscriptions-dialog">
              {displayFolders.filter(isSelectable).map((folder) => {
                const subscribed = isSubscribed(folder);
                const inbox = folder.name.toUpperCase() === "INBOX";
                return (
                  <label
                    key={folder.name}
                    className="h-7 px-2 flex items-center gap-2 rounded text-[12px] hover:bg-[var(--taomni-hover)]"
                    style={{ paddingLeft: `${8 + Math.min(folderDepth(folder), 6) * 14}px` }}
                    data-testid="mail-subscription-row"
                    data-folder-name={folder.name}
                    data-subscribed={subscribed ? "true" : "false"}
                  >
                    <input
                      type="checkbox"
                      checked={subscribed}
                      disabled={inbox || subscriptionBusy != null}
                      aria-label={`Subscribe to ${folderLabel(folder)}`}
                      data-testid="mail-subscription-toggle"
                      onChange={(event) => void toggleSubscription(folder, event.target.checked)}
                    />
                    <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                    <span className="min-w-0 flex-1 truncate">{folderLabel(folder)}</span>
                    {subscriptionBusy === folder.name && <Loader2 className="w-3 h-3 animate-spin" />}
                  </label>
                );
              })}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {draftsOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title={draftsTab === "drafts" ? "Drafts" : draftsTab === "templates" ? "Templates" : "Outbox"}
            icon={<FileText className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Drafts and templates"
            minWidth={420}
            minHeight={300}
            className="w-[min(680px,90vw)] h-[min(520px,78vh)] min-h-[340px]"
            onClose={() => setDraftsOpen(false)}
          >
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
              <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={() => void refreshDrafts()} disabled={draftsLoading}>
                {draftsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
              <div className="flex items-center gap-1" role="tablist" aria-label="Drafts and templates">
                {(["drafts", "templates", "outbox"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={draftsTab === tab}
                    data-testid={`mail-drafts-tab-${tab}`}
                    className={`taomni-btn h-7 px-2 text-[12px] ${draftsTab === tab ? "text-[var(--taomni-accent)]" : ""}`}
                    onClick={() => setDraftsTab(tab)}
                  >
                    {tab === "drafts" ? "Drafts" : tab === "templates" ? "Templates" : `Outbox${outboxCount > 0 ? ` (${outboxCount})` : ""}`}
                  </button>
                ))}
              </div>
              <span className="text-[12px] text-[var(--taomni-text-muted)]">
                {visibleDrafts.length} {draftsTab === "drafts" ? "draft" : draftsTab === "templates" ? "template" : "queued message"}{visibleDrafts.length === 1 ? "" : "s"}
              </span>
              {draftsTab === "outbox" && (
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-[12px] ml-auto inline-flex items-center gap-1.5"
                  data-testid="mail-outbox-send-all"
                  disabled={visibleDrafts.length === 0}
                  onClick={() => void processOutbox(true)}
                  title="Send every queued message now"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send all
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-drafts-dialog">
              {visibleDrafts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  {draftsTab === "drafts"
                    ? "No saved drafts"
                    : draftsTab === "templates"
                      ? "No templates. Use \"Save as template\" in the composer."
                      : "The Outbox is empty. Queued and scheduled messages send while this tab is open."}
                </div>
              ) : visibleDrafts.map((saved) => (
                <div
                  key={saved.id}
                  className="min-h-14 px-2 py-1.5 rounded border border-transparent hover:border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-2"
                  data-testid={isOutbox(saved) ? "mail-outbox-row" : isTemplate(saved) ? "mail-template-row" : "mail-draft-row"}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (isTemplate(saved) ? openFromTemplate(saved) : openSavedDraft(saved))}
                  >
                    <div className="text-[12px] font-semibold truncate">{saved.subject || "(no subject)"}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                      {[...saved.to, ...saved.cc, ...saved.bcc].join(", ") || "(no recipients)"}
                    </div>
                    {isOutbox(saved) && (() => {
                      const state = outboxState(saved)!;
                      const at = outboxNextAttemptAt(state);
                      return (
                        <div className="text-[10px] text-[var(--taomni-text-muted)]" data-testid="mail-outbox-state">
                          {at ? `Sends ${new Date(at * 1000).toLocaleString()}` : "Waiting for Send now"}
                          {state.lastError ? ` · attempt ${state.attempts} failed: ${state.lastError}` : ""}
                        </div>
                      );
                    })()}
                    <div className="text-[10px] text-[var(--taomni-text-muted)]">
                      {formatShortDate(saved.updatedAt)}
                      {saved.attachments.length > 0 ? ` · ${saved.attachments.length} attachment${saved.attachments.length === 1 ? "" : "s"}` : ""}
                    </div>
                  </button>
                  {isOutbox(saved) && (
                    <button
                      type="button"
                      className="taomni-btn h-7 px-2 text-[12px] inline-flex items-center gap-1"
                      data-testid="mail-outbox-send"
                      title="Send this message now"
                      onClick={() => void sendOutboxItem(saved, true)}
                    >
                      <Send className="w-3.5 h-3.5" />
                      Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
                    title="Delete draft"
                    onClick={() => void deleteSavedDraft(saved)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </MailDraggableDialog>
        </div>
      )}

      {composeOpen && (
        <div
          ref={composeRootRef}
          className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-4"
          data-testid="mail-compose-dialog"
          onDragEnter={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending || !isOsFileDrag(event.dataTransfer)) return;
            preventDefaultForOsFileDrag(event);
            event.preventDefault();
            setComposeDragActive(true);
          }}
          onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending || !isOsFileDrag(event.dataTransfer)) return;
            preventDefaultForOsFileDrag(event);
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setComposeDragActive(true);
          }}
          onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!composeRootRef.current?.contains(event.relatedTarget as Node | null)) {
              setComposeDragActive(false);
            }
          }}
          onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
            if (sending) return;
            if (!isOsFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            setComposeDragActive(false);
            const paths = droppedFilePaths(event.dataTransfer);
            if (paths.length > 0) {
              void addDraftAttachmentPaths(paths);
              return;
            }
            const files = droppedFiles(event.dataTransfer);
            if (files.length > 0) void handleDropComposeFiles(files);
          }}
        >
          <MailDraggableDialog
            title={draft.id ? "Edit draft" : draft.replyContext?.kind ? "Reply" : "New message"}
            icon={<MailIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="New message"
            minWidth={520}
            minHeight={360}
            className="w-[min(920px,calc(100vw-48px))] h-[min(760px,calc(100vh-72px))] max-w-[calc(100vw-48px)] max-h-[calc(100vh-72px)]"
            onClose={() => setComposeOpen(false)}
          >
            <div className="h-8 px-3 flex items-center gap-1 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] text-[12px]" data-testid="mail-compose-menu-bar">
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => void saveCurrentDraft("manual")} disabled={savingDraft || sending}>File</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => document.execCommand("undo")} disabled={sending}>Edit</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => void handleAddDraftAttachments()} disabled={sending}>Insert</button>
              <button type="button" className="taomni-btn h-6 px-2" onClick={() => setDraft((current) => ({ ...current, richFormatUsed: true }))} disabled={sending}>Format</button>
              <button type="button" className="taomni-btn h-6 px-2" disabled={sending}>Options</button>
              <button type="button" className="taomni-btn h-6 px-2" disabled={sending}>Tools</button>
              <span className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">
                {attachProgress
                  ? `${attachProgress.label} ${attachProgress.done}/${attachProgress.total}`
                  : savingDraft
                    ? "Saving draft..."
                    : draft.id
                      ? "Draft saved locally"
                      : "Auto draft"}
              </span>
            </div>
            {attachProgress && (
              <div
                className="px-3 py-1.5 border-b border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-2"
                data-testid="mail-compose-attach-progress"
              >
                {attachProgress.done < attachProgress.total
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                <span>
                  {attachProgress.label}
                  {" "}
                  ({attachProgress.done}/{attachProgress.total})
                </span>
                <div className="ml-auto h-1.5 w-32 rounded bg-[var(--taomni-divider)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--taomni-accent)] transition-all"
                    style={{ width: `${attachProgress.total ? Math.round((attachProgress.done / attachProgress.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}
            <div className="p-3 grid grid-cols-[56px_1fr] gap-2 text-[12px]">
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-from-${tabId}`}>From</label>
              <select
                id={`mail-from-${tabId}`}
                className="taomni-input h-7"
                data-testid="mail-compose-from"
                value={identityById(draft.identityId).id}
                disabled={sending || identities.length < 2}
                onChange={(event) => {
                  const next = identityById(event.target.value);
                  setDraft((current) => {
                    const previous = identityById(current.identityId);
                    return {
                      ...current,
                      identityId: next.id,
                      htmlBody: swapSignature(
                        current.htmlBody,
                        signatureToMailHtml(previous.signature),
                        signatureToMailHtml(next.signature),
                      ),
                    };
                  });
                }}
              >
                {identities.map((identity) => (
                  <option key={identity.id} value={identity.id}>{identityLabel(identity)}</option>
                ))}
              </select>
              <RecipientField
                id={`mail-to-${tabId}`}
                label="To"
                recipients={draft.to}
                suggestions={recipientSuggestionsFor("to")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "to" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-to"
                onChange={(to) => setDraft((current) => ({ ...current, to }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("to", nextQuery)}
              />
              <RecipientField
                id={`mail-cc-${tabId}`}
                label="Cc"
                recipients={draft.cc}
                suggestions={recipientSuggestionsFor("cc")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "cc" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-cc"
                onChange={(cc) => setDraft((current) => ({ ...current, cc }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("cc", nextQuery)}
              />
              <RecipientField
                id={`mail-bcc-${tabId}`}
                label="Bcc"
                recipients={draft.bcc}
                suggestions={recipientSuggestionsFor("bcc")}
                defaultDomain={defaultMailDomain}
                loading={recipientSearch.field === "bcc" && recipientSearch.loading}
                disabled={sending}
                dataTestId="mail-recipient-bcc"
                onChange={(bcc) => setDraft((current) => ({ ...current, bcc }))}
                onQueryChange={(nextQuery) => handleRecipientQueryChange("bcc", nextQuery)}
              />
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-subject-${tabId}`}>Subject</label>
              <input
                id={`mail-subject-${tabId}`}
                className="taomni-input h-7"
                data-testid="mail-compose-subject"
                value={draft.subject}
                onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
              />
            </div>
            <RichMailEditor
              html={draft.htmlBody}
              disabled={sending}
              dragActive={composeDragActive}
              onAttach={() => void handleAddDraftAttachments()}
              onInlineImage={() => handleInsertInlineImage()}
              onPasteImages={handlePasteImages}
              onDropFiles={(files) => void handleDropComposeFiles(files)}
              onRichFormatUsed={() => setDraft((current) => ({ ...current, richFormatUsed: true }))}
              onChange={(htmlBody, textBody) => setDraft((current) => ({ ...current, htmlBody, textBody }))}
            />
            <div
              className={`mx-3 mb-3 min-h-[40px] rounded border border-dashed px-2 py-2 ${
                composeDragActive
                  ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/10"
                  : "border-[var(--taomni-divider)]"
              }`}
              data-testid="mail-compose-attachments"
              data-drag-active={composeDragActive ? "true" : "false"}
            >
              {draft.attachments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {draft.attachments.map((attachment, index) => (
                    <span
                      key={`${attachment.path}-${index}`}
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-2 py-1 text-[11px] text-[var(--taomni-text-muted)] bg-[var(--taomni-sidebar-bg)]"
                      data-testid="mail-compose-attachment-chip"
                      title={attachment.path}
                    >
                      {attachment.inline ? <ImageIcon className="w-3 h-3" /> : <Paperclip className="w-3 h-3" />}
                      <span className="max-w-[280px] truncate">
                        {attachment.inline ? "Inline " : ""}{attachment.name || basename(attachment.path)}
                      </span>
                      <button
                        type="button"
                        className="ml-1 text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                        aria-label={`Remove ${attachment.name || "attachment"}`}
                        onClick={() => removeDraftAttachment(index)}
                        disabled={sending}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-[var(--taomni-text-muted)] flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5" />
                  Drop files here to attach, or use Attach / paste images into the editor
                </div>
              )}
            </div>
            {attachReminder && (
              <div
                className="px-3 py-1.5 flex items-center gap-2 text-[12px] border-t border-[var(--taomni-divider)] bg-[var(--taomni-warning-bg,rgba(217,119,6,0.12))]"
                role="alert"
                data-testid="mail-attach-reminder"
              >
                <Paperclip className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1">The message mentions an attachment, but nothing is attached.</span>
                <button
                  type="button"
                  className="taomni-btn h-6 px-2 text-[11px]"
                  onClick={() => {
                    setAttachReminder(false);
                    void handleAddDraftAttachments();
                  }}
                >
                  Attach…
                </button>
                <button
                  type="button"
                  className="taomni-btn h-6 px-2 text-[11px]"
                  data-testid="mail-attach-reminder-send"
                  onClick={() => void handleSendDraft(true)}
                >
                  Send anyway
                </button>
              </div>
            )}
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 mr-auto" onClick={() => void handleAddDraftAttachments()} disabled={sending}>
                <Paperclip className="w-3.5 h-3.5" />
                Attach
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" data-testid="mail-compose-save-draft" onClick={() => void saveCurrentDraft("manual")} disabled={savingDraft || sending || !draftHasContent(draft)}>
                {savingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save draft
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-3 text-[12px]"
                data-testid="mail-compose-save-template"
                onClick={() => void saveCurrentAsTemplate()}
                disabled={savingDraft || sending || !draftHasContent(draft)}
                title="Save this message as a reusable template"
              >
                Save as template
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" data-testid="mail-compose-discard" onClick={() => void discardCurrentDraft()} disabled={sending}>
                Discard
              </button>
              <label className="inline-flex items-center gap-1 text-[12px] text-[var(--taomni-text-muted)]" title="Ask the recipient's client to send a read receipt">
                <input
                  type="checkbox"
                  checked={draft.readReceipt === true}
                  data-testid="mail-compose-read-receipt"
                  onChange={(event) => setDraft((current) => ({ ...current, readReceipt: event.target.checked }))}
                />
                Receipt
              </label>
              <div className="relative">
                <button
                  type="button"
                  className="taomni-btn h-7 px-3 text-[12px]"
                  data-testid="mail-compose-send-later"
                  disabled={sending}
                  onClick={() => {
                    setSendLaterAt((current) => current || toDateTimeLocal(Math.floor(Date.now() / 1000) + 3600));
                    setSendLaterOpen((open) => !open);
                  }}
                >
                  Send later
                </button>
                {sendLaterOpen && (
                  <div
                    className="absolute bottom-9 right-0 z-10 w-72 p-2 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg text-[12px] flex flex-col gap-2"
                    data-testid="mail-send-later-panel"
                  >
                    <label className="flex flex-col gap-1">
                      <span className="text-[var(--taomni-text-muted)]">Send at (empty = keep in Outbox)</span>
                      <input
                        type="datetime-local"
                        className="taomni-input"
                        value={sendLaterAt}
                        data-testid="mail-send-later-at"
                        onChange={(event) => setSendLaterAt(event.target.value)}
                      />
                    </label>
                    <span className="text-[11px] text-[var(--taomni-text-muted)]">
                      Scheduled mail only goes out while this account's tab is open.
                    </span>
                    <div className="flex justify-end gap-2">
                      <button type="button" className="taomni-btn h-7 px-2" onClick={() => setSendLaterOpen(false)}>Cancel</button>
                      <button type="button" className="taomni-btn h-7 px-2" data-primary="true" data-testid="mail-send-later-confirm" onClick={() => void handleSendLater()}>
                        Queue
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5" data-primary="true" data-testid="mail-compose-send" onClick={() => void handleSendDraft()} disabled={sending}>
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Send
              </button>
            </div>
          </MailDraggableDialog>
        </div>
      )}
    </div>
  );
}
