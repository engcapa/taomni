import { useEffect,useMemo,useState,type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown,ChevronRight,Copy,GitFork,Plus,Search } from "lucide-react";
import { type GitBranch as GitBranchInfo,type GitSnapshot } from "../../../lib/git";
import { writeText } from "../../../lib/clipboard";
import {
  formatRefDate,
  getRecentBranchNames,
  loadBranchCollapse,
  pickRecentItems,
  rememberRecentBranch,
  saveBranchCollapse,
  sortByDateThenName,
  type BranchSectionId,
} from "../../../lib/gitRefList";
import { ContextMenu,type MenuItem } from "../../ContextMenu";
import { branchMatchesQuery } from "./model";
import { IconButton,EmptyState } from "./controls";


export function BranchesView({
  snapshot,
  selected,
  setSelected,
  busy,
  onCreate,
  onCheckout,
  onMerge,
  onDelete,
  onRename,
  onPush,
  onSetUpstream,
  onCompare,
}: {
  snapshot: GitSnapshot|null;
  selected: GitBranchInfo|null;
  setSelected: (branch: GitBranchInfo) => void;
  busy: boolean;
  onCreate: () => void;
  onCheckout: (branch: GitBranchInfo) => void;
  onMerge: (branch: GitBranchInfo) => void;
  onDelete: (branch: GitBranchInfo) => void;
  onRename: (branch: GitBranchInfo) => void;
  onPush: (branch: GitBranchInfo) => void;
  onSetUpstream: (branch: GitBranchInfo) => void;
  onCompare: (branch: GitBranchInfo) => void;
}) {
  const repoRoot=snapshot?.repoRoot??"";
  const branches=snapshot?.branches??[];
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useState(loadBranchCollapse);
  const [ctx,setCtx]=useState<{ x: number; y: number; branch: GitBranchInfo; }|null>(null);
  const [recentTick,setRecentTick]=useState(0);
  const normalizedQuery=query.trim().toLowerCase();
  const filteredBranches=useMemo(() => (
    sortByDateThenName(branches.filter((branch) => branchMatchesQuery(branch,normalizedQuery)))
  ),[branches,normalizedQuery]);
  const local=useMemo(() => sortByDateThenName(filteredBranches.filter((b) => !b.remote)),[filteredBranches]);
  const remote=useMemo(() => sortByDateThenName(filteredBranches.filter((b) => b.remote)),[filteredBranches]);
  const recent=useMemo(() => {
    void recentTick;
    return pickRecentItems(
      sortByDateThenName(filteredBranches),
      getRecentBranchNames(repoRoot),
    );
  },[filteredBranches,recentTick,repoRoot]);

  useEffect(() => {
    if(snapshot?.currentBranch) {
      rememberRecentBranch(repoRoot,snapshot.currentBranch);
      setRecentTick((n) => n+1);
    }
  },[repoRoot,snapshot?.currentBranch]);

  const toggleSection=(id: BranchSectionId) => {
    setCollapsed((current) => {
      const next={ ...current,[id]: !current[id] };
      saveBranchCollapse(next);
      return next;
    });
  };

  const openBranchMenu=(branch: GitBranchInfo,event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(branch);
    setCtx({ x: event.clientX,y: event.clientY,branch });
  };

  const branchMenuItems=(branch: GitBranchInfo): MenuItem[] => {
    const localSel=!branch.remote;
    return [
      {
        label: "Checkout",
        disabled: busy||branch.current,
        onClick: () => {
          setSelected(branch);
          onCheckout(branch);
        },
      },
      {
        label: "Merge into current",
        disabled: busy||branch.current||branch.remote,
        onClick: () => {
          setSelected(branch);
          onMerge(branch);
        },
      },
      {
        label: "Compare with current",
        disabled: busy||!snapshot?.currentBranch,
        onClick: () => {
          setSelected(branch);
          onCompare(branch);
        },
      },
      { label: "",separator: true },
      {
        label: "Rename…",
        disabled: busy||!localSel,
        onClick: () => {
          setSelected(branch);
          onRename(branch);
        },
      },
      {
        label: "Push",
        disabled: busy||!localSel,
        onClick: () => {
          setSelected(branch);
          onPush(branch);
        },
      },
      {
        label: "Set upstream…",
        disabled: busy||!localSel,
        onClick: () => {
          setSelected(branch);
          onSetUpstream(branch);
        },
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
        onClick: () => {
          setSelected(branch);
          onDelete(branch);
        },
      },
    ];
  };

  const renderBranchRow=(branch: GitBranchInfo) => {
    const dateLabel=formatRefDate(branch.date);
    return (
      <button
        key={branch.fullName}
        type="button"
        data-testid="git-branch-row"
        data-branch={branch.name}
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.fullName===branch.fullName? "bg-[var(--taomni-hover)]":""}`}
        onClick={() => setSelected(branch)}
        onDoubleClick={() => {
          if(!busy&&!branch.current) {
            setSelected(branch);
            onCheckout(branch);
          }
        }}
        onContextMenu={(event) => openBranchMenu(branch,event)}
      >
        <GitFork className={`w-4 h-4 shrink-0 ${branch.current? "text-[var(--taomni-accent)]":"text-[var(--taomni-text-muted)]"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{branch.name}</span>
            {dateLabel? (
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]" title={branch.date??undefined}>
                {dateLabel}
              </span>
            ):null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {branch.upstream? `tracks ${branch.upstream}`:branch.remote? "remote":"local"}
            {branch.subject? ` · ${branch.subject}`:""}
          </div>
        </div>
        {branch.current&&<span className="text-[11px] text-[var(--taomni-accent)] shrink-0">current</span>}
      </button>
    );
  };

  const renderSection=(
    id: BranchSectionId,
    label: string,
    list: GitBranchInfo[],
  ) => {
    if(list.length===0) return null;
    const isCollapsed=collapsed[id];
    return (
      <section data-testid={`git-branch-section-${id}`} className="border-b border-[var(--taomni-divider)]">
        <button
          type="button"
          className="w-full h-7 px-2 flex items-center gap-1.5 text-left bg-[var(--taomni-quick-bg)] hover:bg-[var(--taomni-hover)]"
          aria-expanded={!isCollapsed}
          onClick={() => toggleSection(id)}
        >
          {isCollapsed
            ? <ChevronRight className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            :<ChevronDown className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
            {label}
          </span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">({list.length})</span>
        </button>
        {isCollapsed? null:list.map(renderBranchRow)}
      </section>
    );
  };

  const localSel=!!selected&&!selected.remote;
  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="git-branches-view">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)] overflow-x-auto">
        <div className="relative w-56 min-w-40 shrink-0">
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
        <IconButton label="New" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onCreate} />
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!selected||selected.current} onClick={() => selected&&onCheckout(selected)}>Checkout</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!selected||selected.current||selected.remote} onClick={() => selected&&onMerge(selected)}>Merge</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!selected} onClick={() => selected&&onCompare(selected)}>Compare</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!localSel||!selected} onClick={() => selected&&onRename(selected)}>Rename</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!localSel||!selected} onClick={() => selected&&onPush(selected)}>Push</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!localSel||!selected} onClick={() => selected&&onSetUpstream(selected)}>Upstream</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy||!selected||selected.current||selected.remote} onClick={() => selected&&onDelete(selected)}>Delete</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {branches.length===0? <EmptyState title="No branches" />:filteredBranches.length===0? <EmptyState title="No branches match" />:(
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
          items={branchMenuItems(ctx.branch)}
        />
      ):null}
    </div>
  );
}
