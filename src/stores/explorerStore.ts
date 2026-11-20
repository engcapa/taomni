import { create } from "zustand";
import type { Tab } from "../types";
import { guardViewerClose } from "../lib/openFile/closeGuard";

export interface ExplorerStoreState {
  tabs: Tab[];
  activeTabId: string | null;
  openTab: (tab: Tab, afterActive?: boolean) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeTabs: (ids: string[]) => void;
  updateExplorerPath: (id: string, path: string, title: string) => void;
  updateViewerMode: (id: string, mode: NonNullable<Tab["fileViewer"]>["mode"]) => void;
  renameTab: (id: string, title: string) => void;
  moveTab: (id: string, toIndex: number) => void;
}

export const useExplorerStore = create<ExplorerStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (tab, afterActive = false) => set((state) => {
    if (state.tabs.some((item) => item.id === tab.id)) return { activeTabId: tab.id };
    const tabs = [...state.tabs];
    const activeIndex = tabs.findIndex((item) => item.id === state.activeTabId);
    const index = afterActive && activeIndex >= 0 ? activeIndex + 1 : tabs.length;
    tabs.splice(index, 0, tab);
    return { tabs, activeTabId: tab.id };
  }),

  setActiveTab: (id) => {
    if (get().tabs.some((tab) => tab.id === id)) set({ activeTabId: id });
  },

  closeTab: (id) => get().closeTabs([id]),

  closeTabs: (ids) => {
    const requested = new Set(ids);
    const closing = get().tabs.filter((tab) => requested.has(tab.id));
    if (!closing.length) return;
    const proceed = () => set((state) => {
      const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const tabs = state.tabs.filter((tab) => !requested.has(tab.id));
      const activeTabId = state.activeTabId && requested.has(state.activeTabId)
        ? tabs[Math.min(Math.max(activeIndex, 0), Math.max(tabs.length - 1, 0))]?.id ?? null
        : state.activeTabId;
      return { tabs, activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null };
    });
    guardViewerClose(closing.flatMap((tab) => tab.fileViewer ? [tab.fileViewer.path] : []), proceed);
  },

  updateExplorerPath: (id, path, title) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.id === id && tab.fileBrowser
      ? { ...tab, title, fileBrowser: { ...tab.fileBrowser, initialPath: path, explorer: true } }
      : tab),
  })),

  updateViewerMode: (id, mode) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.id === id && tab.fileViewer
      ? { ...tab, fileViewer: { ...tab.fileViewer, mode } }
      : tab),
  })),

  renameTab: (id, title) => set((state) => ({
    tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, title } : tab),
  })),

  moveTab: (id, toIndex) => set((state) => {
    const from = state.tabs.findIndex((tab) => tab.id === id);
    if (from < 0) return state;
    const to = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
    if (from === to) return state;
    const tabs = [...state.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(to, 0, tab);
    return { tabs };
  }),
}));

export function activeExplorerTab(): Tab | undefined {
  const state = useExplorerStore.getState();
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}
