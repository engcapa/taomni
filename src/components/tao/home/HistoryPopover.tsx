import { taoText as tr } from "../i18n";
import { Clock3, MessageSquare, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import type { RecentWorkspace } from "../../../types";
import { compareRecentSessions } from "../../welcome/sessionModel";
import type { RecentSessionSort } from "../../welcome/types";
import type { TaoThread } from "../ai-chat";

interface Props {
  threads: TaoThread[]; sessions: SessionConfig[]; workspaces: RecentWorkspace[]; demoMode: boolean;
  directories?: ReactNode;
  onSelectThread: (thread: TaoThread) => void;
  onOpenSession?: (session: SessionConfig) => void;
  onOpenWorkspace?: (workspace: RecentWorkspace) => void;
  onNewThread: () => void; onRestore?: () => void; onClose: () => void;
}
type HistoryTab = "chat" | "sessions" | "workspaces" | "directories";

export function HistoryPopover(props: Props) {
  const { threads, sessions, workspaces, demoMode, onClose } = props;
  const [tab, setTab] = useState<HistoryTab>("chat");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RecentSessionSort>("last-desc");
  const needle = query.trim().toLocaleLowerCase();
  // Titles belong to users/providers, even when they match a UI dictionary key.
  const title = (value: string, index: number, kind: string) => demoMode ? `${tr(kind)} ${index + 1}` : value;
  const filteredThreads = threads.filter((thread) => !needle || thread.title.toLocaleLowerCase().includes(needle));
  const filteredSessions = useMemo(() => sessions.filter((session) => !needle || `${session.name} ${session.host}`.toLocaleLowerCase().includes(needle)).sort((a, b) => compareRecentSessions(a, b, sort)), [sessions, needle, sort]);
  const filteredWorkspaces = useMemo(() => workspaces.filter((workspace) => !needle || workspace.name.toLocaleLowerCase().includes(needle)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt), [workspaces, needle]);
  const closeAfter = (action: () => void) => { action(); onClose(); };
  return <div className="tao-home-history-content" data-testid="tao-home-history-popover">
    <div className="tao-home-history-header"><strong><Clock3 size={14} />{tr("历史")}</strong><button type="button" aria-label={tr("关闭历史")} onClick={onClose}><X size={14} /></button></div>
    <div className="tao-home-history-tabs" role="tablist">{(["chat", "sessions", "workspaces", "directories"] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} data-testid={`tao-home-history-tab-${item}`} key={item} className={tab === item ? "active" : ""} onClick={() => { setTab(item); setQuery(""); }}>{tr(({ chat: "Tao 对话", sessions: "最近会话", workspaces: "最近工作区", directories: "最近目录" })[item])}</button>)}</div>
    {tab === "directories" ? <div className="tao-home-directory-history">{props.directories}</div> : <>
      <label className="tao-home-history-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("搜索历史")} /></label>
      {tab === "sessions" ? <select aria-label={tr("会话排序")} value={sort} onChange={(event) => setSort(event.target.value as RecentSessionSort)}>{(["last-desc", "last-asc", "name-asc", "name-desc", "type-asc", "type-desc", "host-asc", "host-desc"] as const).map((value) => <option key={value} value={value}>{tr(({ "last-desc": "最近连接优先", "last-asc": "较早连接优先", "name-asc": "名称升序", "name-desc": "名称降序", "type-asc": "类型升序", "type-desc": "类型降序", "host-asc": "主机升序", "host-desc": "主机降序" })[value])}</option>)}</select> : null}
      <div className="tao-home-history-list" onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".tao-home-history-row"));
        if (!rows.length) return;
        event.preventDefault();
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }}>
        {tab === "chat" ? filteredThreads.map((thread, index) => <button type="button" className="tao-home-history-row" data-testid="tao-home-history-row" data-title={thread.title} key={thread.id} onClick={() => closeAfter(() => props.onSelectThread(thread))}><MessageSquare size={13} /><span>{title(thread.title, index, "对话")}</span><small>{thread.source === "legacy" ? tr("旧 tao-chat") : new Date(thread.updatedAt).toLocaleDateString()}</small>{thread.running ? <i className="running" /> : null}</button>) : null}
        {tab === "sessions" ? filteredSessions.map((session, index) => <button type="button" className="tao-home-history-row" key={session.id} onClick={() => closeAfter(() => props.onOpenSession?.(session))}><span>{title(session.name || session.host || tr("会话"), index, "会话")}</span><small>{session.session_type}</small></button>) : null}
        {tab === "workspaces" ? filteredWorkspaces.map((workspace, index) => <button type="button" className="tao-home-history-row" data-testid="tao-home-history-row" data-workspace-id={workspace.id} data-title={workspace.name} key={workspace.id} onClick={() => closeAfter(() => props.onOpenWorkspace?.(workspace))}><span>{title(workspace.name, index, "工作区")}</span>{!demoMode ? <small>{workspace.roots[0]?.path ?? ""}</small> : null}</button>) : null}
        {(tab === "chat" ? filteredThreads : tab === "sessions" ? filteredSessions : filteredWorkspaces).length === 0 ? <p className="tao-home-history-empty">{tr("暂无记录")}</p> : null}
      </div>
    </>}
    <div className="tao-home-history-footer"><button type="button" onClick={() => closeAfter(props.onNewThread)}>{tr("＋ 新 Tao 对话")}</button><button type="button" disabled={!props.onRestore} onClick={() => closeAfter(() => props.onRestore?.())}>{tr("↺ 恢复上次会话")}</button></div>
  </div>;
}
