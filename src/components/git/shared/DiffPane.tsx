import type { GitBlobPair } from "../../../lib/git";
import { DiffViewer } from "../DiffViewer";

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
}: DiffPaneProps) {
  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
        <span className="font-semibold truncate text-[12px]">{title}</span>
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
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || selectedCount === 0} onClick={onStage}>Stage</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || selectedCount === 0} onClick={onUnstage}>Unstage</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || selectedCount === 0} onClick={onDiscard}>Discard</button>
      </div>
      <DiffViewer
        pair={pair}
        loading={pairLoading}
        emptyLabel="Select a file to preview its diff"
        onNormalizeLineEndings={onNormalizeLineEndings}
        normalizeLineEndingsBusy={normalizeLineEndingsBusy}
        worktreeEditable={worktreeEditable}
        onSaveWorktree={onSaveWorktree}
      />
    </>
  );
}
