import { create } from "zustand";
import { getModuleNetworkConfig, saveModuleNetworkConfig, type ModuleNetworkConfig } from "../lib/ipc/plugin";

interface Adapter {
  load(): Promise<ModuleNetworkConfig>;
  save(config: ModuleNetworkConfig): Promise<void>;
}

interface State {
  config: ModuleNetworkConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load(): Promise<void>;
  save(config: ModuleNetworkConfig): Promise<void>;
  retry(): Promise<void>;
}

/** Save ownership survives Settings unmounts. Serialize writes so slow old
 * requests cannot overwrite a newer mode or independently saved proxy. */
export function createModuleNetworkStore(adapter: Adapter) {
  let revision = 0;
  let loading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  return create<State>((set, get) => ({
    config: null, loading: false, saving: false, error: null,
    load() {
      if (loading) return loading;
      if (get().saving) return writes;
      // Keep a failed draft and its retry available when Settings reopens.
      if (get().config) return Promise.resolve();
      const started = revision;
      set({ loading: true, error: null });
      loading = adapter.load().then((config) => {
        if (revision === started) set({ config, error: null });
      }).catch((reason: unknown) => {
        if (revision === started) set({ error: reason instanceof Error ? reason.message : String(reason) });
      }).finally(() => {
        loading = null;
        set({ loading: false });
      });
      return loading;
    },
    save(config) {
      const saved = ++revision;
      set({ config, saving: true, error: null });
      const operation = writes.then(() => adapter.save(config));
      // Keep the queue alive after a rejected save. Only the latest request
      // publishes status; an old failure cannot overwrite newer success.
      writes = operation.catch(() => undefined);
      return operation.then(() => {
        if (revision === saved) set({ saving: false, error: null });
      }, (reason: unknown) => {
        if (revision === saved) set({ saving: false, error: reason instanceof Error ? reason.message : String(reason) });
        throw reason;
      });
    },
    retry() {
      const config = get().config;
      return config ? get().save(config) : get().load();
    },
  }));
}

export const useModuleNetworkStore = createModuleNetworkStore({ load: getModuleNetworkConfig, save: saveModuleNetworkConfig });
