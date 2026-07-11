import { ChevronRight, File, Folder, Hash } from "lucide-react";
import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";

export interface BreadcrumbPathSegment {
  label: string;
  path: string;
  kind: "root" | "directory" | "file";
}

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

export function Breadcrumbs({
  pathSegments,
  symbols,
  position,
  onPathClick,
  onSymbolClick,
}: BreadcrumbsProps) {
  const symbolChain = symbolChainAtPosition(symbols, position);
  const items: Array<
    | { type: "path"; value: BreadcrumbPathSegment }
    | { type: "symbol"; value: LspDocumentSymbol }
  > = [
    ...pathSegments.map((value) => ({ type: "path" as const, value })),
    ...symbolChain.map((value) => ({ type: "symbol" as const, value })),
  ];

  return (
    <nav
      aria-label="Editor breadcrumbs"
      data-testid="code-workspace-breadcrumbs"
      className="flex h-7 shrink-0 items-center overflow-x-auto border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[11px] text-[var(--taomni-code-muted)]"
    >
      {items.map((item, index) => {
        const path = item.type === "path" ? item.value : null;
        const symbol = item.type === "symbol" ? item.value : null;
        const label = path?.label ?? symbol?.name ?? "";
        return (
          <span key={`${item.type}:${label}:${index}`} className="inline-flex shrink-0 items-center">
            {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
            <button
              type="button"
              className="inline-flex h-5 items-center gap-1 rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
              onClick={() => {
                if (path) onPathClick?.(path);
                if (symbol) onSymbolClick?.(symbol);
              }}
            >
              {path?.kind === "root" || path?.kind === "directory" ? (
                <Folder className="h-3 w-3 text-[#d59d32]" />
              ) : path?.kind === "file" ? (
                <File className="h-3 w-3" />
              ) : (
                <Hash className="h-3 w-3 text-[var(--taomni-accent)]" />
              )}
              <span>{label}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
