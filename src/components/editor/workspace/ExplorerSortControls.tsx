import { ArrowDown, ArrowUp } from "lucide-react";
import type { MenuItem } from "../../ContextMenu";
import { useT } from "../../../lib/i18n";
import type { ExplorerSort, ExplorerSortField } from "./explorerPreferences";

const FIELDS: ExplorerSortField[] = ["name", "size", "type", "modified"];

export function explorerSortMenu(sort: ExplorerSort, change: (value: ExplorerSort) => void, t: ReturnType<typeof useT>): MenuItem {
  return { label: t("platform.explorerSort"), testId: "code-workspace-tree-sort", children: [
    ...FIELDS.map((field) => ({ label: t(`platform.explorerColumn.${field}`),
      testId: `code-workspace-tree-sort-${field}`, checked: sort.field === field,
      onClick: () => change({ ...sort, field }) })),
    { label: "", separator: true },
    { label: t("platform.explorerAscending"), testId: "code-workspace-tree-sort-ascending", checked: !sort.descending,
      onClick: () => change({ ...sort, descending: false }) },
    { label: t("platform.explorerDescending"), testId: "code-workspace-tree-sort-descending", checked: sort.descending,
      onClick: () => change({ ...sort, descending: true }) },
    { label: t("platform.explorerFoldersFirst"), testId: "code-workspace-tree-sort-folders-first", checked: sort.foldersFirst,
      onClick: () => change({ ...sort, foldersFirst: !sort.foldersFirst }) },
  ] };
}

export function ExplorerListColumns({ sort, onChange }: { sort: ExplorerSort; onChange?: (value: ExplorerSort) => void }) {
  const t = useT();
  const column = (field: ExplorerSortField) => {
    const selected = field === sort.field;
    const Direction = sort.descending ? ArrowDown : ArrowUp;
    return <button type="button" key={field} data-testid={`code-workspace-list-sort-${field}`}
      aria-label={t(`platform.explorerColumn.${field}`)} aria-pressed={selected}
      className="flex min-w-0 items-center gap-1 text-left hover:text-[var(--taomni-code-text)]"
      onClick={() => onChange?.({ ...sort, field, descending: selected ? !sort.descending : false })}>
      <span className="truncate">{t(`platform.explorerColumn.${field}`)}</span>
      {selected && <Direction className="h-3 w-3 shrink-0" />}
    </button>;
  };
  return <div data-testid="code-workspace-list-columns" className="taomni-explorer-list-columns sticky top-0 z-10 flex h-7 gap-2 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[var(--taomni-code-muted)]">
    <span className="taomni-explorer-list-name flex min-w-0">{column("name")}</span>
    <span className="taomni-explorer-list-metadata">{FIELDS.slice(1).map(column)}</span>
  </div>;
}
