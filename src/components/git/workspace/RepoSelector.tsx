import { useEffect,useMemo,useRef,useState } from "react";
import { AlertTriangle,Check,ChevronDown,Circle,FolderGit2,GitBranch,Loader2,Search } from "lucide-react";
import { gitRepoName } from "../../../lib/git";
import type { GitWorkspaceRootInfo } from "../../../types";
import { type RepoSnapshotState,type RepoScope,buildRailGroups } from "./model";
import { repoScopeLabel,scopeFromRepoRoots } from "./scope";


export function RepoSelector({
  roots,
  snapshots,
  scope,
  selectedRoot,
  scopedRoots,
  onScopeChange,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string,RepoSnapshotState>;
  scope: RepoScope;
  selectedRoot: GitWorkspaceRootInfo|null;
  scopedRoots: GitWorkspaceRootInfo[];
  onScopeChange: (scope: RepoScope) => void;
}) {
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState("");
  const [draftRoots,setDraftRoots]=useState<Set<string>>(() => (
    new Set(scopedRoots.map((root) => root.repoRoot))
  ));
  const ref=useRef<HTMLDivElement|null>(null);
  const query=filter.trim().toLowerCase();
  const filteredRoots=useMemo(() => (
    roots.filter((root) => {
      if(!query) return true;
      const snapshot=snapshots[root.repoRoot]?.snapshot??null;
      return (
        root.name.toLowerCase().includes(query)||
        root.repoRoot.toLowerCase().includes(query)||
        root.path.toLowerCase().includes(query)||
        (snapshot?.currentBranch??"").toLowerCase().includes(query)||
        (snapshot?.upstream??"").toLowerCase().includes(query)
      );
    })
  ),[query,roots,snapshots]);
  const groups=useMemo(() => buildRailGroups(filteredRoots),[filteredRoots]);
  const totalChanges=roots.reduce((total,root) => total+(snapshots[root.repoRoot]?.snapshot?.changes.length??0),0);
  const scopedRootSet=useMemo(
    () => new Set(scopedRoots.map((root) => root.repoRoot)),
    [scopedRoots],
  );
  const label=repoScopeLabel(scope,scopedRoots,selectedRoot,roots.length);
  const title=scope.mode==="all"
    ? "All repositories"
    :scopedRoots.map((root) => root.repoRoot).join("\n");

  useEffect(() => {
    if(!open) return;
    setDraftRoots(new Set(scopedRoots.map((root) => root.repoRoot)));
    const close=(event: MouseEvent) => {
      const target=event.target as Node|null;
      if(target&&ref.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown",close);
    return () => document.removeEventListener("mousedown",close);
  },[open,scopedRoots]);

  const closeMenu=() => {
    setOpen(false);
    setFilter("");
  };

  const chooseAll=() => {
    onScopeChange({ mode: "all" });
    closeMenu();
  };

  const chooseSingle=(repoRoot: string) => {
    onScopeChange({ mode: "single",repoRoot });
    closeMenu();
  };

  const toggleDraftRoot=(repoRoot: string,checked: boolean) => {
    setDraftRoots((current) => {
      const next=new Set(current);
      if(checked) next.add(repoRoot);
      else next.delete(repoRoot);
      return next;
    });
  };

  const applyDraft=() => {
    if(draftRoots.size===0) return;
    onScopeChange(scopeFromRepoRoots(draftRoots,roots));
    closeMenu();
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <div ref={ref} className="relative min-w-0">
        <button
          type="button"
          data-testid="workspace-repo-selector"
          className="taomni-btn h-7 max-w-[260px] min-w-[180px] px-2 inline-flex items-center gap-2"
          title={title}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        </button>
        {open&&(
          <div
            data-testid="workspace-repo-selector-menu"
            className="absolute left-0 top-[calc(100%+4px)] z-[70] w-[360px] max-w-[min(360px,calc(100vw-24px))] rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg"
          >
            {roots.length>=5&&(
              <div className="p-2 border-b border-[var(--taomni-divider)]">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
                  <input
                    type="search"
                    className="taomni-input h-7 w-full pl-7"
                    value={filter}
                    placeholder="Search repositories"
                    aria-label="Search repositories"
                    autoFocus
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
              </div>
            )}
            <div className="max-h-[420px] overflow-auto py-1">
              <button
                type="button"
                className={`w-full px-2 py-1.5 flex items-center gap-2 text-left hover:bg-[var(--taomni-hover)] ${scope.mode==="all"? "bg-[var(--taomni-hover)]":""}`}
                onClick={chooseAll}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">All Repositories</div>
                  <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{roots.length} repositories</div>
                </div>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${totalChanges? "bg-[var(--taomni-accent)] text-white":"bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"}`}>
                  {totalChanges}
                </span>
              </button>
              {groups.length===0? (
                <div className="px-3 py-3 text-[12px] text-[var(--taomni-text-muted)]">No repositories match</div>
              ):groups.map((group) => (
                <div key={group.key}>
                  {groups.length>1&&(
                    <div className="px-2 pt-2 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">
                      <FolderGit2 className="w-3 h-3" />
                      <span className="truncate">{group.name}</span>
                    </div>
                  )}
                  {group.rows.map(({ root,depth }) => {
                    const state=snapshots[root.repoRoot];
                    const snapshot=state?.snapshot??null;
                    const changes=snapshot?.changes.length??0;
                    const branch=snapshot?.detached? `detached ${snapshot.headOid??""}`:snapshot?.currentBranch??"No branch";
                    const checked=draftRoots.has(root.repoRoot);
                    const inScope=scopedRootSet.has(root.repoRoot);
                    return (
                      <div
                        key={root.repoRoot}
                        role="button"
                        tabIndex={0}
                        className={`w-full px-2 py-1.5 flex items-center gap-2 text-left cursor-pointer hover:bg-[var(--taomni-hover)] ${inScope? "bg-[var(--taomni-hover)]":""}`}
                        style={depth>0? { paddingLeft: `${8+depth*16}px` }:undefined}
                        title={root.repoRoot}
                        onClick={() => chooseSingle(root.repoRoot)}
                        onKeyDown={(event) => {
                          if(event.key==="Enter"||event.key===" ") {
                            event.preventDefault();
                            chooseSingle(root.repoRoot);
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          className="shrink-0 accent-[var(--taomni-accent)]"
                          checked={checked}
                          aria-label={`Include ${root.name}`}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => toggleDraftRoot(root.repoRoot,event.target.checked)}
                        />
                        <RepoStatusIcon loading={!!state?.loading} error={state?.error??null} changes={changes} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate text-[12px] font-medium">{root.name||gitRepoName(root.repoRoot)}</span>
                            {root.isSubmodule&&(
                              <span className="shrink-0 rounded border border-[var(--taomni-divider)] px-1 text-[9px] uppercase text-[var(--taomni-text-muted)]">
                                sub
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{branch}</div>
                        </div>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${changes? "bg-[var(--taomni-accent)] text-white":"bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"}`}>
                          {changes}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="h-9 flex items-center gap-2 px-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]">
                {draftRoots.size} selected
              </span>
              <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={closeMenu}>
                Cancel
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-2 text-[12px]"
                disabled={draftRoots.size===0}
                onClick={applyDraft}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


export function RepoStatusIcon({ loading,error,changes }: { loading: boolean; error: string|null; changes: number; }) {
  if(loading) return <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--taomni-accent)]" />;
  if(error) return <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" />;
  if(changes) return <Circle className="w-2.5 h-2.5 shrink-0 fill-current text-[var(--taomni-accent)]" />;
  return <Check className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />;
}
