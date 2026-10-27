import { create } from "zustand";

/** Shared entry for the toolbar, command palette and keyboard shortcut. */
export const useTabOverviewStore = create<{
  open: boolean;
  toggle: () => void;
  close: () => void;
}>((set) => ({
  open: false,
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));
