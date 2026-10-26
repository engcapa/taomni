import {
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Copy,
  FilePlus,
  Folder,
  History,
  Pencil,
  Plus,
  Search,
  Server,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "../../lib/clipboard";
import { startCustomDrag } from "../../lib/customDnD";
import { useT } from "../../lib/i18n";
import { listLocalShells, listWslDistros, type LocalShellOption } from "../../lib/ipc";
import { getAppPlatform } from "../../lib/runtime";
import { formatTabSessionInfo } from "../../lib/tabDetails";
import { filterVisibleTabs, getFilterChipText } from "../../lib/tabFilter";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { LocalShellSelection, Tab } from "../../types";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { TabDetailsOverlay } from "./TabDetailsOverlay";
import { type DropIndicator, type TabBarProps, type TabScrollState } from "./tabs/model";
import { maxScrollLeft, setTabScrollLeft, TAB_DRAG_MIME, TAB_SCROLL_EDGE_TOLERANCE, TAB_SCROLL_PADDING, TAB_SCROLL_STEP_MIN } from "./tabs/scroll";
import { IconBtn, TabItem } from "./tabs/TabItem";

export function TabBar({
  onStartLocalTerminal,
  onConnectSession,
  onOpenSessionEditor,
  onDuplicateTab,
  detailsRevealExternal = false,
}: TabBarProps) {
  const {
    tabs,
    activeTabId,
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
    setStatusMessage,
    terminalRuntimeByTab,
    cwdByTab,
  } = useAppStore();
  const sessions = useSessionStore((s) => s.sessions);
  const ctx = useContextMenu();
  const t = useT();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [detailsRevealShortcut, setDetailsRevealShortcut] = useState(false);
  const [hoveredDetailsTabId, setHoveredDetailsTabId] = useState<string | null>(null);
  const detailsReveal = detailsRevealShortcut || detailsRevealExternal;
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string; isDefault: boolean; }[]>([]);
  const [shellsLoaded, setShellsLoaded] = useState(false);
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
    const isMac = getAppPlatform() === "macos";
    const matchesShortcut = (event: KeyboardEvent) =>
      (event.code === "KeyH" || event.key.toLowerCase() === "h") &&
      event.shiftKey &&
      !event.altKey &&
      (isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailsRevealShortcut(false);
        return;
      }
      if (event.isComposing || !matchesShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!event.repeat) setDetailsRevealShortcut((visible) => !visible);
    };
    const hide = () => setDetailsRevealShortcut(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") hide();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

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
  }, [activeTabId, tabs, tabFilter, updateTabScrollState]);

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
    () => filterVisibleTabs(tabs.filter((tab) => tab.type !== "welcome"), sessions, tabFilter),
    [tabs, sessions, tabFilter],
  );
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);

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
          onClick: () => { },
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
          onClick: () => { },
        },
      ];

    const items: MenuItem[] = [
      ...shellItems,
      { label: "", separator: true, onClick: () => { } },
      {
        label: t("tabs.recentSessions"),
        icon: <History className="w-3 h-3" />,
        children: recentChildren,
      },
      { label: "", separator: true, onClick: () => { } },
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

  const copyTabSessionInfo = useCallback(
    (tab: Tab) => {
      const text = formatTabSessionInfo(
        tab,
        sessions,
        terminalRuntimeByTab[tab.id],
        cwdByTab[tab.id],
        t,
      );
      void writeText(text)
        .then(() => setStatusMessage(t("tabs.sessionInfoCopied")))
        .catch((error) =>
          setStatusMessage(t("tabs.sessionInfoCopyFailed", { error: String(error) })),
        );
    },
    [cwdByTab, sessions, setStatusMessage, t, terminalRuntimeByTab],
  );

  const handleTabContext = (e: React.MouseEvent, tab: Tab) => {
    const sessionTabs = tabs.filter((item) => item.type !== "welcome");
    const idx = sessionTabs.findIndex((item) => item.id === tab.id);
    const isFirst = idx === 0;
    const isLast = idx === sessionTabs.length - 1;
    const moveToSessionIndex = (index: number) => {
      const target = sessionTabs[index];
      if (target) moveTabToIndex(tab.id, tabs.findIndex((item) => item.id === target.id));
    };
    ctx.show(e, [
      { label: t("tabs.close"), icon: <X className="w-3 h-3" />, onClick: () => removeTab(tab.id), disabled: !tab.closable },
      { label: t("tabs.closeOthersShort"), icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.id !== tab.id && t.closable).map((t) => t.id)) },
      { label: t("tabs.closeAll"), icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.closable).map((t) => t.id)) },
      { label: "", separator: true, onClick: () => { } },
      { label: t("tabs.rename"), icon: <Pencil className="w-3 h-3" />, onClick: () => startRename(tab), disabled: !tab.closable },
      {
        label: t("tabs.duplicate"), icon: <Copy className="w-3 h-3" />, onClick: () => {
          (onDuplicateTab ?? duplicateTab)(tab.id);
        }, disabled: tab.type === "welcome"
      },
      {
        label: t("tabs.copySessionInfo"),
        testId: "tab-context-copy-session-info",
        icon: <ClipboardCopy className="w-3 h-3" />,
        onClick: () => copyTabSessionInfo(tab),
      },
      { label: "", separator: true, onClick: () => { } },
      { label: t("tabs.moveToFirst"), icon: <ChevronFirst className="w-3 h-3" />, onClick: () => moveToSessionIndex(0), disabled: isFirst },
      { label: t("tabs.moveLeft"), icon: <ChevronLeft className="w-3 h-3" />, onClick: () => moveToSessionIndex(idx - 1), disabled: isFirst },
      { label: t("tabs.moveRight"), icon: <ChevronRight className="w-3 h-3" />, onClick: () => moveToSessionIndex(idx + 1), disabled: isLast },
      { label: t("tabs.moveToLast"), icon: <ChevronLast className="w-3 h-3" />, onClick: () => moveToSessionIndex(sessionTabs.length - 1), disabled: isLast },
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
      data-details-reveal={(detailsReveal || hoveredDetailsTabId !== null) || undefined}
      className="taomni-tabbar h-8 flex items-end pl-2 pr-1 pt-1.5 gap-0 overflow-hidden"
      style={{ background: "linear-gradient(to bottom, var(--taomni-tab-inactive), var(--taomni-chrome-bg))" }}
    >
      {ctx.render}
      <TabDetailsOverlay
        open={detailsReveal || hoveredDetailsTabId !== null}
        tabs={visibleTabs}
        tabElements={tabElementRefs.current}
        scrollRef={tabScrollRef}
        tabId={detailsReveal ? null : hoveredDetailsTabId}
      />
      {tabFilter && (
        <button
          type="button"
          data-testid="tab-filter-chip"
          onClick={() => setTabFilter(tabFilter.kind !== "protocol" && tabFilter.protocol && tabFilter.protocol !== "all" ? { kind: "protocol", protocol: tabFilter.protocol } : null)}
          title={t("tabs.filterClear")}
          className="flex items-center gap-1 mb-0.5 mr-1 px-2 h-6 rounded text-[11px] max-w-[112px] shrink-0"
          style={{ background: "var(--taomni-hover)", color: "var(--taomni-text)" }}
        >
          {tabFilter.kind === "group" || tabFilter.kind === "multi" ? (
            <Folder className="w-3 h-3 shrink-0" />
          ) : (
            <Search className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate">
            {tabFilter.kind === "protocol"
              ? t(`tabs.category.${tabFilter.protocol ?? "all"}`)
              : tabFilter.kind === "query"
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
        role="tablist"
        data-keyboard-navigation={keyboardNavigation ? "true" : undefined}
        aria-label={t("tabs.openTabs")}
        className="taomni-tab-scroll flex items-end min-w-0 overflow-x-auto overflow-y-hidden"
        onPointerDownCapture={() => setKeyboardNavigation(false)}
        onWheel={(event) => {
          const el = event.currentTarget;
          if (maxScrollLeft(el) > 0 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            el.scrollLeft += event.deltaY;
          }
        }}
        onKeyDown={(event) => {
          if (editingTabId || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const index = visibleTabs.findIndex((tab) => tab.id === activeTabId);
          const target = event.key === "Home" ? visibleTabs[0] : event.key === "End" ? visibleTabs.at(-1) : visibleTabs[(index + (event.key === "ArrowRight" ? 1 : -1) + visibleTabs.length) % visibleTabs.length];
          if (target) {
            event.preventDefault();
            setKeyboardNavigation(true);
            setActiveTab(target.id);
            tabElementRefs.current.get(target.id)?.focus();
          }
        }}
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
              onShowDetails={setHoveredDetailsTabId}
              onHideDetails={(tabId) =>
                setHoveredDetailsTabId((current) => (current === tabId ? null : current))
              }
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

      <div className="flex shrink-0 items-end" data-testid="new-tab-split">
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

      {/* Trailing draggable filler. The open-tabs `⋯` overflow now lives in the
          ControlBar to the right of the tab-action slot (see ControlBar). */}
      <div className="flex-1 self-stretch" data-window-drag />
    </div>
  );
}

export { TabIcon } from "./tabs/TabItem";
