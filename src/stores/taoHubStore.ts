import { create } from "zustand";

/**
 * Tao Hub is the two-tab surface (Chat | 便签) reached through the Tao Ribbon.
 * The hub tab is a top-level UI concern shared by chat and notes, so it lives
 * in its own store rather than in chatStore (which stays chat-only) or
 * notesStore (notes data).
 */
export type TaoHubTab = "chat" | "notes";

const HUB_TAB_STORAGE_KEY = "taomni.taoHub.lastTab.v1";

function readLastTab(): TaoHubTab {
  if (typeof window === "undefined") return "chat";
  try {
    const raw = window.localStorage.getItem(HUB_TAB_STORAGE_KEY);
    return raw === "notes" ? "notes" : "chat";
  } catch {
    return "chat";
  }
}

function writeLastTab(tab: TaoHubTab): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HUB_TAB_STORAGE_KEY, tab);
  } catch {
    // Best-effort UI preference persistence.
  }
}

interface TaoHubStore {
  /** The active Tao Hub tab; persisted so the ribbon reopens the last-used one. */
  hubTab: TaoHubTab;
  setHubTab: (tab: TaoHubTab) => void;
}

export const useTaoHubStore = create<TaoHubStore>((set) => ({
  hubTab: readLastTab(),
  setHubTab: (tab) => {
    writeLastTab(tab);
    set({ hubTab: tab });
  },
}));
