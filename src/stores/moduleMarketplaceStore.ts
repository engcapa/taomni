import { create } from "zustand";
import {
  downloadMarketplaceModule, fetchMarketplaceCatalog, installMarketplaceModule, reviewMarketplaceModule,
  type ModuleCatalogSelection, type ModuleDownloadInfo, type ModuleInstallReview, type ModuleMarketplaceCatalog,
} from "../lib/ipc/plugin";
import type { PluginRecord } from "../lib/pluginRegistry";

export const OFFICIAL_MODULE_CATALOG = "https://github.com/engcapa/taomni/releases/latest/download/modules.json";
const SOURCE_KEY = "taomni.module-catalog-source.v1";
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

interface Adapter {
  catalog(url: string): Promise<ModuleMarketplaceCatalog>;
  download(selection: ModuleCatalogSelection): Promise<ModuleDownloadInfo>;
  review(selection: ModuleCatalogSelection): Promise<ModuleInstallReview>;
  install(selection: ModuleCatalogSelection): Promise<PluginRecord>;
}

interface Review { selection: ModuleCatalogSelection; detail: ModuleInstallReview }
interface State {
  source: string;
  catalog: ModuleMarketplaceCatalog | null;
  catalogSource: string | null;
  loading: boolean;
  error: string | null;
  busy: Record<string, string | undefined>;
  errors: Record<string, string | undefined>;
  review: Review | null;
  refresh(source?: string): Promise<void>;
  download(selection: ModuleCatalogSelection): Promise<void>;
  openReview(selection: ModuleCatalogSelection): Promise<void>;
  dismissReview(): void;
  install(): Promise<void>;
}

function readSource(storage?: Pick<Storage, "getItem">) {
  try { return storage?.getItem(SOURCE_KEY) || OFFICIAL_MODULE_CATALOG; }
  catch { return OFFICIAL_MODULE_CATALOG; }
}

/** Commands keep running when Settings unmounts. The native catalog, download
 * manager and installer own trust, files and registry state. */
export function createModuleMarketplaceStore(adapter: Adapter, storage?: Pick<Storage, "getItem" | "setItem">) {
  let revision = 0;
  let pending: { source: string; result: Promise<void> } | null = null;
  const operations = new Map<string, Promise<void>>();
  return create<State>((set, get) => {
    const run = (selection: ModuleCatalogSelection, action: string, operation: () => Promise<void>) => {
      const id = selection.pluginId;
      const pending = operations.get(id);
      if (pending) return pending;
      set((state) => ({ busy: { ...state.busy, [id]: action }, errors: { ...state.errors, [id]: undefined } }));
      const result = Promise.resolve().then(operation).catch((reason: unknown) => {
        set((state) => ({ errors: { ...state.errors, [id]: message(reason) } }));
      }).finally(() => {
        operations.delete(id);
        set((state) => ({ busy: { ...state.busy, [id]: undefined } }));
      });
      operations.set(id, result);
      return result;
    };
    return {
      source: readSource(storage), catalog: null, catalogSource: null, loading: false, error: null, busy: {}, errors: {}, review: null,
      refresh(source = get().source) {
        source = source.trim();
        if (pending?.source === source) return pending.result;
        try {
          const parsed = new URL(source);
          if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("Use an HTTP(S) catalog URL without credentials or a fragment");
          storage?.setItem(SOURCE_KEY, source);
        } catch (reason) {
          set({ error: message(reason) });
          return Promise.resolve();
        }
        const started = ++revision;
        const changed = source !== get().source;
        set({ source, loading: true, error: null, ...(changed ? { review: null } : {}) });
        const result = adapter.catalog(source).then((catalog) => {
          if (revision === started) set({ catalog, catalogSource: source, error: null });
        }).catch((reason: unknown) => {
          if (revision === started) set({ error: message(reason) });
        }).finally(() => {
          if (revision === started) { pending = null; set({ loading: false }); }
        });
        pending = { source, result };
        return result;
      },
      download(selection) { return run(selection, "download", async () => { await adapter.download(selection); }); },
      openReview(selection) {
        const started = revision;
        return run(selection, "review", async () => {
          const detail = await adapter.review(selection);
          if (revision === started) set({ review: { selection, detail } });
        });
      },
      dismissReview() { set({ review: null }); },
      install() {
        const review = get().review;
        if (!review) return Promise.resolve();
        return run(review.selection, "install", async () => {
          await adapter.install(review.selection);
          if (get().review === review) set({ review: null });
        });
      },
    };
  });
}

export const useModuleMarketplaceStore = createModuleMarketplaceStore({
  catalog: fetchMarketplaceCatalog, download: downloadMarketplaceModule,
  review: reviewMarketplaceModule, install: installMarketplaceModule,
}, typeof localStorage === "undefined" ? undefined : localStorage);
