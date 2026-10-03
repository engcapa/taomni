import { ChevronDown, ChevronUp, Copy, GitCompare, RotateCcw, X } from "lucide-react";
import type { GitLineChange } from "./gitEditorChrome";

function lineLabel(start: number, end: number): string {
  return start === end ? `${start + 1}` : `${start + 1}-${end + 1}`;
}

/**
 * ED-PARITY-022 DEC-022-02: IDEA's VCS change popup — previous/next change,
 * Rollback, Show Diff and Copy over the HEAD text of this hunk.
 */
export function GitDiffPeek({
  change,
  index,
  total,
  onClose,
  onRollback,
  onPrevious,
  onNext,
  onShowDiff,
  onCopy,
}: {
  change: GitLineChange;
  /** Position of this change among the file's changes (0-based). */
  index?: number;
  total?: number;
  onClose: () => void;
  onRollback?: (change: GitLineChange) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onShowDiff?: (change: GitLineChange) => void;
  onCopy?: (change: GitLineChange) => void;
}) {
  const toolButton = "inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40";
  const multiple = (total ?? 0) > 1;
  return (
    <aside
      data-testid="code-workspace-git-diff-peek"
      data-change-kind={change.kind}
      data-change-index={index ?? 0}
      role="dialog"
      aria-label={`${change.kind} lines ${lineLabel(change.startLine, change.endLine)}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute left-10 top-3 z-20 max-h-[70%] w-[min(640px,calc(100%-4rem))] overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-2xl"
    >
      <div className="flex h-8 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2 text-[10px] text-[var(--taomni-code-muted)]">
        {onPrevious && (
          <button
            type="button"
            data-testid="git-diff-peek-previous"
            aria-label="Previous change"
            title="Previous Change"
            disabled={!multiple}
            className={toolButton}
            onClick={onPrevious}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        )}
        {onNext && (
          <button
            type="button"
            data-testid="git-diff-peek-next"
            aria-label="Next change"
            title="Next Change"
            disabled={!multiple}
            className={toolButton}
            onClick={onNext}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
        {onRollback && (
          <button
            type="button"
            data-testid="git-diff-peek-rollback-btn"
            aria-label="Rollback this change"
            title="Rollback Lines"
            className={toolButton}
            onClick={() => {
              onRollback(change);
              onClose();
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {onShowDiff && (
          <button
            type="button"
            data-testid="git-diff-peek-show-diff"
            aria-label="Show diff"
            title="Show Diff"
            className={toolButton}
            onClick={() => {
              onShowDiff(change);
              onClose();
            }}
          >
            <GitCompare className="h-3.5 w-3.5" />
          </button>
        )}
        {onCopy && (
          <button
            type="button"
            data-testid="git-diff-peek-copy"
            aria-label="Copy HEAD lines"
            title="Copy"
            disabled={!change.oldText}
            className={toolButton}
            onClick={() => onCopy(change)}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="ml-1 font-semibold capitalize text-[var(--taomni-code-text)]">{change.kind} lines</span>
        <span data-testid="git-diff-peek-range">HEAD {lineLabel(change.oldStartLine, change.oldEndLine)} → Buffer {lineLabel(change.startLine, change.endLine)}</span>
        {multiple && (
          <span data-testid="git-diff-peek-position">{(index ?? 0) + 1} of {total}</span>
        )}
        <button
          type="button"
          aria-label="Close inline Git diff"
          className={`${toolButton} ml-auto`}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-[360px] overflow-auto font-mono text-[11px] leading-5">
        {change.oldText && change.oldText.split("\n").map((line, lineIndex) => (
          <div key={`old:${lineIndex}`} data-testid="git-diff-peek-old-line" className="flex bg-red-500/10 text-red-400">
            <span className="w-7 shrink-0 select-none text-center opacity-60">−</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line || " "}</pre>
          </div>
        ))}
        {change.newText && change.newText.split("\n").map((line, lineIndex) => (
          <div key={`new:${lineIndex}`} data-testid="git-diff-peek-new-line" className="flex bg-green-500/10 text-green-400">
            <span className="w-7 shrink-0 select-none text-center opacity-60">+</span>
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line || " "}</pre>
          </div>
        ))}
      </div>
    </aside>
  );
}
