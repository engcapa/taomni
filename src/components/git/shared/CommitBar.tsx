import { GitCommitHorizontal, Upload } from "lucide-react";
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
}: CommitBarProps) {
  return (
    <div className="shrink-0 border-t border-[var(--taomni-divider)] p-2 space-y-2">
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
