import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Check,
  PanelTopClose,
  PanelTopOpen,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import type { Tab } from "../../types";
import {
  filterVisibleTabs,
  tabGroupKey,
  tabMatchesFilter,
  type TabFilter,
} from "../../lib/tabFilter";
import { TabIcon } from "./TabBar";

interface OpenTabsMenuProps {
  open: boolean;
  onClose: () => void;
  /** The trigger element the menu anchors to (used for positioning + hit-test). */
  anchorRef: RefObject<HTMLElement | null>;
}

interface TabGroup {
  /** Normalized directory path; `""` is the ungrouped/local bucket. */
  key: string;
  tabs: Tab[];
}

/**
 * The `…` overflow dropdown for the tab strip. Lists every open tab grouped by
 * its saved session's directory, and lets the user focus the strip on one
 * directory (click a group header) or a fuzzy query (type in the box). The
 * filter hides non-matching tabs from the strip without closing them; this
 * panel always shows the full list (hidden ones dimmed) so any tab stays
 * reachable. See issue #121.
 */
export function OpenTabsMenu({ open, onClose, anchorRef }: OpenTabsMenuProps) {
  const t = useT();
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabFilter = useAppStore((s) => s.tabFilter);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setTabFilter = useAppStore((s) => s.setTabFilter);
  const compactMode = useAppStore((s) => s.compactMode);
  const toggleCompactMode = useAppStore((s) => s.toggleCompactMode);
  const removeTabs = useAppStore((s) => s.removeTabs);
  const sessions = useSessionStore((s) => s.sessions);

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // Sync the box with the active query filter and focus it each time we open.
  useEffect(() => {
    if (!open) return;
    setQuery(tabFilter?.kind === "query" ? tabFilter.text : "");
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Anchor the (portaled, fixed) menu below the trigger's right edge. The strip
  // lives inside an `overflow-hidden` container, so an absolutely-positioned
  // dropdown would be clipped — fixed positioning escapes that.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        setPos({ top: rect.bottom + 4, right: Math.max(4, window.innerWidth - rect.right) });
      }
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);

  // Close on outside click / Escape. The trigger is excluded so its own click
  // toggles instead of double-firing.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  const groups = useMemo<TabGroup[]>(() => {
    const map = new Map<string, Tab[]>();
    for (const tab of tabs) {
      const key = tabGroupKey(tab, sessions);
      const list = map.get(key);
      if (list) list.push(tab);
      else map.set(key, [tab]);
    }
    return [...map.keys()]
      .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map((key) => ({ key, tabs: map.get(key)! }));
  }, [tabs, sessions]);

  if (!open) return null;

  // Keep the active tab visible: jump to the first match when it would hide.
  const applyFilter = (filter: TabFilter | null) => {
    setTabFilter(filter);
    if (!filter) return;
    const visible = filterVisibleTabs(tabs, sessions, filter);
    if (visible.length && !visible.some((tab) => tab.id === activeTabId)) {
      setActiveTab(visible[0].id);
    }
  };

  const toggleGroup = (groupKey: string) => {
    if (query) {
      setQuery("");
    }
    let newPaths = tabFilter?.kind === "multi" ? [...tabFilter.paths] : [];
    let newTabIds = tabFilter?.kind === "multi" ? [...tabFilter.tabIds] : [];

    if (tabFilter?.kind === "group") {
      newPaths = [tabFilter.path];
    }

    const group = groups.find((g) => g.key === groupKey);
    const groupTabIds = group ? group.tabs.map((t) => t.id) : [];

    if (newPaths.includes(groupKey)) {
      newPaths = newPaths.filter((p) => p !== groupKey);
      newTabIds = newTabIds.filter((id) => !groupTabIds.includes(id));
    } else {
      newPaths.push(groupKey);
      newTabIds = newTabIds.filter((id) => !groupTabIds.includes(id));
    }

    const nextFilter: TabFilter | null =
      newPaths.length > 0 || newTabIds.length > 0
        ? { kind: "multi", paths: newPaths, tabIds: newTabIds }
        : null;

    applyFilter(nextFilter);
  };

  const toggleTab = (tab: Tab) => {
    if (query) {
      setQuery("");
    }
    const groupKey = tabGroupKey(tab, sessions);
    const group = groups.find((g) => g.key === groupKey);
    const groupTabIds = group ? group.tabs.map((t) => t.id) : [tab.id];

    let newPaths = tabFilter?.kind === "multi" ? [...tabFilter.paths] : [];
    let newTabIds = tabFilter?.kind === "multi" ? [...tabFilter.tabIds] : [];

    if (tabFilter?.kind === "group") {
      newPaths = [tabFilter.path];
    }

    const isGroupChecked = newPaths.includes(groupKey);
    const isTabChecked = isGroupChecked || newTabIds.includes(tab.id);

    if (isTabChecked) {
      if (isGroupChecked) {
        newPaths = newPaths.filter((p) => p !== groupKey);
        const otherGroupTabs = groupTabIds.filter((id) => id !== tab.id);
        for (const id of otherGroupTabs) {
          if (!newTabIds.includes(id)) {
            newTabIds.push(id);
          }
        }
      } else {
        newTabIds = newTabIds.filter((id) => id !== tab.id);
      }
    } else {
      if (!newTabIds.includes(tab.id)) {
        newTabIds.push(tab.id);
      }
      const allChecked = groupTabIds.every((id) => newTabIds.includes(id));
      if (allChecked) {
        newPaths.push(groupKey);
        newTabIds = newTabIds.filter((id) => !groupTabIds.includes(id));
      }
    }

    const nextFilter: TabFilter | null =
      newPaths.length > 0 || newTabIds.length > 0
        ? { kind: "multi", paths: newPaths, tabIds: newTabIds }
        : null;

    applyFilter(nextFilter);
  };

  const onQueryChange = (text: string) => {
    setQuery(text);
    applyFilter(text.trim() ? { kind: "query", text } : null);
  };

  const pickTab = (tab: Tab) => {
    // Revealing a hidden tab drops the filter so it isn't instantly re-hidden.
    if (!tabMatchesFilter(tab, sessions, tabFilter)) setTabFilter(null);
    setActiveTab(tab.id);
    onClose();
  };

  const showAll = () => {
    setQuery("");
    setTabFilter(null);
  };

  const closeAllTerminals = () => {
    removeTabs(
      tabs.filter((tab) => tab.type === "terminal" && tab.closable).map((tab) => tab.id),
    );
    onClose();
  };

  const rowClass =
    "w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)]";
  const muted = "text-[var(--taomni-text-muted)]";

  return createPortal(
    <div
      ref={menuRef}
      data-testid="open-tabs-menu"
      className="fixed z-[9999] w-72 max-h-[70vh] flex flex-col rounded shadow-lg border text-[12px]"
      style={{
        top: pos.top,
        right: pos.right,
        background: "var(--taomni-panel-bg)",
        borderColor: "var(--taomni-divider)",
        color: "var(--taomni-text)",
      }}
    >
      <div className="py-1">
        <button type="button" className={rowClass} onClick={() => { toggleCompactMode(); onClose(); }}>
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            {compactMode ? <PanelTopOpen className="w-3 h-3" /> : <PanelTopClose className="w-3 h-3" />}
          </span>
          <span className="flex-1 truncate">
            {compactMode ? t("titlebar.exitCompact") : t("titlebar.enterCompact")}
          </span>
          <span className={`ml-6 flex-shrink-0 text-[11px] ${muted}`}>Ctrl+Shift+M</span>
        </button>
        <button type="button" className={rowClass} onClick={closeAllTerminals}>
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            <Trash2 className="w-3 h-3" />
          </span>
          <span className="flex-1 truncate">{t("tabs.closeAllTerminals")}</span>
        </button>
      </div>

      <div className="h-px mx-2" style={{ background: "var(--taomni-divider)" }} />

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Search className={`w-3.5 h-3.5 flex-shrink-0 ${muted}`} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("tabs.filterPlaceholder")}
          data-testid="open-tabs-filter"
          className="flex-1 min-w-0 bg-transparent outline-none"
        />
        <button
          type="button"
          title={t("tabs.filterShowAll")}
          onClick={showAll}
          disabled={tabFilter === null}
          data-testid="open-tabs-show-all"
          className="p-0.5 disabled:opacity-30 hover:opacity-80"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="h-px mx-2" style={{ background: "var(--taomni-divider)" }} />

      <div className="overflow-y-auto py-1">
        {groups.map((group) => {
          const slug =
            (group.key || "ungrouped").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") ||
            "ungrouped";
          const isGroupFilter =
            tabFilter?.kind === "group"
              ? tabFilter.path === group.key
              : tabFilter?.kind === "multi"
                ? tabFilter.paths.includes(group.key)
                : false;
          const isCollapsed = collapsed[group.key] ?? false;
          const label = group.key === "" ? t("tabs.filterUngrouped") : group.key;
          return (
            <div key={slug}>
              <div
                className="flex items-center gap-0.5 px-1.5 py-0.5"
                style={isGroupFilter ? { background: "var(--taomni-hover)" } : undefined}
              >
                <button
                  type="button"
                  className="p-0.5 hover:opacity-80"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !isCollapsed }))}
                  data-testid={`open-tabs-group-toggle-${slug}`}
                  aria-label={label}
                >
                  {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                <input
                  type="checkbox"
                  className="taomni-checkbox mr-1 shrink-0"
                  checked={isGroupFilter}
                  onChange={() => toggleGroup(group.key)}
                  data-testid={`open-tabs-group-checkbox-${slug}`}
                />
                <button
                  type="button"
                  className="flex-1 flex items-center gap-1 min-w-0 text-left hover:opacity-80"
                  title={t("tabs.filterByDir")}
                  onClick={() => toggleGroup(group.key)}
                  data-testid={`open-tabs-group-${slug}`}
                >
                  <span className={`flex-1 truncate ${muted}`}>{label}</span>
                  <span className={`text-[11px] ${muted}`}>({group.tabs.length})</span>
                </button>
              </div>
              {!isCollapsed &&
                group.tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  const hidden = !tabMatchesFilter(tab, sessions, tabFilter);
                  const isChecked =
                    tabFilter?.kind === "group"
                      ? tabFilter.path === group.key
                      : tabFilter?.kind === "multi"
                        ? tabFilter.tabIds.includes(tab.id) || tabFilter.paths.includes(group.key)
                        : false;
                  return (
                    <div
                      key={tab.id}
                      className={`w-full pl-6 pr-3 py-1 flex items-center gap-2 text-left hover:bg-[var(--taomni-hover)] ${hidden ? "opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="taomni-checkbox shrink-0"
                        checked={isChecked}
                        onChange={() => toggleTab(tab)}
                        data-testid={`open-tabs-tab-checkbox-${tab.id}`}
                      />
                      <button
                        type="button"
                        data-testid={`open-tabs-tab-${tab.id}`}
                        onClick={() => pickTab(tab)}
                        title={tab.title}
                        className="flex-1 flex items-center gap-2 min-w-0 text-left"
                      >
                        <span className="w-4 flex-shrink-0 flex items-center justify-center">
                          {isActive ? <Check className="w-3 h-3" /> : <TabIcon tab={tab} />}
                        </span>
                        <span className="flex-1 truncate">{tab.title}</span>
                      </button>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
