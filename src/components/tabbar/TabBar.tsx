import {
  Plus,
  X,
  Terminal as TerminalIcon,
  Folder,
  Monitor,
  Network as NetworkIcon,
  PanelTopClose,
  PanelTopOpen,
  SplitSquareVertical,
  Users,
  MoreHorizontal,
  Copy,
  Trash2,
  FileText,
  Pencil,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu } from "../ContextMenu";
import {
  startCustomDrag,
  useCustomDropTarget,
  type CustomDragData,
} from "../../lib/customDnD";
import type { Tab, TabKind } from "../../types";

type DropIndicator = { tabId: string; side: "before" | "after" } | null;

const TAB_DRAG_MIME = "newmob/tab";

export function TabBar() {
  const {
    tabs,
    activeTabId,
    compactMode,
    setActiveTab,
    removeTab,
    removeTabs,
    addTab,
    moveTab,
    moveTabToIndex,
    updateTabTitle,
    toggleCompactMode,
    multiExecActive,
    multiExecSelectedTabIds,
    terminalSplitActive,
    toggleMultiExec,
    toggleMultiExecTab,
    toggleTerminalSplit,
  } = useAppStore();
  const ctx = useContextMenu();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  useEffect(() => {
    if (editingTabId && !tabs.some((t) => t.id === editingTabId)) {
      setEditingTabId(null);
      setDraftTitle("");
    }
  }, [tabs, editingTabId]);

  const startRename = (tab: Tab) => {
    if (!tab.closable) return;
    setActiveTab(tab.id);
    setEditingTabId(tab.id);
    setDraftTitle(tab.title);
  };

  const commitRename = () => {
    if (!editingTabId) return;
    const next = draftTitle.trim();
    const target = tabs.find((t) => t.id === editingTabId);
    if (next && target && next !== target.title) {
      updateTabTitle(editingTabId, next);
    }
    setEditingTabId(null);
    setDraftTitle("");
  };

  const cancelRename = () => {
    setEditingTabId(null);
    setDraftTitle("");
  };

  const handleNewTab = () => {
    const id = `terminal-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: `Terminal ${tabs.length}`,
      closable: true,
    });
  };

  const handleMouseDown = (e: React.MouseEvent, tab: Tab) => {
    if (e.button === 1 && tab.closable) {
      e.preventDefault();
      removeTab(tab.id);
    }
  };

  const handleTabContext = (e: React.MouseEvent, tab: Tab) => {
    const idx = tabs.findIndex((t) => t.id === tab.id);
    const isFirst = idx === 0;
    const isLast = idx === tabs.length - 1;
    ctx.show(e, [
      { label: "Close", icon: <X className="w-3 h-3" />, onClick: () => removeTab(tab.id), disabled: !tab.closable },
      { label: "Close others", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.id !== tab.id && t.closable).map((t) => t.id)) },
      { label: "Close all", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.closable).map((t) => t.id)) },
      { label: "", separator: true, onClick: () => {} },
      { label: "Rename tab", icon: <Pencil className="w-3 h-3" />, onClick: () => startRename(tab), disabled: !tab.closable },
      { label: "Duplicate tab", icon: <Copy className="w-3 h-3" />, onClick: () => {
        addTab({ ...tab, id: `dup-${Date.now()}`, closable: true });
      }, disabled: tab.type === "welcome" },
      { label: "", separator: true, onClick: () => {} },
      { label: "Move to first", icon: <ChevronFirst className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, 0), disabled: isFirst },
      { label: "Move left", icon: <ChevronLeft className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, idx - 1), disabled: isFirst },
      { label: "Move right", icon: <ChevronRight className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, idx + 1), disabled: isLast },
      { label: "Move to last", icon: <ChevronLast className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, tabs.length - 1), disabled: isLast },
    ]);
  };

  const handleMore = (event: React.MouseEvent) => {
    ctx.show(event, [
      {
        label: compactMode ? "Exit compact mode" : "Enter compact mode",
        icon: compactMode ? <PanelTopOpen className="w-3 h-3" /> : <PanelTopClose className="w-3 h-3" />,
        shortcut: "Ctrl+Shift+M",
        onClick: toggleCompactMode,
      },
      { label: "", separator: true, onClick: () => {} },
      { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: handleNewTab },
      { label: "Close all terminals", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.type === "terminal" && t.closable).map((t) => t.id)) },
    ]);
  };

  const computeDropSide = (rect: DOMRect, clientX: number): "before" | "after" => {
    return clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const clearDragState = () => {
    setDraggedId(null);
    setDropIndicator(null);
  };

  const handleTabPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    tab: Tab,
    el: HTMLDivElement,
  ) => {
    if (editingTabId === tab.id) return;
    if (e.button !== 0) return;
    e.preventDefault();
    startCustomDrag({
      event: e,
      data: { mime: TAB_DRAG_MIME, payload: { tabId: tab.id } },
      ghostText: tab.title,
      ghostElement: el,
      onActivate: () => {
        setDraggedId(tab.id);
        document.body.style.userSelect = "none";
      },
      onEnd: () => {
        clearDragState();
        document.body.style.userSelect = "";
      },
    });
  };

  return (
    <div
      data-testid="tab-bar"
      data-compact={compactMode}
      className="moba-tabbar h-8 flex items-end pl-2 pr-1 pt-1.5 gap-0"
      style={{ background: "linear-gradient(to bottom, var(--moba-tab-inactive), var(--moba-chrome-bg))" }}
    >
      {ctx.render}
      {tabs.map((tab) => {
        const isSelected = multiExecActive && tab.type === "terminal" && multiExecSelectedTabIds.has(tab.id);
        const dropSide = dropIndicator && dropIndicator.tabId === tab.id ? dropIndicator.side : undefined;
        return (
          <TabItem
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            multiExecSelected={!!isSelected}
            multiExecActive={multiExecActive}
            dragging={draggedId === tab.id}
            draggedId={draggedId}
            dropSide={dropSide}
            editing={editingTabId === tab.id}
            draftTitle={draftTitle}
            onStartDrag={handleTabPointerDown}
            onDragOverTab={(t, rect, clientX) => {
              if (!draggedId || draggedId === t.id) {
                setDropIndicator(null);
                return;
              }
              const side = computeDropSide(rect, clientX);
              setDropIndicator((prev) => {
                if (prev && prev.tabId === t.id && prev.side === side) return prev;
                return { tabId: t.id, side };
              });
            }}
            onDragLeaveTab={(t) =>
              setDropIndicator((prev) => (prev && prev.tabId === t.id ? null : prev))
            }
            onDropOnTab={(t, rect, clientX) => {
              if (!draggedId) return;
              const side = computeDropSide(rect, clientX);
              if (draggedId !== t.id) {
                moveTab(draggedId, t.id, side);
              }
              clearDragState();
            }}
            onActivate={(t) => {
              if (editingTabId === t.id) return;
              setActiveTab(t.id);
            }}
            onMouseDown={handleMouseDown}
            onContextMenu={handleTabContext}
            onDraftTitleChange={setDraftTitle}
            onCommitRename={commitRename}
            onCancelRename={cancelRename}
            onStartRename={startRename}
            onToggleMultiExecTab={toggleMultiExecTab}
            onRemove={removeTab}
          />
        );
      })}

      <button
        data-testid="new-local-terminal"
        className="moba-tab"
        data-active={false}
        onClick={handleNewTab}
        title="New tab"
      >
        <Plus className="w-3 h-3" />
      </button>

      <div className="flex-1 self-stretch" data-window-drag />
      <div className="flex items-center gap-1 pr-1 pb-0.5">
        {!compactMode && (
          <>
            <IconBtn
              testId="tab-split-view"
              title={terminalSplitActive ? "Disable terminal split view" : "Enable terminal split view"}
              icon={<SplitSquareVertical className="w-3.5 h-3.5" />}
              onClick={toggleTerminalSplit}
              active={terminalSplitActive}
            />
            <IconBtn
              testId="tab-multiexec-toggle"
              title={multiExecActive ? "Disable MultiExec" : "Enable MultiExec"}
              icon={<Users className="w-3.5 h-3.5" />}
              onClick={toggleMultiExec}
              active={multiExecActive}
            />
          </>
        )}
        <IconBtn testId="tab-more" title="More" icon={<MoreHorizontal className="w-3.5 h-3.5" />} onClick={handleMore} />
      </div>
    </div>
  );
}

function TabIcon({ kind, ssh }: { kind: TabKind; ssh?: boolean }) {
  if (kind === "terminal" && ssh) {
    return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
  switch (kind) {
    case "terminal":
      return <TerminalIcon className="w-3 h-3" style={{ color: "#62d36f" }} />;
    case "sftp":
      return <Folder className="w-3 h-3" style={{ color: "#3b7ac2" }} />;
    case "rdp":
    case "vnc":
      return <Monitor className="w-3 h-3" style={{ color: "#a04b9c" }} />;
    case "nettools":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#236a98" }} />;
    case "file-browser":
      return <FileText className="w-3 h-3" style={{ color: "var(--moba-text-muted)" }} />;
    default:
      return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
}

function IconBtn({
  icon,
  title,
  onClick,
  disabled,
  active,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      aria-label={title}
      data-active={active || undefined}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-40 disabled:cursor-default"
      style={active ? { background: "var(--moba-selected)", color: "var(--moba-accent)" } : undefined}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon}
    </button>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  multiExecActive: boolean;
  multiExecSelected: boolean;
  dragging: boolean;
  draggedId: string | null;
  dropSide: "before" | "after" | undefined;
  editing: boolean;
  draftTitle: string;
  onStartDrag: (e: React.PointerEvent<HTMLDivElement>, tab: Tab, el: HTMLDivElement) => void;
  onDragOverTab: (tab: Tab, rect: DOMRect, clientX: number) => void;
  onDragLeaveTab: (tab: Tab) => void;
  onDropOnTab: (tab: Tab, rect: DOMRect, clientX: number) => void;
  onActivate: (tab: Tab) => void;
  onMouseDown: (e: React.MouseEvent, tab: Tab) => void;
  onContextMenu: (e: React.MouseEvent, tab: Tab) => void;
  onDraftTitleChange: (next: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (tab: Tab) => void;
  onToggleMultiExecTab: (id: string) => void;
  onRemove: (id: string) => void;
}

function TabItem(props: TabItemProps) {
  const {
    tab,
    active,
    multiExecActive,
    multiExecSelected,
    dragging,
    draggedId,
    dropSide,
    editing,
    draftTitle,
    onStartDrag,
    onDragOverTab,
    onDragLeaveTab,
    onDropOnTab,
    onActivate,
    onMouseDown,
    onContextMenu,
    onDraftTitleChange,
    onCommitRename,
    onCancelRename,
    onStartRename,
    onToggleMultiExecTab,
    onRemove,
  } = props;

  const ref = useRef<HTMLDivElement>(null);

  useCustomDropTarget<HTMLDivElement>(ref, {
    accepts: (data: CustomDragData) => data.mime === TAB_DRAG_MIME && draggedId !== null,
    onDragOver: (detail) => {
      const el = ref.current;
      if (!el) return;
      onDragOverTab(tab, el.getBoundingClientRect(), detail.clientX);
    },
    onDragLeave: () => onDragLeaveTab(tab),
    onDrop: (detail) => {
      const el = ref.current;
      if (!el) return;
      onDropOnTab(tab, el.getBoundingClientRect(), detail.clientX);
    },
  });

  return (
    <div
      ref={ref}
      data-testid="tab-item"
      data-tab-id={tab.id}
      data-tab-title={tab.title}
      data-tab-type={tab.type}
      data-multiexec-selected={multiExecSelected || undefined}
      data-dragging={dragging || undefined}
      data-drop-side={dropSide}
      className="moba-tab relative"
      data-active={active}
      onClick={() => onActivate(tab)}
      onMouseDown={(e) => {
        if (editing) return;
        onMouseDown(e, tab);
      }}
      onPointerDown={(e) => {
        if (editing) return;
        const el = ref.current;
        if (!el) return;
        onStartDrag(e, tab, el);
      }}
      onContextMenu={(e) => onContextMenu(e, tab)}
    >
      {multiExecActive && tab.type === "terminal" && (
        <button
          type="button"
          title={multiExecSelected ? "Remove from MultiExec" : "Add to MultiExec"}
          className="absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border flex items-center justify-center z-10 flex-shrink-0"
          style={{
            background: multiExecSelected ? "var(--moba-accent)" : "var(--moba-chrome-bg)",
            borderColor: multiExecSelected ? "var(--moba-accent)" : "var(--moba-divider)",
            fontSize: 7,
            color: multiExecSelected ? "#fff" : "var(--moba-text-muted)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMultiExecTab(tab.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {multiExecSelected ? "✓" : ""}
        </button>
      )}
      <div className="relative flex-shrink-0">
        <TabIcon kind={tab.type} ssh={!!tab.ssh} />
        {tab.hasNewOutput && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 pointer-events-none"
            aria-label="New output"
          />
        )}
      </div>
      <span
        data-testid="tab-title"
        className="truncate max-w-[180px]"
        onDoubleClick={(e) => {
          e.stopPropagation();
          onStartRename(tab);
        }}
      >
        {editing ? (
          <input
            data-testid="tab-title-input"
            autoFocus
            type="text"
            value={draftTitle}
            onChange={(e) => onDraftTitleChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
              e.stopPropagation();
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={onCommitRename}
            className="bg-transparent border-b border-[var(--moba-accent)] outline-none text-[12px] leading-none w-[160px] px-0"
            style={{ color: "inherit", font: "inherit" }}
          />
        ) : (
          tab.title
        )}
      </span>
      {tab.closable && (
        <X
          className="w-3 h-3 ml-1 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tab.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
