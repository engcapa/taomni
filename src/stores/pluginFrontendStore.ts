import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { listPlugins } from "../lib/ipc/plugin";
import { PLUGIN_CORE_API_VERSION, validatePluginManifest, type PluginRecord } from "../lib/pluginRegistry";
import { PLUGIN_REGISTRY_CHANGED, subscribePluginRegistryChanges } from "../lib/pluginRegistryEvents";
import { isTauriRuntime } from "../lib/runtime";

export interface PluginFrontendState {
  records: Readonly<Record<string, PluginRecord>>;
  epochs: Readonly<Record<string, number>>;
  pending: ReadonlySet<string>;
  status: "idle" | "loading" | "ready" | "failed";
  error: string | null;
  refresh: (slug?: string) => Promise<void>;
  attach: () => () => void;
}

export interface PluginFrontendServices {
  list: () => Promise<PluginRecord[]>;
  subscribe: (invalidate: (slug?: string) => void) => Promise<() => void>;
}

function validateRecord(record: PluginRecord): PluginRecord {
  if (record.lifecycle === "uninstalled") return { ...record, manifest: null };
  if (!record.manifest) return record;
  const validation = validatePluginManifest(record.manifest, { coreApiVersion: PLUGIN_CORE_API_VERSION });
  if (!validation.ok || record.slug !== record.manifest.slug) {
    return { ...record, manifest: null, lifecycle: "disabled", reason: validation.errors.join("; ") || "Module identity mismatch" };
  }
  return { ...record, manifest: validation.manifest! };
}

/** One owner per WebView. Pending imports are invalidated before re-reading native state. */
export function createPluginFrontendStore(services: PluginFrontendServices) {
  let sequence = 0;
  let attachments = 0;
  let subscriptionEpoch = 0;
  let unlisten: (() => void) | undefined;
  return create<PluginFrontendState>((set, get) => ({
    records: {}, epochs: {}, pending: new Set(), status: "idle", error: null,
    refresh: async (slug) => {
      const request = ++sequence;
      set((state) => {
        const affected = slug ? [slug] : Object.keys(state.records);
        const epochs = { ...state.epochs };
        const pending = new Set(state.pending);
        for (const owner of affected) {
          epochs[owner] = (epochs[owner] ?? 0) + 1;
          pending.add(owner);
        }
        return { epochs, pending, error: null, status: state.status === "ready" ? "ready" : "loading" };
      });
      try {
        const records = await services.list();
        if (request !== sequence) return;
        const next: Record<string, PluginRecord> = {};
        for (const input of records) {
          const record = validateRecord(input);
          if (Object.hasOwn(next, record.slug)) throw new Error(`Duplicate module ${record.slug}`);
          const previous = get().records[record.slug];
          Object.defineProperty(next, record.slug, {
            value: previous && JSON.stringify(previous) === JSON.stringify(record) ? previous : record,
            enumerable: true,
          });
        }
        set({ records: next, pending: new Set(), status: "ready", error: null });
      } catch (error) {
        if (request !== sequence) return;
        set({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    },
    attach: () => {
      attachments += 1;
      if (attachments === 1) {
        const owner = ++subscriptionEpoch;
        // Register the native listener before the first snapshot, closing the
        // startup race with an installation/disable in another WebView.
        void services.subscribe((slug) => { void get().refresh(slug); }).then((stop) => {
          if (owner !== subscriptionEpoch || attachments === 0) { stop(); return; }
          unlisten = stop;
          void get().refresh();
        }).catch((error) => {
          if (owner === subscriptionEpoch && attachments > 0) {
            set({ status: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        });
      }
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        attachments -= 1;
        if (attachments > 0) return;
        subscriptionEpoch += 1;
        sequence += 1;
        unlisten?.();
        unlisten = undefined;
      };
    },
  }));
}

export const usePluginFrontendStore = createPluginFrontendStore({
  list: listPlugins,
  subscribe: async (invalidate) => {
    const stopLocal = subscribePluginRegistryChanges(invalidate);
    try {
      const stopNative = isTauriRuntime()
        ? await listen<{ slug?: string }>(PLUGIN_REGISTRY_CHANGED, (event) => invalidate(event.payload?.slug))
        : () => undefined;
      return () => { stopLocal(); stopNative(); };
    } catch (error) {
      stopLocal();
      throw error;
    }
  },
});
