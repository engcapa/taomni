import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ListTree, Search } from "lucide-react";
import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";
import { symbolChainAtPosition } from "./Breadcrumbs";
import { symbolKindBadge } from "./StructurePopup";
import { FilterClearButton } from "./workspaceChrome";

export type OutlineSortMode = "position" | "type" | "name";

interface OutlineNode {
  symbol: LspDocumentSymbol;
  children: OutlineNode[];
}

interface OutlineRow {
  symbol: LspDocumentSymbol;
  depth: number;
  hasChildren: boolean;
}

function symbolKey(symbol: LspDocumentSymbol): string {
  return `${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`;
}

export function isProbablyPublicSymbol(symbol: LspDocumentSymbol): boolean {
  if ([2, 3, 4, 5, 10, 11, 23, 26].includes(symbol.kind)) return true;
  return !symbol.name.startsWith("_") && !symbol.name.startsWith("#");
}

function symbolForest(symbols: LspDocumentSymbol[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Array<{ depth: number; node: OutlineNode }> = [];
  for (const symbol of symbols) {
    const node = { symbol, children: [] } satisfies OutlineNode;
    while (stack.length > 0 && stack[stack.length - 1].depth >= symbol.depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ depth: symbol.depth, node });
  }
  return roots;
}

function compareNodes(mode: OutlineSortMode): (left: OutlineNode, right: OutlineNode) => number {
  if (mode === "name") {
    return (left, right) => left.symbol.name.localeCompare(right.symbol.name, undefined, { sensitivity: "base" });
  }
  if (mode === "type") {
    return (left, right) => left.symbol.kind - right.symbol.kind
      || left.symbol.name.localeCompare(right.symbol.name, undefined, { sensitivity: "base" });
  }
  return (left, right) => left.symbol.selectionRange.start.line - right.symbol.selectionRange.start.line
    || left.symbol.selectionRange.start.character - right.symbol.selectionRange.start.character;
}

export function outlineRows(
  symbols: LspDocumentSymbol[],
  options: {
    query: string;
    sort: OutlineSortMode;
    publicOnly: boolean;
    collapsed: ReadonlySet<string>;
  },
): OutlineRow[] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  const filterNode = (node: OutlineNode): OutlineNode | null => {
    const children = node.children.map(filterNode).filter((child): child is OutlineNode => child !== null);
    const matchesName = !normalizedQuery || node.symbol.name.toLocaleLowerCase().includes(normalizedQuery);
    const matchesVisibility = !options.publicOnly || isProbablyPublicSymbol(node.symbol);
    if ((!matchesName || !matchesVisibility) && children.length === 0) return null;
    return { symbol: node.symbol, children };
  };
  const roots = symbolForest(symbols)
    .map(filterNode)
    .filter((node): node is OutlineNode => node !== null);
  const rows: OutlineRow[] = [];
  const visit = (nodes: OutlineNode[], depth: number) => {
    const sorted = [...nodes].sort(compareNodes(options.sort));
    for (const node of sorted) {
      rows.push({ symbol: node.symbol, depth, hasChildren: node.children.length > 0 });
      if (!options.collapsed.has(symbolKey(node.symbol))) visit(node.children, depth + 1);
    }
  };
  visit(roots, 0);
  return rows;
}

export function OutlinePane({
  symbols,
  position,
  loading,
  unavailableReason,
  onPick,
}: {
  symbols: LspDocumentSymbol[];
  position: LspPosition;
  loading: boolean;
  unavailableReason?: string | null;
  onPick: (symbol: LspDocumentSymbol) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<OutlineSortMode>("position");
  const [publicOnly, setPublicOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(
    () => outlineRows(symbols, { query, sort, publicOnly, collapsed }),
    [collapsed, publicOnly, query, sort, symbols],
  );
  const activeKey = symbolChainAtPosition(symbols, position).at(-1);
  const currentSymbolKey = activeKey ? symbolKey(activeKey) : null;

  return (
    <section data-testid="code-workspace-outline-pane" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-[var(--taomni-code-border)] p-2">
        <label className="flex h-7 items-center gap-1.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            aria-label="Filter outline"
            value={query}
            placeholder="Filter symbols"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          <FilterClearButton
            value={query}
            label="Clear outline filter"
            testId="code-workspace-outline-filter-clear"
            onClear={() => setQuery("")}
          />
        </label>
        <div className="flex items-center gap-1 text-[10px] text-[var(--taomni-code-muted)]">
          <label className="inline-flex items-center gap-1">
            <span>Sort</span>
            <select
              aria-label="Outline sort"
              value={sort}
              className="h-6 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 outline-none"
              onChange={(event) => setSort(event.target.value as OutlineSortMode)}
            >
              <option value="position">Position</option>
              <option value="type">Type</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="ml-auto inline-flex items-center gap-1" title="Approximate filter based on symbol kind and naming conventions">
            <input
              type="checkbox"
              checked={publicOnly}
              onChange={(event) => setPublicOnly(event.target.checked)}
            />
            Public only ≈
          </label>
        </div>
      </div>
      <div role="tree" aria-label="Outline" className="min-h-0 flex-1 overflow-auto py-1">
        {rows.map(({ symbol, depth, hasChildren }) => {
          const key = symbolKey(symbol);
          const isCollapsed = collapsed.has(key);
          const badge = symbolKindBadge(symbol.kind);
          return (
            <div
              key={key}
              role="treeitem"
              aria-current={key === currentSymbolKey ? "location" : undefined}
              aria-expanded={hasChildren ? !isCollapsed : undefined}
              className="group flex h-6 items-center pr-2 text-[11px] text-[var(--taomni-code-muted)] aria-[current=location]:bg-[var(--taomni-code-selection-match-bg)] aria-[current=location]:text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
              style={{ paddingLeft: `${6 + depth * 14}px` }}
            >
              <button
                type="button"
                aria-label={hasChildren ? `${isCollapsed ? "Expand" : "Collapse"} ${symbol.name}` : undefined}
                tabIndex={hasChildren ? 0 : -1}
                className="inline-flex h-5 w-4 shrink-0 items-center justify-center"
                onClick={() => {
                  if (!hasChildren) return;
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }}
              >
                {hasChildren && (isCollapsed
                  ? <ChevronRight className="h-3 w-3" />
                  : <ChevronDown className="h-3 w-3" />)}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={`${symbol.name} · line ${symbol.selectionRange.start.line + 1}`}
                onClick={() => onPick(symbol)}
              >
                <span aria-hidden="true" className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold ${badge.className}`}>
                  {badge.label}
                </span>
                <span className="min-w-0 flex-1 truncate">{symbol.name}</span>
                <span className="shrink-0 font-mono text-[9px] opacity-70">:{symbol.selectionRange.start.line + 1}</span>
              </button>
            </div>
          );
        })}
        {!loading && rows.length === 0 && (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-[var(--taomni-code-muted)]">
            <ListTree className="h-5 w-5 opacity-60" />
            <span>{unavailableReason ?? (query ? "No matching symbols" : "No symbols in this file")}</span>
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="p-4 text-center text-[11px] text-[var(--taomni-code-muted)]">Loading symbols...</div>
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--taomni-code-border)] px-2 py-1 text-[9px] text-[var(--taomni-code-muted)]">
        {rows.length} / {symbols.length} symbols
      </div>
    </section>
  );
}
