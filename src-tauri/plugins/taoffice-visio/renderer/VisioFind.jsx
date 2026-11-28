import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { normalizeSearch } from "./visioSvg.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useMemo, useRef, useState } = React;

export function composing(event) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function matchingPages(pages, query) {
  if (!query) return [];
  return pages.flatMap((page, index) => page.text.includes(query) ? [index] : []);
}

export function VisioFind({ pages, setPage, close, label }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [composition, setComposition] = useState(false);
  const [match, setMatch] = useState(null);
  const input = useRef(null);
  const matches = useMemo(() => matchingPages(pages, query), [pages, query]);
  const normalize = normalizeSearch(text);
  const ready = !composition && normalize === query;

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (composition) return;
    const timer = setTimeout(() => setQuery(normalize), 150);
    return () => clearTimeout(timer);
  }, [composition, normalize]);

  function move(direction) {
    const found = ready ? matches : matchingPages(pages, normalize);
    if (!found.length) return;
    const current = match?.query === normalize ? match.index : (direction > 0 ? -1 : 0);
    const index = (current + direction + found.length) % found.length;
    setQuery(normalize);
    setMatch({ query: normalize, index });
    setPage(found[index]);
  }

  function update(value) {
    setText(value);
    setMatch(null);
  }

  return <form className="taoffice-visio-find" role="search" aria-label={label("查找图形文字", "Find diagram text")}
    onSubmit={(event) => {
      event.preventDefault();
      if (!composition) move(1);
    }}
    onKeyDown={(event) => {
      if (composing(event)) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === input.current && text) update("");
        else close();
      }
    }}>
    <input ref={input} type="search" className="taomni-input" data-testid="taoffice-visio-find-input"
      aria-label={label("查找文字", "Find text")} autoComplete="off" value={text}
      onChange={(event) => update(event.target.value)} onCompositionStart={() => setComposition(true)}
      onCompositionEnd={() => setComposition(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !composing(event) && !composition) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }} />
    <Button data-testid="taoffice-visio-find-previous" onClick={() => move(-1)} disabled={!ready || !matches.length}>
      {label("上一个结果", "Previous result")}
    </Button>
    <Button type="submit" data-testid="taoffice-visio-find-next" disabled={!ready || !matches.length}>
      {label("下一个结果", "Next result")}
    </Button>
    <Button data-testid="taoffice-visio-find-close" onClick={close}>{label("关闭查找", "Close search")}</Button>
    <span role="status" data-testid="taoffice-visio-find-status">
      {ready && query && (matches.length ? match?.query === query
        ? label(`匹配页 ${match.index + 1}/${matches.length}`, `Matching page ${match.index + 1} of ${matches.length}`)
        : label(`${matches.length} 页匹配`, `${matches.length} matching pages`)
        : label("未找到文字", "No text found"))}
    </span>
  </form>;
}
