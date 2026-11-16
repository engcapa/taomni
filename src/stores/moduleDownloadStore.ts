import { create } from "zustand";
import {
  cancelPluginDownload, forgetPluginDownload, listPluginDownloads, resumePluginDownload,
  type ModuleDownloadInfo, type ModuleDownloadListing, type ModuleDownloadProgress,
} from "../lib/ipc/plugin";

interface Adapter {
  list(): Promise<ModuleDownloadListing>;
  cancel(id: string): Promise<ModuleDownloadProgress>;
  resume(id: string): Promise<ModuleDownloadProgress>;
  forget(id: string): Promise<void>;
}

interface State {
  tasks: ModuleDownloadInfo[];
  recoveryErrors: string[];
  error: string | null;
  errors: Record<string, string>;
  busy: Record<string, boolean>;
  loaded: boolean;
  refresh(): Promise<void>;
  cancel(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  forget(id: string): Promise<void>;
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
export const isModuleDownloadActive = (task: ModuleDownloadInfo) =>
  ["connecting", "downloading", "verifying"].includes(task.progress.phase);

/** Native owns network/disk work. This shared projection and pending commands
 * survive Settings unmounts; discovering a saved job never resumes it. */
export function createModuleDownloadStore(adapter: Adapter) {
  let epoch = 0;
  let listing: Promise<void> | null = null;
  const operations = new Map<string, Promise<void>>();
  return create<State>((set) => {
    const run = (id: string, action: "cancel" | "resume" | "forget") => {
      const running = operations.get(id);
      if (running) return running;
      epoch++;
      set((state) => ({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: "" } }));
      const operation = Promise.resolve().then(async () => {
        try {
          const progress = await adapter[action](id);
          epoch++;
          set((state) => ({ tasks: action === "forget" ? state.tasks.filter((task) => task.id !== id)
            : state.tasks.map((task) => task.id === id ? { ...task, progress: progress! } : task) }));
        } catch (reason) {
          epoch++;
          set((state) => ({ errors: { ...state.errors, [id]: message(reason) } }));
        } finally {
          operations.delete(id);
          set((state) => ({ busy: { ...state.busy, [id]: false } }));
        }
      });
      operations.set(id, operation);
      return operation;
    };
    return {
      tasks: [], recoveryErrors: [], error: null, errors: {}, busy: {}, loaded: false,
      refresh() {
        if (listing) return listing;
        const started = epoch;
        listing = Promise.resolve().then(() => adapter.list()).then((result) => {
          if (epoch === started) set({ tasks: result.tasks, recoveryErrors: result.recoveryErrors, error: null, loaded: true });
        }, (reason: unknown) => {
          if (epoch === started) set({ error: message(reason) });
        }).finally(() => { listing = null; });
        return listing;
      },
      cancel: (id) => run(id, "cancel"),
      resume: (id) => run(id, "resume"),
      forget: (id) => run(id, "forget"),
    };
  });
}

export const useModuleDownloadStore = createModuleDownloadStore({
  list: listPluginDownloads, cancel: cancelPluginDownload,
  resume: resumePluginDownload, forget: forgetPluginDownload,
});
