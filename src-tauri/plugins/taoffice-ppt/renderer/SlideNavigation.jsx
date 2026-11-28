import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";

const { React } = globalThis.__taomniHost;
const { useEffect, useLayoutEffect, useRef } = React;

export function SlideNavigation({ titles, selected, thumbnails, width, height, active, select, observe, label }) {
  const pane = useRef(null);
  const prefix = useRef({ text: "", time: 0 });
  useEffect(() => {
    const root = pane.current;
    if (!active || !root) { observe([]); return; }
    const visible = new Set();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number(entry.target.dataset.slide) - 1;
        if (entry.isIntersecting) visible.add(index);
        else visible.delete(index);
      }
      observe([...visible].sort((a, b) => a - b));
    }, { root, rootMargin: "64px 0px" });
    for (const button of root.children) observer.observe(button);
    return () => observer.disconnect();
  }, [titles.length, active, observe]);

  useLayoutEffect(() => {
    if (active) pane.current?.children[selected]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, active]);

  function keyDown(event) {
    if (!active || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const current = Number(event.target.closest("[data-slide]")?.dataset.slide) - 1;
    if (!Number.isInteger(current)) return;
    const list = pane.current;
    const step = Math.max(1, Math.floor(list.clientHeight / Math.max(1, list.children[current].offsetHeight)));
    const byKey = { ArrowUp: current - 1, ArrowDown: current + 1, Home: 0, End: titles.length - 1,
      PageUp: current - step, PageDown: current + step };
    let next = byKey[event.key];
    if (next === undefined) {
      if (event.key.length !== 1 || !event.key.trim()) return;
      const now = Date.now();
      const text = (now - prefix.current.time < 700 ? prefix.current.text : "") + event.key.toLocaleLowerCase();
      prefix.current = { time: now, text };
      const match = titles.findIndex((_, offset) => titles[(current + 1 + offset) % titles.length].toLocaleLowerCase().startsWith(text));
      if (match < 0) return;
      next = (current + 1 + match) % titles.length;
    }
    event.preventDefault();
    event.stopPropagation();
    next = Math.max(0, Math.min(titles.length - 1, next));
    list.children[next].focus({ preventScroll: true });
    select(next);
  }

  return <div ref={pane} className="taoffice-ppt-thumbnails" role="listbox" aria-orientation="vertical"
    aria-label={label("幻灯片缩略图", "Slide thumbnails")} data-testid="taoffice-ppt-thumbnails" onKeyDown={keyDown}>
    {titles.map((title, index) => {
      const number = index + 1;
      const name = label("第 " + number + " 张", "Slide " + number) + (title ? " · " + title : "");
      const url = thumbnails.get(index);
      return <Button key={index} role="option" tabIndex={index === selected ? 0 : -1}
        aria-selected={index === selected} aria-label={name} data-taomni-tooltip={name}
        data-testid="taoffice-ppt-thumbnail" data-slide={number} onClick={event => {
          event.currentTarget.focus({ preventScroll: true });
          select(index);
        }}>
        <span className="taoffice-ppt-thumb-number" aria-hidden="true">{number}</span>
        <span className="taoffice-ppt-thumb-page" style={{ aspectRatio: width + " / " + height }}>
          {url ? <img src={url} alt="" draggable={false} /> : <span>{title || name}</span>}
        </span>
      </Button>;
    })}
  </div>;
}
