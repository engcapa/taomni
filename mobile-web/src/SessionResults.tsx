import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const SESSION_BATCH_SIZE = 8;

export function SessionResults<T>({ sessions, searchText, listClassName, listTestId, testIdPrefix, searchLabel, placeholder, empty, renderItem }: {
  sessions: T[];
  searchText: (session: T) => string[];
  listClassName: string;
  listTestId?: string;
  testIdPrefix: string;
  searchLabel: string;
  placeholder: string;
  empty: ReactNode;
  renderItem: (session: T) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(SESSION_BATCH_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNewItems = useRef(false);
  const previousVisibleCount = useRef(visibleCount);
  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!keyword) return sessions;
    return sessions.filter(session => searchText(session).some(value => value.toLowerCase().includes(keyword)));
  }, [sessions, keyword, searchText]);
  const visible = filtered.slice(0, visibleCount);
  useEffect(() => {
    if (!focusNewItems.current) return;
    focusNewItems.current = false;
    const firstNew = listRef.current?.children[previousVisibleCount.current];
    const focusTarget = firstNew instanceof HTMLElement && firstNew.matches("button, a, input, [tabindex]")
      ? firstNew
      : firstNew?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]");
    focusTarget?.focus();
  }, [visible.length]);
  const updateQuery = (value: string) => {
    focusNewItems.current = false;
    setQuery(value);
    setVisibleCount(SESSION_BATCH_SIZE);
  };
  const showMore = () => {
    focusNewItems.current = true;
    previousVisibleCount.current = visible.length;
    setVisibleCount(count => Math.min(count + SESSION_BATCH_SIZE, filtered.length));
  };

  return <>
    {sessions.length > 0 && <>
      <div className="session-search">
        <span aria-hidden>⌕</span>
        <input id={`${testIdPrefix}-search`} type="search" data-testid={`${testIdPrefix}-search`} aria-label={searchLabel} placeholder={placeholder} autoComplete="off" enterKeyHint="search" value={query} onChange={event => updateQuery(event.target.value)} />
        {query && <button type="button" data-testid={`${testIdPrefix}-search-clear`} aria-label="清除搜索" onClick={() => updateQuery("")}>清除</button>}
      </div>
      <p className="session-result-count" role="status" aria-live="polite" data-testid={`${testIdPrefix}-result-count`}>
        {keyword ? `找到 ${filtered.length} / ${sessions.length} 个会话，当前显示 ${visible.length} 条` : `共 ${sessions.length} 个会话，当前显示 ${visible.length} 条`}
      </p>
    </>}
    <div ref={listRef} className={listClassName} data-testid={listTestId}>
      {visible.map(session => renderItem(session))}
      {!sessions.length && empty}
      {!!sessions.length && !filtered.length && <p className="muted session-empty-search" role="status" data-testid={`${testIdPrefix}-empty-search`}>没有匹配“{query.trim()}”的会话</p>}
    </div>
    {visible.length < filtered.length && <button type="button" className="session-more" data-testid={`${testIdPrefix}-more`} onClick={showMore}>显示更多（剩余 {filtered.length - visible.length} 条）</button>}
  </>;
}
