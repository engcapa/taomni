import { create } from "zustand";
import { EMPTY_EXPLORER_TAB_FILTER, type ExplorerTabFilter } from "../lib/explorerTabFilter";

/** Display-only filter for the Explorer tab strip; it never closes tabs or runtimes. */
export interface ExplorerUiState {
  tabFilter: ExplorerTabFilter;
  setTabFilter: (filter: ExplorerTabFilter) => void;
  clearTabFilter: () => void;
}

export const useExplorerUiStore = create<ExplorerUiState>((set) => ({
  tabFilter: EMPTY_EXPLORER_TAB_FILTER,
  setTabFilter: (tabFilter) => set({ tabFilter }),
  clearTabFilter: () => set({ tabFilter: EMPTY_EXPLORER_TAB_FILTER }),
}));
