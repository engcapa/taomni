import { useMemo,useState } from "react";
import { ChevronDown,ChevronRight,Copy,GitFork,Search } from "lucide-react";
import { gitCheckoutBranch,gitCreateBranch,gitDeleteBranch,gitMergeBranch,gitPush,selectedRemote } from "../../../lib/git";
import { notifyGitRepoChanged } from "../../../lib/gitRefresh";
import { confirmAppDialog,promptAppDialog } from "../../../lib/appDialogs";
import { writeText } from "../../../lib/clipboard";
import { formatRefDate,getRecentBranchNames,loadBranchCollapse,rememberRecentBranch,saveBranchCollapse,type BranchSectionId } from "../../../lib/gitRefList";
import { useAppStore } from "../../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../../types";
import { ContextMenu,type MenuItem } from "../../ContextMenu";
import { type RepoSnapshotState,type WorkspaceBranchRow,sortWorkspaceBranchRows,workspaceBranchMatchesQuery,workspaceBranchRowKey } from "./model";
import { EmptyState } from "./controls";


export function WorkspaceBranchesView({
  roots,
  snapshots,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string,RepoSnapshotState>;
}) {
  const setStatusMessage=useAppStore((s) => s.setStatusMessage);
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useState(loadBranchCollapse);
  const [busy,setBusy]=useState(false);
  const [selectedKey,setSelectedKey]=useState<string|null>(null);
  const [ctx,setCtx]=useState<{ x: number; y: number; row: WorkspaceBranchRow; }|null>(null);
  const [recentTick,setRecentTick]=useState(0);
  const normalizedQuery=query.trim().toLowerCase();
  const rows=useMemo(() => sortWorkspaceBranchRows(
    roots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.branches??[])
        .filter((branch) => workspaceBranchMatchesQuery(root,branch,normalizedQuery))
        .map((branch) => ({ root,branch }))
    )),
  ),[normalizedQuery,roots,snapshots]);
  const local=useMemo(() => rows.filter((row) => !row.branch.remote),[rows]);
  const remote=useMemo(() => rows.filter((row) => row.branch.remote),[rows]);
  const recent=useMemo(() => {
    void recentTick;
    const remembered: WorkspaceBranchRow[]=[];
    const seen=new Set<string>();
    for(const root of roots) {
      for(const name of getRecentBranchNames(root.repoRoot)) {
        const hit=rows.find((row) => row.root.repoRoot===root.repoRoot&&row.branch.name===name);
        if(!hit) continue;
        const key=workspaceBranchRowKey(hit);
        if(seen.has(key)) continue;
        remembered.push(hit);
        seen.add(key);
      }
    }
    // Fill from date-sorted rows for remaining slots.
    const filled=[...remembered];
    for(const row of rows) {
      if(filled.length>=12) break;
      const key=workspaceBranchRowKey(row);
      if(seen.has(key)) continue;
      filled.push(row);
      seen.add(key);
    }
    return filled;
  },[recentTick,roots,rows]);
  const total=roots.reduce((count,root) => (
    count+(snapshots[root.repoRoot]?.snapshot?.branches.length??0)
  ),0);

  const toggleSection=(id: BranchSectionId) => {
    setCollapsed((current) => {
      const next={ ...current,[id]: !current[id] };
      saveBranchCollapse(next);
      return next;
    });
  };

  const runOnRow=async (label: string,row: WorkspaceBranchRow,action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      rememberRecentBranch(row.root.repoRoot,row.branch.remote
        ? row.branch.name.split("/").slice(1).join("/")||row.branch.name
        :row.branch.name);
      setRecentTick((n) => n+1);
      notifyGitRepoChanged(row.root.repoRoot);
      setStatusMessage(`${label}: ${row.root.name} / ${row.branch.name}`);
    } catch(err) {
      setStatusMessage(err instanceof Error? err.message:String(err));
    } finally {
      setBusy(false);
    }
  };

  const branchMenuItems=(row: WorkspaceBranchRow): MenuItem[] => {
    const { root,branch }=row;
    const localSel=!branch.remote;
    return [
      {
        label: "Checkout",
        disabled: busy||branch.current,
        onClick: () => void runOnRow("Checkout",row,async () => {
          if(branch.remote) {
            const suggested=branch.name.split("/").slice(1).join("/")||branch.name;
            const localName=await promptAppDialog({
              title: "Checkout remote branch",
              label: `Local branch name (${root.name})`,
              initialValue: suggested,
            });
            if(!localName) return;
            await gitCreateBranch(root.repoRoot,localName,branch.name,true);
            rememberRecentBranch(root.repoRoot,localName);
          } else {
            await gitCheckoutBranch(root.repoRoot,branch.name);
            rememberRecentBranch(root.repoRoot,branch.name);
          }
        }),
      },
      {
        label: "Merge into current",
        disabled: busy||branch.current||branch.remote,
        onClick: () => void (async () => {
          const ok=await confirmAppDialog({
            title: "Merge branch",
            message: `Merge ${branch.name} into current branch in ${root.name}?`,
          });
          if(!ok) return;
          await runOnRow("Merge",row,() => gitMergeBranch(root.repoRoot,branch.name));
        })(),
      },
      {
        label: "Push",
        disabled: busy||!localSel,
        onClick: () => void runOnRow("Push",row,async () => {
          const remoteName=selectedRemote(snapshots[root.repoRoot]?.snapshot??null)?.name??"origin";
          await gitPush(root.repoRoot,remoteName,branch.name,!branch.upstream);
        }),
      },
      {
        label: "Copy name",
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => void writeText(branch.name),
      },
      { label: "",separator: true },
      {
        label: "Delete…",
        danger: true,
        disabled: busy||branch.current||branch.remote,
        onClick: () => void (async () => {
          const ok=await confirmAppDialog({
            title: "Delete branch",
            message: `Delete local branch ${branch.name} in ${root.name}?`,
            danger: true,
            confirmLabel: "Delete",
          });
          if(!ok) return;
          await runOnRow("Delete",row,() => gitDeleteBranch(root.repoRoot,branch.name,false));
        })(),
      },
    ];
  };

  const renderRow=(row: WorkspaceBranchRow) => {
    const key=workspaceBranchRowKey(row);
    const dateLabel=formatRefDate(row.branch.date);
    return (
      <button
        key={key}
        type="button"
        data-testid="workspace-git-branch-row"
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selectedKey===key? "bg-[var(--taomni-hover)]":""}`}
        title={`${row.root.repoRoot} · ${row.branch.fullName}`}
        onClick={() => setSelectedKey(key)}
        onContextMenu={(event) => {
          event.preventDefault();
          setSelectedKey(key);
          setCtx({ x: event.clientX,y: event.clientY,row });
        }}
      >
        <GitFork className={`w-4 h-4 shrink-0 ${row.branch.current? "text-[var(--taomni-accent)]":"text-[var(--taomni-text-muted)]"}`} />
        <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
          {row.root.name}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{row.branch.name}</span>
            {dateLabel? <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{dateLabel}</span>:null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {row.branch.upstream? `tracks ${row.branch.upstream}`:row.branch.remote? "remote":"local"}
            {row.branch.subject? ` · ${row.branch.subject}`:""}
          </div>
        </div>
        {row.branch.current&&<span className="text-[11px] text-[var(--taomni-accent)] shrink-0">current</span>}
      </button>
    );
  };

  const renderSection=(id: BranchSectionId,label: string,list: WorkspaceBranchRow[]) => {
    if(list.length===0) return null;
    const isCollapsed=collapsed[id];
    return (
      <section data-testid={`workspace-git-branch-section-${id}`} className="border-b border-[var(--taomni-divider)]">
        <button
          type="button"
          className="w-full h-7 px-2 flex items-center gap-1.5 text-left bg-[var(--taomni-quick-bg)] hover:bg-[var(--taomni-hover)]"
          aria-expanded={!isCollapsed}
          onClick={() => toggleSection(id)}
        >
          {isCollapsed
            ? <ChevronRight className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            :<ChevronDown className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">({list.length})</span>
        </button>
        {isCollapsed? null:list.map(renderRow)}
      </section>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="workspace-git-branches-view">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-64 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search branches"
            aria-label="Search branches"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">
          {roots.length} repositories
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {total===0? (
          <EmptyState title="No branches" />
        ):rows.length===0? (
          <EmptyState title="No branches match" />
        ):(
          <>
            {renderSection("recent","Recent",recent)}
            {renderSection("local","Local",local)}
            {renderSection("remote","Remote",remote)}
          </>
        )}
      </div>
      {ctx? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={branchMenuItems(ctx.row)}
        />
      ):null}
    </div>
  );
}
