import type { SavedSession } from "./api";
import { SessionResults } from "./SessionResults";

const savedSearchText = (session: SavedSession) => [session.name, session.session_type, session.group_path ?? ""];

export function SavedSessionsPanel({ sessions, canOpen, opening, onOpen }: {
  sessions: SavedSession[];
  canOpen: boolean;
  opening: boolean;
  onOpen: (session: SavedSession) => void;
}) {
  return <section className="card saved-sessions">
    <div className="saved-heading">
      <div><p className="eyebrow">SAVED SESSIONS</p><h2>已保存会话{!canOpen && <span className="muted"> · 只读</span>}</h2></div>
      <span className="count">{sessions.length}</span>
    </div>
    <p className="note">{canOpen ? "在实例的桌面窗口中打开，复用其已保存的凭据、代理与跳板机。" : "在桌面 设置 → 移动服务 中允许后，可在手机上打开已保存会话与新建本地终端。headless 实例不支持。"}</p>
    <SessionResults sessions={sessions} searchText={savedSearchText} listClassName="saved-results" testIdPrefix="mobile-saved" searchLabel="搜索已保存会话" placeholder="搜索名称、类型或分组" empty={<p className="muted">没有已保存的终端类会话</p>} renderItem={session => <div className="saved-session" data-testid="mobile-saved-session" key={session.id}>
      <div><strong>{session.name}</strong><span>{session.session_type} · {session.group_path || "未分组"}</span></div>
      {canOpen && <button data-testid="mobile-saved-open" disabled={opening} onClick={() => onOpen(session)}>打开</button>}
    </div>} />
  </section>;
}
