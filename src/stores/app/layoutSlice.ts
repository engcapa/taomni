import { type StateCreator } from "zustand";
import { t as tr } from "../../lib/i18n";
import { readMergeToolWindowRail, readSidebarCollapsedByGroup, sidebarRailGroup, writeMergeToolWindowRail } from "../sidebarRailPolicy";
import { type AppState } from "./types";
import { readSidebarCollapsed } from "./preferences";
import { rememberSidebarForActiveGroup } from "./policies";

export const createLayoutSlice: StateCreator<AppState, [], [], Pick<AppState, "sidebarCollapsed" | "mergeToolWindowRail" | "sidebarCollapsedByGroup" | "activeSideTab" | "statusMessage" | "toggleSidebar" | "setSidebarCollapsed" | "setActiveSideTab" | "setMergeToolWindowRail" | "applySidebarForActiveTab" | "setStatusMessage">> = (set, get) => ({
  sidebarCollapsed: readSidebarCollapsed(),
  mergeToolWindowRail: readMergeToolWindowRail(),
  sidebarCollapsedByGroup: readSidebarCollapsedByGroup(readSidebarCollapsed()),
  activeSideTab: "sessions",
  statusMessage: tr("status.ready"),

  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      return { sidebarCollapsed, ...rememberSidebarForActiveGroup(s, sidebarCollapsed) };
    }),
  setSidebarCollapsed: (collapsed) => {
    set((s) => ({ sidebarCollapsed: collapsed, ...rememberSidebarForActiveGroup(s, collapsed) }));
  },
  setActiveSideTab: (tab) => {
    set((s) => ({ activeSideTab: tab, sidebarCollapsed: false, ...rememberSidebarForActiveGroup(s, false) }));
  },
  setMergeToolWindowRail: (value) => {
    writeMergeToolWindowRail(value);
    set({ mergeToolWindowRail: value });
  },
  applySidebarForActiveTab: () => {
    const s = get();
    if (!s.mergeToolWindowRail) return;
    const active = s.tabs.find((tab) => tab.id === s.activeTabId);
    const collapsed = s.sidebarCollapsedByGroup[sidebarRailGroup(active?.type)];
    if (collapsed === s.sidebarCollapsed) return;
    // Applying a group's state is not a manual change: the legacy key keeps
    // the "other" group's state for the next launch.
    set({ sidebarCollapsed: collapsed });
  },

  setStatusMessage: (message) =>
    set((s) => (s.statusMessage === message ? s : { statusMessage: message }))
});
