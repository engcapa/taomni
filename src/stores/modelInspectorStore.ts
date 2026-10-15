import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useAiStore } from "./aiStore";

export interface ModelCheckResult {
  ok: boolean; latency_ms: number | null; error: string | null; checked_at: number;
}
export interface InspectorRow {
  id: string; name: string; protocol: string; protocol_source: string | null;
  context_limit: number | null; output_limit: number | null;
  input_modalities: string[] | null; output_modalities: string[] | null;
  tool_call: boolean | null; reasoning: boolean | null;
  cost: Record<string, number> | null; status: string | null;
  metadata_source: "catalog" | "alias" | "live" | "unlisted";
  live_exists: boolean | null; current: boolean; check: ModelCheckResult | null;
}
export interface ProviderModels {
  rows: InspectorRow[]; fetched_at: number; source: string; last_error: string | null;
  unavailable: boolean; checks_disabled: boolean;
}
interface InspectorEntry {
  data?: ProviderModels; loading: boolean; error: string | null; pending: string[]; batch: boolean;
}
interface InspectorState {
  entries: Record<string, InspectorEntry>;
  load: (providerId: string, force?: boolean) => Promise<void>;
  check: (providerId: string, model: string) => Promise<void>;
  checkAll: (providerId: string) => Promise<void>;
  selectModel: (providerId: string, model: string) => Promise<void>;
}
const emptyEntry = (): InspectorEntry => ({ loading: false, error: null, pending: [], batch: false });
const versions = new Map<string, number>();
export const useModelInspectorStore = create<InspectorState>((set, get) => {
  const patch = (id: string, next: Partial<InspectorEntry>) =>
    set((s) => ({ entries: { ...s.entries, [id]: { ...(s.entries[id] ?? emptyEntry()), ...next } } }));
  const checkOne = async (id: string, model: string) => {
    const entry = get().entries[id] ?? emptyEntry();
    if (entry.pending.includes(model) || entry.data?.checks_disabled) return;
    const config = useAiStore.getState().config;
    const runtime = config?.llm.providers[id]?.runtime;
    if (config?.fully_disabled || (config?.full_local_mode && !["llama-server", "ollama"].includes(runtime ?? ""))) return;
    patch(id, { pending: [...entry.pending, model], error: null });
    try {
      const check = await invoke<ModelCheckResult>("test_llm_model", { providerId: id, model });
      const latest = get().entries[id];
      if (latest?.data) patch(id, { data: {
        ...latest.data, rows: latest.data.rows.map((row) => row.id === model ? { ...row, check } : row),
      } });
    } catch (error) { patch(id, { error: String(error) }); }
    finally { patch(id, { pending: (get().entries[id]?.pending ?? []).filter((m) => m !== model) }); }
  };
  return {
    entries: {},
    load: async (id, force = false) => {
      if (get().entries[id]?.loading && !force) return;
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      patch(id, { loading: true, error: null });
      try {
        const data = await invoke<ProviderModels>("get_provider_models", { providerId: id, forceRefresh: force });
        if (versions.get(id) !== version) return;
        const previous = get().entries[id]?.data;
        // A list read started before a check completed must not erase the new check.
        data.rows = data.rows.map((row) => {
          const old = previous?.rows.find((r) => r.id === row.id)?.check;
          return old && old.checked_at >= (row.check?.checked_at ?? 0) ? { ...row, check: old } : row;
        });
        patch(id, { data, loading: false });
      } catch (error) {
        if (versions.get(id) === version) patch(id, { error: String(error), loading: false });
      }
    },
    check: async (id, model) => { if (!get().entries[id]?.batch) await checkOne(id, model); },
    checkAll: async (id) => {
      const entry = get().entries[id];
      if (!entry?.data || entry.batch || entry.pending.length || entry.data.checks_disabled) return;
      patch(id, { batch: true });
      try { for (const row of entry.data.rows) await checkOne(id, row.id); }
      finally { patch(id, { batch: false }); }
    },
    selectModel: async (id, model) => {
      const { config, saveConfig } = useAiStore.getState();
      if (!config || !config.llm.providers[id]) throw new Error("Unknown provider");
      await saveConfig({ ...config, llm: { ...config.llm, providers: {
        ...config.llm.providers, [id]: { ...config.llm.providers[id], model },
      } } });
    },
  };
});
