import type { NoteFilter } from "../notes";

export function coerceFilter(value: unknown): NoteFilter {
  const filters: NoteFilter[] = ["recent_incomplete", "all", "pinned", "today", "due_soon", "overdue", "completed", "archived", "tag"];
  return filters.includes(value as NoteFilter) ? value as NoteFilter : "recent_incomplete";
}

export function normalizeStatusFilters(values: unknown): NoteFilter[] {
  const raw = Array.isArray(values) ? values : [values];
  const next: NoteFilter[] = [];
  for (const value of raw) {
    const filter = coerceFilter(value);
    if (filter === "tag" || next.includes(filter)) continue;
    if (filter === "all") return ["all"];
    next.push(filter);
  }
  return next.length ? next : ["recent_incomplete"];
}

export function toggleStatusFilter(selected: NoteFilter[], filter: NoteFilter): NoteFilter[] {
  if (filter === "tag") return selected;
  if (filter === "all") return ["all"];
  const base = selected.filter((item) => item !== "all");
  return normalizeStatusFilters(base.includes(filter) ? base.filter((item) => item !== filter) : [...base, filter]);
}
