import { create } from "zustand";
import type { Tab } from "../types";
import { t as tr } from "../lib/i18n";

export type SideTab = "sessions" | "tools" | "macros";
export type TerminalSplitLayout = "horizontal" | "vertical" | "grid";

const COMPACT_MODE_KEY = "newmob.compactMode";
const UI_FONT_FAMILY_KEY = "newmob.uiFontFamily";
const UI_FONT_SIZE_KEY = "newmob.uiFontSize";
const TERMINAL_SPLIT_LAYOUT_KEY = "newmob.terminalSplitLayout";

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  compactMode: boolean;
  activeSideTab: SideTab;
  xServerEnabled: boolean;
  statusMessage: string;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  terminalSplitActive: boolean;
  terminalSplitLayout: TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  uiFontFamily: string;
  uiFontSize: number;

  addTab: (tab: Tab) => void;
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
  statusMessage: tr("status.ready"),
  multiExecActive: false,
  multiExecSelectedTabIds: new Set(),
  terminalSplitActive: false,
  terminalSplitLayout: readTerminalSplitLayout(),
  terminalSplitInputLockedTabIds: new Set(),
  uiFontFamily: readUiFontFamily(),
  uiFontSize: readUiFontSize(),

  addTab: (tab) =>
    set((s) => {
      const nextTabs = [...s.tabs, tab];
      return {
        tabs: nextTabs,
        activeTabId: tab.id,
        terminalSplitActive: tab.type === "terminal" ? s.terminalSplitActive : false,
        statusMessage: tr("status.openedTab", { title: tab.title }),
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

  toggleXServer: () =>
    set((s) => ({
      xServerEnabled: !s.xServerEnabled,
      statusMessage: !s.xServerEnabled ? tr("status.xServerEnabled") : tr("status.xServerDisabled"),
    })),

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
}));
