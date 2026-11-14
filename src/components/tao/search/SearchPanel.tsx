import { Check, ExternalLink, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ContextPorts, TaoChatController, TaoSearchResult } from "../ai-chat";
import { searchResults } from "./query";

export function SearchPanel({ controller, contextPorts, onClose }: { controller: TaoChatController; contextPorts?: ContextPorts; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaoSearchResult[]>([]);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void contextPorts?.search?.(query).then((items) => {
        if (disposed) return;
        const ranked = searchResults(items ?? [], query);
        setResults(ranked.results);
        setFallback(ranked.fallbackLike);
        setLoading(false);
      }).catch(() => { if (!disposed) { setResults([]); setLoading(false); } });
    }, 120);
    return () => { disposed = true; clearTimeout(timer); };
  }, [contextPorts, query]);
  const visibleResults = sourceFilter ? results.filter((result) => result.source === sourceFilter) : results;
  return <div className="tao-home-search-overlay" data-testid="tao-home-search-panel" role="dialog"><div className="tao-home-search-dialog"><div className="tao-home-search-title"><strong><Search size={15} />Tao Search</strong><button type="button" aria-label="关闭搜索" onClick={onClose}><X size={15} /></button></div><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已保存资料（支持 source:sql since:14）" data-testid="tao-home-search-input" /><div className="tao-home-search-filters" role="tablist" aria-label="资料来源">{[["", "全部"], ["session", "会话"], ["workspace", "工作区"], ["thread", "Tao 对话"]].map(([value, label]) => <button type="button" role="tab" aria-selected={sourceFilter === value} data-testid={`tao-home-search-filter-${value || "all"}`} className={sourceFilter === value ? "active" : ""} key={value} onClick={() => setSourceFilter(value)}>{label}</button>)}</div><div className="tao-home-search-results">{loading ? <p>正在本机检索…</p> : visibleResults.map((result) => <div className="tao-home-search-result" key={result.id}><div><strong>{result.title}</strong><small>{result.source} · 已脱敏 {result.redactedCount ?? 0} 处</small><p>{result.body}</p></div><div className="tao-home-search-result-actions"><button type="button" onClick={() => { controller.setChips([...controller.getState().composer.chips, { id: `local-${result.id}`, kind: "local", label: result.title, preview: result.body, removable: true }]); onClose(); }}><Check size={12} />加入上下文</button><button type="button" onClick={() => { controller.setComposerText(`请根据这条资料回答：${result.title}`); onClose(); }}>问 Tao</button>{result.ref.startsWith("http") ? <a href={result.ref} target="_blank" rel="noreferrer"><ExternalLink size={12} />打开</a> : null}</div></div>)}{!loading && visibleResults.length === 0 ? <p className="tao-home-search-empty">本地没有找到相关资料</p> : null}</div><footer>{fallback ? <span>关键词少于 3 字，已改用精确匹配</span> : <span>本机检索 · 不消耗 token</span>}<kbd>↑ ↓</kbd><kbd>Enter</kbd></footer></div></div>;
}
