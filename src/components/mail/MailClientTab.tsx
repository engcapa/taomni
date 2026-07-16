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
  Bot,
  CheckCircle2,
  ChevronDown,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
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
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  mailClearCache,
  mailCopyMessages,
  mailCreateFolder,
  mailDeleteFolder,
  mailDeleteMessages,
  mailDownloadAttachment,
  mailFetchRaw,
  mailGetMessageBody,
  mailIndexCachedContacts,
  mailDeleteDraft,
  mailListDrafts,
  mailListCachedFolders,
  mailListCachedMessages,
  mailSaveDraft,
  mailMarkRead,
  mailMoveMessages,
  mailRenameFolder,
  mailSaveRaw,
  mailSendMessage,
  mailSetFlags,
  mailSearchContacts,
  mailSyncAllFolders,
  mailSyncHeaders,
  mailTestConnection,
  type MailAddress,
  type MailAttachmentInfo,
  type MailContactSuggestion,
  type MailDraft,
  type MailDraftAttachment,
  type MailDraftContext,
  type MailFolder,
  type MailMessageBody,
  type MailMessageHeader,
} from "../../lib/mail";
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

const SPECIAL_FOLDER_MATCHERS: Record<SpecialFolderKind, { flag: string; names: string[] }> = {
  trash: { flag: "trash", names: ["trash", "deleted", "已删除", "已刪除", "垃圾桶", "废件箱", "廢件匣"] },
  junk: { flag: "junk", names: ["junk", "spam", "bulk", "垃圾邮件", "垃圾郵件"] },
  archive: { flag: "archive", names: ["archive", "归档", "封存", "歸檔"] },
  sent: { flag: "sent", names: ["sent", "已发送", "已傳送", "寄件"] },
};

function folderMatchesSpecial(folder: MailFolder, kind: SpecialFolderKind): boolean {
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

function folderHasMoreMessages(folders: readonly MailFolder[], folderName: string, loadedCount: number): boolean {
  const total = folders.find((folder) => folder.name === folderName)?.total;
  return typeof total === "number" && total > loadedCount;
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

function draftFromSaved(saved: MailDraft): ComposeDraft {
  return {
    id: saved.id,
    to: parseRecipientsText(saved.to.join(", ")),
    cc: parseRecipientsText(saved.cc.join(", ")),
    bcc: parseRecipientsText(saved.bcc.join(", ")),
    subject: saved.subject,
    htmlBody: saved.htmlBody || plainTextToMailHtml(saved.textBody),
    textBody: saved.textBody,
    attachments: saved.attachments ?? [],
    replyContext: saved.replyContext ?? null,
    richFormatUsed: hasRichMailFormatting(saved.htmlBody),
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
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bodyCache, setBodyCache] = useState<Map<string, MailMessageBody>>(() => new Map());
  const [bodyLoadingKey, setBodyLoadingKey] = useState<string | null>(null);
  const [bodyWarming, setBodyWarming] = useState<BodyWarmState>({ active: false, done: 0, total: 0 });
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
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
  const oauthReauthRequired = isOAuthReauthRequired(error);
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const batchSize = useMemo(() => refreshBatchSize(info), [info.sync.maxFetchPerSync]);
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

  const filteredMessages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((message) => {
      const haystack = [
        message.subject,
        addressLabel(message.from),
        message.snippet ?? "",
        ...message.to.map(addressLabel),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [messages, query]);
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
      setSelectedFolder((current) =>
        cached.length > 0 && !cached.some((folder) => folder.name === current)
          ? cached[0].name
          : current,
      );
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setLoadingFolders(false);
    }
  }, [info.sessionId]);

  const loadCachedMessages = useCallback(async (folder: string, offset = 0, append = false, quiet = false) => {
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
      const cached = await mailListCachedMessages(info.sessionId, folder, pageSize + 1, offset);
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return { page: [] as MailMessageHeader[], hasMore: false };
      }
      const page = cached.slice(0, pageSize);
      const loadedCount = offset + page.length;
      const hasMore = cached.length > pageSize || folderHasMoreMessages(foldersRef.current, folder, loadedCount);
      setHasMoreMessages(hasMore);
      setMessages((current) => append ? mergeMessagePages(current, page) : sortMessages(page));
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

  const syncFolder = useCallback(async (
    folder = selectedFolder,
    quiet = false,
    options: SyncFolderOptions = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const append = options.append ?? false;
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? (offset > 0 ? pageSize : batchSize));
    const includeBodies = options.includeBodies ?? false;
    const refreshFolders = options.refreshFolders ?? true;

    if (syncInFlightRef.current) {
      if (indicator !== "none" && visibleRef.current) {
        setStatus("Mail sync already running");
      }
      return null;
    }
    syncInFlightRef.current = true;

    if (indicator === "more") {
      setLoadingMoreMessages(true);
    } else if (indicator === "sync") {
      setSyncing(true);
    }
    if (!quiet && indicator !== "none") setStatus(null);
    if (indicator !== "none") setError(null);

    try {
      const result = await mailSyncHeaders(info, folder, {
        limit,
        offset,
        includeBodies,
        refreshFolders,
      });
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return result;
      }
      foldersRef.current = result.folders;
      setFolders(result.folders);
      setSelectedFolder(result.folder);
      setMessages((current) => mergeMessagePages(
        current.filter((message) => message.folder === result.folder),
        result.messages,
      ));
      setHasMoreMessages(
        result.hasMore
        || folderHasMoreMessages(result.folders, result.folder, offset + result.messages.length),
      );
      if (indicator !== "none") {
        setStatus(
          append
            ? result.fetchedMessages > 0 ? `Loaded ${result.fetchedMessages} older messages` : "No more messages"
            : `Synced ${result.fetchedMessages} headers`,
        );
      }
      return result;
    } catch (e) {
      if (indicator !== "none") setError(mailClientErrorMessage(e));
      return null;
    } finally {
      syncInFlightRef.current = false;
      if (indicator === "more") {
        if (visibleRef.current) setLoadingMoreMessages(false);
      } else if (indicator === "sync") {
        if (visibleRef.current) setSyncing(false);
      }
    }
  }, [batchSize, info, pageSize, selectedFolder]);

  /** Quiet background poll: selected folder (+ INBOX when different), no LIST. */
  const quietPollSelectedAndInbox = useCallback(async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    const activeFolder = selectedFolder;
    const alsoInbox = activeFolder.trim().toUpperCase() !== "INBOX";
    try {
      const selectedResult = await mailSyncHeaders(info, activeFolder, {
        limit: batchSize,
        includeBodies: false,
        refreshFolders: false,
      });
      let folders = selectedResult.folders;
      if (alsoInbox) {
        try {
          const inboxResult = await mailSyncHeaders(info, "INBOX", {
            limit: batchSize,
            includeBodies: false,
            refreshFolders: false,
          });
          // Merge INBOX metadata into the folder tree without switching the UI
          // selection away from the active folder.
          const byName = new Map(folders.map((f) => [f.name, f]));
          for (const f of inboxResult.folders) {
            byName.set(f.name, f);
          }
          folders = Array.from(byName.values());
        } catch (e) {
          // Selected-folder refresh already succeeded; inbox is best-effort.
          console.debug("quiet INBOX poll failed", e);
        }
      }
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return;
      }
      foldersRef.current = folders;
      setFolders(folders);
      setMessages((current) => mergeMessagePages(
        current.filter((message) => message.folder === selectedResult.folder),
        selectedResult.messages,
      ));
      setHasMoreMessages(
        selectedResult.hasMore
        || folderHasMoreMessages(
          folders,
          selectedResult.folder,
          selectedResult.messages.length,
        ),
      );
    } catch (e) {
      console.debug("quiet mail poll failed", e);
    } finally {
      syncInFlightRef.current = false;
    }
  }, [batchSize, info, selectedFolder]);

  const syncAllFolders = useCallback(async (
    quiet = false,
    options: Pick<SyncFolderOptions, "limit" | "includeBodies" | "indicator"> = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const limit = Math.max(1, options.limit ?? batchSize);
    const includeBodies = options.includeBodies ?? false;
    const activeBeforeSync = selectedFolder;

    if (syncInFlightRef.current) {
      if (indicator !== "none" && visibleRef.current) {
        setStatus("Mail sync already running");
      }
      return null;
    }
    syncInFlightRef.current = true;

    if (indicator === "sync") {
      setSyncing(true);
    }
    if (!quiet && indicator !== "none") setStatus(null);
    if (indicator !== "none") setError(null);

    try {
      const result = await mailSyncAllFolders(info, { limit, includeBodies });
      const newMessages = result.newMessages ?? 0;
      if (indicator === "none" && newMessages > 0) {
        pushMailNew(
          tabId,
          info.sessionId,
          info.displayName?.trim() || info.emailAddress || info.sessionId,
          newMessages,
        );
      }
      if (!visibleRef.current) {
        pendingCacheRefreshRef.current = true;
        return result;
      }
      foldersRef.current = result.folders;
      setFolders(result.folders);
      const nextFolder = result.folders.some((folder) => folder.name === activeBeforeSync)
        ? activeBeforeSync
        : result.folders[0]?.name ?? activeBeforeSync;
      if (nextFolder !== activeBeforeSync) {
        setSelectedFolder(nextFolder);
      }
      await loadCachedMessages(nextFolder, 0, false, quiet || indicator === "none");
      if (indicator !== "none") {
        setStatus(
          `Synced ${result.fetchedMessages} new headers across ${result.folders.length} folders`,
        );
      }
      void warmRecentBodies(result.folders, nextFolder);
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
  }, [batchSize, info, loadCachedMessages, pushMailNew, selectedFolder, tabId, warmRecentBodies]);

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
    setSelectedFolder(message.folder);
    setSelectedMessageKey(key);
    setMailViewKey(viewKey);
    const cached = bodyCacheRef.current.get(key);
    setBody((current) => (
      cached && bodyMatchesMessage(cached, message)
        ? cached
        : bodyMatchesMessage(current, message) ? current : null
    ));
  }, []);

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
    setSelectedFolder("INBOX");
    void loadCachedFolders();
  }, [info.sessionId, loadCachedFolders]);

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
    void syncFolder(selectedFolder, true, {
      limit: batchSize,
      includeBodies: false,
      indicator: "sync",
    });
  }, [batchSize, info.sync.onOpen, selectedFolder, syncFolder, visible]);

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
    setSelectedFolder(folder.name);
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
      setStatus(`IMAP ${result.imapOk ? "ok" : "failed"}, SMTP ${result.smtpOk ? "ok" : "failed"}, ${result.folderCount} folders`);
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
    const result = await syncFolder(selectedFolder, true, {
      limit: pageSize,
      offset: messages.length,
      includeBodies: false,
      append: true,
      indicator: "more",
    });
    if (!result) {
      await loadCachedMessages(selectedFolder, messages.length, true);
    }
  }, [
    hasMoreMessages,
    loadCachedMessages,
    loadingMessages,
    loadingMoreMessages,
    messages.length,
    pageSize,
    query,
    selectedFolder,
    syncFolder,
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
    const next = includeSignature ? draftWithSignature(nextDraft, info.signature) : { ...emptyComposeDraft(), ...nextDraft };
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
        replyContext: draft.replyContext ?? null,
      });
      lastSavedDraftJsonRef.current = serialized;
      setDraft((current) => ({ ...current, id: saved.id }));
      setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      if (mode === "manual") setStatus("Draft saved");
      return saved;
    } catch (e) {
      if (mode === "manual") setError(mailClientErrorMessage(e));
      return null;
    } finally {
      setSavingDraft(false);
    }
  };

  const openSavedDraft = (saved: MailDraft) => {
    const next = draftFromSaved(saved);
    setDraft(next);
    lastSavedDraftJsonRef.current = serializeDraftContent(next);
    setRecipientSearch({ field: null, query: "", suggestions: [], loading: false });
    setDraftsOpen(false);
    setComposeOpen(true);
  };

  const deleteSavedDraft = async (saved: MailDraft) => {
    try {
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

  const replyDraftBody = (target: MailMessageHeader, currentBody: MailMessageBody) => {
    const intro = `On ${formatFullDate(target.dateTs) || "an unknown date"}, ${addressLabel(target.from) || "(unknown sender)"} wrote:`;
    const originalText = currentBody.text?.trim() || currentBody.snippet || "";
    return {
      htmlBody: buildReplyHtml(intro, { html: currentBody.html, text: originalText }, info.signature),
      textBody: `\n\n${info.signature?.trim() ? `-- \n${info.signature.trimEnd()}\n\n` : ""}${intro}\n${quotePlainText(originalText)}`,
    };
  };

  const openReply = (target = selectedMessage) => {
    if (!target) return;
    const from = target.from?.address ?? addressLabel(target.from);
    const replyBody = bodyMatchesMessage(body, target)
      ? body
      : fallbackBodyFor(target);
    const replyBodyDraft = replyDraftBody(target, replyBody);
    openCompose({
      to: parseRecipientsText(from),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: { kind: "reply", folder: target.folder, uid: target.uid, messageId: target.messageId, subject: target.subject },
      richFormatUsed: true,
    }, false);
  };

  const openReplyAll = (target = selectedMessage) => {
    if (!target) return;
    const ownAddresses = new Set([
      normalizedMailAddress(info.emailAddress),
      normalizedMailAddress(info.imap.username),
      normalizedMailAddress(info.smtp.username),
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
    const replyBodyDraft = replyDraftBody(target, replyBody);
    openCompose({
      to: parseRecipientsText(to.join(", ")),
      cc: parseRecipientsText(cc.join(", ")),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      htmlBody: replyBodyDraft.htmlBody,
      textBody: replyBodyDraft.textBody,
      replyContext: { kind: "replyAll", folder: target.folder, uid: target.uid, messageId: target.messageId, subject: target.subject },
      richFormatUsed: true,
    }, false);
  };

  const handleSendDraft = async () => {
    // Convert compose-time data-URL previews (data-taomni-cid) to cid: for MIME.
    const htmlBody = prepareMailHtmlForSend(draft.htmlBody);
    const textBody = draft.textBody.trim() || mailHtmlToPlainText(htmlBody);
    const sendHtml = draft.richFormatUsed || hasRichMailFormatting(htmlBody);
    const request = {
      to: draft.to.map(formatRecipientForSend),
      cc: draft.cc.map(formatRecipientForSend),
      bcc: draft.bcc.map(formatRecipientForSend),
      subject: draft.subject.trim(),
      textBody,
      htmlBody: sendHtml ? htmlBody : null,
      attachments: draft.attachments.map((attachment) => ({
        path: attachment.path,
        name: attachment.name ?? null,
        contentType: attachment.contentType ?? null,
        inline: attachment.inline ?? false,
        contentId: attachment.contentId ?? null,
      })),
    };
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
    if (recipients.length === 0) {
      setError("At least one recipient is required.");
      return;
    }
    const invalidRecipient = recipients.find((recipient) => !isValidEmailAddress(recipient.email));
    if (invalidRecipient) {
      setError(`Invalid recipient: ${recipientLabel(invalidRecipient)}`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const result = await mailSendMessage(info, request);
      if (draft.id) {
        await mailDeleteDraft(info.sessionId, draft.id).catch(() => undefined);
        setDrafts((current) => current.filter((item) => item.id !== draft.id));
      }
      setStatus(result.accepted ? "Message sent" : result.response || "SMTP send returned no acceptance");
      setComposeOpen(false);
      setDraft(emptyComposeDraft());
    } catch (e) {
      setError(mailClientErrorMessage(e));
    } finally {
      setSending(false);
    }
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
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath);
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
      const result = await mailDownloadAttachment(info, message.folder, message.uid, index, targetPath);
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
        await mailDownloadAttachment(info, message.folder, message.uid, index, joinLocalPath(targetDir, fileName));
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
    displayFolders.find((folder) => folderMatchesSpecial(folder, kind))?.name ?? null;

  const resolveInboxFolder = (): string =>
    displayFolders.find((folder) => folder.name.toUpperCase() === "INBOX")?.name
    ?? displayFolders.find((folder) => `${folder.name} ${folderLabel(folder)}`.toLowerCase().includes("inbox"))?.name
    ?? "INBOX";

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
    const moved = await moveTargetsTo(targets, target);
    setStatus(moved > 0 ? `Moved ${moved} message${moved === 1 ? "" : "s"} to Junk` : "Already in Junk");
  });

  const handleNotJunkMessages = (targets: MailMessageHeader[]) => runMailAction(async () => {
    const target = resolveInboxFolder();
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

  const buildForwardBody = (target: MailMessageHeader): { htmlBody: string; textBody: string } => {
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
      htmlBody: buildForwardHtml(headerLines, { html: currentBody.html, text: originalText }, info.signature),
      textBody: `\n\n${info.signature?.trim() ? `-- \n${info.signature.trimEnd()}\n\n` : ""}---------- Forwarded message ----------\n${headerLines.join("\n")}\n\n${originalText}`,
    };
  };

  const openForward = (target = selectedMessage) => {
    if (!target) return;
    const forwardBody = buildForwardBody(target);
    openCompose({
      subject: forwardSubject(target.subject),
      htmlBody: forwardBody.htmlBody,
      textBody: forwardBody.textBody,
      replyContext: { kind: "forward", folder: target.folder, uid: target.uid, messageId: target.messageId, subject: target.subject },
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
    if (selectedFolder === folder.name) setSelectedFolder(target);
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
      { label: "Mark folder read", icon: <MailOpen className="w-3.5 h-3.5" />, disabled: markingRead, onClick: () => void handleMarkFolderRead(message.folder) },
      { label: "", separator: true },
      { label: `Archive${suffix}`, icon: <Archive className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleArchiveMessages(targets) },
      { label: `Move to${suffix}`, icon: <FolderInput className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleMoveMessages(t, folder)) },
      { label: `Copy to${suffix}`, icon: <FolderSymlink className="w-3.5 h-3.5" />, children: folderTargetChildren(targets, (t, folder) => void handleCopyMessages(t, folder)) },
      { label: `Mark as junk${suffix}`, icon: <Ban className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleJunkMessages(targets) },
      { label: `Not junk${suffix}`, icon: <Inbox className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleNotJunkMessages(targets) },
      { label: `Delete${suffix}`, icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, disabled: busyAction, onClick: () => void handleDeleteMessages(targets) },
      { label: "", separator: true },
      { label: "Save as .eml", icon: <Save className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleSaveEml(message) },
      { label: "View source", icon: <Code className="w-3.5 h-3.5" />, disabled: busyAction, onClick: () => void handleViewSource(message) },
      { label: "Print", icon: <Printer className="w-3.5 h-3.5" />, onClick: () => handlePrintMessage(message) },
      { label: "", separator: true },
      { label: "Copy subject", icon: <FileText className="w-3.5 h-3.5" />, onClick: () => copyText("subject", message.subject || "(no subject)") },
      { label: "Copy sender", icon: <MailIcon className="w-3.5 h-3.5" />, onClick: () => copyText("sender", addressLabel(message.from)) },
      { label: "Copy recipients", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => copyText("recipients", message.to.map(addressLabel).filter(Boolean).join(", ")) },
    ];
  };


  const folderMenuItems = (folder: MailFolder): MenuItem[] => {
    const isTrashLike = folderMatchesSpecial(folder, "trash") || folderMatchesSpecial(folder, "junk");
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
    ? `${info.cache.headerRetentionDays}d headers, ${info.cache.bodyRecentLimit} recent bodies`
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
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            ref={searchInputRef}
            className="taomni-input h-7 w-full pl-7 text-[12px]"
            placeholder="Search cached headers"
            aria-label="Search cached mail headers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
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
                </div>
                <div className="flex-1 min-h-0 py-1 overflow-auto">
                  {displayFolders.map((folder) => {
                    const active = folder.name === selectedFolder;
                    const label = folderLabel(folder);
                    return (
                      <button
                        key={folder.name}
                        type="button"
                        className={`w-full h-7 pr-3 flex items-center gap-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] ${active ? "bg-[var(--taomni-selected)] font-semibold" : ""}`}
                        style={{ paddingLeft: `${12 + Math.min(folderDepth(folder), 6) * 14}px` }}
                        data-active={active || undefined}
                        onClick={() => handleFolderSelect(folder)}
                        onContextMenu={(event) => mailMenu.show(event, folderMenuItems(folder))}
                      >
                        <span className="text-[var(--taomni-text-muted)]">{folderIcon(folder)}</span>
                        <span className="min-w-0 flex-1 truncate" title={label === folder.name ? folder.name : `${label} (${folder.name})`}>{label}</span>
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
                    IMAP {info.imap.host}:{info.imap.port}
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
                </div>
                <span className="text-[11px] text-[var(--taomni-text-muted)]">
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
                    {query ? "No cached messages match the search." : "No cached messages. Run Sync to refresh all folders."}
                  </div>
                ) : (
                  <>
                    {filteredMessages.map((message) => {
                      const active = messageKey(message) === selectedMessageKey;
                      const unread = isUnread(message);
                      return (
                        <div
                          key={messageKey(message)}
                          role="button"
                          tabIndex={0}
                          aria-pressed={active}
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
                            <div className="min-w-0 flex-1">
                              <div className={`min-w-0 text-[14px] leading-5 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "font-medium text-[var(--taomni-text-muted)]"}`}>
                                {message.subject || "(no subject)"}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4">
                                <span className={`min-w-0 truncate ${unread ? "font-semibold text-[var(--taomni-text)]" : "text-[var(--taomni-text-muted)]"}`}>
                                  {addressLabel(message.from) || "(unknown)"}
                                </span>
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
                    {!query.trim() && (hasMoreMessages || loadingMoreMessages) && (
                      <div className="p-2">
                        <button
                          type="button"
                          className="taomni-btn h-7 w-full inline-flex items-center justify-center gap-1.5 text-[12px]"
                          onClick={() => void loadMoreMessages()}
                          disabled={loadingMoreMessages}
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

      {draftsOpen && (
        <div className="absolute inset-0 z-[145] bg-black/30 flex items-center justify-center p-5">
          <MailDraggableDialog
            title="Local drafts"
            icon={<FileText className="w-4 h-4 text-[var(--taomni-text-muted)]" />}
            ariaLabel="Local drafts"
            minWidth={420}
            minHeight={300}
            className="w-[min(680px,90vw)] h-[min(520px,78vh)] min-h-[340px]"
            onClose={() => setDraftsOpen(false)}
          >
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
              <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={() => void refreshDrafts()} disabled={draftsLoading}>
                {draftsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
              <span className="text-[12px] text-[var(--taomni-text-muted)]">{drafts.length} draft{drafts.length === 1 ? "" : "s"}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-2" data-testid="mail-drafts-dialog">
              {drafts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  No saved drafts
                </div>
              ) : drafts.map((saved) => (
                <div
                  key={saved.id}
                  className="min-h-14 px-2 py-1.5 rounded border border-transparent hover:border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] flex items-center gap-2"
                  data-testid="mail-draft-row"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => openSavedDraft(saved)}
                  >
                    <div className="text-[12px] font-semibold truncate">{saved.subject || "(no subject)"}</div>
                    <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                      {[...saved.to, ...saved.cc, ...saved.bcc].join(", ") || "(no recipients)"}
                    </div>
                    <div className="text-[10px] text-[var(--taomni-text-muted)]">
                      {formatShortDate(saved.updatedAt)}
                      {saved.attachments.length > 0 ? ` · ${saved.attachments.length} attachment${saved.attachments.length === 1 ? "" : "s"}` : ""}
                    </div>
                  </button>
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
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 mr-auto" onClick={() => void handleAddDraftAttachments()} disabled={sending}>
                <Paperclip className="w-3.5 h-3.5" />
                Attach
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" data-testid="mail-compose-save-draft" onClick={() => void saveCurrentDraft("manual")} disabled={savingDraft || sending || !draftHasContent(draft)}>
                {savingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save draft
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={() => void discardCurrentDraft()} disabled={sending}>
                Discard
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5" data-primary="true" data-testid="mail-compose-send" onClick={handleSendDraft} disabled={sending}>
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
