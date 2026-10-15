import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export const GO_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export type GoProtocol = "chat" | "messages" | "responses" | "google";
export interface GoModelEntry {
  id: string;
  name: string;
  protocol: GoProtocol;
  protocol_source: string;
  context_limit: number | null;
  output_limit: number | null;
  cost: Record<string, number> | null;
  input_modalities: string[];
  tool_call: boolean;
  reasoning: boolean;
  interleaved_field: string | null;
  status: string | null;
  training_use: boolean;
  base_url: string | null;
}
export interface GoCatalog {
  models: GoModelEntry[];
  fetched_at: number;
  source: "live" | "cache" | "snapshot";
  last_error: string | null;
}
interface CatalogState extends GoCatalog {
  loading: boolean;
  loaded: boolean;
  refresh: (force?: boolean) => Promise<void>;
  ensureLoaded: (blocked?: boolean) => Promise<void>;
}
let pending: Promise<void> | null = null;
export const useOpencodeGoStore = create<CatalogState>((set, get) => ({
  models: [], fetched_at: 0, source: "snapshot", last_error: null, loading: false, loaded: false,
  refresh: (force = true) => {
    if (pending) return pending;
    set({ loading: true });
    pending = (async () => {
      try {
        const catalog = await invoke<GoCatalog>("get_opencode_go_catalog", { forceRefresh: force });
        set({ ...catalog, loaded: true });
      } catch (error) {
        // IPC failures must not clear the last-good list.
        set({ last_error: String(error) });
      } finally {
        set({ loading: false });
        pending = null;
      }
    })();
    return pending;
  },
  ensureLoaded: async (blocked = false) => {
    await get().refresh(false);
    if (!blocked && Date.now() - get().fetched_at * 1000 > GO_CATALOG_TTL_MS) {
      await get().refresh(true);
    }
  },
}));
