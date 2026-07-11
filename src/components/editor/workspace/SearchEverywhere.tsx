import { useEffect, useMemo, useRef, useState } from "react";
import { File, Loader2, Search } from "lucide-react";
import { rankFuzzy } from "./fuzzyMatch";

export interface GoToFileItem {
  rootId: string;
  rootName: string;
  path: string;
}

interface SearchEverywhereProps {
  open: boolean;
  items: GoToFileItem[];
  loading: boolean;
  truncated?: boolean;
  onClose: () => void;
  onOpenFile: (item: GoToFileItem) => void;
}

const MAX_RESULTS = 50;

function itemKey(item: GoToFileItem): string {
  return `${item.rootId}:${item.path}`;
}

export function SearchEverywhere({
  open,
  items,
  loading,
  truncated = false,
  onClose,
  onOpenFile,
}: SearchEverywhereProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    // Focus after the overlay is painted.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const results = useMemo(
    () => rankFuzzy(query, items, (item) => `${item.rootName}/${item.path}`, MAX_RESULTS),
    [items, query],
  );
  const selected = Math.min(selectedIndex, Math.max(0, results.length - 1));

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
      if (item) onOpenFile(item);
    }
  };

  return (
    <div
      data-testid="code-workspace-search-everywhere"
      className="absolute inset-0 z-40 flex justify-center bg-black/30 pt-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="h-fit max-h-[70%] w-[560px] max-w-[90%] flex flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] shadow-xl">
        <div className="shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Go to file (supports camelCase abbreviations)"
            aria-label="Go to file"
            className="h-6 w-full bg-transparent text-[12px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--taomni-code-muted)]" />}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1 text-[11px]">
          {results.length === 0 && (
            <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
              {loading ? "Indexing workspace files..." : items.length === 0 ? "No files in workspace roots" : "No matching files"}
            </div>
          )}
          {results.map((item, index) => {
            const name = item.path.split("/").pop() ?? item.path;
            const dir = item.path.slice(0, item.path.length - name.length).replace(/\/$/, "");
            return (
              <button
                key={itemKey(item)}
                type="button"
                data-index={index}
                data-selected={index === selected || undefined}
                className="h-7 w-full min-w-0 flex items-center gap-2 px-3 text-left hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onOpenFile(item)}
              >
                <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                <span className="shrink-0 text-[var(--taomni-code-text)]">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
                  {item.rootName}{dir ? `/${dir}` : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="shrink-0 flex items-center gap-3 border-t border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]">
          <span>↑↓ select</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span className="ml-auto">
            {truncated ? "file index truncated · " : ""}
            {items.length} file{items.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}
