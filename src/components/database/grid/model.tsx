import { type MouseEvent } from "react";
import type { DbQueryResult } from "../../../lib/ipc";
import { type GridRow, type ColumnFilterConfig, type DistinctColumnSummary } from "./types";
import { DISTINCT_FILTER_VALUE_LIMIT } from "./preferences";


export const ROW_HEIGHT = 26;

export const OVERSCAN = 12;


export function makeRows(result: DbQueryResult): GridRow[] {
  return result.rows.map((values, index) => ({
    id: `row-${index}-${result.rows.length}`,
    originalIndex: index,
    values: [...values],
    original: [...values],
    status: "clean",
  }));
}


export function nextRowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}


/** Detect a numeric column value for right-alignment + numeric sort. */
export function isNumeric(value: string | null): boolean {
  if (value === null || value === "") return false;
  return !Number.isNaN(Number(value));
}


export function filterValueKey(value: string | null): string {
  return value === null ? "__taomni_null__" : `value:${value}`;
}


export function filterValueLabel(value: string | null): string {
  if (value === null) return "NULL";
  if (value === "") return "(empty)";
  return value;
}


export function isColumnFilterActive(config: ColumnFilterConfig): boolean {
  return config.text.trim().length > 0 || config.selectedValues.length > 0;
}


export function distinctValuesForColumn(rows: GridRow[], columnIndex: number): DistinctColumnSummary {
  const counts = new Map<string, { value: string | null; count: number }>();
  for (const row of rows) {
    if (row.status === "deleted") continue;
    const value = row.values[columnIndex] ?? null;
    const key = filterValueKey(value);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  const entries = Array.from(counts.entries())
    .map(([key, item]) => ({ key, value: item.value, label: filterValueLabel(item.value), count: item.count }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return 0;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (isNumeric(a.value) && isNumeric(b.value)) return Number(a.value) - Number(b.value);
      return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
    });
  return {
    values: entries.slice(0, DISTINCT_FILTER_VALUE_LIMIT),
    total: entries.length,
    truncated: entries.length > DISTINCT_FILTER_VALUE_LIMIT,
  };
}


export function isGridBlockSelectionMouseEvent(event: Pick<MouseEvent<HTMLElement>, "button" | "altKey" | "ctrlKey" | "shiftKey">): boolean {
  return event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey));
}
