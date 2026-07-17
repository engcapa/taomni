import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, Folder, Hash, MoreHorizontal } from "lucide-react";
import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";

export interface BreadcrumbPathSegment {
  label: string;
  path: string;
  kind: "root" | "directory" | "file";
}

type BreadcrumbItem =
  | { type: "path"; value: BreadcrumbPathSegment }
  | { type: "symbol"; value: LspDocumentSymbol }
  | { type: "collapsed" };

interface BreadcrumbsProps {
  pathSegments: BreadcrumbPathSegment[];
  symbols: LspDocumentSymbol[];
  position: LspPosition;
  onPathClick?: (segment: BreadcrumbPathSegment) => void;
  onSymbolClick?: (symbol: LspDocumentSymbol) => void;
}

function positionWithin(symbol: LspDocumentSymbol, position: LspPosition): boolean {
  const { start, end } = symbol.range;
  if (position.line < start.line || position.line > end.line) return false;
  if (position.line === start.line && position.character < start.character) return false;
  if (position.line === end.line && position.character > end.character) return false;
  return true;
}

export function symbolChainAtPosition(
  symbols: LspDocumentSymbol[],
  position: LspPosition,
): LspDocumentSymbol[] {
  return symbols
    .filter((symbol) => positionWithin(symbol, position))
    .sort((left, right) => left.depth - right.depth);
}

/** Keep the root, the active file, and the nearest parent visible in narrow panes. */
export function collapsedBreadcrumbItems(
  pathSegments: BreadcrumbPathSegment[],
  symbols: LspDocumentSymbol[],
): BreadcrumbItem[] {
  const compactPath: BreadcrumbItem[] = pathSegments.length > 3
    ? [
        { type: "path", value: pathSegments[0]! },
        { type: "collapsed" },
        ...pathSegments.slice(-2).map((value) => ({ type: "path" as const, value })),
      ]
    : pathSegments.map((value) => ({ type: "path" as const, value }));
  const compactSymbols: BreadcrumbItem[] = symbols.length > 1
    ? [{ type: "collapsed" }, { type: "symbol", value: symbols.at(-1)! }]
    : symbols.map((value) => ({ type: "symbol" as const, value }));

  return [...compactPath, ...compactSymbols];
}

export function Breadcrumbs({
  pathSegments,
  symbols,
  position,
  onPathClick,
  onSymbolClick,
}: BreadcrumbsProps) {
  const symbolChain = symbolChainAtPosition(symbols, position);
  const navRef = useRef<HTMLElement | null>(null);
  const fullPathMeasureRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const fullItems = useMemo<BreadcrumbItem[]>(() => [
    ...pathSegments.map((value) => ({ type: "path" as const, value })),
    ...symbolChain.map((value) => ({ type: "symbol" as const, value })),
  ], [pathSegments, symbolChain]);
  const compactItems = useMemo(
    () => collapsedBreadcrumbItems(pathSegments, symbolChain),
    [pathSegments, symbolChain],
  );
  const visibleItems = collapsed ? compactItems : fullItems;

  useLayoutEffect(() => {
    const updateCollapsedState = () => {
      const availableWidth = navRef.current?.clientWidth ?? 0;
      const fullPathWidth = fullPathMeasureRef.current?.getBoundingClientRect().width ?? 0;
      if (availableWidth > 0 && fullPathWidth > 0) {
        setCollapsed(fullPathWidth > availableWidth);
      }
    };

    updateCollapsedState();
    if (typeof ResizeObserver === "undefined" || !navRef.current) return;
    const observer = new ResizeObserver(updateCollapsedState);
    observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [fullItems]);

  const renderItems = (items: BreadcrumbItem[], compact: boolean) => items.map((item, index) => {
    const path = item.type === "path" ? item.value : null;
    const symbol = item.type === "symbol" ? item.value : null;
    const label = path?.label ?? symbol?.name ?? "";
    const flexible = compact && (path?.kind === "file" || !!symbol);
    if (item.type === "collapsed") {
      return (
        <span key={`collapsed:${index}`} className="inline-flex shrink-0 items-center">
          {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
          <MoreHorizontal className="mx-1 h-3 w-3" aria-label="Hidden breadcrumb segments" />
        </span>
      );
    }
    return (
      <span
        key={`${item.type}:${label}:${index}`}
        className={`inline-flex min-w-0 items-center ${flexible ? "flex-1" : "shrink-0"}`}
      >
        {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0" />}
        <button
          type="button"
          className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${flexible ? "flex-1" : ""}`}
          onClick={() => {
            if (path) onPathClick?.(path);
            if (symbol) onSymbolClick?.(symbol);
          }}
        >
          {path?.kind === "root" || path?.kind === "directory" ? (
            <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
          ) : path?.kind === "file" ? (
            <File className="h-3 w-3 shrink-0" />
          ) : (
            <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
          )}
          <span className={flexible ? "truncate" : undefined}>{label}</span>
        </button>
      </span>
    );
  });

  return (
    <nav
      ref={navRef}
      aria-label="Editor breadcrumbs"
      data-testid="code-workspace-breadcrumbs"
      className="relative flex h-7 shrink-0 items-center overflow-hidden border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[11px] text-[var(--taomni-code-muted)]"
    >
      <div
        ref={fullPathMeasureRef}
        aria-hidden="true"
        className="pointer-events-none absolute invisible w-max whitespace-nowrap"
      >
        {renderItems(fullItems, false)}
      </div>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {renderItems(visibleItems, collapsed)}
      </div>
    </nav>
  );
}
