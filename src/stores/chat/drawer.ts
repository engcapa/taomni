import type { StoreApi } from "zustand";
import { latestTabThread, rememberedTabThread, resolveDefaultProviderId } from "./context";
import { type ChatStore } from "./model";
import { clampDrawerFloatingOpacity, clampDrawerHeight, clampDrawerWidth, writeDrawerLayoutPrefs } from "./preferences";

export function createChatDrawerActions(set: StoreApi<ChatStore>["setState"], get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "toggleDrawer" | "setDrawerOpen" | "dismissDrawer" | "hideDrawer" | "setDrawerWidth" | "setDrawerHeight" | "setDrawerPosition" | "setDrawerPinned" | "setDrawerFloatingOpacity" | "setRibbonPlacement" | "openTabChat" | "toggleTabChat" | "syncTabChatWithActiveTab"> {
  return {

    toggleDrawer: () => {
      const s = get();
      const tabId = s.drawerScope === "tab" ? s.drawerTabId : null;
      set({
        drawerOpen: !s.drawerOpen,
        ...(s.drawerOpen && tabId
          ? { tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false } }
          : {}),
      });
    },
    setDrawerOpen: (open) => {
      set({ drawerOpen: open });
    },
    dismissDrawer: () => {
      const s = get();
      const tabId = s.drawerScope === "tab" ? s.drawerTabId : null;
      set({
        drawerOpen: false,
        ...(tabId
          ? { tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false } }
          : {}),
      });
    },
    hideDrawer: () => {
      get().dismissDrawer();
    },
    setDrawerWidth: (w) => {
      const width = clampDrawerWidth(w);
      writeDrawerLayoutPrefs({ width });
      set({ drawerWidth: width });
    },
    setDrawerHeight: (h) => {
      const height = clampDrawerHeight(h);
      writeDrawerLayoutPrefs({ height });
      set({ drawerHeight: height });
    },
    setDrawerPosition: (position) => {
      const pinned = position === "left" || position === "right";
      writeDrawerLayoutPrefs({ position, pinned });
      set({ drawerPosition: position, drawerPinned: pinned });
    },
    setDrawerPinned: (pinned) => {
      // Any edge can now be pinned (top/bottom dock as a horizontal band; §8).
      writeDrawerLayoutPrefs({ pinned });
      set({ drawerPinned: pinned });
    },
    setDrawerFloatingOpacity: (opacity) => {
      const floatingOpacity = clampDrawerFloatingOpacity(opacity);
      writeDrawerLayoutPrefs({ floatingOpacity });
      set({ drawerFloatingOpacity: floatingOpacity });
    },
    setRibbonPlacement: (position, offsetRatio) => {
      const pinned = position === "left" || position === "right";
      const ribbonOffsetRatio = Math.min(1, Math.max(0, offsetRatio));
      writeDrawerLayoutPrefs({ position, pinned, ribbonOffsetRatio });
      set({ drawerPosition: position, drawerPinned: pinned, ribbonOffsetRatio });
    },

    openTabChat: async (tabId: string) => {
      if (!tabId) return;
      if (!get().threadsLoaded) {
        await get().loadThreads();
      }
      let thread = rememberedTabThread(
        get().threads,
        get().activeThreadIdByTabId,
        tabId,
      ) ?? latestTabThread(get().threads, tabId);
      if (!thread) {
        const defaultProviderId = await resolveDefaultProviderId();
        thread = await get().newThread(defaultProviderId ?? undefined, tabId);
      }
      set((s) => ({
        activeThreadId: thread.id,
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: tabId,
        tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: true },
        activeThreadIdByTabId: { ...s.activeThreadIdByTabId, [tabId]: thread.id },
      }));
      // Opening the thread clears any pending "AI reply ready" ribbon alert.
      void import("../taoAlertStore")
        .then((m) => m.useTaoAlertStore.getState().clearThread(thread.id))
        .catch(() => { });
    },

    toggleTabChat: async (tabId: string) => {
      if (!tabId) return;
      const s = get();
      if (s.drawerOpen && s.drawerScope === "tab" && s.drawerTabId === tabId) {
        set({
          drawerOpen: false,
          tabDrawerOpenByTabId: { ...s.tabDrawerOpenByTabId, [tabId]: false },
        });
        return;
      }
      await get().openTabChat(tabId);
    },

    syncTabChatWithActiveTab: async (tabId: string | null) => {
      const s = get();

      if (!tabId) {
        if (s.drawerOpen) {
          set({ drawerOpen: false, drawerTabId: null });
        }
        return;
      }

      if (s.tabDrawerOpenByTabId[tabId]) {
        await get().openTabChat(tabId);
        return;
      }

      if (s.drawerScope === "tab" && s.drawerOpen) {
        set({ drawerOpen: false, drawerTabId: tabId });
      }
    }
  };
}
