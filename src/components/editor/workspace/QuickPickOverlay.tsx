import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";
import { useFocusReturn } from "./useFocusReturn";
import { detectKeymapPlatform, type KeymapPlatform } from "./workspaceKeymapPlatform";

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
  /** Static footer, or one derived from the selected result (IDEA path bar). */
  footer?: ReactNode | ((selected: T | null) => ReactNode);
  /**
   * Left column beside the result list (Recent Files tool windows). A render
   * function receives the keyboard-selected aside row (IDEA Switcher: Left
   * moves the selection into this column, Right back to the results).
   */
  aside?: ReactNode | ((state: { selectedIndex: number | null }) => ReactNode);
  /** Keyboard-selectable rows in `aside`; 0 keeps the column pointer-only. */
  asideItemCount?: number;
  /** Enter on a keyboard-selected aside row. */
  onAsideActivate?: (index: number) => void;
  /**
   * IDEA Search Everywhere switches the category tab with every chord its UI
   * registers (see `searchEverywhereTabDirection`) instead of moving DOM focus.
   */
  onTabNavigate?: (direction: 1 | -1) => void;
  /**
   * IDEA SearchEverywhere.NavigateToNextGroup / PrevGroup: PageDown or
   * Ctrl+Down selects the last result, PageUp or Ctrl+Up the first.
   */
  groupNavigation?: boolean;
  onClose: () => void;
  onPick: (item: T, options?: { split: boolean }) => void;
  /** Called when Enter is pressed with no selectable results (e.g. Text search). */
  onEnterEmpty?: (query: string) => void;
  /** Notified whenever the filter query changes. */
  onQueryChange?: (query: string) => void;
  /** Alt+Enter on the selected item (e.g. Find Action → Assign Shortcut). */
  onAltEnter?: (item: T) => void;
}

type TabKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * Tab-switch direction of one key event in IDEA Search Everywhere, or null.
 * SearchEverywhereUI registers SearchEverywhere.NextTab/PrevTab (Tab /
 * Shift+Tab), the platform NextTab/PreviousTab actions (XWin Alt+Right /
 * Alt+Left; macOS Ctrl+Right / Ctrl+Left and Cmd+Shift+] / [) and Switcher
 * (Ctrl+Tab, with Shift = previous).
 */
export function searchEverywhereTabDirection(event: TabKeyEvent, platform: KeymapPlatform = detectKeymapPlatform()): 1 | -1 | null {
  const { key, code, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta } = event;
  if (key === "Tab" && !alt && !meta) return shift ? -1 : 1;
  const arrow = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : null;
  if (platform === "mac") {
    if (arrow && ctrl && !alt && !shift && !meta) return arrow;
    if (meta && shift && !ctrl && !alt) {
      if (code === "BracketRight") return 1;
      if (code === "BracketLeft") return -1;
    }
    return null;
  }
  if (arrow && alt && !ctrl && !shift && !meta) return arrow;
  return null;
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
  aside,
  asideItemCount = 0,
  onAsideActivate,
  onTabNavigate,
  groupNavigation = false,
  onClose,
  onPick,
  onEnterEmpty,
  onQueryChange,
  onAltEnter,
}: QuickPickOverlayProps<T>) {
  // DEC-ALIGN-11 / ED-PARITY-012: closing returns focus to the opener.
  useFocusReturn(open);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** Keyboard pane: the result list, or the aside column (IDEA Switcher). */
  const [asideIndex, setAsideIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const initialIndexRef = useRef(initialIndex);
  initialIndexRef.current = initialIndex;
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;

  // Reopening starts from an empty query in the SAME render that shows the
  // popup: the overlay stays mounted while closed, and a slow runner could
  // otherwise paint (and type into) the previous query before the effect runs.
  const [openSeen, setOpenSeen] = useState(open);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) {
      setQuery("");
      setSelectedIndex(initialIndex);
      setAsideIndex(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    setQuery("");
    onQueryChangeRef.current?.("");
    setSelectedIndex(initialIndexRef.current);
    setAsideIndex(null);
    // Focus after the overlay is painted.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // IDEA popups close on Esc wherever focus ended up (a late editor focus
  // restore, a WebView that dropped the deferred input focus). Keys inside the
  // overlay keep their React handlers; another dialog on top keeps its Esc.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && overlayRef.current?.contains(target)) return;
      if (target?.closest("[role='dialog'], [role='alertdialog']")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
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

  const asideActive = asideIndex !== null && asideItemCount > 0;
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const input = inputRef.current;
    const tabDirection = onTabNavigate ? searchEverywhereTabDirection(event) : null;
    if (onTabNavigate && tabDirection) {
      event.preventDefault();
      event.stopPropagation();
      onTabNavigate(tabDirection);
      return;
    }
    if (groupNavigation && !event.altKey && !event.metaKey && !event.shiftKey) {
      const plain = !event.ctrlKey;
      const toLast = (plain && event.key === "PageDown") || (event.ctrlKey && event.key === "ArrowDown");
      const toFirst = (plain && event.key === "PageUp") || (event.ctrlKey && event.key === "ArrowUp");
      if (toLast || toFirst) {
        event.preventDefault();
        setAsideIndex(null);
        setSelectedIndex(toLast ? Math.max(0, results.length - 1) : 0);
        return;
      }
    }
    if (asideActive) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setAsideIndex((current) => Math.max(0, Math.min(asideItemCount - 1, (current ?? 0) + delta)));
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setAsideIndex(null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (asideIndex !== null) onAsideActivate?.(asideIndex);
        return;
      }
    } else if (
      event.key === "ArrowLeft"
      && asideItemCount > 0
      && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && (!input || (input.selectionStart === 0 && input.selectionEnd === 0))
    ) {
      // Only at the start of the query, where Left cannot move the caret.
      event.preventDefault();
      setAsideIndex(Math.min(selected, asideItemCount - 1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex(Math.min(selected + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(Math.max(selected - 1, 0));
    } else if (event.key === "Enter" && event.altKey && onAltEnter) {
      event.preventDefault();
      const item = results[selected];
      if (item) onAltEnter(item);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[selected];
      if (item) {
        const split = event.ctrlKey || event.metaKey;
        if (split) onPick(item, { split: true });
        else onPick(item);
      }
      else onEnterEmpty?.(query);
    }
  };

  return (
    <div
      ref={overlayRef}
      data-testid={testId}
      className="absolute inset-0 z-40 flex justify-center bg-black/30 pt-14"
      onKeyDown={(event) => {
        // Esc closes even before the deferred input focus lands (or after a
        // click moved focus onto a result row).
        if (event.key === "Escape" && event.target !== inputRef.current) {
          event.preventDefault();
          onClose();
        }
      }}
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
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={inputLabel}
            className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              onQueryChangeRef.current?.(next);
              setSelectedIndex(0);
              setAsideIndex(null);
            }}
            onKeyDown={handleKeyDown}
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--taomni-code-muted)]" />}
        </div>
        <div className="min-h-0 flex-1 flex">
        {aside && (
          <div className="w-[190px] shrink-0 overflow-auto border-r border-[var(--taomni-code-border)] py-1 text-[11px]">
            {typeof aside === "function" ? aside({ selectedIndex: asideActive ? asideIndex : null }) : aside}
          </div>
        )}
        <div ref={listRef} className="min-h-0 min-w-0 flex-1 overflow-auto py-1 text-[11px]">
          {results.length === 0 && (
            <div className="px-3 py-2 text-[var(--taomni-code-muted)]">{emptyText(query)}</div>
          )}
          {results.map((item, index) => (
            <button
              key={itemKey(item)}
              type="button"
              data-index={index}
              data-selected={(!asideActive && index === selected) || undefined}
              className="h-7 w-full min-w-0 flex items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onPick(item)}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
        </div>
        {footer && (
          <div className="shrink-0 flex min-w-0 items-center gap-3 border-t border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">
            {typeof footer === "function" ? footer(results[selected] ?? null) : footer}
          </div>
        )}
      </div>
    </div>
  );
}
