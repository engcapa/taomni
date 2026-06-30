import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type UIEvent } from "react";
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
  Bot,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Inbox,
  Loader2,
  Mail as MailIcon,
  MailOpen,
  MessageSquareReply,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  mailClearCache,
  mailDownloadAttachment,
  mailGetMessageBody,
  mailListCachedFolders,
  mailListCachedMessages,
  mailMarkRead,
  mailSendMessage,
  mailSyncAllFolders,
  mailSyncHeaders,
  mailTestConnection,
  type MailAddress,
  type MailAttachmentInfo,
  type MailFolder,
  type MailMessageBody,
  type MailMessageHeader,
} from "../../lib/mail";
import { renderFormatted } from "../../lib/chat/renderFormatted";
import { temporaryFilePath } from "../../lib/ipc";
import { useChatStore } from "../../stores/chatStore";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { DEFAULT_MAIL_TERMINAL_PROFILE, resolveTerminalThemeWithSystem, type TerminalProfile } from "../../lib/terminalProfile";
import { useSystemPrefersDark } from "../../lib/systemColorScheme";

interface MailClientTabProps {
  tabId: string;
  info: MailTabInfo;
  visible: boolean;
}

interface ComposeDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

interface OpenMailMessageTab {
  key: string;
  message: MailMessageHeader;
}

type AiAction = "summarize" | "reply" | "tasks";
type SyncIndicator = "sync" | "more" | "none";

interface SyncFolderOptions {
  limit?: number;
  offset?: number;
  includeBodies?: boolean;
  append?: boolean;
  indicator?: SyncIndicator;
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

const EMPTY_DRAFT: ComposeDraft = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
};

const MAIL_MESSAGE_PAGE_SIZE = 200;
const MAIL_REFRESH_BATCH_SIZE = 50;
const MAILBOX_RIBBON_THRESHOLD = 7;
const MAILBOX_EXPANDED_SIZE = 14;
const MAIL_BASE_FONT_SIZE = DEFAULT_MAIL_TERMINAL_PROFILE.fontSize;
const MAIL_MIN_FONT_SIZE = 8;
const MAIL_MAX_FONT_SIZE = 32;

function messageKey(message: MailMessageHeader): string {
  return `${message.folder}:${message.uid}`;
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

function mailAppearanceStyle(profile: TerminalProfile | undefined, fontSize: number, systemPrefersDark: boolean): CSSProperties {
  const terminalProfile = profile ?? DEFAULT_MAIL_TERMINAL_PROFILE;
  const theme = resolveTerminalThemeWithSystem(terminalProfile.theme, systemPrefersDark);
  const background = color(theme.background, "#1d1f21");
  const foreground = color(theme.foreground, "#eaeaea");
  const accent = color(theme.blue ?? theme.cyan ?? theme.cursor, "#83a7d8");
  const divider = mixColor(foreground, background, 18);
  return {
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
    "--taomni-text": foreground,
    "--taomni-text-muted": mixColor(foreground, background, 62),
    fontFamily: terminalProfile.fontFamily,
    zoom: clampMailFontSize(fontSize) / MAIL_BASE_FONT_SIZE,
  } as CSSProperties;
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

function draftBodyWithSignature(body: string | undefined, signature: string | null | undefined): string {
  const cleanSignature = signature?.trimEnd();
  const cleanBody = body ?? "";
  if (!cleanSignature) return cleanBody;
  if (!cleanBody.trim()) return `\n\n${cleanSignature}`;
  if (cleanBody.includes(cleanSignature)) return cleanBody;
  return `${cleanBody.trimEnd()}\n\n${cleanSignature}`;
}

function suggestedAttachmentName(attachment: MailAttachmentInfo, index: number, subject?: string): string {
  const raw = attachment.name?.trim() || `${subject?.trim() || "attachment"}-${index + 1}`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || `attachment-${index + 1}`).slice(0, 160);
}

function splitRecipients(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

function sanitizeMailHtml(html: string, allowImages: boolean): string {
  const sanitized = renderFormatted(html, "html") ?? "";
  if (allowImages) return sanitized;
  if (typeof DOMParser === "undefined") {
    return sanitized.replace(/<img\b[^>]*>/gi, "[image blocked]");
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const placeholder = doc.createElement("span");
    placeholder.textContent = "[image blocked]";
    img.replaceWith(placeholder);
  });
  return doc.body.innerHTML;
}

function htmlToText(html: string): string {
  const sanitized = renderFormatted(html, "html") ?? html;
  if (typeof document === "undefined") {
    return sanitized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const node = document.createElement("div");
  node.innerHTML = sanitized;
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
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

export function MailClientTab({ tabId, info, visible }: MailClientTabProps) {
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
  const [bodyLoading, setBodyLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const [downloadingAttachmentIndex, setDownloadingAttachmentIndex] = useState<number | null>(null);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const initialSyncDoneRef = useRef(false);
  const foldersPanelRef = useRef<PanelImperativeHandle>(null);
  const [mailboxCollapsed, setMailboxCollapsed] = useState(false);
  const [mailboxPaneSize, setMailboxPaneSize] = useState(MAILBOX_EXPANDED_SIZE);
  const [mailFontSize, setMailFontSize] = useState(() =>
    clampMailFontSize(info.terminalProfile?.fontSize ?? MAIL_BASE_FONT_SIZE),
  );
  const attachmentMenu = useContextMenu();
  const mailMenu = useContextMenu();
  const systemPrefersDark = useSystemPrefersDark();

  const openTabChat = useChatStore((s) => s.openTabChat);
  const sendMessageToAi = useChatStore((s) => s.sendMessage);

  const displayFolders = folders.length > 0 ? folders : [{ ...DEFAULT_FOLDER, accountId: info.sessionId }];
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const batchSize = useMemo(() => refreshBatchSize(info), [info.sync.maxFetchPerSync]);
  const mailAppearance = useMemo(
    () => mailAppearanceStyle(info.terminalProfile, mailFontSize, systemPrefersDark),
    [info.terminalProfile, mailFontSize, systemPrefersDark],
  );
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

  const readerHtml = useMemo(() => {
    if (!body?.html) return null;
    return sanitizeMailHtml(body.html, allowRemoteImages);
  }, [allowRemoteImages, body?.html]);

  const visibleAttachments = useMemo(
    () => (body?.attachments.length ? body.attachments : selectedMessage?.attachments ?? []),
    [body?.attachments, selectedMessage?.attachments],
  );

  const increaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size + 1));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size - 1));
  }, []);

  const resetFontSize = useCallback(() => {
    setMailFontSize(clampMailFontSize(info.terminalProfile?.fontSize ?? MAIL_BASE_FONT_SIZE));
  }, [info.terminalProfile?.fontSize]);

  useEffect(() => {
    setMailFontSize(clampMailFontSize(info.terminalProfile?.fontSize ?? MAIL_BASE_FONT_SIZE));
  }, [info.sessionId, info.terminalProfile?.fontSize]);

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
    setLoadingFolders(true);
    setError(null);
    try {
      const cached = await mailListCachedFolders(info.sessionId);
      setFolders(cached);
      setSelectedFolder((current) =>
        cached.length > 0 && !cached.some((folder) => folder.name === current)
          ? cached[0].name
          : current,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingFolders(false);
    }
  }, [info.sessionId]);

  const loadCachedMessages = useCallback(async (folder: string, offset = 0, append = false, quiet = false) => {
    if (append) {
      setLoadingMoreMessages(true);
    } else {
      setLoadingMessages(true);
      setHasMoreMessages(false);
    }
    setError(null);
    try {
      const cached = await mailListCachedMessages(info.sessionId, folder, pageSize + 1, offset);
      const page = cached.slice(0, pageSize);
      const hasMore = cached.length > pageSize;
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
      setError(String(e));
      return { page: [] as MailMessageHeader[], hasMore: false };
    } finally {
      if (append) {
        setLoadingMoreMessages(false);
      } else {
        setLoadingMessages(false);
      }
    }
  }, [info.sessionId, pageSize]);

  const syncFolder = useCallback(async (
    folder = selectedFolder,
    quiet = false,
    options: SyncFolderOptions = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const append = options.append ?? false;
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? (offset > 0 ? pageSize : batchSize));
    const includeBodies = options.includeBodies ?? offset === 0;

    if (indicator === "more") {
      setLoadingMoreMessages(true);
    } else if (indicator === "sync") {
      setSyncing(true);
    }
    if (!quiet && indicator !== "none") setStatus(null);
    if (indicator !== "none") setError(null);

    try {
      const result = await mailSyncHeaders(info, folder, { limit, offset, includeBodies });
      setFolders(result.folders);
      setSelectedFolder(result.folder);
      setMessages((current) => mergeMessagePages(
        current.filter((message) => message.folder === result.folder),
        result.messages,
      ));
      setHasMoreMessages(result.hasMore);
      if (indicator !== "none") {
        setStatus(
          append
            ? result.fetchedMessages > 0 ? `Loaded ${result.fetchedMessages} older messages` : "No more messages"
            : `Synced ${result.fetchedMessages} messages, cached ${result.cachedBodies} bodies`,
        );
      }
      return result;
    } catch (e) {
      if (indicator !== "none") setError(String(e));
      return null;
    } finally {
      if (indicator === "more") {
        setLoadingMoreMessages(false);
      } else if (indicator === "sync") {
        setSyncing(false);
      }
    }
  }, [batchSize, info, pageSize, selectedFolder]);

  const syncAllFolders = useCallback(async (
    quiet = false,
    options: Pick<SyncFolderOptions, "limit" | "includeBodies" | "indicator"> = {},
  ) => {
    const indicator = options.indicator ?? "sync";
    const limit = Math.max(1, options.limit ?? batchSize);
    const includeBodies = options.includeBodies ?? true;
    const activeBeforeSync = selectedFolder;

    if (indicator === "sync") {
      setSyncing(true);
    }
    if (!quiet && indicator !== "none") setStatus(null);
    if (indicator !== "none") setError(null);

    try {
      const result = await mailSyncAllFolders(info, { limit, includeBodies });
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
          `Synced ${result.fetchedMessages} new messages across ${result.folders.length} folders, cached ${result.cachedBodies} bodies`,
        );
      }
      return result;
    } catch (e) {
      if (indicator !== "none") setError(String(e));
      return null;
    } finally {
      if (indicator === "sync") {
        setSyncing(false);
      }
    }
  }, [batchSize, info, loadCachedMessages, selectedFolder]);

  const loadBody = useCallback(async (message: MailMessageHeader) => {
    setBodyLoading(true);
    setError(null);
    try {
      const nextBody = await mailGetMessageBody(info, message.folder, message.uid);
      setBody(nextBody);
      setStatus(nextBody.source === "cache" ? "Loaded body from cache" : "Loaded body from server");
      return nextBody;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBodyLoading(false);
    }
  }, [info]);

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
      setError(String(e));
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
      setError(String(e));
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
    setSelectedFolder(message.folder);
    setSelectedMessageKey(messageKey(message));
    setMailViewKey(viewKey);
    setBody(null);
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
      setError(String(e));
    } finally {
      setMarkingRead(false);
    }
  }, [info, markMessagesReadLocally]);

  const loadInitialMessages = useCallback(async (folder: string) => {
    await loadCachedMessages(folder);
  }, [loadCachedMessages]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
    setFolders([]);
    setMessages([]);
    setSelectedMessageKey(null);
    setMailViewKey("mailbox");
    setMessageTabs([]);
    setPopupMessageKey(null);
    setCheckedMessageKeys(new Set());
    setBody(null);
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
    if (!visible || !info.sync.onOpen || initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    void syncAllFolders(true, {
      limit: batchSize,
      includeBodies: true,
      indicator: "sync",
    });
  }, [batchSize, info.sync.onOpen, syncAllFolders, visible]);

  useEffect(() => {
    if (info.sync.intervalMinutes <= 0) return;
    const intervalMs = Math.max(1, info.sync.intervalMinutes) * 60 * 1000;
    const id = window.setInterval(() => {
      void syncAllFolders(true, {
        limit: batchSize,
        includeBodies: true,
        indicator: "none",
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [batchSize, info.sync.intervalMinutes, syncAllFolders]);

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

  useEffect(() => {
    if (!selectedMessage) return;
    let cancelled = false;
    setAllowRemoteImages(false);
    void (async () => {
      await loadBody(selectedMessage);
      if (cancelled || !isUnread(selectedMessage)) return;
      try {
        const result = await mailMarkRead(info, selectedMessage.folder, [selectedMessage.uid], false);
        if (!cancelled && result.marked > 0) {
          markMessagesReadLocally(selectedMessage.folder, [selectedMessage.uid], result.marked);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, loadBody, markMessagesReadLocally, selectedMessage]);

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
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      await mailClearCache(info.sessionId);
      setFolders([]);
      setMessages([]);
      setBody(null);
      setSelectedMessageKey(null);
      setMailViewKey("mailbox");
      setMessageTabs([]);
      setPopupMessageKey(null);
      setCheckedMessageKeys(new Set());
      setHasMoreMessages(false);
      setLoadingMoreMessages(false);
      setStatus("Mail cache cleared");
    } catch (e) {
      setError(String(e));
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

  const openCompose = (nextDraft: Partial<ComposeDraft> = {}) => {
    setDraft({
      ...EMPTY_DRAFT,
      ...nextDraft,
      body: draftBodyWithSignature(nextDraft.body, info.signature),
    });
    setComposeOpen(true);
  };

  const openReply = (target = selectedMessage) => {
    if (!target) return;
    const from = target.from?.address ?? addressLabel(target.from);
    const replyBody = body && body.uid === target.uid && body.folder === target.folder
      ? body
      : {
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
        } satisfies MailMessageBody;
    openCompose({
      to: from,
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      body: bodyTextForAi(replyBody),
    });
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
    const replyBody = body && body.uid === target.uid && body.folder === target.folder
      ? body
      : {
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
        } satisfies MailMessageBody;
    openCompose({
      to: to.join(", "),
      cc: cc.join(", "),
      subject: target.subject.toLowerCase().startsWith("re:")
        ? target.subject
        : `Re: ${target.subject || "(no subject)"}`,
      body: bodyTextForAi(replyBody),
    });
  };

  const handleSendDraft = async () => {
    const request = {
      to: splitRecipients(draft.to),
      cc: splitRecipients(draft.cc),
      bcc: splitRecipients(draft.bcc),
      subject: draft.subject.trim(),
      textBody: draft.body,
      htmlBody: null,
    };
    if (request.to.length === 0) {
      setError("At least one recipient is required.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const result = await mailSendMessage(info, request);
      setStatus(result.accepted ? "Message sent" : result.response || "SMTP send returned no acceptance");
      setComposeOpen(false);
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

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
      setError(String(e));
    }
  };

  const handleDownloadAttachment = async (attachment: MailAttachmentInfo, index: number) => {
    if (!selectedMessage) return;
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultPath = suggestedAttachmentName(attachment, index, selectedMessage.subject);
      const targetPath = await save({
        title: "Save attachment",
        defaultPath,
      });
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        setStatus("Attachment download cancelled");
        return;
      }
      const result = await mailDownloadAttachment(info, selectedMessage.folder, selectedMessage.uid, index, targetPath);
      setStatus(`Downloaded attachment to ${result.path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const handleOpenAttachment = async (attachment: MailAttachmentInfo, index: number) => {
    if (!selectedMessage) return;
    setDownloadingAttachmentIndex(index);
    setError(null);
    try {
      const defaultPath = suggestedAttachmentName(attachment, index, selectedMessage.subject);
      const targetPath = await temporaryFilePath(defaultPath);
      const result = await mailDownloadAttachment(info, selectedMessage.folder, selectedMessage.uid, index, targetPath);
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(result.path);
      setStatus(`Opened attachment ${result.name || defaultPath}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloadingAttachmentIndex(null);
    }
  };

  const attachmentMenuItems = (attachment: MailAttachmentInfo, index: number): MenuItem[] => [
    {
      label: "Save attachment as...",
      icon: <Download className="w-3.5 h-3.5" />,
      onClick: () => void handleDownloadAttachment(attachment, index),
    },
    {
      label: "Open with default app",
      icon: <ExternalLink className="w-3.5 h-3.5" />,
      onClick: () => void handleOpenAttachment(attachment, index),
    },
  ];

  const handleAttachmentContextMenu = (
    event: ReactMouseEvent,
    attachment: MailAttachmentInfo,
    index: number,
  ) => {
    attachmentMenu.show(event, attachmentMenuItems(attachment, index));
  };

  const copyText = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text)
      .then(() => setStatus(`Copied ${label}`))
      .catch((e) => setError(String(e)));
  };

  const messageMenuItems = (message: MailMessageHeader): MenuItem[] => [
    {
      label: "Open",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      onClick: () => selectMessage(message, "mailbox"),
    },
    {
      label: "Open in mail tab",
      icon: <FileText className="w-3.5 h-3.5" />,
      onClick: () => openMessageTab(message),
    },
    {
      label: "Open in popup window",
      icon: <ExternalLink className="w-3.5 h-3.5" />,
      onClick: () => openMessagePopup(message),
    },
    { label: "", separator: true },
    {
      label: "Reply",
      icon: <MessageSquareReply className="w-3.5 h-3.5" />,
      onClick: () => openReply(message),
    },
    {
      label: "Reply all",
      icon: <MessageSquareReply className="w-3.5 h-3.5" />,
      onClick: () => openReplyAll(message),
    },
    {
      label: "Forward",
      icon: <Send className="w-3.5 h-3.5" />,
      disabled: true,
      onClick: () => undefined,
    },
    { label: "", separator: true },
    {
      label: "Mark as read",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      disabled: !isUnread(message) || markingRead,
      onClick: () => void handleMarkSingleRead(message),
    },
    {
      label: "Mark folder read",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      disabled: markingRead,
      onClick: () => void handleMarkFolderRead(message.folder),
    },
    { label: "", separator: true },
    {
      label: "Copy subject",
      icon: <FileText className="w-3.5 h-3.5" />,
      onClick: () => copyText("subject", message.subject || "(no subject)"),
    },
    {
      label: "Copy sender",
      icon: <MailIcon className="w-3.5 h-3.5" />,
      onClick: () => copyText("sender", addressLabel(message.from)),
    },
  ];

  const folderMenuItems = (folder: MailFolder): MenuItem[] => [
    {
      label: "Open folder",
      icon: folderIcon(folder),
      onClick: () => handleFolderSelect(folder),
    },
    {
      label: "Sync all folders",
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      disabled: syncing,
      onClick: () => void syncAllFolders(false, {
        limit: batchSize,
        includeBodies: true,
        indicator: "sync",
      }),
    },
    {
      label: "Mark folder read",
      icon: <MailOpen className="w-3.5 h-3.5" />,
      disabled: markingRead || (folder.unread ?? 0) === 0,
      onClick: () => void handleMarkFolderRead(folder.name),
    },
    { label: "", separator: true },
    {
      label: "Copy folder name",
      icon: <Folder className="w-3.5 h-3.5" />,
      onClick: () => copyText("folder name", folder.name),
    },
  ];

  const messageListMenuItems = (): MenuItem[] => [
    {
      label: "Sync all folders",
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      disabled: syncing,
      onClick: () => void syncAllFolders(false, {
        limit: batchSize,
        includeBodies: true,
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

  const activeFolder = displayFolders.find((folder) => folder.name === selectedFolder) ?? displayFolders[0];
  const cacheLine = info.cache.enabled
    ? `${info.cache.headerRetentionDays}d headers, ${info.cache.bodyRecentLimit} recent bodies`
    : "cache off";
  const renderReaderSurface = (message: MailMessageHeader | null, popup = false) => {
    const currentBody = message && body?.uid === message.uid && body.folder === message.folder ? body : null;
    const currentHtml = currentBody?.html ? sanitizeMailHtml(currentBody.html, allowRemoteImages) : null;
    const currentAttachments = currentBody?.attachments.length ? currentBody.attachments : message?.attachments ?? [];
    const loadingThisBody = !!message && bodyLoading && selectedMessageKey === messageKey(message);

    return (
      <main
        className="h-full min-w-0 flex flex-col"
        onContextMenu={(event) => {
          if (message) {
            mailMenu.show(event, messageMenuItems(message));
          } else {
            mailMenu.show(event, messageListMenuItems());
          }
        }}
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
                {currentBody?.html && (
                  <button
                    type="button"
                    className="taomni-btn h-5 px-2 text-[10px]"
                    onClick={() => setAllowRemoteImages((value) => !value)}
                  >
                    {allowRemoteImages ? "Block images" : "Load images"}
                  </button>
                )}
              </div>
              {currentAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {currentAttachments.map((attachment, index) => {
                    const downloading = downloadingAttachmentIndex === index;
                    const name = attachment.name || `attachment-${index + 1}`;
                    return (
                      <button
                        key={`${name}-${index}`}
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                        title={`Download ${name}; right-click for more actions`}
                        onClick={() => void handleDownloadAttachment(attachment, index)}
                        onContextMenu={(event) => handleAttachmentContextMenu(event, attachment, index)}
                        disabled={downloading}
                      >
                        {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                        <span className="max-w-[360px] truncate">{name}</span>
                        {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="p-5 text-[13px] leading-6">
              {loadingThisBody && !currentBody ? (
                <div className="h-32 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Loading message body
                </div>
              ) : currentHtml ? (
                <div
                  className="max-w-none text-[13px] leading-6 [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--taomni-divider)] [&_td]:px-2 [&_td]:py-1 [&_a]:text-[var(--taomni-accent)]"
                  dangerouslySetInnerHTML={{ __html: currentHtml }}
                />
              ) : currentBody?.text ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6">{currentBody.text}</pre>
              ) : (
                <div className="text-[12px] text-[var(--taomni-text-muted)]">
                  {message.snippet || "No cached body content."}
                </div>
              )}
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
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5" onClick={() => openCompose()}>
          <MailIcon className="w-3.5 h-3.5" />
          Compose
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={() => void syncAllFolders(false, {
            limit: batchSize,
            includeBodies: true,
            indicator: "sync",
          })}
          disabled={syncing}
          data-testid="mail-sync-button"
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Sync
        </button>
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
          <span className={error ? "text-red-500 truncate" : "text-[var(--taomni-text-muted)] truncate"}>{error ?? status}</span>
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
                          onClick={() => {
                            setSelectedMessageKey(messageKey(message));
                            setBody(null);
                          }}
                          onDoubleClick={() => openMessageTab(message)}
                          onContextMenu={(event) => mailMenu.show(event, messageMenuItems(message))}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            setSelectedMessageKey(messageKey(message));
                            setBody(null);
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
              onContextMenu={(event) => {
                if (selectedMessage) {
                  mailMenu.show(event, messageMenuItems(selectedMessage));
                } else {
                  mailMenu.show(event, messageListMenuItems());
                }
              }}
            >
              <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
                <span className="text-[12px] font-semibold min-w-0 truncate">
                  {selectedMessage?.subject || "Message"}
                </span>
                {bodyLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
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
                      <span>{body?.source === "cache" ? "cached body" : body?.source === "remote" ? "remote body" : "header cached"}</span>
                      {selectedMessage.rawSize ? <span>{formatBytes(selectedMessage.rawSize)}</span> : null}
                      {info.ai.enabled && <span>AI confirm {info.ai.skipBodyConfirm ? "skipped" : "required"}</span>}
                      {body?.html && (
                        <button
                          type="button"
                          className="taomni-btn h-5 px-2 text-[10px]"
                          onClick={() => setAllowRemoteImages((value) => !value)}
                        >
                          {allowRemoteImages ? "Block images" : "Load images"}
                        </button>
                      )}
                    </div>
                    {visibleAttachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {visibleAttachments.map((attachment, index) => {
                          const downloading = downloadingAttachmentIndex === index;
                          const name = attachment.name || `attachment-${index + 1}`;
                          return (
                            <button
                              key={`${name}-${index}`}
                              type="button"
                              className="inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-60"
                              title={`Download ${name}; right-click for more actions`}
                              onClick={() => void handleDownloadAttachment(attachment, index)}
                              onContextMenu={(event) => handleAttachmentContextMenu(event, attachment, index)}
                              disabled={downloading}
                            >
                              {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                              <span className="max-w-[260px] truncate">{name}</span>
                              {attachment.size ? <span>{formatBytes(attachment.size)}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="p-4 text-[13px] leading-6">
                    {bodyLoading && !body ? (
                      <div className="h-32 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Loading message body
                      </div>
                    ) : readerHtml ? (
                      <div
                        className="max-w-none text-[13px] leading-6 [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--taomni-divider)] [&_td]:px-2 [&_td]:py-1 [&_a]:text-[var(--taomni-accent)]"
                        dangerouslySetInnerHTML={{ __html: readerHtml }}
                      />
                    ) : body?.text ? (
                      <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6">{body.text}</pre>
                    ) : (
                      <div className="text-[12px] text-[var(--taomni-text-muted)]">
                        {selectedMessage.snippet || "No cached body content."}
                      </div>
                    )}
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

      {popupMessage && (
        <div className="absolute inset-0 z-[130] bg-black/35 flex items-center justify-center p-5">
          <section
            className="w-[min(1120px,92vw)] h-[min(780px,86vh)] min-h-[480px] flex flex-col rounded-md border shadow-2xl"
            style={{
              background: "var(--taomni-bg)",
              borderColor: "var(--taomni-divider)",
              color: "var(--taomni-text)",
            }}
            role="dialog"
            aria-modal="true"
            aria-label={popupMessage.subject || "Mail message"}
          >
            <div className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
              <MailOpen className="w-4 h-4 text-[var(--taomni-text-muted)]" />
              <span className="text-[12px] font-semibold min-w-0 flex-1 truncate">
                {popupMessage.subject || "(no subject)"}
              </span>
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px]"
                onClick={() => openMessageTab(popupMessage)}
              >
                Open tab
              </button>
              <button
                type="button"
                className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
                onClick={() => setPopupMessageKey(null)}
                aria-label="Close popup"
                title="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {renderReaderSurface(popupMessage, true)}
            </div>
          </section>
        </div>
      )}

      {composeOpen && (
        <div className="absolute inset-0 z-[150] bg-black/30 flex items-center justify-center p-4">
          <div className="w-[760px] max-w-[calc(100vw-48px)] max-h-[calc(100vh-72px)] flex flex-col rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] shadow-xl">
            <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
              <MailIcon className="w-4 h-4 text-[var(--taomni-text-muted)]" />
              <span className="text-[12px] font-semibold">New message</span>
              <button type="button" className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center ml-auto" onClick={() => setComposeOpen(false)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-3 grid grid-cols-[56px_1fr] gap-2 text-[12px]">
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-to-${tabId}`}>To</label>
              <input id={`mail-to-${tabId}`} className="taomni-input h-7" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-cc-${tabId}`}>Cc</label>
              <input id={`mail-cc-${tabId}`} className="taomni-input h-7" value={draft.cc} onChange={(event) => setDraft((current) => ({ ...current, cc: event.target.value }))} />
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-bcc-${tabId}`}>Bcc</label>
              <input id={`mail-bcc-${tabId}`} className="taomni-input h-7" value={draft.bcc} onChange={(event) => setDraft((current) => ({ ...current, bcc: event.target.value }))} />
              <label className="self-center text-[var(--taomni-text-muted)]" htmlFor={`mail-subject-${tabId}`}>Subject</label>
              <input id={`mail-subject-${tabId}`} className="taomni-input h-7" value={draft.subject} onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))} />
            </div>
            <textarea
              className="taomni-input mx-3 mb-3 min-h-[260px] flex-1 resize-none font-sans text-[13px] leading-6"
              value={draft.body}
              onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
              aria-label="Message body"
            />
            <div className="h-10 px-3 flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
              <button type="button" className="taomni-btn h-7 px-3 text-[12px]" onClick={() => setComposeOpen(false)} disabled={sending}>
                Discard
              </button>
              <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5" data-primary="true" onClick={handleSendDraft} disabled={sending}>
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
