import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { LspFileState } from "./codeWorkspaceModel";

export function LspStatusPill({
  state,
  diagnostics,
}: {
  state: LspFileState | null;
  diagnostics: LspDiagnostic[];
}) {
  if (!state?.status) {
    return (
      <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">
        LSP idle
      </span>
    );
  }
  const status = state.status;
  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;
  const label = status.active
    ? `${status.displayName ?? "LSP"}${errors || warnings ? ` · ${errors}E ${warnings}W` : ""}`
    : status.installHint
      ? `Install: ${status.installHint}`
      : status.error ?? "No LSP";
  return (
    <span
      title={label}
      data-active={status.active || undefined}
      data-error={!!state.error || (!status.active && !!status.error) || undefined}
      className="max-w-[38%] shrink-0 truncate rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[10px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-muted)] data-[active=true]:text-[var(--taomni-accent)] data-[error=true]:text-amber-500"
    >
      {label}
    </span>
  );
}

export function IconButton({
  label,
  icon,
  disabled,
  testId,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  testId?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      data-active={active || undefined}
      disabled={disabled}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-accent)] disabled:opacity-40 disabled:cursor-default"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/**
 * Trailing clear control for filter/search fields. Hidden when the field is
 * empty. Use `variant="app"` for main shell / Git chrome tokens, and
 * `placement="absolute"` for Search-icon inputs with `pl-7 pr-7`.
 */
export function FilterClearButton({
  value,
  onClear,
  label = "Clear",
  testId,
  variant = "code",
  placement = "inline",
}: {
  value: string;
  onClear: () => void;
  label?: string;
  testId?: string;
  variant?: "code" | "app";
  placement?: "inline" | "absolute";
}) {
  if (!value) return null;
  const tone = variant === "app"
    ? "text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
    : "text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]";
  const place = placement === "absolute"
    ? "absolute right-1.5 top-1/2 -translate-y-1/2"
    : "shrink-0";
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      className={`h-5 w-5 inline-flex items-center justify-center rounded ${place} ${tone}`}
      onMouseDown={(event) => {
        // Keep focus behavior predictable: clear without stealing the next click.
        event.preventDefault();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClear();
      }}
    >
      <X className="h-3 w-3" />
    </button>
  );
}
