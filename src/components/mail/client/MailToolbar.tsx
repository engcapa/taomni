import { type SetStateAction } from "react";
import { Bot, CheckCircle2, FileText, Loader2, Mail as MailIcon, MailOpen, Paperclip, RefreshCw, Search, ShieldCheck, Star, X, ZoomIn, ZoomOut } from "lucide-react";
import { type MailFolder, type MailSearchField } from "../../../lib/mail";
import { MAIL_TAGS } from "../../../lib/mailTags";
import { type ComposeDraft } from "./types";


export interface MailToolbarProps {
  openCompose: (nextDraft?: Partial<ComposeDraft>, includeSignature?: boolean) => void;
  setDraftsOpen: import("react").Dispatch<SetStateAction<boolean>>;
  refreshDrafts: () => Promise<void>;
  outboxCount: number;
  syncAllFolders: (quiet?: boolean, options?: Pick<import("./types").SyncFolderOptions, "limit" | "includeBodies" | "indicator">) => Promise<import("../../../lib/mail").MailSyncAllResult | null>;
  batchSize: number;
  syncing: boolean;
  idleEnabled: boolean;
  idleState: string | null;
  handleMarkSelectedRead: () => Promise<void>;
  markingRead: boolean;
  checkedUnreadCount: number;
  handleMarkFolderRead: (folderName?: string) => Promise<void>;
  activeFolder: MailFolder;
  visibleUnreadCount: number;
  handleTest: () => Promise<void>;
  testing: boolean;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
  searchScope: "folder" | "all";
  query: string;
  setQuery: import("react").Dispatch<SetStateAction<string>>;
  runServerSearch: () => Promise<void>;
  searchField: MailSearchField;
  setSearchField: import("react").Dispatch<SetStateAction<MailSearchField>>;
  setSearchScope: import("react").Dispatch<SetStateAction<"folder" | "all">>;
  searchActive: boolean;
  serverSearching: boolean;
  quickFilters: { unread: boolean; flagged: boolean; attachments: boolean; };
  setQuickFilters: import("react").Dispatch<SetStateAction<{ unread: boolean; flagged: boolean; attachments: boolean; }>>;
  tagFilter: string;
  setTagFilter: import("react").Dispatch<SetStateAction<string>>;
  decreaseFontSize: () => void;
  increaseFontSize: () => void;
  openTabChat: (tabId: string) => Promise<void>;
  tabId: string;
  handleClearCache: () => Promise<void>;
  clearing: boolean;
  info: import("../../../types").MailTabInfo;
}

export function MailToolbar(viewProps: MailToolbarProps) {
  const { activeFolder, batchSize, checkedUnreadCount, clearing, decreaseFontSize, handleClearCache, handleMarkFolderRead, handleMarkSelectedRead, handleTest, idleEnabled, idleState, increaseFontSize, info, markingRead, openCompose, openTabChat, outboxCount, query, quickFilters, refreshDrafts, runServerSearch, searchActive, searchField, searchInputRef, searchScope, serverSearching, setDraftsOpen, setQuery, setQuickFilters, setSearchField, setSearchScope, setTagFilter, syncAllFolders, syncing, tabId, tagFilter, testing, visibleUnreadCount } = viewProps;
 return (<div className="min-h-9 shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
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
        {idleEnabled && (
          <span
            className="h-7 w-14 shrink-0 px-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]"
            data-testid="mail-idle-status"
            data-state={idleState ?? "connecting"}
            data-active={idleState === "ready" || idleState === "changed" ? "true" : "false"}
            title={!idleState ? "Connecting IMAP IDLE" : idleState === "ready" || idleState === "changed"
              ? "Instant push (IMAP IDLE) active"
              : "Instant push unavailable; polling"}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${idleState === "ready" || idleState === "changed"
                ? "bg-[var(--taomni-success,#22c55e)]"
                : "bg-[var(--taomni-text-muted)]"}`}
            />
            {!idleState || idleState === "ready" || idleState === "changed" ? "Push" : "Poll"}
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
          aria-busy={markingRead}
          data-testid="mail-mark-folder-read"
          title="Mark all messages in this folder as read"
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
        <div className="relative w-[320px] max-w-[40vw] shrink-0">
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
      </div>);
}
