import { useCallback } from "react";
import { useT } from "../../../lib/i18n";
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
  /** ED-PARITY-014 DEC-014-04: symbols come from the grammar, not a provider. */
  syntaxOnly?: boolean;
  onClose: () => void;
  onPick: (symbol: LspDocumentSymbol) => void;
}

const MAX_RESULTS = 200;

/** LSP SymbolKind → compact badge (label + tint), IDEA-structure-view style. */
export function symbolKindBadge(kind: number): { label: string; className: string } {
  switch (kind) {
    case 5: // Class
    case 23: // Struct
      return { label: "C", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-property)]" };
    case 10: // Enum
      return { label: "E", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-property)]" };
    case 11: // Interface
      return { label: "I", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-type)]" };
    case 6: // Method
      return { label: "m", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-function)]" };
    case 9: // Constructor
      return { label: "c", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-function)]" };
    case 12: // Function
      return { label: "ƒ", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-function)]" };
    case 7: // Property
      return { label: "p", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-heading)]" };
    case 8: // Field
      return { label: "f", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-heading)]" };
    case 22: // EnumMember
      return { label: "e", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-heading)]" };
    case 13: // Variable
      return { label: "v", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]" };
    case 14: // Constant
      return { label: "K", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-syntax-number)]" };
    case 2: // Module
    case 3: // Namespace
    case 4: // Package
      return { label: "M", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]" };
    default:
      return { label: "•", className: "bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]" };
  }
}

export function StructurePopup({
  open,
  fileTitle,
  symbols,
  loading,
  unavailableReason = null,
  syntaxOnly = false,
  onClose,
  onPick,
}: StructurePopupProps) {
  const t = useT();
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
      inputLabel={t("fileStructure.title")}
      placeholder={fileTitle ? t("fileStructure.filter", { file: fileTitle }) : t("fileStructure.title")}
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
              data-symbol-kind={symbol.kind}
              className={`h-4 w-4 shrink-0 inline-flex items-center justify-center rounded text-ui-caption font-bold ${badge.className}`}
            >
              {badge.label}
            </span>
            <span className="shrink-0 text-[var(--taomni-code-text)]">{symbol.name}</span>
            {symbol.detail && (
              <span className="min-w-0 flex-1 truncate text-ui-caption text-[var(--taomni-code-muted)]">
                {symbol.detail}
              </span>
            )}
            <span className="ml-auto shrink-0 font-mono text-ui-caption text-[var(--taomni-code-muted)]">
              :{symbol.selectionRange.start.line + 1}
            </span>
          </>
        );
      }}
      emptyText={(query) => {
        if (loading) return t("fileStructure.loading");
        if (unavailableReason) return unavailableReason;
        return query ? t("fileStructure.noMatches") : t("fileStructure.empty");
      }}
      header={
        // IDEA titles File Structure with the file name.
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3 text-ui-small">
          <span data-testid="code-workspace-structure-title" className="min-w-0 flex-1 truncate font-medium text-[var(--taomni-code-text)]">
            {fileTitle ?? t("fileStructure.title")}
          </span>
          {syntaxOnly && (
            <span
              data-testid="code-workspace-structure-syntax-only"
              title={t("fileStructure.syntaxHint")}
              className="shrink-0 rounded border border-[var(--taomni-warning-border)] bg-[var(--taomni-warning-bg)] px-1 text-ui-caption text-ui-warning"
            >
              {t("fileStructure.syntaxOnly")}
            </span>
          )}
        </div>
      }
      footer={
        <>
          <span>{t("fileStructure.select")}</span>
          <span>{t("fileStructure.jump")}</span>
          <span>{t("fileStructure.close")}</span>
          <span className="ml-auto">
            {t(symbols.length === 1 ? "fileStructure.symbol" : "fileStructure.symbols", { count: symbols.length })}
          </span>
        </>
      }
      onClose={onClose}
      onPick={onPick}
    />
  );
}
