import {
  Archive,
  Bot,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Star,
  Trash2,
} from "lucide-react";
import type { MailTabInfo } from "../../types";

interface MailClientTabProps {
  info: MailTabInfo;
}

const PREVIEW_MESSAGES = [
  {
    id: "welcome",
    from: "Taomni Mail",
    subject: "Mail workspace is ready for IMAP/SMTP integration",
    excerpt: "This tab is wired as a saved Mail session. The next task will replace this placeholder with the backend mailbox sync.",
    time: "Now",
    unread: true,
    hasAttachment: false,
  },
  {
    id: "ai",
    from: "AI Assistant",
    subject: "Account-level AI policy",
    excerpt: "This account can be configured to allow mail body analysis without a per-message confirmation.",
    time: "Draft",
    unread: false,
    hasAttachment: true,
  },
];

export function MailClientTab({ info }: MailClientTabProps) {
  const folders = [
    { id: "inbox", label: "Inbox", count: 0, icon: <Inbox className="w-4 h-4" /> },
    { id: "unread", label: "Unread", count: 0, icon: <MailOpen className="w-4 h-4" /> },
    { id: "starred", label: "Starred", count: 0, icon: <Star className="w-4 h-4" /> },
    { id: "sent", label: "Sent", count: 0, icon: <Send className="w-4 h-4" /> },
    { id: "archive", label: "Archive", count: 0, icon: <Archive className="w-4 h-4" /> },
    { id: "trash", label: "Trash", count: 0, icon: <Trash2 className="w-4 h-4" /> },
  ];

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5">
          <Mail className="w-3.5 h-3.5" />
          Compose
        </button>
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          Sync
        </button>
        <div className="relative w-[320px] max-w-[40vw]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search this mailbox"
            aria-label="Search this mailbox"
          />
        </div>
        <button type="button" className="taomni-btn h-7 px-2 inline-flex items-center gap-1.5 ml-auto">
          <Bot className="w-3.5 h-3.5" />
          AI
        </button>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {info.emailAddress || info.imap.username || info.imap.host}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(280px,34%)_1fr]">
        <aside className="min-w-0 border-r border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
          <div className="h-8 flex items-center px-3 text-[12px] font-semibold border-b border-[var(--taomni-divider)]">
            Mailbox
          </div>
          <div className="py-1">
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                className="w-full h-7 px-3 flex items-center gap-2 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
                data-active={folder.id === "inbox" || undefined}
              >
                <span className="text-[var(--taomni-text-muted)]">{folder.icon}</span>
                <span className="min-w-0 flex-1 truncate">{folder.label}</span>
                <span className="text-[11px] text-[var(--taomni-text-muted)]">{folder.count}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 px-3 text-[11px] text-[var(--taomni-text-muted)]">
            IMAP {info.imap.host}:{info.imap.port} · SMTP {info.smtp.host}:{info.smtp.port}
          </div>
        </aside>

        <section className="min-w-0 border-r border-[var(--taomni-divider)]">
          <div className="h-8 px-3 flex items-center justify-between border-b border-[var(--taomni-divider)]">
            <span className="text-[12px] font-semibold">Inbox</span>
            <span className="text-[11px] text-[var(--taomni-text-muted)]">Placeholder</span>
          </div>
          <div>
            {PREVIEW_MESSAGES.map((message) => (
              <button
                key={message.id}
                type="button"
                className="w-full min-h-[72px] px-3 py-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              >
                <div className="flex items-center gap-2">
                  <span className={message.unread ? "font-semibold text-[12px]" : "text-[12px]"}>
                    {message.from}
                  </span>
                  {message.hasAttachment && <Paperclip className="w-3 h-3 text-[var(--taomni-text-muted)]" />}
                  <span className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">{message.time}</span>
                </div>
                <div className={message.unread ? "font-semibold text-[12px] truncate mt-1" : "text-[12px] truncate mt-1"}>
                  {message.subject}
                </div>
                <div className="text-[11px] text-[var(--taomni-text-muted)] line-clamp-2 mt-1">
                  {message.excerpt}
                </div>
              </button>
            ))}
          </div>
        </section>

        <main className="min-w-0 flex flex-col">
          <div className="h-8 px-3 flex items-center border-b border-[var(--taomni-divider)]">
            <span className="text-[12px] font-semibold">Message</span>
            <span className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">
              AI body confirm: {info.ai.skipBodyConfirm ? "off" : "on"}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-4 text-[13px] leading-6">
            <h2 className="text-[16px] font-semibold mb-1">Mail workspace shell</h2>
            <div className="text-[12px] text-[var(--taomni-text-muted)] mb-4">
              {info.displayName || info.emailAddress} · cache keeps {info.cache.bodyRecentLimit} recent bodies
            </div>
            <p>
              This is the Outlook/Thunderbird-style dense mail workspace that will host the IMAP
              folder tree, message list, secure HTML reader, composer, and AI actions.
            </p>
            <p className="mt-3">
              The session model already carries account endpoints, vault-backed credentials,
              cache limits, and the account-level AI confirmation policy.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
