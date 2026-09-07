import { useMemo, useState } from "react";
import {
  createReplaceInFilesPlan,
  type ReplaceInFilesFilePreimage,
} from "../replaceInFilesModel";
import type { WorkspaceEditPreview } from "../workspaceEditPreview";
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
  /** Frozen disk/readability facts captured before this dialog opened. */
  filePreimages?: readonly ReplaceInFilesFilePreimage[];
  committing: boolean;
  commitError: string | null;
  onCommit: (excludedKeys: ReadonlySet<string>) => void;
  onCancel: () => void;
}

export function stableUsageKey(path: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): string {
  return `${path}:${startLine}:${startCharacter}:${endLine}:${endCharacter}`;
}

type ReplaceUsage = WorkspaceEditPreview["usages"][number];

function usageKey(usage: ReplaceUsage): string {
  return stableUsageKey(
    usage.path,
    usage.range.start.line,
    usage.range.start.character,
    usage.range.end.line,
    usage.range.end.character,
  );
}

function preimageStatus(preimage: ReplaceInFilesFilePreimage | undefined): string | null {
  if (!preimage) return null;
  const statuses: string[] = [];
  if (preimage.dirty) statuses.push("dirty buffer");
  if (preimage.readOnly) statuses.push("read-only");
  if (preimage.availability === "oversize") statuses.push("too large");
  if (preimage.availability === "unreadable") statuses.push("unreadable");
  return statuses.length > 0 ? statuses.join(" · ") : "ready";
}

export function ReplacePreviewDialog({
  edit,
  replacement,
  filePreimages = [],
  committing,
  commitError,
  onCommit,
  onCancel,
}: ReplacePreviewDialogProps) {
  const source = useMemo(() => createReplaceInFilesPlan(edit), [edit]);
  const preimagesByPath = useMemo(
    () => new Map(filePreimages.map((preimage) => [preimage.path, preimage])),
    [filePreimages],
  );
  const blockedPaths = useMemo(
    () => new Set(filePreimages
      .filter((preimage) => (
        preimage.dirty
        || preimage.readOnly
        || preimage.availability !== "ready"
        || preimage.hash === null
      ))
      .map((preimage) => preimage.path)),
    [filePreimages],
  );
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set(
    source.preview.usages
      .filter((usage) => blockedPaths.has(usage.path))
      .map(usageKey),
  ));
  const live = useMemo(() => {
    const excludedUsageIds = new Set(
      source.preview.usages
        .filter((usage) => excluded.has(usageKey(usage)))
        .map((usage) => usage.id),
    );
    return createReplaceInFilesPlan(edit, excludedUsageIds);
  }, [edit, excluded, source]);
  const byFile = useMemo(() => {
    const groups = new Map<string, ReplaceUsage[]>();
    for (const usage of source.preview.usages) {
      const list = groups.get(usage.path);
      if (list) list.push(usage);
      else groups.set(usage.path, [usage]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [source]);

  const toggleUsageKey = (key: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleFile = (path: string, checked: boolean) => {
    if (blockedPaths.has(path)) return;
    setExcluded((current) => {
      const next = new Set(current);
      for (const usage of source.preview.usages) {
        if (usage.path !== path) continue;
        if (checked) next.delete(usageKey(usage));
        else next.add(usageKey(usage));
      }
      return next;
    });
  };

  return (
    <div
      data-testid="code-workspace-replace-preview"
      role="dialog"
      aria-label="Replace in files preview"
      className="flex max-h-[70vh] min-h-0 w-[560px] max-w-[90vw] flex-col rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-text)]"
    >
      <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2">
        <div className="font-medium">Replace in files preview</div>
        <div
          data-testid="code-workspace-replace-counts"
          className="mt-0.5 text-[11px] text-[var(--taomni-code-muted)]"
        >
          {live.includedMatches} of {live.totalMatches} occurrences · replace with “{replacement}”
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {byFile.map(([path, usages]) => {
          const excludedCount = usages.filter((usage) => excluded.has(usageKey(usage))).length;
          const includedCount = usages.length - excludedCount;
          const status = preimageStatus(preimagesByPath.get(path));
          const pathBlocked = blockedPaths.has(path);
          const allExcluded = includedCount === 0;
          return (
            <section key={path}>
              <label className="flex h-6 items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)]">
                <input
                  type="checkbox"
                  checked={!allExcluded && !pathBlocked}
                  disabled={pathBlocked}
                  aria-label={`Include all matches in ${path}`}
                  data-testid="code-workspace-replace-file-toggle"
                  data-path={path}
                  onChange={(event) => toggleFile(path, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-left">{path}</span>
                <span className="shrink-0 text-[10px] tabular-nums">
                  {includedCount}/{usages.length}
                </span>
                {status && (
                  <span
                    data-testid="code-workspace-replace-file-status"
                    data-path={path}
                    className={pathBlocked ? "shrink-0 text-[10px] text-amber-500" : "shrink-0 text-[10px] text-[var(--taomni-code-muted)]"}
                    title={preimagesByPath.get(path)?.reason ?? undefined}
                  >
                    {status}
                  </span>
                )}
              </label>
              {usages.map((usage) => {
                const key = usageKey(usage);
                return (
                  <label
                    key={key}
                    className="flex h-6 items-center gap-2 px-6 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  >
                    <input
                      type="checkbox"
                      checked={!excluded.has(key) && !pathBlocked}
                      disabled={pathBlocked}
                      aria-label={`Include occurrence at ${usage.path}:${usage.range.start.line + 1}`}
                      data-testid="code-workspace-replace-usage"
                      data-usage-id={usage.id}
                      onChange={() => toggleUsageKey(key)}
                    />
                    <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                      {usage.range.start.line + 1}:{usage.range.start.character}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      → {usage.newText}
                    </span>
                  </label>
                );
              })}
            </section>
          );
        })}
        {live.preview.usages.length === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            Every occurrence is excluded — nothing will be replaced.
          </div>
        )}
      </div>
      {commitError && (
        <div
          data-testid="code-workspace-replace-commit-error"
          role="alert"
          className="shrink-0 border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500"
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
          data-testid="code-workspace-replace-commit"
          className="h-7 rounded bg-[var(--taomni-accent)] px-3 font-medium text-white disabled:opacity-50"
          disabled={committing || live.includedMatches === 0}
          onClick={() => onCommit(excluded)}
        >
          {committing ? "Replacing…" : `Replace ${live.includedMatches}`}
        </button>
      </div>
    </div>
  );
}
