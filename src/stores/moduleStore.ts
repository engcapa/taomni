import { create } from "zustand";
import {
  type ModuleRecord,
  type ModuleStoreState,
  type ModuleTransition,
  createModuleStoreState,
  reduceModuleStore,
} from "../lib/moduleStore";
import type { PluginRecord } from "../lib/pluginRegistry";

export function projectModuleRecord(record: PluginRecord): ModuleRecord {
  return {
    slug: record.slug,
    version: record.manifest?.version ?? "0.0.0",
    activeVersion: record.lifecycle === "uninstalled" || record.reason ? undefined : record.manifest?.version,
    previousVersion: record.previousVersion,
    lifecycle: record.lifecycle,
    dataRetained: record.dataRetained === true,
    error: record.reason,
  };
}

export interface ModuleStore extends ModuleStoreState {
  apply: (slug: string, transition: ModuleTransition) => void;
  hydrate: (records: ModuleRecord[]) => void;
  update: (record: ModuleRecord) => void;
}

/** Renderer projection of native module lifecycle state for the settings UI. */
export const useModuleStore = create<ModuleStore>((set) => ({
  ...createModuleStoreState(),
  apply: (slug, transition) => set((state) => reduceModuleStore(state, slug, transition)),
  hydrate: (records) => set(createModuleStoreState(records)),
  update: (record) => set((state) => ({ records: { ...state.records, [record.slug]: record }, revision: state.revision + 1 })),
}));

