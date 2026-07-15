import { GitBranch, GitCommitHorizontal, Upload } from "lucide-react";
import type { ReactNode } from "react";

export interface CommitBarProps {
  message: string;
  onMessageChange: (message: string) => void;
  canCommit: boolean;
  canCommitAndPush: boolean;
  onCommit: () => void;
  onCommitAndPush: () => void;
  commitLabel?: string;
  summary?: ReactNode;
  amend?: {
    checked: boolean;
    onChange: (value: boolean) => void;
  };
  /** Target branch for commit (issue #324 S4). Empty means current branch. */
  targetBranch?: string;
  onTargetBranchChange?: (branch: string) => void;
  branchOptions?: string[];
  branchPlaceholder?: string;
}

export function CommitBar({
  message,
  onMessageChange,
  canCommit,
  canCommitAndPush,
  onCommit,
  onCommitAndPush,
  commitLabel = "Commit",
  summary,
  amend,
  targetBranch,
  onTargetBranchChange,
  branchOptions = [],
  branchPlaceholder = "Current branch",
}: CommitBarProps) {
  const listId = "taomni-git-commit-branch-options";
  return (
    <div className="shrink-0 border-t border-[var(--taomni-divider)] p-2 space-y-2">
      {onTargetBranchChange ? (
        <label className="flex items-center gap-2 text-[12px]" data-testid="commit-target-branch">
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="shrink-0 text-[var(--taomni-text-muted)]">Branch</span>
          <input
            className="taomni-input h-7 flex-1 min-w-0 text-[12px]"
            list={listId}
            value={targetBranch ?? ""}
            placeholder={branchPlaceholder}
            aria-label="Commit target branch"
            onChange={(event) => onTargetBranchChange(event.target.value)}
          />
          <datalist id={listId}>
            {branchOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
      ) : null}
      <textarea
        className="taomni-input w-full min-h-20 resize-none"
        value={message}
        placeholder="Commit message"
        onChange={(event) => onMessageChange(event.target.value)}
      />
      <div className="flex items-center gap-2">
        {amend ? (
          <label className="flex items-center gap-1 text-[12px] select-none">
            <input type="checkbox" checked={amend.checked} onChange={(event) => amend.onChange(event.target.checked)} />
            Amend
          </label>
        ) : null}
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]">
            {summary}
          </span>
        ) : (
          <div className="flex-1" />
        )}
        <button
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          type="button"
          disabled={!canCommit}
          onClick={onCommit}
        >
          <GitCommitHorizontal className="w-3.5 h-3.5" />
          <span>{commitLabel}</span>
        </button>
        <button
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          type="button"
          disabled={!canCommitAndPush}
          onClick={onCommitAndPush}
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Commit and Push</span>
        </button>
      </div>
    </div>
  );
}
