import { GitCommitHorizontal,Loader2 } from "lucide-react";
import { type GitSnapshot } from "../../../lib/git";


export function DiffPane({ diff,loading }: { diff: string; loading: boolean; }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-term-bg,#111827)]">
      {loading? (
        <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading diff
        </div>
      ):diff? (
        <pre className="taomni-mono text-[12px] leading-5 p-3 whitespace-pre-wrap break-words text-slate-100">{diff}</pre>
      ):(
        <EmptyState title="Select an item to preview its diff" />
      )}
    </div>
  );
}


export function BranchBadge({ snapshot }: { snapshot: GitSnapshot|null; }) {
  if(!snapshot) return <span className="text-[11px] text-[var(--taomni-text-muted)]">No repo state</span>;
  return (
    <span className="inline-flex items-center gap-1 h-6 px-2 rounded bg-[var(--taomni-hover)] text-[12px]">
      <GitCommitHorizontal className="w-3.5 h-3.5" />
      {snapshot.detached? `detached ${snapshot.headOid??""}`:snapshot.currentBranch??"(no branch)"}
    </span>
  );
}


export function IconButton({ label,icon,disabled,onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; onClick: () => void; }) {
  return (
    <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" disabled={disabled} onClick={onClick} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}


export function EmptyState({ title }: { title: string; }) {
  return <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{title}</div>;
}
