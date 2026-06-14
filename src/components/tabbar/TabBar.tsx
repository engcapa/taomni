import {
  Plus,
  X,
  Terminal as TerminalIcon,
  Folder,
  Monitor,
  Network as NetworkIcon,
  MoreHorizontal,
  Search,
  Copy,
  Trash2,
  FileText,
  Pencil,
  Database as DatabaseIcon,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Server,
  History,
  FilePlus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import {
  startCustomDrag,
  useCustomDropTarget,
  type CustomDragData,
} from "../../lib/customDnD";
import type { Tab, LocalShellSelection } from "../../types";
import { useT, type TranslateFn } from "../../lib/i18n";
import {
  listLocalShells,
  listWslDistros,
  type LocalShellOption,
  type SessionConfig,
} from "../../lib/ipc";
import { getAppPlatform } from "../../lib/runtime";
import { OpenTabsMenu } from "./OpenTabsMenu";
import { filterVisibleTabs, getFilterChipText } from "../../lib/tabFilter";

type DropIndicator = { tabId: string; side: "before" | "after" } | null;
type TabScrollState = { overflow: boolean; atStart: boolean; atEnd: boolean };

const TAB_DRAG_MIME = "taomni/tab";
const TAB_SCROLL_EDGE_TOLERANCE = 1;
const TAB_SCROLL_PADDING = 8;
const TAB_SCROLL_STEP_MIN = 160;

function maxScrollLeft(el: HTMLElement): number {
  return Math.max(0, el.scrollWidth - el.clientWidth);
}

function setTabScrollLeft(el: HTMLElement, left: number) {
  const next = Math.max(0, Math.min(left, maxScrollLeft(el)));
  el.scrollLeft = next;
  if (typeof el.scrollTo === "function") {
    try {
      el.scrollTo({ left: next });
    } catch {
      // The assigned scrollLeft above is enough for older WebViews and tests.
    }
  }
}

interface TabBarProps {
  onStartLocalTerminal: (localShell?: LocalShellSelection) => void;
  onConnectSession: (session: SessionConfig) => void;
  onOpenSessionEditor: () => void;
  /**
   * Optional override for the "Duplicate tab" action. MainLayout supplies this
   * so a duplicated local/SSH terminal can first resolve the source terminal's
   * current directory and open the copy there. Falls back to the plain store
   * action (no cwd handling) when not provided.
   */
  onDuplicateTab?: (id: string) => void;
}

export function TabBar({
  onStartLocalTerminal,
  onConnectSession,
  onOpenSessionEditor,
  onDuplicateTab,
}: TabBarProps) {
  const {
    tabs,
    activeTabId,
    compactMode,
    setActiveTab,
    removeTab,
    removeTabs,
    duplicateTab,
    moveTab,
    moveTabToIndex,
    updateTabTitle,
    tabFilter,
    setTabFilter,
    multiExecActive,
    multiExecSelectedTabIds,
    toggleMultiExecTab,
  } = useAppStore();
  const sessions = useSessionStore((s) => s.sessions);
  const ctx = useContextMenu();
  const t = useT();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string; isDefault: boolean }[]>([]);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const tabElementRefs = useRef(new Map<string, HTMLDivElement>());
  const [tabScrollState, setTabScrollState] = useState<TabScrollState>({
    overflow: false,
    atStart: true,
    atEnd: true,
  });

  const setTabElement = useCallback((tabId: string, node: HTMLDivElement | null) => {
    if (node) {
      tabElementRefs.current.set(tabId, node);
    } else {
      tabElementRefs.current.delete(tabId);
    }
  }, []);

  const updateTabScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const maxLeft = maxScrollLeft(el);
    const next: TabScrollState = {
      overflow: maxLeft > TAB_SCROLL_EDGE_TOLERANCE,
      atStart: el.scrollLeft <= TAB_SCROLL_EDGE_TOLERANCE,
      atEnd: el.scrollLeft >= maxLeft - TAB_SCROLL_EDGE_TOLERANCE,
    };
    setTabScrollState((prev) =>
      prev.overflow === next.overflow &&
      prev.atStart === next.atStart &&
      prev.atEnd === next.atEnd
        ? prev
        : next,
    );
  }, []);

  const scrollTabsBy = useCallback(
    (direction: "left" | "right") => {
      const el = tabScrollRef.current;
      if (!el) return;
      const delta = Math.max(TAB_SCROLL_STEP_MIN, Math.floor(el.clientWidth * 0.8));
      setTabScrollLeft(el, el.scrollLeft + (direction === "right" ? delta : -delta));
      updateTabScrollState();
    },
    [updateTabScrollState],
  );

  useEffect(() => {
    let cancelled = false;
    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        setLocalShells(shells);
        setShellsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setShellsLoaded(true);
      });
    if (getAppPlatform() === "windows") {
      listWslDistros()
        .then((distros) => {
          if (cancelled) return;
          setWslDistros(distros.map((d) => ({ name: d.name, isDefault: d.isDefault })));
        })
        .catch(() => {
          /* WSL unavailable — ignore */
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    updateTabScrollState();
  }, [tabs, updateTabScrollState]);

  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    updateTabScrollState();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => updateTabScrollState());
    resizeObserver?.observe(el);
    window.addEventListener("resize", updateTabScrollState);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateTabScrollState);
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    const container = tabScrollRef.current;
    const activeEl = activeTabId ? tabElementRefs.current.get(activeTabId) : null;
    if (!container || !activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const tabLeft = activeRect.left - containerRect.left + container.scrollLeft;
    const tabRight = activeRect.right - containerRect.left + container.scrollLeft;
    const visibleLeft = container.scrollLeft;
    const visibleRight = visibleLeft + container.clientWidth;

    if (tabLeft < visibleLeft + TAB_SCROLL_PADDING) {
      setTabScrollLeft(container, tabLeft - TAB_SCROLL_PADDING);
    } else if (tabRight > visibleRight - TAB_SCROLL_PADDING) {
      setTabScrollLeft(container, tabRight - container.clientWidth + TAB_SCROLL_PADDING);
    }
    updateTabScrollState();
  }, [activeTabId, tabs, updateTabScrollState]);

  const mergedShells = useMemo<LocalShellOption[]>(() => {
    if (wslDistros.length === 0) return localShells;
    const virtual: LocalShellOption[] = wslDistros.map((d) => ({
      id: `wsl:${d.name}`,
      name: `WSL: ${d.name}`,
      path: "wsl.exe",
      args: ["-d", d.name],
      isDefault: false,
      canElevate: true,
    }));
    return [...localShells, ...virtual];
  }, [localShells, wslDistros]);

  const recentSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.last_connected_at)
        .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0))
        .slice(0, 10),
    [sessions],
  );

  // Tabs actually rendered in the strip. The focus filter (issue #121) hides
  // non-matching tabs here without closing them; the `…` menu still lists all.
  const visibleTabs = useMemo(
    () => filterVisibleTabs(tabs, sessions, tabFilter),
    [tabs, sessions, tabFilter],
  );

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

  const shellSelectionFor = (shell: LocalShellOption): LocalShellSelection => ({
    id: shell.path,
    name: shell.name,
    ...(shell.args && shell.args.length > 0 ? { args: shell.args } : {}),
  });

  const handleQuickLaunch = () => {
    if (!shellsLoaded || mergedShells.length === 0) {
      onStartLocalTerminal();
      return;
    }
    const shell = mergedShells.find((s) => s.isDefault) ?? mergedShells[0];
    onStartLocalTerminal(shellSelectionFor(shell));
  };

  const handleOpenLaunchMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();

    const shellItems: MenuItem[] = mergedShells.length > 0
      ? mergedShells.map((shell) => ({
          label: shell.name,
          testId: `launch-menu-shell-${shell.id}`,
          icon: <TerminalIcon className="w-3 h-3" />,
          checked: shell.isDefault,
          onClick: () => onStartLocalTerminal(shellSelectionFor(shell)),
        }))
      : [
          {
            label: t("tabs.shellsLoading"),
            disabled: true,
            onClick: () => {},
          },
        ];

    const recentChildren: MenuItem[] = recentSessions.length > 0
      ? recentSessions.map((s) => ({
          label: s.name || `${s.username ?? "user"}@${s.host}`,
          testId: `launch-menu-recent-${s.id}`,
          icon: <Server className="w-3 h-3" />,
          onClick: () => onConnectSession(s),
        }))
      : [
          {
            label: t("tabs.recentSessionsEmpty"),
            disabled: true,
            onClick: () => {},
          },
        ];

    const items: MenuItem[] = [
      ...shellItems,
      { label: "", separator: true, onClick: () => {} },
      {
        label: t("tabs.recentSessions"),
        icon: <History className="w-3 h-3" />,
        children: recentChildren,
      },
      { label: "", separator: true, onClick: () => {} },
      {
        label: t("tabs.newSession"),
        testId: "launch-menu-new-session",
        icon: <FilePlus className="w-3 h-3" />,
        onClick: onOpenSessionEditor,
      },
    ];

    ctx.showAt(rect.left, rect.bottom + 2, items);
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
      { label: t("tabs.close"), icon: <X className="w-3 h-3" />, onClick: () => removeTab(tab.id), disabled: !tab.closable },
      { label: t("tabs.closeOthersShort"), icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.id !== tab.id && t.closable).map((t) => t.id)) },
      { label: t("tabs.closeAll"), icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.closable).map((t) => t.id)) },
      { label: "", separator: true, onClick: () => {} },
      { label: t("tabs.rename"), icon: <Pencil className="w-3 h-3" />, onClick: () => startRename(tab), disabled: !tab.closable },
      { label: t("tabs.duplicate"), icon: <Copy className="w-3 h-3" />, onClick: () => {
        (onDuplicateTab ?? duplicateTab)(tab.id);
      }, disabled: tab.type === "welcome" },
      { label: "", separator: true, onClick: () => {} },
      { label: t("tabs.moveToFirst"), icon: <ChevronFirst className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, 0), disabled: isFirst },
      { label: t("tabs.moveLeft"), icon: <ChevronLeft className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, idx - 1), disabled: isFirst },
      { label: t("tabs.moveRight"), icon: <ChevronRight className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, idx + 1), disabled: isLast },
      { label: t("tabs.moveToLast"), icon: <ChevronLast className="w-3 h-3" />, onClick: () => moveTabToIndex(tab.id, tabs.length - 1), disabled: isLast },
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
      className="taomni-tabbar h-8 flex items-end pl-2 pr-1 pt-1.5 gap-0 overflow-hidden"
      style={{ background: "linear-gradient(to bottom, var(--taomni-tab-inactive), var(--taomni-chrome-bg))" }}
    >
      {ctx.render}
      {tabFilter && (
        <button
          type="button"
          data-testid="tab-filter-chip"
          onClick={() => setTabFilter(null)}
          title={t("tabs.filterClear")}
          className="flex items-center gap-1 mb-0.5 mr-1 px-2 h-6 rounded text-[11px] max-w-[180px] shrink-0"
          style={{ background: "var(--taomni-hover)", color: "var(--taomni-text)" }}
        >
          {tabFilter.kind === "group" || tabFilter.kind === "multi" ? (
            <Folder className="w-3 h-3 shrink-0" />
          ) : (
            <Search className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate">
            {tabFilter.kind === "query"
              ? tabFilter.text
              : tabFilter.kind === "multi"
                ? getFilterChipText(tabFilter, sessions, tabs, t)
                : tabFilter.path === ""
                  ? t("tabs.filterUngrouped")
                  : tabFilter.path}
          </span>
          <X className="w-3 h-3 shrink-0" />
        </button>
      )}
      {tabScrollState.overflow && (
        <IconBtn
          testId="tab-scroll-left"
          title={t("tabs.scrollLeft")}
          icon={<ChevronLeft className="w-3.5 h-3.5" />}
          onClick={() => scrollTabsBy("left")}
          disabled={tabScrollState.atStart}
        />
      )}
      <div
        ref={tabScrollRef}
        data-testid="tab-scroll-area"
        className="taomni-tab-scroll flex items-end min-w-0 overflow-x-auto overflow-y-hidden"
        onScroll={updateTabScrollState}
      >
        {tabFilter && visibleTabs.length === 0 && (
          <div
            data-testid="tab-filter-empty"
            className="self-center px-3 text-[12px] whitespace-nowrap"
            style={{ color: "var(--taomni-text-muted)" }}
          >
            {t("tabs.filterNoMatch")}
          </div>
        )}
        {visibleTabs.map((tab) => {
          const isSelected = multiExecActive && tab.type === "terminal" && multiExecSelectedTabIds.has(tab.id);
          const dropSide = dropIndicator && dropIndicator.tabId === tab.id ? dropIndicator.side : undefined;
          return (
            <TabItem
              key={tab.id}
              tab={tab}
              translate={t}
              active={activeTabId === tab.id}
              multiExecSelected={!!isSelected}
              multiExecActive={multiExecActive}
              dragging={draggedId === tab.id}
              draggedId={draggedId}
              dropSide={dropSide}
              editing={editingTabId === tab.id}
              draftTitle={draftTitle}
              onElementChange={setTabElement}
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
      </div>
      {tabScrollState.overflow && (
        <IconBtn
          testId="tab-scroll-right"
          title={t("tabs.scrollRight")}
          icon={<ChevronRight className="w-3.5 h-3.5" />}
          onClick={() => scrollTabsBy("right")}
          disabled={tabScrollState.atEnd}
        />
      )}

      <div className="flex items-end" data-testid="new-tab-split">
        <button
          data-testid="new-local-terminal"
          className="taomni-tab"
          style={{ paddingRight: 4, borderTopRightRadius: 0 }}
          data-active={false}
          onClick={handleQuickLaunch}
          title={t("tabs.newTab")}
        >
          <Plus className="w-3 h-3" />
        </button>
        <button
          data-testid="new-tab-launch-menu"
          className="taomni-tab"
          style={{ paddingLeft: 2, paddingRight: 4, borderTopLeftRadius: 0, marginLeft: -1 }}
          data-active={false}
          onClick={handleOpenLaunchMenu}
          title={t("tabs.newTabMenu")}
          aria-haspopup="menu"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 self-stretch" data-window-drag />
      <div className="flex items-center gap-1 pr-1 pb-0.5">
        <div ref={moreWrapRef} className="relative">
          <IconBtn
            testId="tab-more"
            title={t("tabs.more")}
            icon={<MoreHorizontal className="w-3.5 h-3.5" />}
            active={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          />
          <OpenTabsMenu open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreWrapRef} />
        </div>
      </div>
    </div>
  );
}

function dbEngineColor(engine?: string): string {
  switch (engine) {
    case "MySQL":
      return "#00758f";
    case "PostgreSQL":
      return "#336791";
    case "ClickHouse":
      return "#e6a817";
    case "Presto":
      return "#5a4fcf";
    case "Redis":
      return "#d82c20";
    case "HBaseShell":
      return "#1d7f8c";
    default:
      return "#2b5d8b";
  }
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (tab.type === "terminal" && tab.ssh) {
    return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
  switch (tab.type) {
    case "terminal":
      return <TerminalIcon className="w-3 h-3" style={{ color: "#62d36f" }} />;
    case "database":
    case "redis":
      return <DatabaseIcon className="w-3 h-3" style={{ color: dbEngineColor(tab.db?.engine) }} />;
    case "hbase-shell":
      return <DatabaseIcon className="w-3 h-3" style={{ color: dbEngineColor("HBaseShell") }} />;
    case "sftp":
      return <Folder className="w-3 h-3" style={{ color: "#3b7ac2" }} />;
    case "rdp":
    case "vnc":
      return <Monitor className="w-3 h-3" style={{ color: "#a04b9c" }} />;
    case "nettools":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#236a98" }} />;
    case "proxy-test":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#6b7280" }} />;
    case "file-browser":
      return <FileText className="w-3 h-3" style={{ color: "var(--taomni-text-muted)" }} />;
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
      className="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      style={active ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
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
  translate: TranslateFn;
  active: boolean;
  multiExecActive: boolean;
  multiExecSelected: boolean;
  dragging: boolean;
  draggedId: string | null;
  dropSide: "before" | "after" | undefined;
  editing: boolean;
  draftTitle: string;
  onElementChange: (id: string, node: HTMLDivElement | null) => void;
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
    translate: t,
    active,
    multiExecActive,
    multiExecSelected,
    dragging,
    draggedId,
    dropSide,
    editing,
    draftTitle,
    onElementChange,
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

  useEffect(() => {
    onElementChange(tab.id, ref.current);
    return () => onElementChange(tab.id, null);
  }, [onElementChange, tab.id]);

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
      className="taomni-tab relative"
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
          title={multiExecSelected ? t("tabs.multiExecRemove") : t("tabs.multiExecAdd")}
          className="absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border flex items-center justify-center z-10 flex-shrink-0"
          style={{
            background: multiExecSelected ? "var(--taomni-accent)" : "var(--taomni-chrome-bg)",
            borderColor: multiExecSelected ? "var(--taomni-accent)" : "var(--taomni-divider)",
            fontSize: 7,
            color: multiExecSelected ? "#fff" : "var(--taomni-text-muted)",
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
        <TabIcon tab={tab} />
        {tab.hasNewOutput && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 pointer-events-none"
            aria-label={t("tabs.newOutput")}
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
            className="bg-transparent border-b border-[var(--taomni-accent)] outline-none text-[12px] leading-none w-[160px] px-0"
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
