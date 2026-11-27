import { ModalSurface } from "../../../ui/ModalSurface";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createReplaceInFilesPlan,
} from "../replaceInFilesModel";
import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";

/**
 * ED-FIND-004 A1: structured Replace in Files preview. Groups the frozen
 * plan usages by file with per-match and per-file exclusion checkboxes, live
 * included/total counts, and an explicit commit/cancel boundary.
 *
 * Exclusion is keyed by STABLE content keys (path + range), never by the
 * positional `opIdx:editIdx` usage ids: those shift when an exclusion
 * rebuilds the plan, which would silently re-include or misattribute rows.
 * The positional ids are derived per render for the model call only.
 */
export interface ReplacePreviewDialogProps {
  /** Frozen source edit the preview was built from (rebuilt immutably on exclusion). */
  edit: LspWorkspaceEdit;
  /** Replacement text shown in the header. */
  replacement: string;
  /** Frozen query shown in the IDEA-style replacement summary. */
  query?: string;
  /** Exclusions selected in the result list before opening the preview. */
  initialExcludedKeys?: ReadonlySet<string>;
  /** ED-IMPROVE-005: frozen scope/query identity captured before the preview. */
  scopeLabel?: string;
  committing: boolean;
  commitError: string | null;
  onCommit: (excludedKeys: ReadonlySet<string>) => void;
  onCancel: () => void;
}

export function stableUsageKey(path: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): string {
  return `${path}:${startLine}:${startCharacter}:${endLine}:${endCharacter}`;
}

export function ReplacePreviewDialog({
  edit,
  replacement,
  query = "",
  initialExcludedKeys,
  scopeLabel,
  committing,
  commitError,
  onCommit,
  onCancel,
}: ReplacePreviewDialogProps) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set(initialExcludedKeys));
  const commitRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    setExcluded(new Set(initialExcludedKeys));
    commitRef.current?.focus();
  }, [edit, initialExcludedKeys]);
  useLayoutEffect(() => {
    // Disabled controls lose focus in WebKit. Keep pending keys in the modal
    // and restore its primary action when a blocked commit becomes retryable.
    (committing ? commitRef.current?.closest("dialog") : commitRef.current)?.focus();
  }, [committing]);
  const allPlan = useMemo(() => createReplaceInFilesPlan(edit), [edit]);
  const excludedUsageIds = useMemo(() => {
    const excludedUsageIds = new Set<string>();
    for (const usage of allPlan.preview.usages) {
      const key = stableUsageKey(
        usage.path,
        usage.range.start.line,
        usage.range.start.character,
        usage.range.end.line,
        usage.range.end.character,
      );
      if (excluded.has(key)) excludedUsageIds.add(usage.id);
    }
    return excludedUsageIds;
  }, [allPlan, excluded]);
  const live = useMemo(
    () => createReplaceInFilesPlan(edit, excludedUsageIds),
    [edit, excludedUsageIds],
  );
  const byFile = useMemo(() => {
    const groups = new Map<string, typeof allPlan.preview.usages>();
    for (const usage of allPlan.preview.usages) {
      const list = groups.get(usage.path);
      if (list) list.push(usage);
      else groups.set(usage.path, [usage]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [allPlan]);

  const keyOf = (usage: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }) => stableUsageKey(
    usage.path,
    usage.range.start.line,
    usage.range.start.character,
    usage.range.end.line,
    usage.range.end.character,
  );
  const toggleUsageKey = (key: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleFile = (path: string, checked: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      for (const usage of allPlan.preview.usages) {
        if (usage.path !== path) continue;
        if (checked) next.delete(keyOf(usage));
        else next.add(keyOf(usage));
      }
      return next;
    });
  };

  const includedFiles = useMemo(
    () => new Set(allPlan.preview.usages
      .filter((usage) => !excluded.has(keyOf(usage)))
      .map((usage) => usage.path)).size,
    [allPlan, excluded],
  );

  return (
    <ModalSurface
      tabIndex={-1}
      data-testid="code-workspace-replace-preview"
      aria-labelledby="code-workspace-replace-title"
      initialFocus='[data-testid="code-workspace-replace-commit"]'
      onCancel={() => { if (!committing) onCancel(); }}
      className="taomni-modal taomni-workspace-modal"
      data-bleed="true"
      style={{ width: "min(560px, calc(100vw - 32px))" }}
    >
      <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2">
        <h2 id="code-workspace-replace-title" className="font-medium">Replace in files preview</h2>
        <div
          data-testid="code-workspace-replace-summary"
          className="mt-0.5 text-ui-small text-[var(--taomni-code-text)]"
        >
          Replace {live.includedMatches} occurrence{live.includedMatches === 1 ? "" : "s"} of '{query}' across {includedFiles} file{includedFiles === 1 ? "" : "s"} with '{replacement}'?
        </div>
        <div
          data-testid="code-workspace-replace-counts"
          className="mt-0.5 text-ui-small text-[var(--taomni-code-muted)]"
        >
          {live.includedMatches} of {live.totalMatches} occurrences · replace with “{replacement}”
        </div>
        {scopeLabel && (
          <div
            data-testid="code-workspace-replace-scope"
            className="mt-0.5 text-ui-caption text-[var(--taomni-code-muted)]"
          >
            {scopeLabel}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-auto overflow-auto py-1">
        {byFile.map(([path, usages]) => {
          const excludedCount = usages.filter((usage) => excluded.has(keyOf(usage))).length;
          const allExcluded = excludedCount === usages.length;
          return (
            <section key={path}>
              <label className="flex h-6 items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)]">
                <input
                  type="checkbox"
                  checked={!allExcluded}
                  aria-label={`Include all matches in ${path}`}
                  data-testid="code-workspace-replace-file-toggle"
                  data-path={path}
                  onChange={(event) => toggleFile(path, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-left">{path}</span>
                <span className="shrink-0 text-ui-caption tabular-nums">
                  {usages.length - excludedCount}/{usages.length}
                </span>
              </label>
              {usages.map((usage) => {
                const key = keyOf(usage);
                return (
                  <label
                    key={key}
                    className="flex h-6 items-center gap-2 px-6 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  >
                    <input
                      type="checkbox"
                      checked={!excluded.has(key)}
                      aria-label={`Include occurrence at ${usage.path}:${usage.range.start.line + 1}`}
                      data-testid="code-workspace-replace-usage"
                      data-usage-id={usage.id}
                      onChange={() => toggleUsageKey(key)}
                    />
                    <span className="shrink-0 font-mono text-ui-caption text-[var(--taomni-code-muted)]">
                      {usage.range.start.line + 1}:{usage.range.start.character}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-ui-small">
                      → {usage.newText}
                    </span>
                  </label>
                );
              })}
            </section>
          );
        })}
        {byFile.length > 0 && live.includedMatches === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            Every occurrence is excluded — nothing will be replaced.
          </div>
        )}
      </div>
      {commitError && (
        <div
          data-testid="code-workspace-replace-commit-error"
          role="alert"
          className="shrink-0 border-t border-ui-danger-border bg-ui-danger-surface px-3 py-1.5 text-ui-small text-ui-danger"
        >
          {commitError}
        </div>
      )}
      <div className="shrink-0 flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
        <button
          type="button"
          data-testid="code-workspace-replace-cancel"
          className="h-7 rounded px-3 hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onCancel}
          disabled={committing}
        >
          Cancel
        </button>
        <button
          type="button"
          ref={commitRef}
          data-testid="code-workspace-replace-commit"
          className="h-7 rounded bg-[var(--taomni-accent)] px-3 font-medium text-white disabled:opacity-50"
          disabled={committing || live.includedMatches === 0}
          onClick={() => onCommit(excluded)}
        >
          {committing ? "Replacing…" : `Replace ${live.includedMatches}`}
        </button>
      </div>
    </ModalSurface>
  );
}
