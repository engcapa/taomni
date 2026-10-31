import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editorAction } from "./keymap/actions";
import type { WorkspaceActionHost } from "./workspaceActionHost";

export interface MarkdownPreviewSearchOwner {
  actionHost?: WorkspaceActionHost | null;
  groupId: string;
  standalone: boolean;
}

/** Own rendered-text search independently of the editable Markdown buffer. */
export function useMarkdownPreviewSearch(
  rootRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  html: string,
  owner?: MarkdownPreviewSearchOwner,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useRef<HTMLElement[]>([]);
  const openSearch = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    rootRef.current?.focus({ preventScroll: true });
  }, [rootRef]);
  const move = useCallback((delta: number) => {
    setIndex((current) => matches.current.length ? (current + delta + matches.current.length) % matches.current.length : 0);
  }, []);

  useEffect(() => {
    const host = owner?.actionHost;
    if (!host || (!owner.standalone && !focused)) return;
    return host.registerActions([
      editorAction({ id: "editor.find", title: "Find in File", category: "Edit", defaultKeybinding: "Ctrl+f",
        secondary: ["Meta+f"], requiresEditor: true, run: async () => { openSearch(); return { kind: "applied" }; } }),
      editorAction({ id: "editor.findNext", title: "Find Next Match", category: "Edit", defaultKeybinding: "F3",
        secondary: ["Ctrl+l"], requiresEditor: true, run: async () => { move(1); return { kind: "applied" }; } }),
      editorAction({ id: "editor.findPrevious", title: "Find Previous Match", category: "Edit", defaultKeybinding: "Shift+F3",
        secondary: ["Ctrl+Shift+l"], requiresEditor: true, run: async () => { move(-1); return { kind: "applied" }; } }),
    ], { ownerViewId: owner.groupId, priority: 1 });
  }, [owner?.actionHost, owner?.groupId, owner?.standalone, focused, openSearch, move]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const clear = () => {
      for (const mark of content.querySelectorAll('mark[data-testid="markdown-search-match"]')) mark.replaceWith(...mark.childNodes);
      content.normalize();
      matches.current = [];
    };
    clear();
    if (open && query) {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest("svg, button, script, style")) nodes.push(node);
      }
      for (const node of nodes) {
        const text = node.data;
        const lower = text.toLowerCase();
        const needle = query.toLowerCase();
        let start = 0;
        let found = lower.indexOf(needle);
        if (found < 0) continue;
        const fragment = document.createDocumentFragment();
        while (found >= 0) {
          fragment.append(document.createTextNode(text.slice(start, found)));
          const mark = document.createElement("mark");
          mark.dataset.testid = "markdown-search-match";
          mark.className = "rounded bg-yellow-200 text-black data-[current=true]:bg-orange-300";
          mark.textContent = text.slice(found, found + query.length);
          matches.current.push(mark);
          fragment.append(mark);
          start = found + query.length;
          found = lower.indexOf(needle, start);
        }
        fragment.append(document.createTextNode(text.slice(start)));
        node.replaceWith(fragment);
      }
    }
    setCount(matches.current.length);
    setIndex(0);
    return clear;
  }, [html, open, query, contentRef]);

  useLayoutEffect(() => {
    matches.current.forEach((mark, position) => { mark.dataset.current = String(position === index); });
    matches.current[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index, count, query]);

  const toolbar = open ? <div data-testid="markdown-preview-search" role="search"
    className="sticky top-0 z-10 flex items-center gap-1 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2 py-1 text-[12px]"
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); openSearch(); }
    }}>
    <input ref={input} type="search" aria-label="Find in preview" value={query}
      className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-transparent px-2 py-1 outline-none"
      onChange={(event) => setQuery(event.target.value)} />
    <span data-testid="markdown-search-count" aria-live="polite">{count ? `${index + 1}/${count}` : "0/0"}</span>
    <button type="button" aria-label="Previous match" disabled={!count} onClick={() => move(-1)}>↑</button>
    <button type="button" aria-label="Next match" disabled={!count} onClick={() => move(1)}>↓</button>
    <button type="button" aria-label="Close preview search" onClick={close}>×</button>
  </div> : null;

  return { toolbar, onFocusCapture: () => setFocused(true), onBlurCapture: (event: React.FocusEvent) => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setFocused(false);
  } };
}
