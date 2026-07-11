import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";

interface QuickPickOverlayProps<T> {
  open: boolean;
  testId: string;
  inputLabel: string;
  placeholder: string;
  items: T[];
  loading?: boolean;
  /** Selection applied every time the popup opens (e.g. 1 = previous file). */
  initialIndex?: number;
  /** Bump while open to advance the selection (wraps), e.g. repeated Ctrl+E. */
  advanceNonce?: number;
  filterItems: (query: string, items: T[]) => T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  emptyText: (query: string) => string;
  header?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onPick: (item: T) => void;
  /** Called when Enter is pressed with no selectable results (e.g. Text search). */
  onEnterEmpty?: (query: string) => void;
  /** Notified whenever the filter query changes. */
  onQueryChange?: (query: string) => void;
}

/**
 * Shared shell for Search Everywhere style popups: centered overlay, query
 * input, keyboard-navigable result list. Owns query and selection state;
 * ranking/rendering stay with the caller.
 */
export function QuickPickOverlay<T>({
  open,
  testId,
  inputLabel,
  placeholder,
  items,
  loading = false,
  initialIndex = 0,
  advanceNonce,
  filterItems,
  itemKey,
  renderItem,
  emptyText,
  header,
  footer,
  onClose,
  onPick,
  onEnterEmpty,
  onQueryChange,
}: QuickPickOverlayProps<T>) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const initialIndexRef = useRef(initialIndex);
  initialIndexRef.current = initialIndex;
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    onQueryChangeRef.current?.("");
    setSelectedIndex(initialIndexRef.current);
    // Focus after the overlay is painted.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const results = useMemo(() => filterItems(query, items), [filterItems, items, query]);
  const selected = Math.min(selectedIndex, Math.max(0, results.length - 1));

  const lastAdvanceRef = useRef(advanceNonce ?? 0);
  useEffect(() => {
    if (advanceNonce === undefined || advanceNonce === lastAdvanceRef.current) return;
    lastAdvanceRef.current = advanceNonce;
    if (!open || results.length === 0) return;
    setSelectedIndex((selected + 1) % results.length);
  }, [advanceNonce, open, results.length, selected]);

  useEffect(() => {
    const element = listRef.current?.querySelector(`[data-index="${selected}"]`);
    // scrollIntoView is missing from jsdom, so probe before calling.
    if (element instanceof HTMLElement && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [selected, results]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex(Math.min(selected + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(Math.max(selected - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[selected];
      if (item) onPick(item);
      else onEnterEmpty?.(query);
    }
  };

  return (
    <div
      data-testid={testId}
      className="absolute inset-0 z-40 flex justify-center bg-black/30 pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="h-fit max-h-[70%] w-[560px] max-w-[90%] flex flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] shadow-xl">
        {header}
        <div className="shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={inputRef}
            value={query}
            placeholder={placeholder}
            aria-label={inputLabel}
            className="h-6 w-full bg-transparent text-[12px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              onQueryChangeRef.current?.(next);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--taomni-code-muted)]" />}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1 text-[11px]">
          {results.length === 0 && (
            <div className="px-3 py-2 text-[var(--taomni-code-muted)]">{emptyText(query)}</div>
          )}
          {results.map((item, index) => (
            <button
              key={itemKey(item)}
              type="button"
              data-index={index}
              data-selected={index === selected || undefined}
              className="h-7 w-full min-w-0 flex items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onPick(item)}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
        {footer && (
          <div className="shrink-0 flex items-center gap-3 border-t border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
