import { useRef, useState } from "react";
import { ChevronDown, ListFilter } from "lucide-react";
import type { NoteFilter, NoteTag } from "../../lib/notes";
import { useT } from "../../lib/i18n";
import { ContextMenu, type MenuItem } from "../ContextMenu";

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
  prefix?: string;
}

interface NoteTagFiltersProps {
  tagFilterId: string | null;
  tags: NoteTag[];
  onSelectTag: (tagId: string | null) => void;
  className?: string;
  prefix?: string;
}

export function NoteStatusFilter({ filters, onToggleFilter, className = "", prefix = "notes" }: NoteStatusFilterProps) {
  const t = useT();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const selected: NoteFilter[] = filters.length > 0 ? filters : ["recent_incomplete"];
  const summary =
    selected.length === 1
      ? t(`notes.filters.${selected[0]}`)
      : t("notes.statusCount", { count: selected.length });
  const buttonLabel = `${t("notes.status")}: ${summary}`;
  const open = menuPos !== null;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      data-testid={`${prefix}-filters`}
      aria-label={t("notes.title")}
    >
      <button
        ref={buttonRef}
        type="button"
        className="taomni-btn h-6 w-8 p-0 inline-flex items-center justify-center gap-0.5"
        onClick={() => {
          if (open) {
            setMenuPos(null);
            return;
          }
          const rect = buttonRef.current?.getBoundingClientRect();
          setMenuPos(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 8, y: 36 });
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        title={buttonLabel}
        data-testid={`${prefix}-filter-menu`}
      >
        <ListFilter className="w-3.5 h-3.5" />
        <ChevronDown className="w-2.5 h-2.5" />
      </button>
      {menuPos && (
        <ContextMenu
          testId={`${prefix}-filter-dropdown`}
          ariaLabel={buttonLabel}
          x={menuPos.x}
          y={menuPos.y}
          anchorRef={buttonRef}
          onClose={() => setMenuPos(null)}
          items={FILTERS.map((f): MenuItem => ({
            label: t(`notes.filters.${f}`),
            testId: `${prefix}-filter-${f}`,
            checked: selected.includes(f),
            keepOpen: true,
            onClick: () => onToggleFilter(f),
          }))}
        />
      )}
    </div>
  );
}

export function NoteTagFilters({
  tagFilterId,
  tags,
  onSelectTag,
  prefix = "notes",
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
            data-testid={`${prefix}-tag-filter-${tag.id}`}
            className={`h-5 px-2 rounded-full text-ui-caption whitespace-nowrap border transition-colors ${
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
