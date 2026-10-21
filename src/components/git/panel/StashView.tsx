import { Group as PanelGroup,Panel,Separator as PanelResizeHandle } from "react-resizable-panels";
import { type GitSnapshot,type GitStashEntry } from "../../../lib/git";
import { EmptyState,DiffPane } from "./controls";


export function StashView({
  snapshot,
  selected,
  setSelected,
  diff,
  diffLoading,
  busy,
  includeUntracked,
  setIncludeUntracked,
  onSave,
  onApply,
  onPop,
  onDrop,
}: {
  snapshot: GitSnapshot|null;
  selected: GitStashEntry|null;
  setSelected: (stash: GitStashEntry) => void;
  diff: string;
  diffLoading: boolean;
  busy: boolean;
  includeUntracked: boolean;
  setIncludeUntracked: (value: boolean) => void;
  onSave: () => void;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}) {
  const stashes=snapshot?.stashes??[];
  return (
    <PanelGroup orientation="horizontal" id="git-stash-layout">
      <Panel id="stash-list" defaultSize={34} minSize={24} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy} onClick={onSave}>Stash</button>
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
            Include untracked
          </label>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {stashes.length===0? <EmptyState title="No stashes" />:stashes.map((stash) => (
            <button
              key={stash.selector}
              type="button"
              className={`w-full px-3 py-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.selector===stash.selector? "bg-[var(--taomni-hover)]":""}`}
              onClick={() => setSelected(stash)}
            >
              <div className="taomni-mono text-[11px] text-[var(--taomni-accent)]">{stash.selector}</div>
              <div className="text-[12px] truncate">{stash.message}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">{stash.date}</div>
            </button>
          ))}
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="stash-diff" defaultSize={66} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold text-[12px] truncate">{selected?.selector??"Stash"}</span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!selected} onClick={onApply}>Apply</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!selected} onClick={onPop}>Pop</button>
          <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy||!selected} onClick={onDrop}>Drop</button>
        </div>
        <DiffPane diff={diff} loading={diffLoading} />
      </Panel>
    </PanelGroup>
  );
}
