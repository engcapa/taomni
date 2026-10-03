import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Inbox, Loader2, MailOpen, Mail as MailIcon, RefreshCw, Star, Trash2 } from "lucide-react";
import type { MailTabInfo } from "../../types";
import {
  mailDeleteMessages,
  mailGetMessageBody,
  mailListCachedFolders,
  mailListCachedMessages,
  mailMoveMessages,
  mailSearchMessages,
  mailSetFlags,
  mailSyncFolder,
  type MailFolder,
  type MailMessageBody,
  type MailMessageHeader,
} from "../../lib/mail";
import {
  MAIL_UNIFIED_VIEWS,
  accountLabel,
  isStarred,
  isUnreadMessage,
  mergeUnified,
  unifiedFolderFor,
  unifiedKey,
  type MailUnifiedView,
  type UnifiedMessage,
} from "../../lib/mailUnified";
import { MailMessageBodyView } from "./MailMessageBodyView";

export interface MailUnifiedTabProps {
  /** Every saved mail account (built like a regular mail tab's info). */
  accounts: MailTabInfo[];
  visible: boolean;
  /** Open the account's own mail tab. */
  onOpenAccount?: (sessionId: string) => void;
}

const PER_ACCOUNT_LIMIT = 200;

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

function sender(message: MailMessageHeader): string {
  return message.from?.name?.trim() || message.from?.address || "(unknown sender)";
}

function withFlags(message: MailMessageHeader, add: string[], remove: string[]): MailMessageHeader {
  const lower = remove.map((flag) => flag.toLowerCase());
  const flags = message.flags.filter((flag) => !lower.includes(flag.toLowerCase()));
  for (const flag of add) if (!flags.some((existing) => existing.toLowerCase() === flag.toLowerCase())) flags.push(flag);
  return { ...message, flags };
}

export function MailUnifiedTab({ accounts, visible, onOpenAccount }: MailUnifiedTabProps) {
  const [view, setView] = useState<MailUnifiedView>("inbox");
  const [entries, setEntries] = useState<UnifiedMessage[]>([]);
  const [folders, setFolders] = useState<Record<string, MailFolder[]>>({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [accountErrors, setAccountErrors] = useState<Record<string, string>>({});
  /** Failures of the last Get mail, kept across the reload that follows. */
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [body, setBody] = useState<{ key: string; body: MailMessageBody | null; loading: boolean; error?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const byId = useMemo(() => new Map(accounts.map((info) => [info.sessionId, info])), [accounts]);
  const accountKey = accounts.map((info) => info.sessionId).join("|");

  /** Folder of `view` for one account (null: the account has no such folder). */
  const folderFor = useCallback((info: MailTabInfo, list: MailFolder[], kind: "inbox" | "sent" | "drafts" | "trash") =>
    unifiedFolderFor(list, kind, info.specialFolders), []);

  const load = useCallback(async (target: MailUnifiedView) => {
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    setLoading(true);
    const nextFolders: Record<string, MailFolder[]> = {};
    const errors: Record<string, string> = {};
    const lists = await Promise.all(accounts.map(async (info): Promise<UnifiedMessage[]> => {
      try {
        const list = await mailListCachedFolders(info.sessionId);
        nextFolders[info.sessionId] = list;
        let messages: MailMessageHeader[];
        if (target === "starred") {
          messages = await mailSearchMessages(info.sessionId, { text: "", flaggedOnly: true, limit: PER_ACCOUNT_LIMIT });
        } else {
          const folder = folderFor(info, list, target);
          messages = folder ? await mailListCachedMessages(info.sessionId, folder, PER_ACCOUNT_LIMIT, 0) : [];
        }
        return messages.map((message) => ({ accountId: info.sessionId, message }));
      } catch (e) {
        errors[info.sessionId] = String(e);
        return [];
      }
    }));
    if (loadSeq.current !== seq) return;
    setFolders(nextFolders);
    setAccountErrors(errors);
    setEntries(mergeUnified(lists));
    setLoading(false);
  }, [accounts, folderFor]);

  useEffect(() => {
    if (!visible) return;
    void load(view);
    // Reload when the account set or the view changes.
  }, [accountKey, load, view, visible]);

  /** Pull new mail for the view's folder of every account, then reload. */
  const refresh = async () => {
    setSyncing(true);
    setError(null);
    const errors: Record<string, string> = {};
    let fetched = 0;
    await Promise.all(accounts.map(async (info) => {
      const list = folders[info.sessionId] ?? await mailListCachedFolders(info.sessionId).catch(() => []);
      const folder = view === "starred" ? folderFor(info, list, "inbox") : folderFor(info, list, view);
      if (!folder) return;
      try {
        for (let step = 0; step < 10; step += 1) {
          const result = await mailSyncFolder(info, folder, { mode: "auto", limit: 100, includeBodies: false });
          fetched += result.fetched;
          if (!result.more) break;
        }
      } catch (e) {
        errors[info.sessionId] = String(e);
      }
    }));
    setSyncErrors(errors);
    setSyncing(false);
    setStatus(fetched > 0 ? `Fetched ${fetched} new message${fetched === 1 ? "" : "s"}` : "All accounts up to date");
    await load(view);
  };

  const selected = entries.find((entry) => unifiedKey(entry) === selectedKey) ?? null;

  const replaceMessage = (entry: UnifiedMessage, next: MailMessageHeader | null) => {
    const key = unifiedKey(entry);
    setEntries((current) => (next
      ? current.map((item) => (unifiedKey(item) === key ? { ...item, message: next } : item))
      : current.filter((item) => unifiedKey(item) !== key)));
  };

  const setFlags = async (entry: UnifiedMessage, add: string[], remove: string[]) => {
    const info = byId.get(entry.accountId);
    if (!info) return;
    try {
      await mailSetFlags(info, entry.message.folder, [entry.message.uid], add, remove);
      const next = withFlags(entry.message, add, remove);
      replaceMessage(entry, view === "starred" && !isStarred(next) ? null : next);
    } catch (e) {
      setError(String(e));
    }
  };

  const open = async (entry: UnifiedMessage) => {
    const key = unifiedKey(entry);
    setSelectedKey(key);
    const info = byId.get(entry.accountId);
    if (!info) return;
    setBody({ key, body: null, loading: true });
    try {
      const loaded = await mailGetMessageBody(info, entry.message.folder, entry.message.uid);
      setBody((current) => (current?.key === key ? { key, body: loaded, loading: false } : current));
      if (isUnreadMessage(entry.message)) void setFlags(entry, ["\\Seen"], []);
    } catch (e) {
      setBody((current) => (current?.key === key ? { key, body: null, loading: false, error: String(e) } : current));
    }
  };

  /** Move within the owning account (AC-48); delete goes to that account's Trash. */
  const moveTo = async (entry: UnifiedMessage, target: string | "trash") => {
    const info = byId.get(entry.accountId);
    if (!info) return;
    const list = folders[entry.accountId] ?? [];
    try {
      if (target === "trash") {
        const trash = folderFor(info, list, "trash");
        if (trash && trash !== entry.message.folder) {
          await mailMoveMessages(info, entry.message.folder, [entry.message.uid], trash);
        } else {
          await mailDeleteMessages(info, entry.message.folder, [entry.message.uid]);
        }
        setStatus(`Deleted from ${accountLabel(info)}`);
      } else {
        await mailMoveMessages(info, entry.message.folder, [entry.message.uid], target);
        setStatus(`Moved to ${target} in ${accountLabel(info)}`);
      }
      replaceMessage(entry, null);
      if (selectedKey === unifiedKey(entry)) {
        setSelectedKey(null);
        setBody(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const unreadCount = entries.filter((entry) => isUnreadMessage(entry.message)).length;
  const failed = Object.entries({ ...accountErrors, ...syncErrors });
  const selectedInfo = selected ? byId.get(selected.accountId) : undefined;
  const moveTargets = selected
    ? (folders[selected.accountId] ?? []).filter((folder) =>
      folder.name !== selected.message.folder && !folder.flags.some((flag) => flag.toLowerCase() === "\\noselect"))
    : [];

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]" data-testid="mail-unified-tab">
      <div className="h-10 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] text-[12px]">
        <Inbox className="w-4 h-4 text-[var(--taomni-text-muted)]" />
        <span className="font-semibold">Unified mail</span>
        <div className="ml-2 inline-flex rounded border border-[var(--taomni-divider)] overflow-hidden" role="tablist" aria-label="Unified folder">
          {MAIL_UNIFIED_VIEWS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              aria-selected={view === entry.value}
              data-testid={`mail-unified-view-${entry.value}`}
              className={`h-7 px-3 ${view === entry.value ? "bg-[var(--taomni-selected)] font-semibold" : "hover:bg-[var(--taomni-hover)]"}`}
              onClick={() => {
                setView(entry.value);
                setSelectedKey(null);
                setBody(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="text-[var(--taomni-text-muted)]" data-testid="mail-unified-count" data-count={entries.length} data-unread={unreadCount}>
          {entries.length} message{entries.length === 1 ? "" : "s"}{unreadCount ? `, ${unreadCount} unread` : ""} · {accounts.length} account{accounts.length === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-text-muted)]" />}
        <button
          type="button"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          data-testid="mail-unified-refresh"
          disabled={syncing || accounts.length === 0}
          onClick={() => void refresh()}
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Get mail
        </button>
      </div>
      {(error || status || failed.length > 0) && (
        <div className="shrink-0 px-3 py-1 border-b border-[var(--taomni-divider)] text-[11px]">
          {error && <div className="text-red-500">{error}</div>}
          {!error && status && <div className="text-[var(--taomni-text-muted)]" data-testid="mail-unified-status">{status}</div>}
          {failed.map(([id, message]) => (
            <div key={id} className="flex items-center gap-1 text-amber-600" data-testid="mail-unified-account-error">
              <AlertTriangle className="w-3 h-3" /> {accountLabel(byId.get(id) ?? { sessionId: id, emailAddress: id })}: {message}
            </div>
          ))}
        </div>
      )}
      {accounts.length === 0 ? (
        <div className="p-6 text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-unified-empty">
          No mail accounts yet. Create a Mail session to see its mail here.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-[42%] min-w-[280px] border-r border-[var(--taomni-divider)] overflow-auto" data-testid="mail-unified-list">
            {entries.length === 0 && !loading && (
              <div className="p-4 text-[12px] text-[var(--taomni-text-muted)]">Nothing here. Use Get mail to check every account.</div>
            )}
            {entries.map((entry) => {
              const key = unifiedKey(entry);
              const info = byId.get(entry.accountId);
              const unread = isUnreadMessage(entry.message);
              return (
                <button
                  key={key}
                  type="button"
                  className={`w-full px-3 py-2 text-left border-b border-[var(--taomni-divider)] text-[12px] hover:bg-[var(--taomni-hover)] ${selectedKey === key ? "bg-[var(--taomni-selected)]" : ""}`}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 58px" }}
                  data-testid="mail-unified-row"
                  data-account-id={entry.accountId}
                  data-unread={unread ? "true" : "false"}
                  onClick={() => void open(entry)}
                >
                  <div className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{sender(entry.message)}</span>
                    {isStarred(entry.message) && <Star className="w-3 h-3 text-amber-500 fill-amber-500" />}
                    <span className="shrink-0 text-[11px] text-[var(--taomni-text-muted)]">{formatDate(entry.message.dateTs)}</span>
                  </div>
                  <div className={`truncate ${unread ? "font-semibold" : ""}`}>{entry.message.subject || "(no subject)"}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--taomni-text-muted)]">
                    <span className="max-w-[45%] truncate rounded px-1 border border-[var(--taomni-divider)]" data-testid="mail-unified-account">
                      {info ? accountLabel(info) : entry.accountId}
                    </span>
                    <span className="min-w-0 truncate">{entry.message.snippet ?? ""}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col" data-testid="mail-unified-reader">
            {!selected || !selectedInfo ? (
              <div className="p-6 text-[12px] text-[var(--taomni-text-muted)]">Select a message to read it.</div>
            ) : (
              <>
                <div className="shrink-0 px-4 py-3 border-b border-[var(--taomni-divider)]">
                  <h2 className="text-[16px] font-semibold break-words">{selected.message.subject || "(no subject)"}</h2>
                  <div className="mt-1 text-[12px] text-[var(--taomni-text-muted)]">
                    {sender(selected.message)} · {accountLabel(selectedInfo)} / {selected.message.folder}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      className="taomni-btn h-6 px-2 inline-flex items-center gap-1"
                      data-testid="mail-unified-toggle-read"
                      onClick={() => void (isUnreadMessage(selected.message)
                        ? setFlags(selected, ["\\Seen"], [])
                        : setFlags(selected, [], ["\\Seen"]))}
                    >
                      {isUnreadMessage(selected.message) ? <MailOpen className="w-3 h-3" /> : <MailIcon className="w-3 h-3" />}
                      {isUnreadMessage(selected.message) ? "Mark read" : "Mark unread"}
                    </button>
                    <button
                      type="button"
                      className="taomni-btn h-6 px-2 inline-flex items-center gap-1"
                      data-testid="mail-unified-toggle-star"
                      onClick={() => void (isStarred(selected.message)
                        ? setFlags(selected, [], ["\\Flagged"])
                        : setFlags(selected, ["\\Flagged"], []))}
                    >
                      <Star className="w-3 h-3" /> {isStarred(selected.message) ? "Unstar" : "Star"}
                    </button>
                    <select
                      className="h-6 px-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[11px]"
                      aria-label="Move to folder"
                      data-testid="mail-unified-move"
                      value=""
                      onChange={(event) => {
                        if (event.target.value) void moveTo(selected, event.target.value);
                      }}
                    >
                      <option value="">Move to…</option>
                      {moveTargets.map((folder) => <option key={folder.name} value={folder.name}>{folder.displayName || folder.name}</option>)}
                    </select>
                    <button
                      type="button"
                      className="taomni-btn h-6 px-2 inline-flex items-center gap-1"
                      data-testid="mail-unified-delete"
                      onClick={() => void moveTo(selected, "trash")}
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                    {onOpenAccount && (
                      <button
                        type="button"
                        className="taomni-btn h-6 px-2 inline-flex items-center gap-1"
                        data-testid="mail-unified-open-account"
                        title="Reply, forward and more in the account's own tab"
                        onClick={() => onOpenAccount(selected.accountId)}
                      >
                        <ExternalLink className="w-3 h-3" /> Open account
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto p-3">
                  {body?.error ? (
                    <div className="text-[12px] text-red-500">{body.error}</div>
                  ) : (
                    <MailMessageBodyView
                      html={body?.key === selectedKey ? body.body?.html : null}
                      text={body?.key === selectedKey ? body.body?.text : null}
                      snippet={selected.message.snippet}
                      allowRemoteImages={false}
                      title={selected.message.subject || "Message body"}
                      loading={body?.key === selectedKey && body.loading}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
