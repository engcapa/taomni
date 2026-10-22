import type { LspDocumentSymbol, LspPosition } from "../../../../lib/editor/lsp";
import { type BreadcrumbItem, type BreadcrumbPathChild, type BreadcrumbPathSegment } from "./model";

export function positionWithin(symbol: LspDocumentSymbol, position: LspPosition): boolean {
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

/**
 * Siblings of `target` under the same enclosing parent symbol (or top-level
 * peers when depth is 0). Matches IDEA breadcrumb symbol dropdown behavior.
 */
export function symbolSiblingsAt(
  symbols: LspDocumentSymbol[],
  target: LspDocumentSymbol,
): LspDocumentSymbol[] {
  const parent = symbols
    .filter((symbol) =>
      symbol.depth === target.depth - 1 && positionWithin(symbol, target.selectionRange.start)
    )
    .sort((left, right) => right.depth - left.depth)[0] ?? null;

  return symbols
    .filter((symbol) => {
      if (symbol.depth !== target.depth) return false;
      if (!parent) return target.depth === 0;
      return positionWithin(parent, symbol.selectionRange.start);
    })
    .sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return left.range.start.line - right.range.start.line;
      }
      return left.range.start.character - right.range.start.character;
    });
}

/** Keep the root, the active file, and the nearest parent visible in narrow panes. */
export function collapsedBreadcrumbItems(
  pathSegments: BreadcrumbPathSegment[],
  symbols: LspDocumentSymbol[],
): BreadcrumbItem[] {
  const compactPath: BreadcrumbItem[] = pathSegments.length > 3
    ? [
      { type: "path", value: pathSegments[0]! },
      { type: "collapsed", hiddenPaths: pathSegments.slice(1, -2) },
      ...pathSegments.slice(-2).map((value) => ({ type: "path" as const, value })),
    ]
    : pathSegments.map((value) => ({ type: "path" as const, value }));
  const compactSymbols: BreadcrumbItem[] = symbols.length > 1
    ? [{ type: "collapsed", hiddenPaths: [] }, { type: "symbol", value: symbols.at(-1)! }]
    : symbols.map((value) => ({ type: "symbol" as const, value }));

  return [...compactPath, ...compactSymbols];
}

export function sortPathChildren(entries: BreadcrumbPathChild[]): BreadcrumbPathChild[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}

export function filterByQuery<T>(items: T[], query: string, labelOf: (item: T) => string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) => labelOf(item).toLowerCase().includes(trimmed));
}
