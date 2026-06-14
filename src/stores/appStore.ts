import { create } from "zustand";
import type { Tab } from "../types";
import { t as tr } from "../lib/i18n";
import { detectXServer, type XServerStatus } from "../lib/ipc";
import type { TabFilter } from "../lib/tabFilter";

export type SideTab = "sessions" | "tools" | "macros";
export type TerminalSplitLayout = "horizontal" | "vertical" | "grid";

const COMPACT_MODE_KEY = "taomni.compactMode";
const UI_FONT_FAMILY_KEY = "taomni.uiFontFamily";
const UI_FONT_SIZE_KEY = "taomni.uiFontSize";
const TERMINAL_SPLIT_LAYOUT_KEY = "taomni.terminalSplitLayout";

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  compactMode: boolean;
  activeSideTab: SideTab;
  /**
   * Whether a usable local X server is reachable (Xorg / XQuartz / VcXsrv /
   * WSLg). This is now backed by real backend detection via
   * {@link refreshXServer}, not a manual toggle — the value reflects whether
   * forwarded X11 apps actually have somewhere to display.
   */
  xServerEnabled: boolean;
  /** Full detection result for the local X server (null until first probe). */
  xServerStatus: XServerStatus | null;
  statusMessage: string;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  terminalSplitActive: boolean;
  terminalSplitLayout: TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  uiFontFamily: string;
  uiFontSize: number;
  /**
   * When non-null, the named tab is rendered alone in the OS window: the
   * sidebar, menu bar, ribbon, quick-connect bar, and tab strip are all
   * hidden so the tab content fills the available area. The OS window
   * itself is unchanged — this is "in-window maximize", not a true
   * Fullscreen API call. Cleared automatically if the maximized tab is
   * removed or its kind changes.
   */
  tabMaximizedId: string | null;

  /**
   * Transient focus filter for the open-tab strip (issue #121). When set, the
   * strip only renders tabs matching the filter; the rest are hidden, not
   * closed. Session-scoped — reset on reload and cleared whenever a new tab is
   * opened so the new tab is always visible.
   */
  tabFilter: TabFilter | null;

  addTab: (tab: Tab) => void;
  /**
   * Duplicate an existing tab, inserting the copy immediately to the right of
   * the original (not at the end of the strip) and activating it. See issue
   * #120: a duplicated session should sit next to its source for quick
   * switching/comparison.
   *
   * The copy's title gets a `-<n>` suffix that increments across all open tabs
   * sharing the same base name (so duplicating "Server" yields "Server-1",
   * then "Server-2", and duplicating "Server-1" continues the same family).
   * `overrides.terminalInitialCwd`, when provided, is carried onto the copy so
   * a duplicated local/SSH terminal can open in the source terminal's cwd.
   */
  duplicateTab: (id: string, overrides?: { terminalInitialCwd?: string }) => void;
  removeTab: (id: string) => void;
  removeTabs: (ids: string[]) => void;
  updateTabTitle: (id: string, title: string) => void;
  setActiveTab: (id: string) => void;
  moveTab: (fromId: string, targetId: string, position: "before" | "after") => void;
  moveTabToIndex: (id: string, toIndex: number) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleCompactMode: () => void;
  setCompactMode: (compact: boolean) => void;
  setActiveSideTab: (tab: SideTab) => void;
  /** Re-probe the local X server and update {@link xServerStatus}. */
  refreshXServer: () => Promise<void>;
  /** @deprecated X server availability is detected, not toggled. Kept as a
   *  manual re-probe trigger so the existing ribbon/menu command still works. */
  toggleXServer: () => void;
  setStatusMessage: (message: string) => void;
  toggleMultiExec: () => void;
  toggleMultiExecTab: (tabId: string) => void;
  selectAllTerminalTabs: () => void;
  clearMultiExecSelection: () => void;
  setTerminalSplitActive: (active: boolean) => void;
  toggleTerminalSplit: () => void;
  setTerminalSplitLayout: (layout: TerminalSplitLayout) => void;
  toggleTerminalSplitInputLock: (tabId: string) => void;
  clearTerminalSplitInputLocks: () => void;
  setTabHasNewOutput: (tabId: string, hasNewOutput: boolean) => void;
  setUiFontFamily: (font: string) => void;
  setUiFontSize: (size: number) => void;
  setTabMaximized: (tabId: string | null) => void;
  toggleTabMaximized: (tabId: string) => void;
  setTabFilter: (filter: TabFilter | null) => void;
  clearTabFilter: () => void;
}

function readCompactMode() {
  try {
    return window.localStorage.getItem(COMPACT_MODE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCompactMode(compact: boolean) {
  try {
    window.localStorage.setItem(COMPACT_MODE_KEY, compact ? "true" : "false");
  } catch {
    // Ignore storage failures; compact mode still works for this run.
  }
}

function readUiFontFamily(): string {
  try {
    return window.localStorage.getItem(UI_FONT_FAMILY_KEY) || "Inter";
  } catch {
    return "Inter";
  }
}

function writeUiFontFamily(font: string) {
  try {
    window.localStorage.setItem(UI_FONT_FAMILY_KEY, font);
  } catch {
    // Ignore storage failures
  }
}

function readUiFontSize(): number {
  try {
    const val = window.localStorage.getItem(UI_FONT_SIZE_KEY);
    if (val) {
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed >= 10 && parsed <= 18) {
        return parsed;
      }
    }
    return 12;
  } catch {
    return 12;
  }
}

function writeUiFontSize(size: number) {
  try {
    window.localStorage.setItem(UI_FONT_SIZE_KEY, size.toString());
  } catch {
    // Ignore storage failures
  }
}

function readTerminalSplitLayout(): TerminalSplitLayout {
  try {
    const value = window.localStorage.getItem(TERMINAL_SPLIT_LAYOUT_KEY);
    if (value === "horizontal" || value === "vertical" || value === "grid") {
      return value;
    }
    return "horizontal";
  } catch {
    return "horizontal";
  }
}

function writeTerminalSplitLayout(layout: TerminalSplitLayout) {
  try {
    window.localStorage.setItem(TERMINAL_SPLIT_LAYOUT_KEY, layout);
  } catch {
    // Ignore storage failures; layout changes still apply for this run.
  }
}

function pruneSet(ids: Set<string>, validIds: Set<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
}

function activeTabIsTerminal(tabs: Tab[], activeTabId: string | null): boolean {
  return !!activeTabId && tabs.some((tab) => tab.id === activeTabId && tab.type === "terminal");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the title for a duplicated tab. The base name is the source title with
 * any trailing `-<digits>` stripped, so the whole "family" shares one counter.
 * The returned title is `<base>-<n>` where `n` is one past the highest suffix
 * already used by an open tab in that family.
 *
 * Examples (given the open titles in brackets):
 *   "Server"   ["Server"]                       -> "Server-1"
 *   "Server"   ["Server","Server-1"]            -> "Server-2"
 *   "Server-1" ["Server","Server-1","Server-2"] -> "Server-3"
 */
export function computeDuplicateTitle(sourceTitle: string, openTitles: string[]): string {
  const suffixMatch = /^(.*?)-(\d+)$/.exec(sourceTitle);
  const base = suffixMatch ? suffixMatch[1] : sourceTitle;
  const familyRe = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let maxSuffix = 0;
  for (const title of openTitles) {
    const m = familyRe.exec(title);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxSuffix) maxSuffix = n;
    }
  }
  return `${base}-${maxSuffix + 1}`;
}

export const useAppStore = create<AppState>((set) => ({
  tabs: [
    {
      id: "welcome",
      type: "welcome",
      title: "Welcome",
      closable: false,
    },
  ],
  activeTabId: "welcome",
  sidebarCollapsed: false,
  compactMode: readCompactMode(),
  activeSideTab: "sessions",
  xServerEnabled: false,
  xServerStatus: null,
  statusMessage: tr("status.ready"),
  multiExecActive: false,
  multiExecSelectedTabIds: new Set(),
  terminalSplitActive: false,
  terminalSplitLayout: readTerminalSplitLayout(),
  terminalSplitInputLockedTabIds: new Set(),
  uiFontFamily: readUiFontFamily(),
  uiFontSize: readUiFontSize(),
  tabMaximizedId: null,
  tabFilter: null,

  addTab: (tab) =>
    set((s) => {
      const nextTabs = [...s.tabs, tab];
      return {
        tabs: nextTabs,
        activeTabId: tab.id,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: tab.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: tab.title }),
      };
    }),

  duplicateTab: (id, overrides) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const source = s.tabs[idx];
      const copy: Tab = {
        ...source,
        id: `dup-${crypto.randomUUID()}`,
        title: computeDuplicateTitle(source.title, s.tabs.map((t) => t.title)),
        closable: true,
        hasNewOutput: false,
        // Only terminal copies carry an initial cwd; clear any inherited value
        // for other tab kinds (and when none was resolved).
        terminalInitialCwd:
          source.type === "terminal" ? overrides?.terminalInitialCwd : undefined,
      };
      const next = s.tabs.slice();
      next.splice(idx + 1, 0, copy);
      return {
        tabs: next,
        activeTabId: copy.id,
        // A freshly opened tab must be visible, so drop any active focus filter.
        tabFilter: null,
        terminalSplitActive: copy.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: copy.title }),
      };
    }),

  removeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const next = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeTabId;
      if (activeId === id) {
        activeId = next[Math.min(idx, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      return {
        tabs: next,
        activeTabId: activeId,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        tabMaximizedId: s.tabMaximizedId === id ? null : s.tabMaximizedId,
        statusMessage: tr("status.closedTab"),
      };
    }),

  removeTabs: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const next = s.tabs.filter((t) => !idSet.has(t.id));
      let activeId = s.activeTabId;
      if (!activeId || idSet.has(activeId)) {
        activeId = next[Math.min(activeIndex, next.length - 1)]?.id ?? null;
      }
      const validIds = new Set(next.map((tab) => tab.id));
      return {
        tabs: next,
        activeTabId: activeId,
        terminalSplitActive: s.terminalSplitActive && activeTabIsTerminal(next, activeId),
        terminalSplitInputLockedTabIds: pruneSet(s.terminalSplitInputLockedTabIds, validIds),
        multiExecSelectedTabIds: pruneSet(s.multiExecSelectedTabIds, validIds),
        tabMaximizedId:
          s.tabMaximizedId && idSet.has(s.tabMaximizedId) ? null : s.tabMaximizedId,
        statusMessage: tr("status.closedTabs"),
      };
    }),

  updateTabTitle: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
      statusMessage: tr("status.renamedTab", { title }),
    })),

  setActiveTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((item) => item.id === id);
      return {
        activeTabId: id,
        terminalSplitActive: tab?.type === "terminal" ? s.terminalSplitActive : false,
      };
    }),

  moveTab: (fromId, targetId, position) =>
    set((s) => {
      if (fromId === targetId) return s;
      const from = s.tabs.findIndex((t) => t.id === fromId);
      const target = s.tabs.findIndex((t) => t.id === targetId);
      if (from === -1 || target === -1) return s;

      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      const adjustedTarget = target > from ? target - 1 : target;
      const insertAt = position === "after" ? adjustedTarget + 1 : adjustedTarget;
      next.splice(insertAt, 0, moved);
      if (next.every((t, i) => t === s.tabs[i])) return s;
      return { tabs: next };
    }),

  moveTabToIndex: (id, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from === -1) return s;
      const clamped = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
      if (from === clamped) return s;
      const next = s.tabs.slice();
      const [moved] = next.splice(from, 1);
      next.splice(clamped, 0, moved);
      return { tabs: next };
    }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleCompactMode: () =>
    set((s) => {
      const compactMode = !s.compactMode;
      writeCompactMode(compactMode);
      return {
        compactMode,
        statusMessage: compactMode ? tr("status.compactEnabled") : tr("status.compactDisabled"),
      };
    }),
  setCompactMode: (compactMode) => {
    writeCompactMode(compactMode);
    set({
      compactMode,
      statusMessage: compactMode ? tr("status.compactEnabled") : tr("status.compactDisabled"),
    });
  },
  setActiveSideTab: (tab) => set({ activeSideTab: tab, sidebarCollapsed: false }),

  refreshXServer: async () => {
    const status = await detectXServer();
    set({
      xServerStatus: status,
      xServerEnabled: status.available,
    });
  },

  // The "X server" ribbon/menu command now means "re-detect", since whether a
  // local X server exists is a property of the system, not something the app
  // turns on. We re-probe and report the result in the status line.
  toggleXServer: () => {
    void detectXServer().then((status) => {
      set({
        xServerStatus: status,
        xServerEnabled: status.available,
        statusMessage: status.available
          ? tr("status.xServerEnabled")
          : tr("status.xServerDisabled"),
      });
    });
  },

  setStatusMessage: (message) => set({ statusMessage: message }),

  toggleMultiExec: () =>
    set((s) => {
      const next = !s.multiExecActive;
      return {
        multiExecActive: next,
        multiExecSelectedTabIds: new Set(),
        tabs: next ? s.tabs : s.tabs.map((t) => ({ ...t, hasNewOutput: false })),
        statusMessage: next ? tr("status.multiExecEnabled") : tr("status.multiExecDisabled"),
      };
    }),

  toggleMultiExecTab: (tabId) =>
    set((s) => {
      const next = new Set(s.multiExecSelectedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return { multiExecSelectedTabIds: next };
    }),

  selectAllTerminalTabs: () =>
    set((s) => ({
      multiExecSelectedTabIds: new Set(
        s.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
      ),
    })),

  clearMultiExecSelection: () =>
    set({ multiExecSelectedTabIds: new Set() }),

  setTerminalSplitActive: (active) =>
    set((s) => {
      if (!active) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  toggleTerminalSplit: () =>
    set((s) => {
      if (s.terminalSplitActive) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitDisabled"),
        };
      }
      const terminalTabs = s.tabs.filter((tab) => tab.type === "terminal");
      if (terminalTabs.length === 0) {
        return {
          terminalSplitActive: false,
          statusMessage: tr("status.splitNoTerminals"),
        };
      }
      const activeTabId = activeTabIsTerminal(s.tabs, s.activeTabId)
        ? s.activeTabId
        : terminalTabs[0].id;
      return {
        terminalSplitActive: true,
        activeTabId,
        statusMessage: tr("status.splitEnabled"),
      };
    }),

  setTerminalSplitLayout: (layout) => {
    writeTerminalSplitLayout(layout);
    set({
      terminalSplitLayout: layout,
      statusMessage: tr("status.splitLayout", { layout }),
    });
  },

  toggleTerminalSplitInputLock: (tabId) =>
    set((s) => {
      if (!s.tabs.some((tab) => tab.id === tabId && tab.type === "terminal")) {
        return s;
      }
      const next = new Set(s.terminalSplitInputLockedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return {
        terminalSplitInputLockedTabIds: next,
        statusMessage: next.has(tabId) ? tr("status.paneInputLocked") : tr("status.paneInputUnlocked"),
      };
    }),

  clearTerminalSplitInputLocks: () =>
    set({
      terminalSplitInputLockedTabIds: new Set(),
      statusMessage: tr("status.splitLocksCleared"),
    }),

  setTabHasNewOutput: (tabId, hasNewOutput) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.hasNewOutput === hasNewOutput) return s;
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasNewOutput } : t)) };
    }),

  setUiFontFamily: (font) =>
    set(() => {
      writeUiFontFamily(font);
      return { uiFontFamily: font };
    }),

  setUiFontSize: (size) =>
    set(() => {
      writeUiFontSize(size);
      return { uiFontSize: size };
    }),

  setTabMaximized: (tabId) =>
    set((s) => {
      if (tabId && !s.tabs.some((t) => t.id === tabId)) {
        return s;
      }
      return { tabMaximizedId: tabId };
    }),

  toggleTabMaximized: (tabId) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === tabId)) return s;
      return { tabMaximizedId: s.tabMaximizedId === tabId ? null : tabId };
    }),

  setTabFilter: (filter) => set({ tabFilter: filter }),
  clearTabFilter: () => set({ tabFilter: null }),
}));
