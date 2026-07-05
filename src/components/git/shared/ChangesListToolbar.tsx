import { List, ListTree } from "lucide-react";

export interface ChangesListToolbarProps {
  busy: boolean;
  checkedCount: number;
  totalCount: number;
  treeMode: boolean;
  canStageAll: boolean;
  canUnstageAll: boolean;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onToggleTreeMode: () => void;
}

export function ChangesListToolbar({
  busy,
  checkedCount,
  totalCount,
  treeMode,
  canStageAll,
  canUnstageAll,
  onStageAll,
  onUnstageAll,
  onToggleTreeMode,
}: ChangesListToolbarProps) {
  return (
    <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
      <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !canStageAll} onClick={onStageAll}>Stage all</button>
      <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !canUnstageAll} onClick={onUnstageAll}>Unstage all</button>
      <div className="flex-1" />
      <span className="text-[11px] text-[var(--taomni-text-muted)]">{checkedCount}/{totalCount}</span>
      <button
        className="taomni-btn h-7 px-2"
        type="button"
        title={treeMode ? "Switch to flat list" : "Switch to directory tree"}
        onClick={onToggleTreeMode}
      >
        {treeMode ? <ListTree className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
