import { ChevronLeft, ChevronRight } from "lucide-react";
import type { GitBlobPair } from "../../../lib/git";
import { DiffViewer } from "../DiffViewer";

/** Previous/next changed-file navigation across the visible change list. */
export interface DiffPaneFileNavigation {
  /** Zero-based index of the focused file, or -1 when it is not in the visible list. */
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}

/** Labels for the two diff sides, e.g. `HEAD 8748e377` and `Working tree`. */
export interface DiffPaneSideLabels {
  old: string;
  new: string;
}

export interface DiffPaneProps {
  title: string;
  busy: boolean;
  selectedCount: number;
  pair: GitBlobPair | null;
  pairLoading: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onNormalizeLineEndings?: () => void;
  normalizeLineEndingsBusy?: boolean;
  onOpenInEditor?: () => void;
  onSaveWorktree?: (text: string) => Promise<void> | void;
  worktreeEditable?: boolean;
  /** Repository that produced `pair` (multi-repository workspaces). */
  repoRoot?: string | null;
  fileNavigation?: DiffPaneFileNavigation;
  sideLabels?: DiffPaneSideLabels | null;
}

export function DiffPane({
  title,
  busy,
  selectedCount,
  pair,
  pairLoading,
  onStage,
  onUnstage,
  onDiscard,
  onNormalizeLineEndings,
  normalizeLineEndingsBusy,
  onOpenInEditor,
  onSaveWorktree,
  worktreeEditable,
  repoRoot,
  fileNavigation,
  sideLabels,
}: DiffPaneProps) {
  const navIndex = fileNavigation?.index ?? -1;
  const navCount = fileNavigation?.count ?? 0;
  return (
    <div className="h-full min-h-0 min-w-0 w-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
        {fileNavigation ? (
          <div className="shrink-0 flex items-center gap-0.5 mr-1" role="group" aria-label="Changed file navigation">
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              data-testid="workspace-diff-prev-file"
              title="Compare Previous File"
              aria-label="Compare Previous File"
              disabled={navIndex <= 0}
              onClick={fileNavigation.onPrevious}
            >
              <ChevronLeft className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text)]" />
            </button>
            <span
              className="min-w-[4.5rem] text-center text-[11px] text-[var(--taomni-accent)] tabular-nums"
              data-testid="workspace-diff-file-position"
              aria-live="polite"
            >
              {navIndex >= 0 ? `${navIndex + 1}/${navCount} files` : `${navCount} files`}
            </span>
            <button
              type="button"
              className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
              data-testid="workspace-diff-next-file"
              title="Compare Next File"
              aria-label="Compare Next File"
              disabled={navIndex < 0 || navIndex >= navCount - 1}
              onClick={fileNavigation.onNext}
            >
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text)]" />
            </button>
          </div>
        ) : null}
        <span className="font-semibold truncate text-[12px]" data-testid="workspace-diff-title">{title}</span>
        <div className="flex-1" />
        {onOpenInEditor ? (
          <button
            className="taomni-btn h-7 px-2"
            type="button"
            data-testid="git-diff-open-in-editor"
            disabled={busy || selectedCount === 0}
            onClick={onOpenInEditor}
          >
            Edit
          </button>
        ) : null}
        <button className="taomni-btn h-7 px-2" type="button" data-testid="git-diff-stage" disabled={busy || selectedCount === 0} onClick={onStage}>Stage</button>
        <button className="taomni-btn h-7 px-2" type="button" data-testid="git-diff-unstage" disabled={busy || selectedCount === 0} onClick={onUnstage}>Unstage</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" data-testid="git-diff-discard" disabled={busy || selectedCount === 0} onClick={onDiscard}>Discard</button>
      </div>
      {sideLabels ? (
        <div className="h-6 shrink-0 grid grid-cols-2 border-b border-[var(--taomni-divider)] text-[11px] text-[var(--taomni-text-muted)]">
          <span className="min-w-0 truncate px-3 leading-6 font-mono" data-testid="workspace-diff-old-label">{sideLabels.old}</span>
          <span className="min-w-0 truncate px-3 leading-6 font-mono border-l border-[var(--taomni-divider)]" data-testid="workspace-diff-new-label">{sideLabels.new}</span>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 min-w-0">
        <DiffViewer
          pair={pair}
          loading={pairLoading}
          emptyLabel="Select a file to preview its diff"
          onNormalizeLineEndings={onNormalizeLineEndings}
          normalizeLineEndingsBusy={normalizeLineEndingsBusy}
          worktreeEditable={worktreeEditable}
          onSaveWorktree={onSaveWorktree}
          repoRoot={repoRoot}
        />
      </div>
    </div>
  );
}
