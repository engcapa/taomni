import { create } from "zustand";
import {
  dismissNewMarketplaceModules, downloadMarketplaceModule, fetchMarketplaceCatalog, installMarketplaceModule,
  provisionMarketplaceModule, reviewMarketplaceModule,
  type ModuleCatalogSelection, type ModuleDownloadInfo, type ModuleInstallReview, type ModuleMarketplaceCatalog,
} from "../lib/ipc/plugin";
import type { PluginRecord } from "../lib/pluginRegistry";

export const OFFICIAL_MODULE_CATALOG = "https://github.com/engcapa/taomni/releases/latest/download/modules.json";
const SOURCE_KEY = "taomni.module-catalog-source.v1";
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

interface Adapter {
  catalog(url: string): Promise<ModuleMarketplaceCatalog>;
  download(selection: ModuleCatalogSelection, installedVersion?: string): Promise<ModuleDownloadInfo>;
  review(selection: ModuleCatalogSelection): Promise<ModuleInstallReview>;
  install(selection: ModuleCatalogSelection, installedVersion?: string): Promise<PluginRecord>;
  provision(selection: ModuleCatalogSelection, retry: boolean): Promise<void | "restart-required">;
  dismiss(ids: readonly string[]): Promise<void>;
}

interface Review { selection: ModuleCatalogSelection; detail: ModuleInstallReview; installedVersion?: string }
interface State {
  source: string;
  catalog: ModuleMarketplaceCatalog | null;
  catalogSource: string | null;
  loading: boolean;
  error: string | null;
  busy: Record<string, string | undefined>;
  errors: Record<string, string | undefined>;
  review: Review | null;
  dismissError: string | null;
  refresh(source?: string): Promise<void>;
  download(selection: ModuleCatalogSelection, installedVersion?: string): Promise<void>;
  openReview(selection: ModuleCatalogSelection, installedVersion?: string): Promise<void>;
  dismissReview(): void;
  install(): Promise<void>;
  provision(id: string, retry?: boolean): Promise<void>;
  dismissNew(ids: readonly string[]): Promise<void>;
}

function readSource(storage?: Pick<Storage, "getItem">) {
  try { return storage?.getItem(SOURCE_KEY) || OFFICIAL_MODULE_CATALOG; }
  catch { return OFFICIAL_MODULE_CATALOG; }
}

function matchesSelection(catalog: ModuleMarketplaceCatalog, selection: ModuleCatalogSelection) {
  const entry = catalog.catalog.plugins[selection.pluginId];
  const asset = entry?.platforms[catalog.platform];
  return entry?.version === selection.version && asset?.sha256.toLowerCase() === selection.sha256.toLowerCase();
}

/** Commands keep running when Settings unmounts. The native catalog, download
 * manager and installer own trust, files and registry state. */
export function createModuleMarketplaceStore(adapter: Adapter, storage?: Pick<Storage, "getItem" | "setItem">) {
  let revision = 0;
  let sourceRevision = 0;
  const attempted = new Set<string>();
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
    const dropReleaseEntry = (id: string, field: "legacyPending" | "newModules") => {
      set((state) => {
        const catalog = state.catalog;
        if (!catalog?.release?.[field].includes(id)) return state;
        const release = {
          ...catalog.release,
          [field]: catalog.release[field].filter((current) => current !== id),
        };
        if (field === "legacyPending") {
          release.legacyRestartRequired = release.legacyRestartRequired?.filter((current) => current !== id);
          release.legacyImportFailed = release.legacyImportFailed?.filter((current) => current !== id);
        }
        return { catalog: { ...catalog, release } };
      });
    };
    return {
      source: readSource(storage), catalog: null, catalogSource: null, loading: false, error: null, busy: {}, errors: {}, review: null,
      dismissError: null,
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
        if (changed) sourceRevision++;
        set({ source, loading: true, error: null, ...(changed ? { review: null } : {}) });
        const result = adapter.catalog(source).then((catalog) => {
          if (revision !== started) return;
          set((state) => ({
            catalog, catalogSource: source, error: null,
            review: state.review && matchesSelection(catalog, state.review.selection) ? state.review : null,
          }));
          void (async () => {
            for (const id of catalog.release?.legacyPending ?? []) {
              if (revision !== started) return;
              await get().provision(id);
            }
          })();
        }).catch((reason: unknown) => {
          if (revision === started) set({ error: message(reason) });
        }).finally(() => {
          if (revision === started) { pending = null; set({ loading: false }); }
        });
        pending = { source, result };
        return result;
      },
      download(selection, installedVersion) {
        return run(selection, "download", async () => { await adapter.download(selection, installedVersion); });
      },
      openReview(selection, installedVersion) {
        const started = sourceRevision;
        return run(selection, "review", async () => {
          const detail = await adapter.review(selection);
          const { catalog } = get();
          if (sourceRevision === started && (!catalog || matchesSelection(catalog, selection))) {
            set({ review: { selection, detail, installedVersion } });
          }
        });
      },
      dismissReview() { set({ review: null }); },
      install() {
        const review = get().review;
        if (!review) return Promise.resolve();
        return run(review.selection, "install", async () => {
          await adapter.install(review.selection, review.installedVersion);
          dropReleaseEntry(review.selection.pluginId, "newModules");
          dropReleaseEntry(review.selection.pluginId, "legacyPending");
          if (get().review === review) set({ review: null });
        });
      },
      provision(id, retry = false) {
        const snapshot = get().catalog;
        const entry = snapshot?.catalog.plugins[id];
        const asset = snapshot && entry?.platforms[snapshot.platform];
        if (!entry || !asset || !snapshot?.release?.legacyPending.includes(id)) return Promise.resolve();
        if (!retry && (snapshot.release.legacyRestartRequired?.includes(id) || snapshot.release.legacyImportFailed?.includes(id))) {
          return Promise.resolve();
        }
        const selection = { pluginId: id, version: entry.version, sha256: asset.sha256 };
        const attempt = `${id}:${asset.sha256}`;
        const active = operations.get(id);
        if (active) return active;
        if (!retry && attempted.has(attempt)) return Promise.resolve();
        attempted.add(attempt);
        return run(selection, "provision", async () => {
          const result = await adapter.provision(selection, retry);
          if (result === "restart-required") {
            set((state) => {
              const catalog = state.catalog;
              const release = catalog?.release;
              if (!catalog || !release || !matchesSelection(catalog, selection)) return state;
              return {
                catalog: {
                  ...catalog,
                  release: {
                    ...release,
                    legacyRestartRequired: [...new Set([...(release.legacyRestartRequired ?? []), id])],
                    legacyImportFailed: release.legacyImportFailed?.filter((current) => current !== id),
                  },
                },
              };
            });
          } else {
            dropReleaseEntry(id, "legacyPending");
          }
        });
      },
      async dismissNew(ids) {
        set({ dismissError: null });
        try {
          await adapter.dismiss(ids);
          for (const id of ids) dropReleaseEntry(id, "newModules");
        } catch (reason) {
          set({ dismissError: message(reason) });
        }
      },
    };
  });
}

export const useModuleMarketplaceStore = createModuleMarketplaceStore({
  catalog: fetchMarketplaceCatalog, download: downloadMarketplaceModule,
  review: reviewMarketplaceModule, install: installMarketplaceModule,
  provision: provisionMarketplaceModule, dismiss: dismissNewMarketplaceModules,
}, typeof localStorage === "undefined" ? undefined : localStorage);
