import { type StateCreator } from "zustand";
import { type AppState, type FloatingMfaWindowState } from "./types";

/** Default floating MFA window anchor: bottom-left of the main window. */
export const DEFAULT_FLOATING_MFA_POSITION = { left: 50, bottom: 30 };

/** Floating MFA window frame used for viewport clamping while dragging. */
export const FLOATING_MFA_SIZE = { width: 310, height: 400 };

function clampPosition(position: FloatingMfaWindowState["position"]): FloatingMfaWindowState["position"] {
  if (typeof window === "undefined") return position;
  const maxLeft = Math.max(0, window.innerWidth - FLOATING_MFA_SIZE.width);
  const maxBottom = Math.max(0, window.innerHeight - FLOATING_MFA_SIZE.height);
  return {
    left: Math.min(Math.max(0, Math.round(position.left)), maxLeft),
    bottom: Math.min(Math.max(0, Math.round(position.bottom)), maxBottom),
  };
}

export const createPlatformChromeSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | "rightSidebarCollapsed"
    | "toggleRightSidebar"
    | "setRightSidebarCollapsed"
    | "floatingMfa"
    | "toggleFloatingMfa"
    | "setFloatingMfaOpen"
    | "setFloatingMfaPosition"
    | "setFloatingMfaPinned"
    | "setFloatingMfaSearchQuery"
    | "globalSearchOpen"
    | "setGlobalSearchOpen"
    | "toggleGlobalSearch"
  >
> = (set) => ({
  rightSidebarCollapsed: true,
  toggleRightSidebar: () => set((s) => ({ rightSidebarCollapsed: !s.rightSidebarCollapsed })),
  setRightSidebarCollapsed: (collapsed) => set(() => ({ rightSidebarCollapsed: collapsed })),

  floatingMfa: {
    open: false,
    pinned: false,
    position: { ...DEFAULT_FLOATING_MFA_POSITION },
    searchQuery: "",
  },
  toggleFloatingMfa: () =>
    set((s) => ({ floatingMfa: { ...s.floatingMfa, open: !s.floatingMfa.open } })),
  setFloatingMfaOpen: (open) =>
    set((s) => (s.floatingMfa.open === open ? s : { floatingMfa: { ...s.floatingMfa, open } })),
  setFloatingMfaPosition: (left, bottom) =>
    set((s) => ({
      floatingMfa: { ...s.floatingMfa, position: clampPosition({ left, bottom }) },
    })),
  setFloatingMfaPinned: (pinned) =>
    set((s) => ({ floatingMfa: { ...s.floatingMfa, pinned } })),
  setFloatingMfaSearchQuery: (searchQuery) =>
    set((s) => (s.floatingMfa.searchQuery === searchQuery ? s : { floatingMfa: { ...s.floatingMfa, searchQuery } })),

  globalSearchOpen: false,
  setGlobalSearchOpen: (open) => set(() => ({ globalSearchOpen: open })),
  toggleGlobalSearch: () => set((s) => ({ globalSearchOpen: !s.globalSearchOpen })),
});
