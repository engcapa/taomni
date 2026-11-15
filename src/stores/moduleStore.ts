import { create } from "zustand";
import {
  type ModuleRecord,
  type ModuleStoreState,
  type ModuleTransition,
  createModuleStoreState,
  reduceModuleStore,
} from "../lib/moduleStore";

export interface ModuleStore extends ModuleStoreState {
  apply: (slug: string, transition: ModuleTransition) => void;
  hydrate: (records: ModuleRecord[]) => void;
}

/** Renderer projection of native module lifecycle state for the settings UI. */
export const useModuleStore = create<ModuleStore>((set) => ({
  ...createModuleStoreState(),
  apply: (slug, transition) => set((state) => reduceModuleStore(state, slug, transition)),
  hydrate: (records) => set(createModuleStoreState(records)),
}));

