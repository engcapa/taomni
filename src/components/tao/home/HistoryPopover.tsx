import { Clock3, MessageSquare, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import type { RecentWorkspace } from "../../../types";
import type { TaoThread } from "../ai-chat";

type HistoryTab = "chat" | "sessions" | "workspaces";

export function HistoryPopover({ threads, sessions, workspaces, demoMode, onSelectThread, onOpenSession, onOpenWorkspace, onNewThread, onRestore, onClose }: { threads: TaoThread[]; sessions: SessionConfig[]; workspaces: RecentWorkspace[]; demoMode: boolean; onSelectThread: (thread: TaoThread) => void; onOpenSession?: (session: SessionConfig) => void; onOpenWorkspace?: (workspace: RecentWorkspace) => void; onNewThread: () => void; onRestore?: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<HistoryTab>("chat");
  const [query, setQuery] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => query.trim().toLocaleLowerCase(), [query]);
  const title = (value: string, index: number, kind: string) => demoMode ? `${kind} ${index + 1}` : value;
  const filteredThreads = threads.filter((thread) => !visible || thread.title.toLocaleLowerCase().includes(visible));
  const filteredSessions = sessions.filter((session) => !visible || `${session.name} ${session.host}`.toLocaleLowerCase().includes(visible));
  const filteredWorkspaces = workspaces.filter((workspace) => !visible || workspace.name.toLocaleLowerCase().includes(visible));
  const empty = tab === "chat" ? filteredThreads.length === 0 : tab === "sessions" ? filteredSessions.length === 0 : filteredWorkspaces.length === 0;
  const rows = tab === "chat" ? filteredThreads : tab === "sessions" ? filteredSessions : filteredWorkspaces;
  const selectRow = (index: number) => {
    const item = rows[index];
    if (!item) return;
    if (tab === "chat") onSelectThread(item as TaoThread);
    else if (tab === "sessions") onOpenSession?.(item as SessionConfig);
    else onOpenWorkspace?.(item as RecentWorkspace);
    onClose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
      event.preventDefault();
      const current = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".tao-home-history-row") ?? []).indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1 + rows.length) % rows.length : (current - 1 + rows.length) % rows.length;
      Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".tao-home-history-row") ?? [])[next]?.focus();
      return;
    }
    if (event.key === "Enter" && document.activeElement?.classList.contains("tao-home-history-row")) {
      event.preventDefault();
      const current = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".tao-home-history-row") ?? []).indexOf(document.activeElement as HTMLButtonElement);
      if (current >= 0) selectRow(current);
    }
  };
  return <div ref={popoverRef} className="tao-home-history-popover" data-testid="tao-home-history-popover" role="dialog" aria-label="历史" tabIndex={-1} onKeyDown={handleKeyDown}><div className="tao-home-history-header"><strong><Clock3 size={14} />历史</strong><button type="button" aria-label="关闭历史" onClick={onClose}><X size={14} /></button></div><div className="tao-home-history-tabs" role="tablist">{(["chat", "sessions", "workspaces"] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} data-testid={`tao-home-history-tab-${item}`} key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "chat" ? "Tao 对话" : item === "sessions" ? "最近会话" : "最近工作区"}</button>)}</div><label className="tao-home-history-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史" /></label><div className="tao-home-history-list">{tab === "chat" ? filteredThreads.map((thread, index) => <button type="button" className="tao-home-history-row" key={thread.id} onClick={() => { onSelectThread(thread); onClose(); }}><MessageSquare size={13} /><span>{title(thread.title, index, "会话")}</span>{thread.running ? <i className="running" /> : null}</button>) : null}{tab === "sessions" ? filteredSessions.map((session, index) => <button type="button" className="tao-home-history-row" key={session.id} onClick={() => { onOpenSession?.(session); onClose(); }}><span>{title(session.name || session.host || "会话", index, "会话")}</span><small>{session.session_type}</small></button>) : null}{tab === "workspaces" ? filteredWorkspaces.map((workspace, index) => <button type="button" className="tao-home-history-row" key={workspace.id} onClick={() => { onOpenWorkspace?.(workspace); onClose(); }}><span>{title(workspace.name, index, "工作区")}</span><small>{workspace.roots[0]?.path ?? ""}</small></button>) : null}{empty ? <p className="tao-home-history-empty">暂无记录</p> : null}</div><div className="tao-home-history-footer"><button type="button" onClick={() => { onNewThread(); onClose(); }}>＋ 新 Tao 对话</button><button type="button" disabled={!onRestore} onClick={() => { onRestore?.(); onClose(); }}>↺ 恢复上次会话</button></div></div>;
}
