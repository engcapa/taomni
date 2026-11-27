import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { useGridSearch } from "./useGridSearch";

export function GridSearchBar({ search }: { search: ReturnType<typeof useGridSearch> }) {
  return <div className="ml-auto h-6 inline-flex items-center gap-1 px-1 text-ui-small text-[var(--taomni-text-muted)]" data-testid="query-result-search">
    <Search className="w-3.5 h-3.5" />
    <input ref={search.inputRef} type="search" value={search.text} onChange={(event) => search.setText(event.target.value)}
      className="taomni-input h-6 w-[150px] text-ui-small" placeholder="Search" aria-label="Search result set"
      title={`Search result set (${search.mac ? "⌘F" : "Ctrl+F"})`} />
    <span data-testid="query-result-search-count" className="min-w-8 text-right tabular-nums" aria-live="polite">{search.position}/{search.count}</span>
    <button type="button" data-testid="query-result-search-previous" className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
      aria-label="Previous match" title={`Previous match (Shift+Enter, Shift+F3${search.mac ? ", ⌘⇧G" : ""})`} disabled={!search.count} onClick={() => search.move(-1)}><ArrowUp className="h-3.5 w-3.5" /></button>
    <button type="button" data-testid="query-result-search-next" className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
      aria-label="Next match" title={`Next match (Enter, F3${search.mac ? ", ⌘G" : ""})`} disabled={!search.count} onClick={() => search.move(1)}><ArrowDown className="h-3.5 w-3.5" /></button>
  </div>;
}
