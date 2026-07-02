import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ListFilter } from "lucide-react";
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
  filters: NoteFilter[];
  tagFilterId: string | null;
  tags: NoteTag[];
  onToggleFilter: (filter: NoteFilter) => void;
  onSelectTag: (tagId: string | null) => void;
}

interface NoteStatusFilterProps {
  filters: NoteFilter[];
  onToggleFilter: (filter: NoteFilter) => void;
  className?: string;
}

interface NoteTagFiltersProps {
  tagFilterId: string | null;
  tags: NoteTag[];
  onSelectTag: (tagId: string | null) => void;
  className?: string;
}

export function NoteStatusFilter({ filters, onToggleFilter, className = "" }: NoteStatusFilterProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected: NoteFilter[] = filters.length > 0 ? filters : ["recent_incomplete"];
  const summary =
    selected.length === 1
      ? t(`notes.filters.${selected[0]}`)
      : t("notes.statusCount", { count: selected.length });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`relative shrink-0 ${className}`}
      data-testid="notes-filters"
      aria-label={t("notes.title")}
    >
      <button
        type="button"
        className="taomni-btn h-6 max-w-[150px] px-2 inline-flex items-center gap-1 text-[11px]"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="notes-filter-menu"
      >
        <ListFilter className="w-3.5 h-3.5" />
        <span className="max-w-[112px] truncate">
          {t("notes.status")}: {summary}
        </span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-[30px] z-20 w-44 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-1 shadow-lg"
          role="menu"
          data-testid="notes-filter-dropdown"
        >
          {FILTERS.map((f) => {
            const active = selected.includes(f);
            return (
              <button
                key={f}
                type="button"
                role="menuitemcheckbox"
                aria-checked={active}
                data-testid={`notes-filter-${f}`}
                className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[11px] ${
                  active ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]" : "hover:bg-[var(--taomni-hover)]"
                }`}
                onClick={() => onToggleFilter(f)}
              >
                <span className="w-3.5 shrink-0">{active && <Check className="w-3.5 h-3.5" />}</span>
                <span className="truncate">{t(`notes.filters.${f}`)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NoteTagFilters({
  tagFilterId,
  tags,
  onSelectTag,
  className = "flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--taomni-divider)] shrink-0",
}: NoteTagFiltersProps) {
  if (tags.length === 0) return null;

  return (
    <div className={className}>
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

/** Status dropdown + tag chips for the notes views (§4.2). */
export function NoteFilters({ filters, tagFilterId, tags, onToggleFilter, onSelectTag }: NoteFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--taomni-divider)] shrink-0">
      <NoteStatusFilter filters={filters} onToggleFilter={onToggleFilter} />
      <NoteTagFilters tagFilterId={tagFilterId} tags={tags} onSelectTag={onSelectTag} className="contents" />
    </div>
  );
}
