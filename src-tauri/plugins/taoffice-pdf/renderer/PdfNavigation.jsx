import { findPdfPages, normalizePdfText, outlineEntries, outlinePage } from "./pdfNavigation.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

export function PdfSearch({ pdf, label, onMatch, onClose }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(null);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(null);
  const field = useRef(null);
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    if (!search) return;
    const controller = new AbortController();
    const { signal } = controller;
    setResult(null);
    setNotice("");
    findPdfPages(pdf, search, signal).then((pages) => {
      if (signal.aborted) return;
      setResult({ pages, index: 0 });
      if (pages.length) onMatchRef.current(pages[0], search);
    }).catch((error) => { if (!signal.aborted) setNotice(String(error)); });
    return () => controller.abort();
  }, [pdf, search]);

  function move(direction) {
    if (!result?.pages.length) return;
    const { pages, index } = result;
    const next = (index + direction + pages.length) % pages.length;
    setResult({ pages, index: next });
    onMatch(pages[next], search);
  }

  return <form className="taoffice-pdf-navigation" role="search" aria-label={label("查找 PDF", "Find in PDF")}
    onSubmit={(event) => {
      event.preventDefault();
      const value = normalizePdfText(query);
      if (search === value && result?.pages.length) move(1);
      else if (value) setSearch(value);
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.stopPropagation();
        onClose();
      }
    }}>
    <input ref={field} className="taomni-input" type="search" data-testid="taoffice-pdf-search-input"
      aria-label={label("查找文字", "Find text")} value={query} onChange={(event) => {
        setQuery(event.target.value); setSearch(null); setResult(null); setNotice(""); onMatch(null, "");
      }} />
    <button className="taomni-btn" type="submit" data-testid="taoffice-pdf-search-submit" disabled={!query.trim()}>
      {label("查找", "Find")}
    </button>
    <button className="taomni-btn" type="button" data-testid="taoffice-pdf-search-previous"
      disabled={(result?.pages.length ?? 0) < 2} onClick={() => move(-1)}>
      {label("上一处", "Previous result")}
    </button>
    <button className="taomni-btn" type="button" data-testid="taoffice-pdf-search-next"
      disabled={(result?.pages.length ?? 0) < 2} onClick={() => move(1)}>
      {label("下一处", "Next result")}
    </button>
    <span role="status" data-testid="taoffice-pdf-search-status">
      {result ? result.pages.length
        ? label(`匹配页 ${result.index + 1}/${result.pages.length}`, `Matching page ${result.index + 1} of ${result.pages.length}`)
        : label("未找到文字", "No text found") : search && !notice ? label("正在查找…", "Searching…") : ""}
    </span>
    {notice && <span role="alert">{notice}</span>}
  </form>;
}

export function PdfOutline({ pdf, label, onGo, onClose }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const list = useRef(null);
  const generation = useRef(0);
  useEffect(() => {
    let current = true;
    list.current?.focus();
    pdf.getOutline().then((nodes) => { if (current) setEntries(outlineEntries(nodes)); })
      .catch((reason) => { if (current) setError(String(reason)); });
    return () => { current = false; generation.current += 1; };
  }, [pdf]);

  async function pick(destination) {
    const current = ++generation.current;
    try {
      const page = await outlinePage(pdf, destination);
      if (generation.current === current) onGo(page);
    } catch (reason) {
      if (generation.current === current) setError(String(reason));
    }
  }

  return <nav ref={list} tabIndex={-1} className="taoffice-pdf-outline"
    aria-label={label("PDF 大纲", "PDF outline")} data-testid="taoffice-pdf-outline"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
    {error && <p role="alert">{error}</p>}
    {!entries && !error && <p role="status">{label("正在读取大纲…", "Reading outline…")}</p>}
    {entries?.length === 0 && <p role="status">{label("文档没有大纲", "This document has no outline")}</p>}
    {entries?.length > 0 && <ul>{entries.map((entry, index) => <li key={index}>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-outline-item"
        style={{ paddingInlineStart: 8 + Math.min(entry.depth, 6) * 12 }}
        onClick={() => void pick(entry.destination)}>{entry.title}</button>
    </li>)}</ul>}
  </nav>;
}
