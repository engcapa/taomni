import { type StateCreator } from "zustand";
import { t as tr } from "../../lib/i18n";
import { readMergeToolWindowRail, readSidebarCollapsedByGroup, sidebarRailGroup, writeMergeToolWindowRail } from "../sidebarRailPolicy";
import { type AppState, type FloatingMfaWindowState } from "./types";
import { readSidebarCollapsed } from "./preferences";
import { rememberSidebarForActiveGroup } from "./policies";

/** Default bottom-left placement of the floating MFA window (design DEC-03). */
export const FLOATING_MFA_DEFAULT_POSITION = { left: 50, bottom: 30 } as const;
/** Width reserved on the right for the right context sidebar toggle target. */
export const FLOATING_MFA_WIDTH = 280;

export function clampFloatingMfaPosition(
  left: number,
  bottom: number,
  viewport: { width: number; height: number } = viewportSize(),
): { left: number; bottom: number } {
  const maxLeft = Math.max(8, viewport.width - FLOATING_MFA_WIDTH - 8);
  const maxBottom = Math.max(8, viewport.height - 200);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    bottom: Math.min(Math.max(8, bottom), maxBottom),
  };
}

function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
}

export function createInitialFloatingMfaState(): FloatingMfaWindowState {
  return {
    open: false,
    pinned: false,
    position: { ...FLOATING_MFA_DEFAULT_POSITION },
    searchQuery: "",
  };
}

export const createLayoutSlice: StateCreator<AppState, [], [], Pick<AppState, "sidebarCollapsed" | "mergeToolWindowRail" | "sidebarCollapsedByGroup" | "activeSideTab" | "rightSidebarCollapsed" | "floatingMfa" | "statusMessage" | "toggleSidebar" | "setSidebarCollapsed" | "setActiveSideTab" | "toggleRightSidebar" | "setRightSidebarCollapsed" | "toggleFloatingMfa" | "openFloatingMfa" | "closeFloatingMfa" | "setFloatingMfaPosition" | "setFloatingMfaPinned" | "setFloatingMfaSearch" | "setMergeToolWindowRail" | "applySidebarForActiveTab" | "setStatusMessage">> = (set, get) => ({
  sidebarCollapsed: readSidebarCollapsed(),
  mergeToolWindowRail: readMergeToolWindowRail(),
  sidebarCollapsedByGroup: readSidebarCollapsedByGroup(readSidebarCollapsed()),
  activeSideTab: "sessions",
  rightSidebarCollapsed: true,
  floatingMfa: createInitialFloatingMfaState(),
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
  toggleRightSidebar: () => set((s) => ({ rightSidebarCollapsed: !s.rightSidebarCollapsed })),
  setRightSidebarCollapsed: (collapsed) => set({ rightSidebarCollapsed: collapsed }),
  toggleFloatingMfa: () => set((s) => ({ floatingMfa: { ...s.floatingMfa, open: !s.floatingMfa.open } })),
  openFloatingMfa: () => set((s) => ({ floatingMfa: { ...s.floatingMfa, open: true } })),
  closeFloatingMfa: () => set((s) => ({ floatingMfa: { ...s.floatingMfa, open: false } })),
  setFloatingMfaPosition: (left, bottom) =>
    set((s) => ({ floatingMfa: { ...s.floatingMfa, position: clampFloatingMfaPosition(left, bottom) } })),
  setFloatingMfaPinned: (pinned) => set((s) => ({ floatingMfa: { ...s.floatingMfa, pinned } })),
  setFloatingMfaSearch: (searchQuery) => set((s) => ({ floatingMfa: { ...s.floatingMfa, searchQuery } })),
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
