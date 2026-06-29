import { useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { gitChangeLabel, type GitChange } from "../../lib/git";
import {
  buildPathTree,
  collectFilePaths,
  type ChangeTreeDir,
  type ChangeTreeNode,
} from "../../lib/gitTree";

export interface ChangesTreeProps {
  changes: GitChange[];
  treeMode: boolean;
  checked: Set<string>;
  onToggleChecked: (paths: string[], value: boolean) => void;
  selected: Set<string>;
  activePath: string | null;
  onSelect: (path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
}

type TriState = "all" | "none" | "some";

function TriCheckbox({
  state,
  onChange,
}: {
  state: TriState;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={(el) => {
        ref.current = el;
        if (el) el.indeterminate = state === "some";
      }}
      type="checkbox"
      className="shrink-0"
      checked={state === "all"}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function StatusPill({ change }: { change: GitChange }) {
  const color = change.conflict
    ? "bg-red-500/15 text-red-500"
    : change.status === "untracked"
      ? "bg-amber-500/15 text-amber-500"
      : change.staged
        ? "bg-emerald-500/15 text-emerald-500"
        : "bg-blue-500/15 text-blue-500";
  return (
    <span className={`shrink-0 w-[68px] text-center rounded px-1 py-0.5 text-[10px] uppercase ${color}`}>
      {gitChangeLabel(change)}
    </span>
  );
}

// MAIN_COMPONENT
export function ChangesTree({
  changes,
  treeMode,
  checked,
  onToggleChecked,
  selected,
  activePath,
  onSelect,
  onContextMenu,
}: ChangesTreeProps) {
  const tree = useMemo(() => buildPathTree(changes), [changes]);
  const flat = useMemo(
    () => [...changes].sort((a, b) => a.path.localeCompare(b.path)),
    [changes],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const dirState = (node: ChangeTreeDir): TriState => {
    const files = collectFilePaths(node);
    const on = files.filter((p) => checked.has(p)).length;
    if (on === 0) return "none";
    if (on === files.length) return "all";
    return "some";
  };

  const renderFile = (change: GitChange, depth: number) => {
    const isActive = activePath === change.path;
    const isSelected = selected.has(change.path);
    return (
      <div
        key={`${change.status}-${change.path}`}
        role="button"
        tabIndex={0}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={`w-full pr-2 py-1 flex items-center gap-2 text-left cursor-pointer border-b border-[var(--taomni-divider)] ${
          isActive ? "bg-[var(--taomni-hover)]" : isSelected ? "bg-[var(--taomni-accent)]/10" : "hover:bg-[var(--taomni-hover)]"
        }`}
        onClick={(e) => onSelect(change.path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
        onContextMenu={(e) => onContextMenu(change.path, e)}
      >
        <input
          type="checkbox"
          className="shrink-0"
          checked={checked.has(change.path)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleChecked([change.path], e.target.checked)}
        />
        <StatusPill change={change} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px]">{treeMode ? lastSegment(change.path) : change.path}</div>
          {change.oldPath && (
            <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">from {change.oldPath}</div>
          )}
        </div>
      </div>
    );
  };

  const renderNode = (node: ChangeTreeNode, depth: number): React.ReactNode => {
    if (node.type === "file") return renderFile(node.change, depth);
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={`dir-${node.path}`}>
        <div
          role="button"
          tabIndex={0}
          style={{ paddingLeft: 8 + depth * 14 }}
          className="w-full pr-2 py-1 flex items-center gap-2 cursor-pointer hover:bg-[var(--taomni-hover)] border-b border-[var(--taomni-divider)]"
          onClick={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            })
          }
          onContextMenu={(e) => {
            e.preventDefault();
            const first = collectFilePaths(node)[0];
            if (first) onContextMenu(first, e);
          }}
        >
          <TriCheckbox
            state={dirState(node)}
            onChange={(value) => onToggleChecked(collectFilePaths(node), value)}
          />
          {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0" />}
          <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
          <span className="truncate text-[12px]">{node.name}</span>
        </div>
        {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (changes.length === 0) {
    return (
      <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        No local changes
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      {treeMode ? tree.map((node) => renderNode(node, 0)) : flat.map((change) => renderFile(change, 0))}
    </div>
  );
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

