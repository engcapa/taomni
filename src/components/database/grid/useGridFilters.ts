import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { distinctValuesForColumn, filterValueKey, isColumnFilterActive, isNumeric } from "./model";
import { DEFAULT_COLUMN_FILTER } from "./preferences";
import { type ActiveColumnFilter, type ActiveSortDir, type ColumnFilterConfig, type GridRow, type OpenColumnFilter, type SortRule } from "./types";


export interface UseGridFiltersContext {
  result: import("../../../lib/ipc").DbQueryResult;
  visibleColumnIndexes: number[];
  rows: GridRow[];
}

export function useGridFilters(context: UseGridFiltersContext) {
  const { result, visibleColumnIndexes, rows } = context;

  const columnFilterPopoverRef = useRef<HTMLDivElement>(null);
  const [sorts, setSorts] = useState<SortRule[]>([]);
  const [filterText, setFilterText] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<number, ColumnFilterConfig>>({});
  const [openColumnFilter, setOpenColumnFilter] = useState<OpenColumnFilter | null>(null);
  const [draftColumnFilter, setDraftColumnFilter] = useState<ColumnFilterConfig>(DEFAULT_COLUMN_FILTER);


  useEffect(() => {
    if (!openColumnFilter) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (columnFilterPopoverRef.current?.contains(event.target as Node)) return;
      setOpenColumnFilter(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenColumnFilter(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openColumnFilter]);

  useEffect(() => {
    setColumnFilters({});
    setOpenColumnFilter(null);
    setDraftColumnFilter(DEFAULT_COLUMN_FILTER);
  }, [result.columns]);

  const activeColumnFiltersFor = useCallback(
    (filters: Record<number, ColumnFilterConfig>): ActiveColumnFilter[] =>
      Object.entries(filters)
        .map(([rawIndex, config]) => ({
          columnIndex: Number(rawIndex),
          text: config.text.trim(),
          mode: config.mode,
          selectedValues: config.selectedValues,
        }))
        .filter(
          (filter) =>
            Number.isInteger(filter.columnIndex) &&
            filter.columnIndex >= 0 &&
            filter.columnIndex < result.columns.length &&
            (filter.text.length > 0 || filter.selectedValues.length > 0),
        ),
    [result.columns.length],
  );

  const activeColumnFilters = useMemo(
    () => activeColumnFiltersFor(columnFilters),
    [activeColumnFiltersFor, columnFilters],
  );

  const activeColumnFilterCount = activeColumnFilters.length;

  const rowMatchesFilter = useCallback(
    (row: GridRow) => {
      const needle = filterText.trim().toLowerCase();
      if (needle && !visibleColumnIndexes.some((index) => (row.values[index] ?? "").toLowerCase().includes(needle))) {
        return false;
      }
      return activeColumnFilters.every((filter) => {
        const rawValue = row.values[filter.columnIndex] ?? null;
        if (filter.selectedValues.length > 0) {
          const selected = new Set(filter.selectedValues.map(filterValueKey));
          return selected.has(filterValueKey(rawValue));
        }
        if (!filter.text) return true;
        const value = (rawValue ?? "").toLowerCase();
        const columnNeedle = filter.text.toLowerCase();
        return filter.mode === "exact" ? value === columnNeedle : value.includes(columnNeedle);
      });
    },
    [activeColumnFilters, filterText, visibleColumnIndexes],
  );

  const order = useMemo(() => {
    const indexes = rows.map((_, index) => index).filter((index) => rowMatchesFilter(rows[index]));
    if (sorts.length === 0) return indexes;
    const numericByColumn = new Map(
      sorts.map((sort) => [sort.columnIndex, indexes.every((index) => isNumeric(rows[index].values[sort.columnIndex]))]),
    );
    indexes.sort((a, b) => {
      for (const sort of sorts) {
        const va = rows[a].values[sort.columnIndex];
        const vb = rows[b].values[sort.columnIndex];
        let cmp = 0;
        if (va === null && vb === null) cmp = 0;
        else if (va === null) cmp = 1;
        else if (vb === null) cmp = -1;
        else {
          cmp = numericByColumn.get(sort.columnIndex)
            ? Number(va) - Number(vb)
            : va.localeCompare(vb);
        }
        if (cmp !== 0) return sort.dir === "asc" ? cmp : -cmp;
      }
      return a - b;
    });
    return indexes;
  }, [rowMatchesFilter, rows, sorts]);

  const orderedRows = useMemo(() => order.map((index) => rows[index]), [order, rows]);
  const rowsFiltered = orderedRows.length < rows.length;

  const nextSortDir = (dir: ActiveSortDir): ActiveSortDir | null => (dir === "asc" ? "desc" : null);
  const toggleSort = (col: number, additive: boolean) => {
    setSorts((current) => {
      const index = current.findIndex((sort) => sort.columnIndex === col);
      if (!additive) {
        if (index < 0) return [{ columnIndex: col, dir: "asc" }];
        const dir = nextSortDir(current[index].dir);
        return dir ? [{ columnIndex: col, dir }] : [];
      }
      if (index < 0) return [...current, { columnIndex: col, dir: "asc" }];
      const dir = nextSortDir(current[index].dir);
      if (!dir) return current.filter((_, sortIndex) => sortIndex !== index);
      return current.map((sort, sortIndex) => (sortIndex === index ? { ...sort, dir } : sort));
    });
  };

  const applyColumnFilter = (columnIndex: number, config: ColumnFilterConfig) => {
    setColumnFilters((current) => {
      const next = { ...current };
      if (isColumnFilterActive(config)) next[columnIndex] = config;
      else delete next[columnIndex];
      return next;
    });
  };

  const updateDraftColumnFilter = (patch: Partial<ColumnFilterConfig>) => {
    setDraftColumnFilter((current) => ({ ...current, ...patch }));
  };

  const toggleDraftColumnFilterValue = (value: string | null) => {
    setDraftColumnFilter((current) => {
      const key = filterValueKey(value);
      const selected = current.selectedValues.some((item) => filterValueKey(item) === key)
        ? current.selectedValues.filter((item) => filterValueKey(item) !== key)
        : [...current.selectedValues, value];
      return { ...current, selectedValues: selected };
    });
  };

  const clearAllFilters = () => {
    setFilterText("");
    setColumnFilters({});
    setOpenColumnFilter(null);
  };

  const openColumnFilterPanel = (event: MouseEvent<HTMLButtonElement>, columnIndex: number) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 280;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360));
    const current = columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
    setDraftColumnFilter({
      text: current.text,
      mode: current.mode,
      selectedValues: [...current.selectedValues],
    });
    setOpenColumnFilter({ columnIndex, left, top });
  };
  const openFilterColumnIndex = openColumnFilter?.columnIndex ?? null;
  const openFilterColumn = openFilterColumnIndex !== null ? result.columns[openFilterColumnIndex] : null;
  const openFilterConfig = openFilterColumnIndex !== null
    ? draftColumnFilter
    : DEFAULT_COLUMN_FILTER;
  const openFilterDistinctValues = useMemo(
    () => {
      if (openFilterColumnIndex === null) return { values: [], total: 0, truncated: false };
      const summary = distinctValuesForColumn(rows, openFilterColumnIndex);
      const needle = draftColumnFilter.text.trim().toLowerCase();
      if (!needle) return summary;
      return {
        ...summary,
        values: summary.values.filter((item) => item.label.toLowerCase().includes(needle)),
      };
    },
    [draftColumnFilter.text, openFilterColumnIndex, rows],
  );
  const openFilterSelectedKeys = new Set(openFilterConfig.selectedValues.map(filterValueKey));
  const filterModeButtonStyle = (active: boolean): CSSProperties | undefined =>
    active
      ? {
        background: "var(--taomni-selected)",
        borderColor: "var(--taomni-selected-border)",
        color: "var(--taomni-accent)",
      }
      : undefined;
  const applyLocalColumnFilter = () => {
    if (openFilterColumnIndex === null) return;
    applyColumnFilter(openFilterColumnIndex, draftColumnFilter);
    setOpenColumnFilter(null);
  };
  return { activeColumnFilters, orderedRows, order, activeColumnFilterCount, clearAllFilters, rowsFiltered, toggleSort, openColumnFilterPanel, openFilterColumn, openFilterConfig, updateDraftColumnFilter, applyLocalColumnFilter, filterModeButtonStyle, openFilterDistinctValues, openFilterSelectedKeys, toggleDraftColumnFilterValue, columnFilterPopoverRef, sorts, setSorts, filterText, setFilterText, filterOpen, setFilterOpen, columnFilters, setColumnFilters, openColumnFilter, setOpenColumnFilter, draftColumnFilter, setDraftColumnFilter };
}
