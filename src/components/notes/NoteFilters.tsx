import type { NoteFilter, NoteTag } from "../../lib/notes";
import { useT } from "../../lib/i18n";

const FILTERS: NoteFilter[] = [
  "recent_incomplete",
  "all",
  "pinned",
  "today",
  "due_soon",
  "overdue",
  "completed",
  "archived",
];

interface NoteFiltersProps {
  filter: NoteFilter;
  tagFilterId: string | null;
  tags: NoteTag[];
  onSelectFilter: (filter: NoteFilter) => void;
  onSelectTag: (tagId: string | null) => void;
}

/** Horizontal, scrollable filter/tag chips for the notes views (§4.2). */
export function NoteFilters({ filter, tagFilterId, tags, onSelectFilter, onSelectTag }: NoteFiltersProps) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-1 px-2 py-1 border-b border-[var(--taomni-divider)] shrink-0 overflow-x-auto"
      data-testid="notes-filters"
      role="tablist"
      aria-label={t("notes.title")}
    >
      {FILTERS.map((f) => {
        const active = filter === f && tagFilterId === null;
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`notes-filter-${f}`}
            className={`h-5 px-2 rounded-full text-[10px] whitespace-nowrap border transition-colors ${
              active
                ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                : "border-[var(--taomni-divider)] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => onSelectFilter(f)}
          >
            {t(`notes.filters.${f}`)}
          </button>
        );
      })}
      {tags.map((tag) => {
        const active = tagFilterId === tag.id;
        return (
          <button
            key={tag.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`notes-tag-filter-${tag.id}`}
            className={`h-5 px-2 rounded-full text-[10px] whitespace-nowrap border transition-colors ${
              active
                ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                : "border-[var(--taomni-divider)] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            }`}
            style={tag.color ? { borderColor: tag.color } : undefined}
            onClick={() => onSelectTag(active ? null : tag.id)}
          >
            #{tag.name}
          </button>
        );
      })}
    </div>
  );
}
