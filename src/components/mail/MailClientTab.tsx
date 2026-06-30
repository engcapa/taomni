import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  Download,
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
} from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  mailClearCache,
  mailDownloadAttachment,
  mailGetMessageBody,
  mailListCachedFolders,
  mailListCachedMessages,
  mailSendMessage,
  mailSyncHeaders,
  mailTestConnection,
  type MailAddress,
  type MailAttachmentInfo,
  type MailFolder,
  type MailMessageBody,
  type MailMessageHeader,
} from "../../lib/mail";
import { renderFormatted } from "../../lib/chat/renderFormatted";
import { useChatStore } from "../../stores/chatStore";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";

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

type AiAction = "summarize" | "reply" | "tasks";

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

function messageKey(message: MailMessageHeader): string {
  return `${message.folder}:${message.uid}`;
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

function mergeMessagePages(current: MailMessageHeader[], next: MailMessageHeader[]): MailMessageHeader[] {
  const seen = new Set(current.map(messageKey));
  const uniqueNext = next.filter((message) => {
    const key = messageKey(message);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return current.concat(uniqueNext);
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
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("INBOX");
  const [messages, setMessages] = useState<MailMessageHeader[]>([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);
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
  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const [downloadingAttachmentIndex, setDownloadingAttachmentIndex] = useState<number | null>(null);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const initialSyncDoneRef = useRef(false);

  const openTabChat = useChatStore((s) => s.openTabChat);
  const sendMessageToAi = useChatStore((s) => s.sendMessage);

  const displayFolders = folders.length > 0 ? folders : [{ ...DEFAULT_FOLDER, accountId: info.sessionId }];
  const pageSize = useMemo(() => messagePageSize(info), [info.sync.maxFetchPerSync]);
  const selectedMessage = useMemo(
    () => messages.find((message) => messageKey(message) === selectedMessageKey) ?? null,
    [messages, selectedMessageKey],
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

  const readerHtml = useMemo(() => {
    if (!body?.html) return null;
    return sanitizeMailHtml(body.html, allowRemoteImages);
  }, [allowRemoteImages, body?.html]);

  const visibleAttachments = useMemo(
    () => (body?.attachments.length ? body.attachments : selectedMessage?.attachments ?? []),
    [body?.attachments, selectedMessage?.attachments],
  );

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

  const loadCachedMessages = useCallback(async (folder: string, offset = 0, append = false) => {
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
      setHasMoreMessages(cached.length > pageSize);
      setMessages((current) => append ? mergeMessagePages(current, page) : page);
      setStatus(
        append
          ? page.length > 0 ? `Loaded ${page.length} older cached messages` : "No more cached messages"
          : page.length > 0 ? `Loaded ${page.length} cached messages` : "No cached messages",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      if (append) {
        setLoadingMoreMessages(false);
      } else {
        setLoadingMessages(false);
      }
    }
  }, [info.sessionId, pageSize]);

  const syncFolder = useCallback(async (folder = selectedFolder, quiet = false) => {
    setSyncing(true);
    if (!quiet) setStatus(null);
    setError(null);
    try {
      const result = await mailSyncHeaders(info, folder);
      setFolders(result.folders);
      setSelectedFolder(result.folder);
      setMessages(result.messages.slice(0, pageSize));
      setHasMoreMessages(result.messages.length >= Math.max(1, Math.min(pageSize, info.sync.maxFetchPerSync || pageSize)));
      setLoadingMoreMessages(false);
      setStatus(`Synced ${result.fetchedMessages} messages, cached ${result.cachedBodies} bodies`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [info, pageSize, selectedFolder]);

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

  useEffect(() => {
    initialSyncDoneRef.current = false;
    setFolders([]);
    setMessages([]);
    setSelectedMessageKey(null);
    setBody(null);
    setHasMoreMessages(false);
    setLoadingMoreMessages(false);
    setDownloadingAttachmentIndex(null);
    setSelectedFolder("INBOX");
    void loadCachedFolders();
  }, [info.sessionId, loadCachedFolders]);

  useEffect(() => {
    void loadCachedMessages(selectedFolder);
  }, [loadCachedMessages, selectedFolder]);

  useEffect(() => {
    if (!visible || !info.sync.onOpen || initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    void syncFolder(selectedFolder, true);
  }, [info.sync.onOpen, selectedFolder, syncFolder, visible]);

  useEffect(() => {
    if (!visible || info.sync.intervalMinutes <= 0) return;
    const intervalMs = Math.max(1, info.sync.intervalMinutes) * 60 * 1000;
    const id = window.setInterval(() => {
      void syncFolder(selectedFolder, true);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [info.sync.intervalMinutes, selectedFolder, syncFolder, visible]);

  useEffect(() => {
    if (messages.length === 0) {
      setSelectedMessageKey(null);
      setBody(null);
      return;
    }
    if (!selectedMessageKey || !messages.some((message) => messageKey(message) === selectedMessageKey)) {
      setSelectedMessageKey(messageKey(messages[0]));
      setBody(null);
    }
  }, [messages, selectedMessageKey]);

  useEffect(() => {
    if (!selectedMessage) return;
    setAllowRemoteImages(false);
    void loadBody(selectedMessage);
  }, [loadBody, selectedMessage]);

  const handleFolderSelect = (folder: MailFolder) => {
    setSelectedFolder(folder.name);
    setSelectedMessageKey(null);
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
    await loadCachedMessages(selectedFolder, messages.length, true);
  }, [
    hasMoreMessages,
    loadCachedMessages,
    loadingMessages,
    loadingMoreMessages,
    messages.length,
    query,
    selectedFolder,
  ]);

  const handleMessageListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 96) {
      void loadMoreMessages();
    }
  }, [loadMoreMessages]);

  const openCompose = (nextDraft: Partial<ComposeDraft> = {}) => {
    setDraft({ ...EMPTY_DRAFT, ...nextDraft });
    setComposeOpen(true);
  };

  const openReply = () => {
    if (!selectedMessage) return;
    const from = selectedMessage.from?.address ?? addressLabel(selectedMessage.from);
    openCompose({
      to: from,
      subject: selectedMessage.subject.toLowerCase().startsWith("re:")
        ? selectedMessage.subject
        : `Re: ${selectedMessage.subject || "(no subject)"}`,
      body: bodyTextForAi(body ?? {
        accountId: selectedMessage.accountId,
        folder: selectedMessage.folder,
        uid: selectedMessage.uid,
        messageId: selectedMessage.messageId,
        subject: selectedMessage.subject,
        text: selectedMessage.snippet ?? "",
        html: null,
        snippet: selectedMessage.snippet,
        attachments: [],
        rawSize: selectedMessage.rawSize,
        cachedAt: null,
        source: "header",
      }),
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

  const activeFolder = displayFolders.find((folder) => folder.name === selectedFolder) ?? displayFolders[0];
  const cacheLine = info.cache.enabled
    ? `${info.cache.headerRetentionDays}d headers, ${info.cache.bodyRecentLimit} recent bodies`
    : "cache off";

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]" data-testid="mail-client-tab">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5" onClick={() => openCompose()}>
          <MailIcon className="w-3.5 h-3.5" />
          Compose
        </button>
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5"
          onClick={() => void syncFolder(selectedFolder)}
          disabled={syncing}
          data-testid="mail-sync-button"
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Sync
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
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5 ml-auto" onClick={() => void openTabChat(tabId)}>
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

      {(error || status) && (
        <div className="h-7 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[11px] bg-[var(--taomni-sidebar-bg)]">
          {error ? <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
          <span className={error ? "text-red-500 truncate" : "text-[var(--taomni-text-muted)] truncate"}>{error ?? status}</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <PanelGroup
          orientation="horizontal"
          id={`mail-client-${info.sessionId}`}
          defaultLayout={loadResizableLayout(`mail-client-${info.sessionId}`, ["folders", "messages", "reader"])}
          onLayoutChanged={saveResizableLayout(`mail-client-${info.sessionId}`)}
          className="h-full min-h-0"
        >
          <Panel id="folders" defaultSize="14%" minSize="10%" maxSize="35%" className="min-w-0">
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
          </Panel>

          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />

          <Panel id="messages" defaultSize="34%" minSize="18%" maxSize="55%" className="min-w-0">
            <section className="h-full min-w-0 flex flex-col">
              <div className="h-8 shrink-0 px-3 flex items-center justify-between border-b border-[var(--taomni-divider)]">
                <span className="text-[12px] font-semibold truncate" title={activeFolder?.name}>{folderLabel(activeFolder)}</span>
                <span className="text-[11px] text-[var(--taomni-text-muted)]">
                  {loadingMessages ? "Loading" : `${filteredMessages.length}/${messages.length}${!query.trim() && hasMoreMessages ? "+" : ""}`}
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto" onScroll={handleMessageListScroll}>
                {loadingMessages && messages.length === 0 ? (
                  <div className="h-20 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading cached headers
                  </div>
                ) : filteredMessages.length === 0 ? (
                  <div className="h-28 flex items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
                    {query ? "No cached messages match the search." : "No cached messages. Run Sync for this folder."}
                  </div>
                ) : (
                  <>
                    {filteredMessages.map((message) => {
                      const active = messageKey(message) === selectedMessageKey;
                      const unread = isUnread(message);
                      return (
                        <button
                          key={messageKey(message)}
                          type="button"
                          className={`w-full min-h-[82px] px-3 py-2.5 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${active ? "bg-[var(--taomni-selected)]" : ""}`}
                          onClick={() => {
                            setSelectedMessageKey(messageKey(message));
                            setBody(null);
                          }}
                        >
                          <div className="flex items-start gap-2">
                            <div className={`min-w-0 flex-1 text-[13px] leading-5 truncate ${unread ? "font-semibold" : "font-medium"}`}>
                              {message.subject || "(no subject)"}
                            </div>
                            <span className="text-[11px] text-[var(--taomni-text-muted)] shrink-0 leading-5">{formatShortDate(message.dateTs)}</span>
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
                        </button>
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
            <main className="h-full min-w-0 flex flex-col">
              <div className="h-8 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)]">
                <span className="text-[12px] font-semibold min-w-0 truncate">
                  {selectedMessage?.subject || "Message"}
                </span>
                {bodyLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                    onClick={openReply}
                    disabled={!selectedMessage}
                    title="Reply"
                  >
                    <MessageSquareReply className="w-3.5 h-3.5" />
                    Reply
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
                              title={`Download ${name}`}
                              onClick={() => void handleDownloadAttachment(attachment, index)}
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
      </div>

      {composeOpen && (
        <div className="absolute inset-0 z-[120] bg-black/30 flex items-center justify-center p-4">
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
