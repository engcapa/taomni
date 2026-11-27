import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleMinus,
  CirclePlus,
  Ellipsis,
  FilePenLine,
  FilePlus2,
  FileQuestion,
  FileSymlink,
  FileX,
  List,
  ListChecks,
  ListFilter,
  ListTree,
  ListX,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { GitChange } from "../../../lib/git";
import { useT } from "../../../lib/i18n";
import { ContextMenu, type MenuItem } from "../../ContextMenu";

export type GitStageFilter = "unstaged" | "staged";
export type GitStatusFilter = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";

export interface GitChangeFilters {
  stage: Set<GitStageFilter>;
  status: Set<GitStatusFilter>;
}

export interface ChangesListToolbarProps {
  busy: boolean;
  filter: string;
  onFilterChange: (value: string) => void;
  filters: GitChangeFilters;
  onToggleStageFilter: (filter: GitStageFilter) => void;
  onToggleStatusFilter: (filter: GitStatusFilter) => void;
  onClearFilters: () => void;
  checkedCount: number;
  totalCount: number;
  visibleCount: number;
  visibleStagedCount: number;
  treeMode: boolean;
  onCheckVisible: () => void;
  onUncheckVisible: () => void;
  onStageVisible: () => void;
  onUnstageVisible: () => void;
  onToggleTreeMode: () => void;
}

const STAGE_FILTERS: Array<{
  key: GitStageFilter;
  labelKey: string;
  icon: ReactNode;
}> = [
  { key: "unstaged", labelKey: "git.workspaceChanges.showUnstaged", icon: <CircleDashed className="w-3.5 h-3.5" /> },
  { key: "staged", labelKey: "git.workspaceChanges.showStaged", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
];

const STATUS_FILTERS: Array<{
  key: GitStatusFilter;
  labelKey: string;
  icon: ReactNode;
}> = [
  { key: "modified", labelKey: "git.workspaceChanges.filterModified", icon: <FilePenLine className="w-3.5 h-3.5" /> },
  { key: "added", labelKey: "git.workspaceChanges.filterAdded", icon: <FilePlus2 className="w-3.5 h-3.5" /> },
  { key: "untracked", labelKey: "git.workspaceChanges.filterUntracked", icon: <FileQuestion className="w-3.5 h-3.5" /> },
  { key: "deleted", labelKey: "git.workspaceChanges.filterDeleted", icon: <FileX className="w-3.5 h-3.5" /> },
  { key: "renamed", labelKey: "git.workspaceChanges.filterRenamed", icon: <FileSymlink className="w-3.5 h-3.5" /> },
  { key: "conflict", labelKey: "git.workspaceChanges.filterConflicted", icon: <TriangleAlert className="w-3.5 h-3.5" /> },
];

export function emptyGitChangeFilters(): GitChangeFilters {
  return { stage: new Set(), status: new Set() };
}

export function hasActiveGitChangeFilters(filters: GitChangeFilters): boolean {
  return filters.stage.size > 0 || filters.status.size > 0;
}

export function gitChangeMatchesFilters(change: GitChange, filters: GitChangeFilters): boolean {
  if (filters.stage.size > 0 && !matchesStageFilters(change, filters.stage)) return false;
  if (filters.status.size > 0 && !matchesStatusFilters(change, filters.status)) return false;
  return true;
}

export function ChangesListToolbar({
  busy,
  filter,
  onFilterChange,
  filters,
  onToggleStageFilter,
  onToggleStatusFilter,
  onClearFilters,
  checkedCount,
  totalCount,
  visibleCount,
  visibleStagedCount,
  treeMode,
  onCheckVisible,
  onUncheckVisible,
  onStageVisible,
  onUnstageVisible,
  onToggleTreeMode,
}: ChangesListToolbarProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [openMenu, setOpenMenu] = useState<{ kind: "filter" | "more"; x: number; y: number } | null>(null);
  const filterOpen = openMenu?.kind === "filter";
  const moreOpen = openMenu?.kind === "more";
  const activeFilterCount = filters.stage.size + filters.status.size;
  const hasFilters = hasActiveGitChangeFilters(filters);
  const filterLabel = hasFilters
    ? t("git.workspaceChanges.changeFiltersActive", { count: activeFilterCount })
    : t("git.workspaceChanges.changeFilters");
  const viewLabel = treeMode
    ? t("git.workspaceChanges.switchToFlatList")
    : t("git.workspaceChanges.switchToDirectoryTree");

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setCompact(entry.contentRect.width < 560);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const toggleMenu = (kind: "filter" | "more", button: HTMLButtonElement | null) => {
    setOpenMenu((current) => {
      if (current?.kind === kind) return null;
      const rect = button?.getBoundingClientRect();
      return {
        kind,
        x: rect ? (kind === "more" ? Math.max(8, rect.right - 220) : rect.left) : 8,
        y: rect ? rect.bottom + 4 : 36,
      };
    });
  };

  const stageVisibleLabel = t("git.workspaceChanges.stageVisible", { count: visibleCount });
  const unstageVisibleLabel = t("git.workspaceChanges.unstageVisible", { count: visibleStagedCount });
  const checkVisibleLabel = t("git.workspaceChanges.selectVisible", { count: visibleCount });
  const uncheckVisibleLabel = t("git.workspaceChanges.unselectVisible", { count: visibleCount });

  const filterItems: MenuItem[] = [
    { label: t("git.workspaceChanges.stageFilterSection"), sectionHeader: true },
    ...STAGE_FILTERS.map((item) => ({
      label: t(item.labelKey),
      icon: item.icon,
      checked: filters.stage.has(item.key),
      keepOpen: true,
      onClick: () => onToggleStageFilter(item.key),
    })),
    { label: "", separator: true },
    { label: t("git.workspaceChanges.statusFilterSection"), sectionHeader: true },
    ...STATUS_FILTERS.map((item) => ({
      label: t(item.labelKey),
      icon: item.icon,
      checked: filters.status.has(item.key),
      keepOpen: true,
      onClick: () => onToggleStatusFilter(item.key),
    })),
    { label: "", separator: true },
    {
      label: t("git.workspaceChanges.clearFilters"),
      icon: <ListFilter className="w-3.5 h-3.5" />,
      disabled: !hasFilters,
      onClick: onClearFilters,
    },
  ];

  const moreItems: MenuItem[] = [
    { label: t("git.workspaceChanges.selectionActions"), sectionHeader: true },
    { label: checkVisibleLabel, icon: <ListChecks className="w-3.5 h-3.5" />, disabled: visibleCount === 0, onClick: onCheckVisible },
    { label: uncheckVisibleLabel, icon: <ListX className="w-3.5 h-3.5" />, disabled: visibleCount === 0, onClick: onUncheckVisible },
    { label: "", separator: true },
    { label: t("git.workspaceChanges.stageActions"), sectionHeader: true },
    ...(compact ? [{ label: stageVisibleLabel, icon: <CirclePlus className="w-3.5 h-3.5" />, disabled: busy || visibleCount === 0, onClick: onStageVisible }] : []),
    { label: unstageVisibleLabel, icon: <CircleMinus className="w-3.5 h-3.5" />, disabled: busy || visibleStagedCount === 0, onClick: onUnstageVisible },
  ];

  return (
    <div
      ref={rootRef}
      className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]"
    >
      <div className="relative min-w-24 flex-1">
        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
        <input
          type="search"
          className="taomni-input h-7 w-full pl-7"
          value={filter}
          placeholder={t("git.workspaceChanges.filterPlaceholder")}
          aria-label={t("git.workspaceChanges.filterPlaceholder")}
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>

      <button
        ref={filterButtonRef}
        type="button"
        className={`taomni-btn h-7 w-8 p-0 inline-flex items-center justify-center gap-0.5 shrink-0 ${
          hasFilters ? "bg-[var(--taomni-primary-bg)] text-[var(--taomni-primary-text)] border-[var(--taomni-primary-bg)]" : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={filterOpen}
        aria-label={filterLabel}
        title={filterLabel}
        onClick={() => toggleMenu("filter", filterButtonRef.current)}
      >
        <ListFilter className="w-3.5 h-3.5" />
        <ChevronDown className="w-2.5 h-2.5" />
      </button>

      {!compact ? (
        <ToolbarIconButton
          label={stageVisibleLabel}
          icon={<CirclePlus className="w-3.5 h-3.5" />}
          disabled={busy || visibleCount === 0}
          onClick={onStageVisible}
        />
      ) : null}

      <button
        type="button"
        data-testid="git-changes-tree-toggle"
        data-tree-mode={treeMode ? "tree" : "flat"}
        aria-pressed={treeMode}
        aria-label={viewLabel}
        title={viewLabel}
        className="taomni-btn h-7 w-8 p-0 inline-flex items-center justify-center"
        onClick={onToggleTreeMode}
      >
        {treeMode ? <List className="w-3.5 h-3.5" /> : <ListTree className="w-3.5 h-3.5" />}
      </button>

      <button
        ref={moreButtonRef}
        type="button"
        className="taomni-btn h-7 w-8 p-0 inline-flex items-center justify-center gap-0.5 shrink-0"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label={t("git.workspaceChanges.moreActions")}
        title={t("git.workspaceChanges.moreActions")}
        onClick={() => toggleMenu("more", moreButtonRef.current)}
      >
        <Ellipsis className="w-3.5 h-3.5" />
        <ChevronDown className="w-2.5 h-2.5" />
      </button>

      {openMenu && (
        <ContextMenu
          testId={filterOpen ? "git-change-filter-dropdown" : "git-change-action-dropdown"}
          ariaLabel={filterOpen ? filterLabel : t("git.workspaceChanges.moreActions")}
          x={openMenu.x}
          y={openMenu.y}
          anchorRef={filterOpen ? filterButtonRef : moreButtonRef}
          items={filterOpen ? filterItems : moreItems}
          onClose={() => setOpenMenu(null)}
        />
      )}

      <span className="shrink-0 min-w-10 text-center text-ui-small text-[var(--taomni-text-muted)]">
        {checkedCount}/{totalCount}
      </span>
    </div>
  );
}

function ToolbarIconButton({
  label,
  icon,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 w-7 shrink-0 inline-flex items-center justify-center px-0"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function matchesStageFilters(change: GitChange, filters: Set<GitStageFilter>): boolean {
  if (filters.size === 2) return true;
  if (filters.has("staged") && change.staged) return true;
  if (filters.has("unstaged") && (change.unstaged || !change.staged)) return true;
  return false;
}

function matchesStatusFilters(change: GitChange, filters: Set<GitStatusFilter>): boolean {
  if (filters.has("conflict") && change.conflict) return true;
  if (filters.has("modified") && !change.conflict && change.status === "modified") return true;
  if (filters.has("added") && !change.conflict && change.status === "added") return true;
  if (filters.has("untracked") && !change.conflict && change.status === "untracked") return true;
  if (filters.has("deleted") && !change.conflict && change.status === "deleted") return true;
  if (filters.has("renamed") && !change.conflict && change.status === "renamed") return true;
  return false;
}
