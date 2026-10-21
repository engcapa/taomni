import { useMemo,useState,type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown,ChevronRight,Copy,Plus,Search,Tag } from "lucide-react";
import { type GitSnapshot,type GitTag } from "../../../lib/git";
import { writeText } from "../../../lib/clipboard";
import { formatRefDate,getRecentTagNames,loadTagCollapse,pickRecentItems,rememberRecentTag,saveTagCollapse,sortByDateThenName,type TagSectionId } from "../../../lib/gitRefList";
import { ContextMenu,type MenuItem } from "../../ContextMenu";
import { tagMatchesQuery } from "./model";
import { IconButton,EmptyState } from "./controls";


export function TagsView({
  snapshot,
  busy,
  hasRemote,
  onCreate,
  onCheckout,
  onDelete,
  onPush,
}: {
  snapshot: GitSnapshot|null;
  busy: boolean;
  hasRemote: boolean;
  onCreate: () => void;
  onCheckout: (tag: GitTag) => void;
  onDelete: (tag: GitTag) => void;
  onPush: (tag: GitTag) => void;
}) {
  const repoRoot=snapshot?.repoRoot??"";
  const tags=snapshot?.tags??[];
  const [selected,setSelected]=useState<string|null>(null);
  const [query,setQuery]=useState("");
  const [collapsed,setCollapsed]=useState(loadTagCollapse);
  const [ctx,setCtx]=useState<{ x: number; y: number; tag: GitTag; }|null>(null);
  const [recentTick,setRecentTick]=useState(0);
  const normalizedQuery=query.trim().toLowerCase();
  const filteredTags=useMemo(() => (
    sortByDateThenName(tags.filter((tag) => tagMatchesQuery(tag,normalizedQuery)))
  ),[tags,normalizedQuery]);
  const recent=useMemo(() => {
    void recentTick;
    return pickRecentItems(filteredTags,getRecentTagNames(repoRoot));
  },[filteredTags,recentTick,repoRoot]);
  const current=tags.find((t) => t.name===selected)??null;

  const toggleSection=(id: TagSectionId) => {
    setCollapsed((state) => {
      const next={ ...state,[id]: !state[id] };
      saveTagCollapse(next);
      return next;
    });
  };

  const openTagMenu=(tag: GitTag,event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(tag.name);
    setCtx({ x: event.clientX,y: event.clientY,tag });
  };

  const tagMenuItems=(tag: GitTag): MenuItem[] => [
    {
      label: "Checkout",
      disabled: busy,
      onClick: () => {
        rememberRecentTag(repoRoot,tag.name);
        setRecentTick((n) => n+1);
        onCheckout(tag);
      },
    },
    {
      label: "Push",
      disabled: busy||!hasRemote,
      onClick: () => onPush(tag),
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
      onClick: () => onDelete(tag),
    },
  ];

  const renderTagRow=(tag: GitTag) => {
    const dateLabel=formatRefDate(tag.date);
    return (
      <button
        key={tag.name}
        type="button"
        data-testid="git-tag-row"
        data-tag={tag.name}
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected===tag.name? "bg-[var(--taomni-hover)]":""}`}
        onClick={() => setSelected(tag.name)}
        onDoubleClick={() => {
          if(!busy) {
            rememberRecentTag(repoRoot,tag.name);
            setRecentTick((n) => n+1);
            onCheckout(tag);
          }
        }}
        onContextMenu={(event) => openTagMenu(tag,event)}
      >
        <Tag className="w-4 h-4 shrink-0 text-[var(--taomni-text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] truncate font-medium">{tag.name}</span>
            {dateLabel? (
              <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]" title={tag.date??undefined}>
                {dateLabel}
              </span>
            ):null}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            <span className="taomni-mono text-[var(--taomni-accent)]">{tag.oid}</span>
            {tag.annotated? " · annotated":" · lightweight"}{tag.subject? ` · ${tag.subject}`:""}
          </div>
        </div>
      </button>
    );
  };

  const renderSection=(id: TagSectionId,label: string,list: GitTag[]) => {
    if(list.length===0) return null;
    const isCollapsed=collapsed[id];
    return (
      <section data-testid={`git-tag-section-${id}`} className="border-b border-[var(--taomni-divider)]">
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
        {isCollapsed? null:list.map(renderTagRow)}
      </section>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="git-tags-view">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-56 min-w-40 shrink-0">
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
        <IconButton label="New tag" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onCreate} />
        <button
          className="taomni-btn h-7 px-2"
          type="button"
          disabled={busy||!current}
          onClick={() => {
            if(!current) return;
            rememberRecentTag(repoRoot,current.name);
            setRecentTick((n) => n+1);
            onCheckout(current);
          }}
        >
          Checkout
        </button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy||!current||!hasRemote} onClick={() => current&&onPush(current)}>Push</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy||!current} onClick={() => current&&onDelete(current)}>Delete</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tags.length===0? <EmptyState title="No tags" />:filteredTags.length===0? <EmptyState title="No tags match" />:(
          <>
            {renderSection("recent","Recent",recent)}
            {renderSection("all","All tags",filteredTags)}
          </>
        )}
      </div>
      {ctx? (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={tagMenuItems(ctx.tag)}
        />
      ):null}
    </div>
  );
}
