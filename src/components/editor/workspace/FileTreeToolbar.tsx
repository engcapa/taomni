import { memo, type MouseEvent, type ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, LocateFixed, Minus, MoreVertical, Plus, Search } from "./icons";
import { treeViewTitle, type FileTreeViewMode } from "./treeToolbarChrome";

interface FileTreeToolbarProps {
  viewMode: FileTreeViewMode;
  speedSearchVisible: boolean;
  showExpandAll: boolean;
  collapsed: boolean;
  openViewSelector: (event: MouseEvent<HTMLElement>) => void;
  openNewMenu: (event: MouseEvent<HTMLElement>) => void;
  openToolbarOverflow: (event: MouseEvent<HTMLElement>) => void;
  onOpenSpeedSearch: () => void;
  onSelectOpenedFile?: () => void;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onToggleCollapse?: () => void;
}

interface TreeIconButtonProps {
  label: string;
  icon: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
}

function TreeIconButton({
  label,
  icon,
  onClick,
  testId,
  active = false,
  disabled = false,
}: TreeIconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)] disabled:opacity-40"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/** File activation updates the tree body without rebuilding the title actions. */
export const FileTreeToolbar = memo(function FileTreeToolbar({
  viewMode, speedSearchVisible, showExpandAll, collapsed, openViewSelector,
  openNewMenu, openToolbarOverflow, onOpenSpeedSearch, onSelectOpenedFile,
  onExpandAll, onCollapseAll, onToggleCollapse,
}: FileTreeToolbarProps) {
  const t = useT();
  return (
      <div
        data-testid="code-workspace-tree-toolbar"
        className="shrink-0 flex flex-col border-b border-[var(--taomni-code-border)]"
      >
        <div
          data-testid="code-workspace-tree-toolbar-actions"
          className="h-[30px] flex items-center gap-0.5 pl-1 pr-1"
        >
          <button
            type="button"
            data-testid="code-workspace-tree-view-selector"
            aria-haspopup="menu"
            title="Select view"
            className="h-6 min-w-0 inline-flex items-center gap-0.5 rounded px-1.5 text-[12px] font-semibold text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={openViewSelector}
          >
            <span className="truncate">{treeViewTitle(viewMode)}</span>
            <ChevronDown className="w-3 h-3 shrink-0 text-[var(--taomni-code-muted)]" />
          </button>
          <div className="flex-1 min-w-0" />
          <TreeIconButton
            label={t("platform.filterFiles")}
            testId="code-workspace-tree-search"
            icon={<Search className="w-3.5 h-3.5" />}
            active={speedSearchVisible}
            onClick={onOpenSpeedSearch}
          />
          <TreeIconButton
            label="New…"
            testId="code-workspace-tree-new"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={openNewMenu}
          />
          {onSelectOpenedFile && (
            <TreeIconButton
              label="Select Opened File (Alt+F1)"
              testId="code-workspace-tree-select-opened"
              icon={<LocateFixed className="w-3.5 h-3.5" />}
              onClick={onSelectOpenedFile}
            />
          )}
          {onExpandAll && showExpandAll && (
            <TreeIconButton
              label="Expand All"
              testId="code-workspace-tree-expand-all"
              icon={<ChevronsUpDown className="w-3.5 h-3.5" />}
              onClick={onExpandAll}
            />
          )}
          {onCollapseAll && (
            <TreeIconButton
              label="Collapse All"
              testId="code-workspace-tree-collapse-all"
              icon={<ChevronsDownUp className="w-3.5 h-3.5" />}
              onClick={onCollapseAll}
            />
          )}
          <TreeIconButton
            label="Options"
            testId="code-workspace-tree-toolbar-more"
            icon={<MoreVertical className="w-3.5 h-3.5" />}
            onClick={openToolbarOverflow}
          />
          {onToggleCollapse && (
            <TreeIconButton
              label={collapsed ? "Show project tree" : "Hide (Shift+Escape)"}
              testId="code-workspace-tree-collapse"
              icon={<Minus className="w-3.5 h-3.5" />}
              onClick={onToggleCollapse}
            />
          )}
        </div>
      </div>
  );
});
