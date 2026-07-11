import { useCallback } from "react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";

interface StructurePopupProps {
  open: boolean;
  fileTitle: string | null;
  symbols: LspDocumentSymbol[];
  loading: boolean;
  /** Why the list may be empty, e.g. the language server being unavailable. */
  unavailableReason?: string | null;
  onClose: () => void;
  onPick: (symbol: LspDocumentSymbol) => void;
}

const MAX_RESULTS = 200;

/** LSP SymbolKind → compact badge (label + tint), IDEA-structure-view style. */
export function symbolKindBadge(kind: number): { label: string; className: string } {
  switch (kind) {
    case 5: // Class
    case 23: // Struct
      return { label: "C", className: "bg-purple-500/15 text-purple-400" };
    case 10: // Enum
      return { label: "E", className: "bg-purple-500/15 text-purple-400" };
    case 11: // Interface
      return { label: "I", className: "bg-sky-500/15 text-sky-400" };
    case 6: // Method
      return { label: "m", className: "bg-amber-500/15 text-amber-400" };
    case 9: // Constructor
      return { label: "c", className: "bg-amber-500/15 text-amber-400" };
    case 12: // Function
      return { label: "ƒ", className: "bg-amber-500/15 text-amber-400" };
    case 7: // Property
      return { label: "p", className: "bg-blue-500/15 text-blue-400" };
    case 8: // Field
      return { label: "f", className: "bg-blue-500/15 text-blue-400" };
    case 22: // EnumMember
      return { label: "e", className: "bg-blue-500/15 text-blue-400" };
    case 13: // Variable
      return { label: "v", className: "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)]" };
    case 14: // Constant
      return { label: "K", className: "bg-teal-500/15 text-teal-400" };
    case 2: // Module
    case 3: // Namespace
    case 4: // Package
      return { label: "M", className: "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)]" };
    default:
      return { label: "•", className: "bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)]" };
  }
}

export function StructurePopup({
  open,
  fileTitle,
  symbols,
  loading,
  unavailableReason = null,
  onClose,
  onPick,
}: StructurePopupProps) {
  const filterItems = useCallback(
    (query: string, all: LspDocumentSymbol[]) =>
      query.trim()
        ? rankFuzzy(query, all, (symbol) => symbol.name, MAX_RESULTS)
        // No query: keep document order with hierarchy indentation.
        : all.slice(0, MAX_RESULTS),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-structure-popup"
      inputLabel="File structure"
      placeholder={fileTitle ? `Structure of ${fileTitle} (type to filter)` : "File structure"}
      items={symbols}
      loading={loading}
      filterItems={filterItems}
      itemKey={(symbol) =>
        `${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`}
      renderItem={(symbol) => {
        const badge = symbolKindBadge(symbol.kind);
        return (
          <>
            <span style={{ width: `${symbol.depth * 14}px` }} className="shrink-0" />
            <span
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 inline-flex items-center justify-center rounded text-[9px] font-bold ${badge.className}`}
            >
              {badge.label}
            </span>
            <span className="shrink-0 text-[var(--taomni-code-text)]">{symbol.name}</span>
            {symbol.detail && (
              <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
                {symbol.detail}
              </span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
              :{symbol.selectionRange.start.line + 1}
            </span>
          </>
        );
      }}
      emptyText={(query) => {
        if (loading) return "Loading symbols...";
        if (unavailableReason) return unavailableReason;
        return query ? "No matching symbols" : "No symbols in this file";
      }}
      footer={
        <>
          <span>↑↓ select</span>
          <span>Enter jump</span>
          <span>Esc close</span>
          <span className="ml-auto">
            {symbols.length} symbol{symbols.length === 1 ? "" : "s"}
          </span>
        </>
      }
      onClose={onClose}
      onPick={onPick}
    />
  );
}
