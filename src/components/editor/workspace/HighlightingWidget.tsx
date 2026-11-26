import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { useId, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Settings,
  ShieldAlert,
} from "lucide-react";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { DiagnosticScope } from "./diagnosticScopeModel";
import type { HighlightingLevel } from "./highlightingLevelModel";

interface HighlightingWidgetProps {
  diagnostics: LspDiagnostic[];
  fileKey?: string;
  diagnosticScope?: DiagnosticScope | null;
  diagnosticsReady?: boolean;
  diagnosticsError?: string | null;
  level: HighlightingLevel;
  onChangeLevel: (level: HighlightingLevel) => void;
  providerName?: string | null;
  providerActive?: boolean;
  onNavigateNextError?: () => void;
  onNavigatePrevError?: () => void;
  onOpenSettings?: () => void;
  onRestoreEditorFocus?: () => void;
}

export function HighlightingWidget({
  diagnostics,
  fileKey,
  diagnosticScope,
  diagnosticsReady = true,
  diagnosticsError = null,
  level,
  onChangeLevel,
  providerName,
  providerActive = false,
  onNavigateNextError,
  onNavigatePrevError,
  onOpenSettings,
  onRestoreEditorFocus,
}: HighlightingWidgetProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = `highlighting-widget-menu-${useId().replace(/:/g, "")}`;
  const levelButtonRef = useRef<HTMLButtonElement | null>(null);
  const levels: HighlightingLevel[] = ["all", "syntax", "none"];

  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;

  const levelLabel = level === "none" ? "None" : level === "syntax" ? "Syntax" : "All Problems";
  const providerLabel = providerActive && providerName ? providerName : "No active language server";
  const diagnosticsStatus = diagnosticsError
    ? `Diagnostics failed: ${diagnosticsError}`
    : !providerActive
      ? "Diagnostics unavailable without a language server"
      : !diagnosticsReady
        ? "Waiting for diagnostics for the current file"
        : errors || warnings
          ? `${errors} error(s), ${warnings} warning(s)`
          : "No problems found";

  const selectLevel = (next: HighlightingLevel) => {
    onChangeLevel(next);
    setMenuOpen(false);
    onRestoreEditorFocus?.();
  };

  return (
    <div
      role="region"
      aria-label="Highlighting level and problems"
      data-testid="code-workspace-highlighting-widget"
      data-file-key={fileKey}
      data-diagnostic-revision={diagnosticScope ? diagnosticScope.revision : undefined}
      data-diagnostic-provider={diagnosticScope?.providerId ?? "none"}
      data-diagnostic-generation={diagnosticScope ? diagnosticScope.providerGeneration : undefined}
      data-diagnostics-ready={diagnosticsReady ? "true" : "false"}
      data-diagnostics-state={diagnosticsError ? "failed" : diagnosticsReady ? "ready" : "pending"}
      className="relative shrink-0 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-1.5 py-0.5 text-ui-small text-[var(--taomni-code-text)]"
    >
      {/* Problems count badge */}
      {diagnosticsReady && errors > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-ui-danger" title={`${errors} error(s)`}>
          <AlertCircle className="h-3 w-3" />
          <span>{errors}</span>
        </span>
      ) : null}

      {diagnosticsReady && warnings > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-ui-warning" title={`${warnings} warning(s)`}>
          <AlertTriangle className="h-3 w-3" />
          <span>{warnings}</span>
        </span>
      ) : null}

      {diagnosticsReady && errors === 0 && warnings === 0 && (
        <span className="inline-flex items-center gap-0.5 text-ui-success" title="No problems found">
          <CheckCircle2 className="h-3 w-3" />
        </span>
      )}

      {!diagnosticsReady && providerActive && (
        <span
          className="inline-flex items-center text-[var(--taomni-code-muted)]"
          title={diagnosticsStatus}
          aria-label={diagnosticsStatus}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
        </span>
      )}

      {/* Up/down error jump buttons */}
      <div className="flex items-center">
        <button
          type="button"
          aria-label="Previous Error (Shift+F2)"
          title="Previous Error (Shift+F2)"
          data-testid="highlighting-widget-prev-error"
          onClick={onNavigatePrevError}
          disabled={!diagnosticsReady || (errors === 0 && warnings === 0)}
          className="rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:opacity-40"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label="Next Error (F2)"
          title="Next Error (F2)"
          data-testid="highlighting-widget-next-error"
          onClick={onNavigateNextError}
          disabled={!diagnosticsReady || (errors === 0 && warnings === 0)}
          className="rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:opacity-40"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {/* Level selector button */}
      <button
        ref={levelButtonRef}
        type="button"
        aria-label="Highlighting level"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        data-testid="highlighting-widget-level-button"
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setMenuOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            setMenuOpen(false);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-[var(--taomni-code-border)]"
      >
        <ShieldAlert className="h-3 w-3 text-[var(--taomni-accent)]" />
        <span>{levelLabel}</span>
      </button>

      {menuOpen && (
        <AnchoredMenu anchor={levelButtonRef} id={menuId}
          testId="highlighting-widget-menu" ariaLabel="Highlighting level options"
          rovingFocus onClose={() => setMenuOpen(false)} items={[
            { label: "Highlighting Level", sectionHeader: true },
            ...levels.map((value) => ({
              label: value === "all" ? "All Problems" : value === "syntax" ? "Syntax" : "None",
              testId: `highlighting-level-option-${value}`,
              role: "menuitemradio" as const,
              checked: level === value,
              onClick: () => selectLevel(value),
            })),
            { label: "", separator: true },
            { label: `Scope: ${providerLabel}`, testId: "highlighting-widget-provider", sectionHeader: true },
            { label: diagnosticsStatus, testId: "highlighting-widget-diagnostic-status", sectionHeader: true },
            ...(onOpenSettings ? [{
              label: "Configure Inspections…", icon: <Settings className="h-3.5 w-3.5" />,
              testId: "highlighting-widget-open-settings", onClick: onOpenSettings,
            }] : []),
          ]} />
      )}
    </div>
  );
}
