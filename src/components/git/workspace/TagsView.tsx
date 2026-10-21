import { useMemo,useState } from "react";
import { ChevronDown,ChevronRight,Copy,Search,Tag } from "lucide-react";
import { gitCheckoutTag,gitDeleteTag,gitPushTag,selectedRemote } from "../../../lib/git";
import { notifyGitRepoChanged } from "../../../lib/gitRefresh";
import { confirmAppDialog } from "../../../lib/appDialogs";
import { writeText } from "../../../lib/clipboard";
import { formatRefDate,getRecentTagNames,loadTagCollapse,rememberRecentTag,saveTagCollapse,type TagSectionId } from "../../../lib/gitRefList";
import { useAppStore } from "../../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../../types";
import { ContextMenu,type MenuItem } from "../../ContextMenu";
import { type RepoSnapshotState,type WorkspaceTagRow,sortWorkspaceTagRows,workspaceTagMatchesQuery,workspaceTagRowKey } from "./model";
import { EmptyState } from "./controls";


export function WorkspaceTagsView({
  roots,
  snapshots,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string,RepoSnapshotState>;
}) {
  const setStatusMessage=useAppStore((s) => s.setStatusMessage);
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useState(loadTagCollapse);
  const [busy,setBusy]=useState(false);
  const [selectedKey,setSelectedKey]=useState<string|null>(null);
  const [ctx,setCtx]=useState<{ x: number; y: number; row: WorkspaceTagRow; }|null>(null);
  const [recentTick,setRecentTick]=useState(0);
  const normalizedQuery=query.trim().toLowerCase();
  const rows=useMemo(() => sortWorkspaceTagRows(
    roots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.tags??[])
        .filter((tag) => workspaceTagMatchesQuery(root,tag,normalizedQuery))
        .map((tag) => ({ root,tag }))
    )),
  ),[normalizedQuery,roots,snapshots]);
  const recent=useMemo(() => {
    void recentTick;
    const remembered: WorkspaceTagRow[]=[];
    const seen=new Set<string>();
    for(const root of roots) {
      for(const name of getRecentTagNames(root.repoRoot)) {
        const hit=rows.find((row) => row.root.repoRoot===root.repoRoot&&row.tag.name===name);
        if(!hit) continue;
        const key=workspaceTagRowKey(hit);
        if(seen.has(key)) continue;
        remembered.push(hit);
        seen.add(key);
      }
    }
    const filled=[...remembered];
    for(const row of rows) {
      if(filled.length>=12) break;
      const key=workspaceTagRowKey(row);
      if(seen.has(key)) continue;
      filled.push(row);
      seen.add(key);
    }
    return filled;
  },[recentTick,roots,rows]);
  const total=roots.reduce((count,root) => (
    count+(snapshots[root.repoRoot]?.snapshot?.tags.length??0)
  ),0);

  const toggleSection=(id: TagSectionId) => {
    setCollapsed((state) => {
      const next={ ...state,[id]: !state[id] };
      saveTagCollapse(next);
      return next;
    });
  };

  const runOnRow=async (label: string,row: WorkspaceTagRow,action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      rememberRecentTag(row.root.repoRoot,row.tag.name);
      setRecentTick((n) => n+1);
      notifyGitRepoChanged(row.root.repoRoot);
      setStatusMessage(`${label}: ${row.root.name} / ${row.tag.name}`);
    } catch(err) {
      setStatusMessage(err instanceof Error? err.message:String(err));
    } finally {
      setBusy(false);
    }
  };

  const tagMenuItems=(row: WorkspaceTagRow): MenuItem[] => {
    const { root,tag }=row;
    const remoteName=selectedRemote(snapshots[root.repoRoot]?.snapshot??null)?.name??"origin";
    return [
      {
        label: "Checkout",
        disabled: busy,
        onClick: () => void (async () => {
          const ok=await confirmAppDialog({
            title: "Checkout tag",
            message: `Checkout ${tag.name} in ${root.name}? This detaches HEAD.`,
          });
          if(!ok) return;
          await runOnRow("Checkout tag",row,() => gitCheckoutTag(root.repoRoot,tag.name));
        })(),
      },
      {
        label: "Push",
        disabled: busy,
        onClick: () => void runOnRow("Push tag",row,() => gitPushTag(root.repoRoot,remoteName,tag.name,false)),
      },
      {
        label: "Copy name",
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => void writeText(tag.name),
      },
      { label: "",separator: true },
      {
        label: "Delete…",
        danger: true,
        disabled: busy,
        onClick: () => void (async () => {
          const ok=await confirmAppDialog({
            title: "Delete tag",
            message: `Delete tag ${tag.name} in ${root.name}?`,
            danger: true,
            confirmLabel: "Delete",
          });
          if(!ok) return;
          await runOnRow("Delete tag",row,() => gitDeleteTag(root.repoRoot,tag.name));
        })(),
      },
    ];
  };

  const renderRow=(row: WorkspaceTagRow) => {
    const key=workspaceTagRowKey(row);
    const dateLabel=formatRefDate(row.tag.date);
    return (
      <button
        key={key}
        type="button"
        data-testid="workspace-git-tag-row"
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selectedKey===key? "bg-[var(--taomni-hover)]":""}`}
        title={`${row.root.repoRoot} · ${row.tag.name}`}
        onClick={() => setSelectedKey(key)}
        onContextMenu={(event) => {
          event.preventDefault();
          setSelectedKey(key);
          setCtx({ x: event.clientX,y: event.clientY,row });
        }}
      >
        <Tag className="w-4 h-4 shrink-0 text-[var(--taomni-text-muted)]" />
        <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
          {row.root.name}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{row.tag.name}</span>
            {dateLabel? <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{dateLabel}</span>:null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            <span className="taomni-mono text-[var(--taomni-accent)]">{row.tag.oid}</span>
            {row.tag.annotated? " · annotated":" · lightweight"}
            {row.tag.subject? ` · ${row.tag.subject}`:""}
          </div>
        </div>
      </button>
    );
  };

  const renderSection=(id: TagSectionId,label: string,list: WorkspaceTagRow[]) => {
    if(list.length===0) return null;
    const isCollapsed=collapsed[id];
    return (
      <section data-testid={`workspace-git-tag-section-${id}`} className="border-b border-[var(--taomni-divider)]">
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
    <div className="h-full min-h-0 flex flex-col" data-testid="workspace-git-tags-view">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-64 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            type="search"
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search tags"
            aria-label="Search tags"
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
          <EmptyState title="No tags" />
        ):rows.length===0? (
          <EmptyState title="No tags match" />
        ):(
          <>
            {renderSection("recent","Recent",recent)}
            {renderSection("all","All tags",rows)}
          </>
        )}
      </div>
      {ctx? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={tagMenuItems(ctx.row)}
        />
      ):null}
    </div>
  );
}
