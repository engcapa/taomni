import { File, Folder, Hash } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { type SegmentPopupProps } from "./model";
import { filterByQuery, sortPathChildren } from "./paths";

export function SegmentPopup({
  open,
  query,
  selectedIndex,
  actions,
  onQueryChange,
  onSelectedIndexChange,
  onClose,
  onPickPathChild,
  onPickSymbol,
  onPickCollapsedSegment,
  onAction,
}: SegmentPopupProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState({ left: open.anchor.left, top: open.anchor.bottom + 2 });
  const popupId = `code-workspace-breadcrumb-popup-${useId().replace(/:/g, "")}`;

  const pathChildren = open.kind === "path" ? sortPathChildren(open.children) : [];
  const filteredPath = open.kind === "path"
    ? filterByQuery(pathChildren, query, (item) => item.label)
    : [];
  const filteredSymbols = open.kind === "symbol"
    ? filterByQuery(open.siblings, query, (item) => item.name)
    : [];
  const filteredCollapsed = open.kind === "collapsed"
    ? filterByQuery(open.segments, query, (item) => item.label)
    : [];

  const itemCount = open.kind === "path"
    ? filteredPath.length
    : open.kind === "symbol"
      ? filteredSymbols.length
      : filteredCollapsed.length;
  const actionStart = itemCount;
  const totalCount = itemCount + actions.length;
  const safeIndex = totalCount === 0 ? 0 : Math.min(selectedIndex, totalCount - 1);
  const activeOptionId = totalCount > 0 ? `${popupId}-option-${safeIndex}` : undefined;

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const left = Math.min(
      Math.max(margin, open.anchor.left),
      Math.max(margin, window.innerWidth - rect.width - margin),
    );
    const preferBelow = open.anchor.bottom + 2;
    const top = preferBelow + rect.height + margin > window.innerHeight
      ? Math.max(margin, open.anchor.top - rect.height - 2)
      : preferBelow;
    setCoords({ left, top });
  }, [open, query, itemCount, actions.length]);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open.kind, open.kind === "path" ? open.segment.path : open.kind === "symbol" ? open.symbol.name : "collapsed"]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-popup-index="${safeIndex}"]`);
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [safeIndex]);

  const activate = (index: number) => {
    if (index < itemCount) {
      if (open.kind === "path") {
        const child = filteredPath[index];
        if (child) onPickPathChild(child);
      } else if (open.kind === "symbol") {
        const symbol = filteredSymbols[index];
        if (symbol) onPickSymbol(symbol);
      } else {
        const segment = filteredCollapsed[index];
        if (segment) onPickCollapsedSegment(segment);
      }
      return;
    }
    const action = actions[index - itemCount];
    if (action && !action.disabled) onAction(action);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (totalCount > 0) onSelectedIndexChange((safeIndex + 1) % totalCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (totalCount > 0) onSelectedIndexChange((safeIndex - 1 + totalCount) % totalCount);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(safeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
    }
  };

  const title = open.kind === "path"
    ? open.segment.label
    : open.kind === "symbol"
      ? open.symbol.name
      : "Path";

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label={`${title} breadcrumb menu`}
      aria-activedescendant={activeOptionId}
      id={popupId}
      data-testid="code-workspace-breadcrumb-popup"
      data-taomni-context-menu="true"
      className="fixed z-[500] flex max-h-[min(360px,50vh)] w-[min(320px,calc(100vw-12px))] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] text-[11px] text-[var(--taomni-code-text)] shadow-xl"
      style={{ left: coords.left, top: coords.top }}
      onKeyDown={onKeyDown}
    >
      <div className="border-b border-[var(--taomni-code-border)] px-2 py-1.5">
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          data-testid="code-workspace-breadcrumb-popup-filter"
          aria-label="Filter breadcrumb entries"
          aria-controls={popupId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className="taomni-input h-6 w-full text-[11px]"
          placeholder={open.kind === "path" && open.loading ? "Loading…" : "Type to filter"}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {open.kind === "path" && open.loading && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">Loading…</div>
        )}
        {open.kind === "path" && open.error && (
          <div className="px-2 py-1.5 text-red-400">{open.error}</div>
        )}
        {open.kind === "path" && !open.loading && !open.error && filteredPath.length === 0 && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">
            {query.trim() ? "No matching entries" : "Empty folder"}
          </div>
        )}
        {open.kind === "path" && filteredPath.map((child, index) => (
          <button
            key={`${child.kind}:${child.path}`}
            type="button"
            role="option"
            id={`${popupId}-option-${index}`}
            aria-selected={index === safeIndex}
            aria-current={child.active ? "page" : undefined}
            data-popup-index={index}
            data-active={child.active || undefined}
            data-testid={`code-workspace-breadcrumb-entry-${child.kind}`}
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] ${index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
              } ${child.active ? "text-[var(--taomni-code-text)] font-medium" : "text-[var(--taomni-code-muted)]"}`}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onClick={() => activate(index)}
          >
            {child.kind === "directory" ? (
              <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
            ) : (
              <File className="h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0 truncate">{child.label}</span>
          </button>
        ))}
        {open.kind === "symbol" && filteredSymbols.length === 0 && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">
            {query.trim() ? "No matching symbols" : "No symbols"}
          </div>
        )}
        {open.kind === "symbol" && filteredSymbols.map((symbol, index) => {
          const current = symbol === open.symbol
            || (symbol.name === open.symbol.name
              && symbol.selectionRange.start.line === open.symbol.selectionRange.start.line
              && symbol.selectionRange.start.character === open.symbol.selectionRange.start.character);
          return (
            <button
              key={`${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`}
              type="button"
              role="option"
              id={`${popupId}-option-${index}`}
              aria-selected={index === safeIndex}
              data-popup-index={index}
              data-testid="code-workspace-breadcrumb-entry-symbol"
              className={`flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] ${index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
                } ${current ? "text-[var(--taomni-code-text)] font-medium" : "text-[var(--taomni-code-muted)]"}`}
              onMouseEnter={() => onSelectedIndexChange(index)}
              onClick={() => activate(index)}
            >
              <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 truncate">{symbol.name}</span>
              {symbol.detail && (
                <span className="ml-auto min-w-0 max-w-[40%] truncate text-[10px] text-[var(--taomni-code-muted)]">
                  {symbol.detail}
                </span>
              )}
            </button>
          );
        })}
        {open.kind === "collapsed" && filteredCollapsed.map((segment, index) => (
          <button
            key={`collapsed:${segment.path}:${segment.label}`}
            type="button"
            role="option"
            id={`${popupId}-option-${index}`}
            aria-selected={index === safeIndex}
            data-popup-index={index}
            data-testid="code-workspace-breadcrumb-entry-collapsed"
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] ${index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
              }`}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onClick={() => activate(index)}
          >
            {segment.kind === "file" ? (
              <File className="h-3 w-3 shrink-0" />
            ) : (
              <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
            )}
            <span className="min-w-0 truncate">{segment.label}</span>
          </button>
        ))}
      </div>
      {actions.length > 0 && (
        <div className="border-t border-[var(--taomni-code-border)] py-1">
          {actions.map((action, offset) => {
            const index = actionStart + offset;
            return (
              <button
                key={action.id}
                type="button"
                role="option"
                id={`${popupId}-option-${index}`}
                aria-selected={index === safeIndex}
                data-popup-index={index}
                data-testid={`code-workspace-breadcrumb-action-${action.id}`}
                disabled={action.disabled}
                className={`flex w-full items-center px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40 ${index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
                  } ${action.danger ? "text-red-400" : "text-[var(--taomni-code-text)]"}`}
                onMouseEnter={() => onSelectedIndexChange(index)}
                onClick={() => activate(index)}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
