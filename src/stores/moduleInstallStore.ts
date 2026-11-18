import { create } from "zustand";
import { installPluginArchive, listPlugins } from "../lib/ipc/plugin";
import type { PluginRecord } from "../lib/pluginRegistry";
import { projectModuleRecord, useModuleStore } from "./moduleStore";

export type ModuleInstallPhase = "idle" | "verifying" | "completed" | "failed";

export interface ModuleInstallState {
  archivePath: string;
  detachedSignature: string;
  phase: ModuleInstallPhase;
  validationError: boolean;
  error: string | null;
  refreshError: string | null;
  installed: PluginRecord | null;
  completionRevision: number;
  setArchivePath: (path: string) => void;
  setDetachedSignature: (signature: string) => void;
  install: () => Promise<PluginRecord | null>;
}

interface InstallServices {
  install: typeof installPluginArchive;
  list: typeof listPlugins;
  hydrate: (records: PluginRecord[]) => void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The operation and draft belong to the app, independently of Settings. */
export function createModuleInstallStore(services: InstallServices) {
  let running: Promise<PluginRecord | null> | null = null;
  return create<ModuleInstallState>((set, get) => ({
    archivePath: "",
    detachedSignature: "",
    phase: "idle",
    validationError: false,
    error: null,
    refreshError: null,
    installed: null,
    completionRevision: 0,
    setArchivePath: (archivePath) => {
      if (get().phase === "verifying") return;
      set({ archivePath, phase: "idle", validationError: false, error: null, refreshError: null });
    },
    setDetachedSignature: (detachedSignature) => {
      if (get().phase === "verifying") return;
      set({ detachedSignature, phase: "idle", validationError: false, error: null, refreshError: null });
    },
    install: () => {
      if (running) return running;
      const archivePath = get().archivePath.trim();
      const detachedSignature = get().detachedSignature.trim();
      if (!archivePath || !detachedSignature) {
        set({ phase: "failed", validationError: true, error: null, refreshError: null });
        return Promise.resolve(null);
      }
      set({ phase: "verifying", validationError: false, error: null, refreshError: null, installed: null });
      running = Promise.resolve().then(async () => {
        try {
          // Native owns signature checking, archive safety and activation. No
          // optimistic lifecycle transition is made before this resolves.
          const installed = await services.install(archivePath, { detachedSignature });
          let refreshError: string | null = null;
          try {
            services.hydrate(await services.list());
          } catch (reason) {
            refreshError = message(reason);
          }
          set((state) => ({
            phase: "completed", installed, refreshError,
            completionRevision: state.completionRevision + 1,
          }));
          return installed;
        } catch (reason) {
          set({ phase: "failed", error: message(reason), installed: null });
          return null;
        } finally {
          running = null;
        }
      });
      return running;
    },
  }));
}

export const useModuleInstallStore = createModuleInstallStore({
  install: installPluginArchive,
  list: listPlugins,
  hydrate: (records) => useModuleStore.getState().hydrate(records.map(projectModuleRecord)),
});
