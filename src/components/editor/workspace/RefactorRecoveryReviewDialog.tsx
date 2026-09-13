import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type {
  RefactorRecoveryJournalEntryV2,
} from "./refactorPlan";
import type { RefactorRecoveryPreconditionSummary } from "./refactorRecoveryController";

export interface RefactorRecoveryReviewDialogProps {
  entry: RefactorRecoveryJournalEntryV2;
  workspaceRoot: string;
  preconditions: RefactorRecoveryPreconditionSummary | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onKeep: () => void;
  onRestore: () => void;
  onDismiss: () => void;
  onClose: () => void;
}

function relativeOrFull(path: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  const rootKey = root.toLowerCase();
  if (normalized.toLowerCase().startsWith(`${rootKey}/`)) {
    return normalized.slice(root.length + 1);
  }
  return path;
}

function docStateLabel(state: string): string {
  switch (state) {
    case "restorable": return "restorable";
    case "already-restored": return "already at pre-refactor content";
    case "conflict": return "changed since the transaction (kept)";
    case "unreadable": return "unreadable";
    default: return state;
  }
}

function moveStateLabel(state: string, detail?: string): string {
  if (state === "restorable") return "moved; ready to move back";
  if (state === "already-restored") return "already moved back";
  if (state === "unreadable") return "unreadable";
  switch (detail) {
    case "both-missing": return "file does not exist at either end";
    case "both-present": return "both ends exist; reversal would destroy bytes";
    case "content-changed": return "content at the new path changed (kept)";
    case "ambiguous-proof": return "ambiguous journal mapping (kept)";
    default: return "conflicting state (kept)";
  }
}

/**
 * RC-02/DEC-01 review surface (figure A): one pending transaction at a time.
 * Lists every text document and move endpoint with its live state, never
 * claims an unreadable file was "deleted by the user", and offers explicit
 * Keep / Restore / Abandon outlets. Abandon only ends this record's reminder
 * (owner confirms again before persisting); it never rebuilds files.
 */
export function RefactorRecoveryReviewDialog({
  entry,
  workspaceRoot,
  preconditions,
  loading,
  error,
  busy,
  onKeep,
  onRestore,
  onDismiss,
  onClose,
}: RefactorRecoveryReviewDialogProps) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelDismissRef = useRef<HTMLButtonElement>(null);
  // Figure B: inline second confirm for abandon. Cancel stays focused so
  // keyboard confirmation cannot abandon by accident; no files change here —
  // the owner persists the dismissal only after this explicit step.
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  useEffect(() => {
    window.setTimeout(() => keepRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (confirmingDismiss) {
      window.setTimeout(() => cancelDismissRef.current?.focus(), 0);
    }
  }, [confirmingDismiss]);

  useEffect(() => {
    setConfirmingDismiss(false);
  }, [entry.recoveryId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (busy) return;
      if (confirmingDismiss) {
        setConfirmingDismiss(false);
        return;
      }
      onClose();
    }
  };

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ key: string; label: string; full: string; state: string }> = [];
    const keyOf = (raw: string): string => {
      try {
        // Keep the dialog dependency-light: case-insensitive comparison for
        // Windows-style paths, exact otherwise. Identity grouping only.
        const normalized = raw.replace(/\\/g, "/");
        return /^(?:[a-zA-Z]:|\\\\|\/\/)/.test(raw) || /^[a-zA-Z]:/.test(normalized)
          ? normalized.toLowerCase()
          : normalized;
      } catch {
        return raw;
      }
    };
    for (const doc of entry.documents) {
      const full = doc.canonicalPath ?? doc.uri;
      const key = `doc:${keyOf(full)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const state = loading || !preconditions
        ? "checking…"
        : preconditions.documents.find((d) => d.uri === doc.uri)?.state ?? "unreadable";
      items.push({
        key,
        label: relativeOrFull(full, workspaceRoot),
        full,
        state: loading ? "checking…" : docStateLabel(state),
      });
    }
    for (const move of entry.resourceMoves ?? []) {
      const oldFull = move.oldPath ?? move.oldUri;
      const newFull = move.newPath ?? move.newUri;
      const key = `move:${keyOf(oldFull)}->${keyOf(newFull)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const precondition = preconditions?.moves.find((m) => m.newUri === move.newUri && m.oldUri === move.oldUri);
      const state = loading || !precondition
        ? "checking…"
        : moveStateLabel(precondition.state, precondition.detail);
      const label = `${relativeOrFull(oldFull, workspaceRoot)} → ${relativeOrFull(newFull, workspaceRoot)}`;
      items.push({ key, label, full: `${oldFull} → ${newFull}`, state });
    }
    return items;
  }, [entry, preconditions, loading, workspaceRoot]);

  const overall = preconditions?.overall ?? null;
  const canRestore = !loading && !busy && !error && !confirmingDismiss && overall === "restorable";
  const canDismiss = !loading && !busy;
  const affectedCount = rows.length;

  return (
      <div
        className="fixed inset-0 z-[940] flex items-center justify-center bg-black/45 p-4"
        onClick={() => {
          if (busy) return;
          if (confirmingDismiss) {
            setConfirmingDismiss(false);
            return;
          }
          onClose();
        }}
        onKeyDown={handleKeyDown}
      >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review refactor recovery"
        data-testid="refactor-recovery-review"
        className="flex max-h-[90vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">
              Review refactor recovery
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">
              {entry.kind} · {affectedCount} affected file{affectedCount === 1 ? "" : "s"} · {new Date(entry.createdAt).toLocaleString()}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close recovery review"
            title="Keep pending and close"
            disabled={busy}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
            onClick={() => {
              if (confirmingDismiss) {
                setConfirmingDismiss(false);
                return;
              }
              onClose();
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <div className="mb-1 text-[10px] text-[var(--taomni-code-muted)]">
            Workspace: <span className="break-all font-mono">{workspaceRoot}</span>
          </div>
          <div className="mb-2 text-[11px] leading-5 text-[var(--taomni-code-text)]">
            {overall === "already-restored"
              ? "Every affected file already matches its pre-refactor content. Closing keeps no pending reminder."
              : overall === "restorable"
                ? "The recorded post-state is intact. Restoring moves relocated files back and writes pre-refactor content with read-back verification."
                : "Some files cannot be restored automatically and will not be overwritten. Keeping or abandoning changes no files."}
          </div>
          {loading && (
            <div className="mb-2 text-[11px] text-[var(--taomni-code-muted)]">
              Loading and verifying the pending entry…
            </div>
          )}
          {error && (
            <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300" role="alert">
              {error}
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.key}
                data-testid="refactor-recovery-resource"
                className="rounded border border-[var(--taomni-code-border)] px-2 py-1.5"
              >
                <div className="break-all font-mono text-[11px] text-[var(--taomni-code-text)]" title={row.full}>
                  {row.label}
                </div>
                <div className="mt-0.5 break-all text-[10px] text-[var(--taomni-code-muted)]" title={row.full}>
                  {row.state} · <span className="select-text">{row.full}</span>
                </div>
              </li>
            ))}
          </ul>
          {rows.length === 0 && (
            <div className="py-4 text-center text-[11px] text-[var(--taomni-code-muted)]">
              This entry records no files.
            </div>
          )}
          <div className="mt-2 text-[10px] leading-4 text-[var(--taomni-code-muted)]">
            Abandon ends only this record&apos;s reminder and keeps files exactly as they are now.
            It never rebuilds deleted files or edits references.
          </div>
          {confirmingDismiss && (
            <div
              className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5"
              data-testid="refactor-recovery-dismiss-confirm"
            >
              <div className="text-[11px] font-semibold text-red-200">
                Abandon recovery for {affectedCount} file{affectedCount === 1 ? "" : "s"}?
              </div>
              <div className="mt-0.5 break-all text-[11px] leading-4 text-red-100/90">
                This ends only this reminder and keeps the current state (files stay missing as they are now).
                It does not restore files, edit references, or affect other pending entries.
              </div>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          {confirmingDismiss ? (
            <>
              <button
                ref={cancelDismissRef}
                type="button"
                data-testid="refactor-recovery-dismiss-cancel"
                disabled={busy}
                className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                onClick={() => setConfirmingDismiss(false)}
              >
                Keep pending
              </button>
              <button
                type="button"
                data-testid="refactor-recovery-dismiss-confirm-button"
                disabled={!canDismiss}
                className="h-8 rounded bg-red-700 px-3 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40"
                onClick={onDismiss}
              >
                Abandon recovery
              </button>
            </>
          ) : (
            <>
              <button
                ref={keepRef}
                type="button"
                data-testid="refactor-recovery-keep"
                disabled={busy}
                className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                onClick={onKeep}
              >
                Keep pending
              </button>
              <button
                type="button"
                data-testid="refactor-recovery-dismiss"
                disabled={!canDismiss}
                title="Abandon this recovery reminder; files stay as they are"
                className="h-8 rounded px-3 text-[11px] hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                onClick={() => setConfirmingDismiss(true)}
              >
                Abandon recovery…
              </button>
              <button
                type="button"
                data-testid="refactor-recovery-restore"
                disabled={!canRestore}
                title={canRestore ? "Restore pre-refactor content" : "Restore is available only when the recorded post-state is intact"}
                className="h-8 rounded bg-[var(--taomni-accent)] px-3 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-40"
                onClick={onRestore}
              >
                Restore files
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
