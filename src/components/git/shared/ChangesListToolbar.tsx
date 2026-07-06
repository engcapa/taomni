import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Check,
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
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
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

  useCloseOnOutside(filterOpen, filterMenuRef, () => setFilterOpen(false));
  useCloseOnOutside(moreOpen, moreMenuRef, () => setMoreOpen(false));

  const stageVisibleLabel = t("git.workspaceChanges.stageVisible", { count: visibleCount });
  const unstageVisibleLabel = t("git.workspaceChanges.unstageVisible", { count: visibleStagedCount });
  const checkVisibleLabel = t("git.workspaceChanges.selectVisible", { count: visibleCount });
  const uncheckVisibleLabel = t("git.workspaceChanges.unselectVisible", { count: visibleCount });

  const menuPlacementClass = compact ? "right-0" : "left-0";

  return (
    <div
      ref={rootRef}
      className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]"
    >
      <div className="relative min-w-24 flex-1">
        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
        <input
          className="taomni-input h-7 w-full pl-7"
          value={filter}
          placeholder={t("git.workspaceChanges.filterPlaceholder")}
          aria-label={t("git.workspaceChanges.filterPlaceholder")}
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>

      <div ref={filterMenuRef} className="relative shrink-0">
        <button
          type="button"
          className={`taomni-btn h-7 w-8 p-0 inline-flex items-center justify-center gap-0.5 ${
            hasFilters ? "bg-[var(--taomni-accent)] text-white border-[var(--taomni-accent)]" : ""
          }`}
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          aria-label={filterLabel}
          title={filterLabel}
          onClick={() => {
            setMoreOpen(false);
            setFilterOpen((value) => !value);
          }}
        >
          <ListFilter className="w-3.5 h-3.5" />
          <ChevronDown className="w-2.5 h-2.5" />
        </button>
        {filterOpen ? (
          <div
            className={`absolute ${menuPlacementClass} top-[31px] z-20 w-52 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-1 shadow-lg`}
            role="menu"
            data-testid="git-change-filter-dropdown"
          >
            <MenuSectionLabel>{t("git.workspaceChanges.stageFilterSection")}</MenuSectionLabel>
            {STAGE_FILTERS.map((item) => (
              <FilterMenuItem
                key={item.key}
                label={t(item.labelKey)}
                icon={item.icon}
                active={filters.stage.has(item.key)}
                onClick={() => onToggleStageFilter(item.key)}
              />
            ))}
            <MenuDivider />
            <MenuSectionLabel>{t("git.workspaceChanges.statusFilterSection")}</MenuSectionLabel>
            {STATUS_FILTERS.map((item) => (
              <FilterMenuItem
                key={item.key}
                label={t(item.labelKey)}
                icon={item.icon}
                active={filters.status.has(item.key)}
                onClick={() => onToggleStatusFilter(item.key)}
              />
            ))}
            <MenuDivider />
            <MenuActionItem
              label={t("git.workspaceChanges.clearFilters")}
              icon={<ListFilter className="w-3.5 h-3.5" />}
              disabled={!hasFilters}
              onClick={() => {
                onClearFilters();
                setFilterOpen(false);
              }}
            />
          </div>
        ) : null}
      </div>

      {!compact ? (
        <ToolbarIconButton
          label={stageVisibleLabel}
          icon={<CirclePlus className="w-3.5 h-3.5" />}
          disabled={busy || visibleCount === 0}
          onClick={onStageVisible}
        />
      ) : null}

      <div ref={moreMenuRef} className="relative shrink-0">
        <button
          type="button"
          className="taomni-btn h-7 w-8 p-0 inline-flex items-center justify-center gap-0.5"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label={t("git.workspaceChanges.moreActions")}
          title={t("git.workspaceChanges.moreActions")}
          onClick={() => {
            setFilterOpen(false);
            setMoreOpen((value) => !value);
          }}
        >
          <Ellipsis className="w-3.5 h-3.5" />
          <ChevronDown className="w-2.5 h-2.5" />
        </button>
        {moreOpen ? (
          <div
            className="absolute right-0 top-[31px] z-20 w-52 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-1 shadow-lg"
            role="menu"
            data-testid="git-change-action-dropdown"
          >
            <MenuSectionLabel>{t("git.workspaceChanges.selectionActions")}</MenuSectionLabel>
            <MenuActionItem
              label={checkVisibleLabel}
              icon={<ListChecks className="w-3.5 h-3.5" />}
              disabled={visibleCount === 0}
              onClick={() => {
                onCheckVisible();
                setMoreOpen(false);
              }}
            />
            <MenuActionItem
              label={uncheckVisibleLabel}
              icon={<ListX className="w-3.5 h-3.5" />}
              disabled={visibleCount === 0}
              onClick={() => {
                onUncheckVisible();
                setMoreOpen(false);
              }}
            />
            <MenuDivider />
            <MenuSectionLabel>{t("git.workspaceChanges.stageActions")}</MenuSectionLabel>
            {compact ? (
              <MenuActionItem
                label={stageVisibleLabel}
                icon={<CirclePlus className="w-3.5 h-3.5" />}
                disabled={busy || visibleCount === 0}
                onClick={() => {
                  onStageVisible();
                  setMoreOpen(false);
                }}
              />
            ) : null}
            <MenuActionItem
              label={unstageVisibleLabel}
              icon={<CircleMinus className="w-3.5 h-3.5" />}
              disabled={busy || visibleStagedCount === 0}
              onClick={() => {
                onUnstageVisible();
                setMoreOpen(false);
              }}
            />
            {compact ? (
              <>
                <MenuDivider />
                <MenuSectionLabel>{t("git.workspaceChanges.viewActions")}</MenuSectionLabel>
                <MenuActionItem
                  label={viewLabel}
                  icon={treeMode ? <List className="w-3.5 h-3.5" /> : <ListTree className="w-3.5 h-3.5" />}
                  onClick={() => {
                    onToggleTreeMode();
                    setMoreOpen(false);
                  }}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <span className="shrink-0 min-w-10 text-center text-[11px] text-[var(--taomni-text-muted)]">
        {checkedCount}/{totalCount}
      </span>

      {!compact ? (
        <ToolbarIconButton
          label={viewLabel}
          icon={treeMode ? <List className="w-3.5 h-3.5" /> : <ListTree className="w-3.5 h-3.5" />}
          onClick={onToggleTreeMode}
        />
      ) : null}
    </div>
  );
}

function useCloseOnOutside(open: boolean, rootRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open, rootRef]);
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

function FilterMenuItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[11px] ${
        active ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]" : "hover:bg-[var(--taomni-hover)]"
      }`}
      title={label}
      onClick={onClick}
    >
      <span className="w-3.5 shrink-0">{active ? <Check className="w-3.5 h-3.5" /> : null}</span>
      <span className="w-3.5 shrink-0 text-[var(--taomni-text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuActionItem({
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
      role="menuitem"
      className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[11px] hover:bg-[var(--taomni-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="w-3.5 shrink-0 text-[var(--taomni-text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-[var(--taomni-divider)]" role="separator" />;
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
