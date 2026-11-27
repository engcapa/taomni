import { Check, ExternalLink, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../../../lib/runtime";
import { ModalSurface } from "../../ui/ModalSurface";
import { useTaoText } from "../i18n";
import type { ContextPorts, TaoChatController, TaoSearchResult } from "../ai-chat";
import { canonicalSearchSource, searchResults } from "./query";

export function SearchPanel({ controller, contextPorts, onClose }: { controller: TaoChatController; contextPorts?: ContextPorts; onClose: () => void }) {
  const tr = useTaoText();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaoSearchResult[]>([]);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      const filteredQuery = sourceFilter ? `${query.replace(/(?:^|\s)source:\S+/g, " ")} source:${canonicalSearchSource(sourceFilter)}` : query;
      const promise = isTauriRuntime() ? invoke<TaoSearchResult[]>("deepseek_app_search", { query: filteredQuery }) : contextPorts?.search?.(filteredQuery) ?? Promise.resolve([]);
      void promise.then((items) => {
        if (disposed) return;
        const ranked = isTauriRuntime() ? { results: items, fallbackLike: items.some((item) => (item as TaoSearchResult & { exactMatchFallback?: boolean }).exactMatchFallback) } : searchResults(items, filteredQuery);
        setResults(ranked.results); setFallback(ranked.fallbackLike); setLoading(false); setSelected(0);
      }).catch((cause) => { if (!disposed) { setResults([]); setLoading(false); setError(String(cause)); } });
    }, 120);
    return () => { disposed = true; clearTimeout(timer); };
  }, [contextPorts, query, sourceFilter]);
  const visible = sourceFilter ? results.filter((result) => canonicalSearchSource(result.source) === canonicalSearchSource(sourceFilter)) : results;
  const cite = (result: TaoSearchResult, ask = false) => {
    const chip = { id: `local-${result.id}`, kind: "local" as const, label: result.title, preview: result.body, source: canonicalSearchSource(result.source), reference: result.ref, timestamp: result.ts, removable: true };
    controller.setChips([...controller.getState().composer.chips.filter((item) => item.id !== chip.id), chip]);
    if (ask) controller.setComposerText(tr("请根据所选资料回答我的问题："));
    onClose();
  };
  return createPortal(
    <ModalSurface
      dismissOnBackdrop
      initialFocus='[data-testid="tao-home-search-input"]'
      onCancel={onClose}
      data-testid="tao-home-search-panel"
      aria-label="Tao Search"
      className="tao-home-search-dialog"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, visible.length)) % Math.max(1, visible.length)); }
        if (event.key === "Enter" && visible[selected]) { event.preventDefault(); cite(visible[selected]); }
      }}
    >
      <div className="tao-home-search-title"><strong><Search size={15} />Tao Search</strong><button type="button" aria-label={tr("关闭搜索")} onClick={onClose}><X size={15} /></button></div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("搜索已保存资料（支持 source:sql since:14d）")} data-testid="tao-home-search-input" />
      <div className="tao-home-search-filters" role="tablist" aria-label={tr("资料来源")}>{[["", "全部"], ["session", "会话"], ["workspace", "工作区"], ["thread", "Tao 对话"], ["command", "命令"], ["sql", "SQL"], ["note", "笔记"]].map(([value, label]) => <button type="button" role="tab" aria-selected={sourceFilter === value} data-testid={`tao-home-search-filter-${value || "all"}`} className={sourceFilter === value ? "active" : ""} key={value} onClick={() => { setSourceFilter(value); setSelected(0); }}>{tr(label)}</button>)}</div>
      <div className="tao-home-search-results">{error ? <p role="alert">{error}</p> : null}{loading ? <p>{tr("正在本机检索…")}</p> : visible.map((result, index) => <div className={`tao-home-search-result ${index === selected ? "selected" : ""}`} data-selected={index === selected} key={result.id}><div><strong>{result.title}</strong><small>{tr(result.source)} · {tr("已脱敏 {count} 处", { count: result.redactedCount ?? 0 })}</small><p>{result.body}</p></div><div className="tao-home-search-result-actions"><button type="button" onClick={() => cite(result)}><Check size={12} />{tr("加入上下文")}</button><button type="button" onClick={() => cite(result, true)}>{tr("问 Tao")}</button>{result.ref.startsWith("http") ? <a href={result.ref} target="_blank" rel="noreferrer"><ExternalLink size={12} />{tr("打开")}</a> : null}</div></div>)}{!loading && !visible.length ? <p className="tao-home-search-empty">{tr("本地没有找到相关资料")}</p> : null}</div><footer><span>{tr(fallback ? "关键词少于 3 字，已改用精确匹配" : "本机检索 · 不消耗 token")}</span><kbd>↑ ↓</kbd><kbd>Enter</kbd></footer>
    </ModalSurface>,
    document.body,
  );
}
