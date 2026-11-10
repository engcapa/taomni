import { useMemo, useState } from "react";
import type { SavedSession } from "./api";

export function SavedSessionsPanel({ sessions, canOpen, opening, onOpen }: {
  sessions: SavedSession[];
  canOpen: boolean;
  opening: boolean;
  onOpen: (session: SavedSession) => void;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase();
  const isExpanded = expanded ?? sessions.length <= 1;
  const filtered = useMemo(() => {
    if (!keyword) return sessions;
    return sessions.filter(session => [session.name, session.session_type, session.group_path ?? ""]
      .some(value => value.toLocaleLowerCase().includes(keyword)));
  }, [sessions, keyword]);

  const toggle = () => {
    setExpanded(!isExpanded);
    if (isExpanded) setQuery("");
  };

  return <section className="card saved-sessions">
    <button type="button" className="saved-toggle" data-testid="mobile-saved-toggle" aria-expanded={isExpanded} aria-controls={isExpanded ? "mobile-saved-results" : undefined} onClick={toggle}>
      <span className="saved-toggle-copy"><span className="eyebrow">SAVED SESSIONS</span><strong>已保存会话{!canOpen && <span className="muted"> · 只读</span>}</strong></span>
      <span className="saved-count"><span className="count">{keyword ? `${filtered.length} / ${sessions.length}` : sessions.length}</span><span aria-hidden>{isExpanded ? "⌄" : "›"}</span></span>
    </button>
    {isExpanded && <div className="saved-body" id="mobile-saved-results">
      <p className="note">{canOpen ? "在实例的桌面窗口中打开，复用其已保存的凭据、代理与跳板机。" : "在桌面 设置 → 移动服务 中允许后，可在手机上打开已保存会话与新建本地终端。headless 实例不支持。"}</p>
      {sessions.length > 0 && <>
        <div className="saved-search">
          <span aria-hidden>⌕</span>
          <input id="mobile-saved-search" type="search" data-testid="mobile-saved-search" aria-label="搜索已保存会话" placeholder="搜索名称、类型或分组" autoComplete="off" enterKeyHint="search" value={query} onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" data-testid="mobile-saved-search-clear" aria-label="清除搜索" onClick={() => setQuery("")}>清除</button>}
        </div>
        <p className="saved-result-count" role="status" aria-live="polite">{keyword ? `找到 ${filtered.length} / ${sessions.length} 个会话` : `共 ${sessions.length} 个会话`}</p>
      </>}
      <div className="saved-results">
        {filtered.map(session => <div className="saved-session" data-testid="mobile-saved-session" key={session.id}>
          <div><strong>{session.name}</strong><span>{session.session_type} · {session.group_path || "未分组"}</span></div>
          {canOpen && <button data-testid="mobile-saved-open" disabled={opening} onClick={() => onOpen(session)}>打开</button>}
        </div>)}
        {!sessions.length && <p className="muted">没有已保存的终端类会话</p>}
        {!!sessions.length && !filtered.length && <p className="muted" role="status" data-testid="mobile-saved-empty-search">没有匹配“{query.trim()}”的会话</p>}
      </div>
    </div>}
  </section>;
}
