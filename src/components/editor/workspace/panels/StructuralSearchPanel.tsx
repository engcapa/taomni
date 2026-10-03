import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, FileCode2, Loader2 } from "lucide-react";
import type { StructuralMatch } from "../../../../lib/editor/structuralSearch";
import type { StructuralSearchSession } from "../useStructuralSearchSession";

interface TreeNode {
  id: string;
  label: string;
  kind: "file" | "class" | "interface" | "enum" | "record" | "method" | "constructor" | "match";
  depth: number;
  count: number;
  match?: StructuralMatch;
  children: TreeNode[];
}

/** Build file → container chain → match nodes, keeping backend order. */
export function buildStructuralResultTree(matches: readonly StructuralMatch[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const ensure = (parent: TreeNode[] | TreeNode, id: string, make: () => TreeNode): TreeNode => {
    const existing = index.get(id);
    if (existing) return existing;
    const node = make();
    index.set(id, node);
    (Array.isArray(parent) ? parent : parent.children).push(node);
    return node;
  };
  for (const [position, match] of matches.entries()) {
    const fileId = `${match.rootId}\u0000${match.path}`;
    const file = ensure(roots, fileId, () => ({
      id: fileId, label: match.path, kind: "file", depth: 0, count: 0, children: [],
    }));
    file.count += 1;
    let parent = file;
    let chain = fileId;
    for (const container of match.containers) {
      chain = `${chain}\u0000${container.kind}:${container.name}`;
      const depth = parent.depth + 1;
      const node = ensure(parent, chain, () => ({
        id: chain, label: container.kind === "method" || container.kind === "constructor" ? `${container.name}()` : container.name,
        kind: container.kind, depth, count: 0, children: [],
      }));
      node.count += 1;
      parent = node;
    }
    parent.children.push({
      id: `${fileId}\u0000match:${position}`,
      label: match.lineText.trim(),
      kind: "match",
      depth: parent.depth + 1,
      count: 1,
      match,
      children: [],
    });
  }
  return roots;
}

function flatten(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    if (!collapsed.has(node.id)) flatten(node.children, collapsed, out);
  }
  return out;
}

interface StructuralSearchPanelProps {
  session: StructuralSearchSession;
  onOpenMatch: (match: StructuralMatch, options: { preview: boolean }) => void;
}

export function StructuralSearchPanel({ session, onOpenMatch }: StructuralSearchPanelProps) {
  const { result, phase, message, capabilities } = session;
  const tree = useMemo(() => buildStructuralResultTree(result?.matches ?? []), [result]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flatten(tree, collapsed), [collapsed, tree]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCollapsed(new Set());
    const first = flatten(tree, new Set()).find((node) => node.kind === "match");
    setSelectedId(first?.id ?? null);
  }, [tree]);

  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const activate = (row: TreeNode, preview: boolean) => {
    setSelectedId(row.id);
    if (row.match) onOpenMatch(row.match, { preview });
    else if (!preview) toggle(row.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const current = rows[selectedIndex] ?? null;
    const move = (delta: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, selectedIndex + delta))];
      if (next) {
        setSelectedId(next.id);
        if (next.match) onOpenMatch(next.match, { preview: true });
      }
    };
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "ArrowLeft" && current && current.children.length > 0 && !collapsed.has(current.id)) {
      event.preventDefault(); toggle(current.id);
    } else if (event.key === "ArrowRight" && current && collapsed.has(current.id)) {
      event.preventDefault(); toggle(current.id);
    } else if (event.key === "Enter" && current) {
      event.preventDefault(); activate(current, false);
    }
  };

  const total = result?.matches.length ?? 0;
  const backendLabel = result?.backendLabel ?? capabilities?.backend.grammar ?? null;
  return (
    <div
      data-testid="structural-search-panel"
      data-phase={phase}
      data-active-requests={capabilities ? String(capabilities.activeRequests) : undefined}
      className="flex h-full min-h-0 flex-col text-[12px]"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-2">
        <span className="shrink-0 font-medium">Find</span>
        <span data-testid="structural-search-summary" className="min-w-0 truncate text-[var(--taomni-code-muted)]">
          {result
            ? `fragments matching template '${result.query.pattern}' · ${total} result${total === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}`
            : "Structural Search"}
        </span>
        <div className="flex-1" />
        {phase === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        <button
          type="button"
          data-testid="structural-search-edit-query"
          className="h-6 rounded px-2 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={session.open}
        >
          Edit Query…
        </button>
      </div>
      <div
        ref={listRef}
        data-testid="structural-search-results"
        role="tree"
        aria-label="Structural search results"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--taomni-accent)]"
        onKeyDown={onKeyDown}
      >
        {phase === "cancelled" ? (
          <div data-testid="structural-search-cancelled" role="status" className="px-3 py-1 text-[11px] text-[var(--taomni-code-muted)]">
            Search cancelled{result ? " — showing the previous results" : ""}.
          </div>
        ) : null}
        {phase === "empty" || (phase === "cancelled" && result?.matches.length === 0) ? (
          <div data-testid="structural-search-empty" className="px-3 py-6 text-center text-[var(--taomni-code-muted)]">
            No occurrences found for the template in {result?.query.scope === "file" ? "the current file" : result?.query.scope === "module" ? "the module" : "the project"}.
          </div>
        ) : phase === "unavailable" ? (
          <div data-testid="structural-search-unavailable" className="px-3 py-6 text-center text-amber-700 dark:text-amber-300">
            {message ?? "Structural Search backend is not available"}
          </div>
        ) : !result ? (
          <div className="px-3 py-6 text-center text-[var(--taomni-code-muted)]">Run Search Structurally… to see results.</div>
        ) : rows.map((row) => {
          const expandable = row.children.length > 0;
          const isCollapsed = collapsed.has(row.id);
          const selected = row.id === selectedId;
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={selected}
              aria-expanded={expandable ? !isCollapsed : undefined}
              data-testid={row.kind === "match" ? "structural-search-match" : "structural-search-node"}
              data-kind={row.kind}
              data-path={row.match?.path}
              data-line={row.match ? String(row.match.start.line + 1) : undefined}
              className={`flex h-6 cursor-default items-center gap-1 pr-2 ${selected ? "bg-[var(--taomni-code-active-line-bg)]" : "hover:bg-[var(--taomni-code-active-line-bg)]"}`}
              style={{ paddingLeft: 6 + row.depth * 14 }}
              onClick={() => activate(row, true)}
              onDoubleClick={() => activate(row, false)}
            >
              {expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={isCollapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
                  className="inline-flex h-4 w-4 items-center justify-center"
                  onClick={(event) => { event.stopPropagation(); toggle(row.id); }}
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              ) : <span className="w-4" />}
              {row.kind === "file" ? <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-accent)]" /> : null}
              {row.kind === "match" && row.match ? (
                <>
                  <span className="w-8 shrink-0 text-right tabular-nums text-[var(--taomni-code-muted)]">{row.match.start.line + 1}</span>
                  <span className="min-w-0 truncate font-mono">{row.label}</span>
                </>
              ) : (
                <>
                  <span className={`min-w-0 truncate ${row.kind === "file" ? "" : "font-mono"}`}>{row.label}</span>
                  <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">
                    {row.count} result{row.count === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div
        data-testid="structural-search-backend"
        className="flex h-6 shrink-0 items-center gap-2 border-t border-[var(--taomni-code-border)] px-2 text-[10px] text-[var(--taomni-code-muted)]"
      >
        <span className="min-w-0 truncate">{backendLabel ? `Parser: ${backendLabel}` : "Parser: unavailable"}</span>
        {result ? <span>· {result.filesScanned} file{result.filesScanned === 1 ? "" : "s"} · {result.elapsedMs} ms</span> : null}
        <span>· active requests {capabilities ? capabilities.activeRequests : "?"}</span>
      </div>
    </div>
  );
}
