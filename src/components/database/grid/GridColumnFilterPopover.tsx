import { Ban, Filter } from "lucide-react";
import { DEFAULT_COLUMN_FILTER, DISTINCT_FILTER_VALUE_LIMIT } from "./preferences";
import type { useGridFilters } from "./useGridFilters";


export interface GridColumnFilterPopoverContext {
  filters: ReturnType<typeof useGridFilters>;
}

export function GridColumnFilterPopover(context: GridColumnFilterPopoverContext) {
  const { filters } = context;
  const { openFilterColumn } = filters;
  return filters.openColumnFilter && openFilterColumn && (
    <div
      ref={filters.columnFilterPopoverRef}
      className="fixed z-[10000] w-[280px] rounded shadow-xl p-2 text-[12px]"
      style={{
        left: filters.openColumnFilter.left,
        top: filters.openColumnFilter.top,
        background: "var(--taomni-panel-bg)",
        border: "1px solid var(--taomni-divider)",
        color: "var(--taomni-text)",
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <Filter className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1 truncate font-semibold" title={openFilterColumn.name}>
          {openFilterColumn.name}
        </div>
        <button
          type="button"
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          title="Clear column filter"
          aria-label={`Clear filter for ${openFilterColumn.name}`}
          onClick={() => filters.setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}
        >
          <Ban className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        type="search"
        autoFocus
        value={filters.openFilterConfig.text}
        onChange={(event) => filters.updateDraftColumnFilter({ text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") filters.applyLocalColumnFilter();
          if (event.key === "Escape") filters.setOpenColumnFilter(null);
        }}
        className="taomni-input h-7 w-full text-[12px]"
        placeholder="Filter this column"
        aria-label={`Filter ${openFilterColumn.name}`}
      />
      <div className="mt-2 grid grid-cols-2 gap-1">
        <button
          type="button"
          className="taomni-btn h-7"
          style={filters.filterModeButtonStyle(filters.openFilterConfig.mode === "fuzzy")}
          onClick={() => filters.updateDraftColumnFilter({ mode: "fuzzy" })}
        >
          Fuzzy
        </button>
        <button
          type="button"
          className="taomni-btn h-7"
          style={filters.filterModeButtonStyle(filters.openFilterConfig.mode === "exact")}
          onClick={() => filters.updateDraftColumnFilter({ mode: "exact" })}
        >
          Exact
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-[var(--taomni-text-muted)]">
        <span>Distinct values</span>
        <span className="shrink-0">
          {filters.openFilterConfig.selectedValues.length > 0
            ? `${filters.openFilterConfig.selectedValues.length} selected`
            : `${filters.openFilterDistinctValues.total} distinct`}
        </span>
      </div>
      <div
        className="mt-1 max-h-[154px] overflow-auto rounded taomni-scroll-y"
        style={{ border: "1px solid var(--taomni-divider)", background: "var(--taomni-bg)" }}
      >
        {filters.openFilterDistinctValues.values.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
            No values
          </div>
        ) : (
          filters.openFilterDistinctValues.values.map((item) => (
            <label
              key={item.key}
              className="flex h-7 items-center gap-2 px-2 text-[11px] hover:bg-[var(--taomni-hover)]"
              title={item.value === null ? "NULL" : item.value}
            >
              <input
                type="checkbox"
                className="h-3 w-3 shrink-0"
                checked={filters.openFilterSelectedKeys.has(item.key)}
                onChange={() => filters.toggleDraftColumnFilterValue(item.value)}
                aria-label={`Select ${item.label} for ${openFilterColumn.name}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono">{item.label}</span>
              <span className="shrink-0 text-[var(--taomni-text-muted)]">{item.count}</span>
            </label>
          ))
        )}
      </div>
      {filters.openFilterDistinctValues.truncated && (
        <div className="mt-1 text-[10px] text-[var(--taomni-text-muted)]">
          Showing first {DISTINCT_FILTER_VALUE_LIMIT} values
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-1">
        <button type="button" className="taomni-btn h-7 px-2" onClick={() => filters.setOpenColumnFilter(null)}>
          Close
        </button>
        <button type="button" className="taomni-btn h-7 px-2" onClick={() => filters.setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}>
          Clear
        </button>
        <button type="button" className="taomni-btn h-7 px-2" onClick={filters.applyLocalColumnFilter}>
          Apply
        </button>
      </div>
    </div>
  );
}
