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
  grouped?: boolean;
  showSectionActions?: boolean;
  busy?: boolean;
  checked: Set<string>;
  onToggleChecked: (paths: string[], value: boolean) => void;
  onStagePaths?: (paths: string[]) => void;
  onUnstagePaths?: (paths: string[]) => void;
  selected: Set<string>;
  activePath: string | null;
  onSelect: (path: string, mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
}

type TriState = "all" | "none" | "some";
type ChangeSectionKind = "staged" | "changes" | "untracked";

interface ChangeSection {
  kind: ChangeSectionKind;
  title: string;
  changes: GitChange[];
}

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
  grouped = true,
  showSectionActions = true,
  busy = false,
  checked,
  onToggleChecked,
  onStagePaths,
  onUnstagePaths,
  selected,
  activePath,
  onSelect,
  onContextMenu,
}: ChangesTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<ChangeSectionKind>>(() => new Set());

  const sections = useMemo(() => partitionChanges(changes), [changes]);

  const pathsState = (paths: string[]): TriState => {
    const on = paths.filter((p) => checked.has(p)).length;
    if (on === 0) return "none";
    if (on === paths.length) return "all";
    return "some";
  };

  const dirState = (node: ChangeTreeDir): TriState => pathsState(collectFilePaths(node));

  const renderFile = (change: GitChange, depth: number, sectionKey = "all") => {
    const isActive = activePath === change.path;
    const isSelected = selected.has(change.path);
    return (
      <div
        key={`${sectionKey}-${change.status}-${change.path}`}
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

  const renderNode = (node: ChangeTreeNode, depth: number, sectionKey = "all"): React.ReactNode => {
    if (node.type === "file") return renderFile(node.change, depth, sectionKey);
    const collapsedKey = `${sectionKey}:${node.path}`;
    const isCollapsed = collapsed.has(collapsedKey);
    return (
      <div key={`${sectionKey}-dir-${node.path}`}>
        <div
          role="button"
          tabIndex={0}
          style={{ paddingLeft: 8 + depth * 14 }}
          className="w-full pr-2 py-1 flex items-center gap-2 cursor-pointer hover:bg-[var(--taomni-hover)] border-b border-[var(--taomni-divider)]"
          onClick={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(collapsedKey)) next.delete(collapsedKey);
              else next.add(collapsedKey);
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
        {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1, sectionKey))}
      </div>
    );
  };

  const renderChangeSet = (items: GitChange[], sectionKey = "all") => {
    if (treeMode) {
      return buildPathTree(items).map((node) => renderNode(node, 0, sectionKey));
    }
    return [...items]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((change) => renderFile(change, 0, sectionKey));
  };

  const renderSection = (section: ChangeSection) => {
    if (section.changes.length === 0) return null;
    const paths = uniquePaths(section.changes);
    const isCollapsed = collapsedSections.has(section.kind);
    const action =
      section.kind === "staged"
        ? { label: "Unstage All", run: onUnstagePaths }
        : { label: "Stage All", run: onStagePaths };
    return (
      <section key={section.kind} className="border-b border-[var(--taomni-divider)] last:border-b-0">
        <div className="h-8 flex items-center gap-2 px-2 bg-[var(--taomni-bg)] border-b border-[var(--taomni-divider)]">
          <button
            type="button"
            className="shrink-0 flex items-center justify-center text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
            aria-label={isCollapsed ? `Expand ${section.title}` : `Collapse ${section.title}`}
            onClick={() =>
              setCollapsedSections((current) => {
                const next = new Set(current);
                if (next.has(section.kind)) next.delete(section.kind);
                else next.add(section.kind);
                return next;
              })
            }
          >
            {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <TriCheckbox
            state={pathsState(paths)}
            onChange={(value) => onToggleChecked(paths, value)}
          />
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase text-[var(--taomni-text-muted)]">
            {section.title} ({section.changes.length})
          </span>
          <div className="flex-1" />
          {showSectionActions && action.run ? (
            <button
              type="button"
              className="taomni-btn h-6 px-1.5 text-[10px]"
              disabled={busy || paths.length === 0}
              onClick={(event) => {
                event.stopPropagation();
                action.run?.(paths);
              }}
            >
              {action.label}
            </button>
          ) : null}
        </div>
        {isCollapsed ? null : renderChangeSet(section.changes, section.kind)}
      </section>
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
      {grouped ? sections.map(renderSection) : renderChangeSet(changes)}
    </div>
  );
}

function partitionChanges(changes: GitChange[]): ChangeSection[] {
  const staged = changes.filter((change) => change.staged);
  const unstaged = changes.filter((change) => change.unstaged && change.status !== "untracked");
  const untracked = changes.filter((change) => change.status === "untracked");
  return [
    { kind: "staged", title: "Staged Changes", changes: staged },
    { kind: "changes", title: "Changes", changes: unstaged },
    { kind: "untracked", title: "Untracked", changes: untracked },
  ];
}

function uniquePaths(changes: GitChange[]): string[] {
  return [...new Set(changes.map((change) => change.path))];
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
