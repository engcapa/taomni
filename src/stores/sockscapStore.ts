import { create } from "zustand";
import {
  sockscap,
  type Capabilities,
  type EngineState,
  type RoutingProfile,
  type RuleSource,
  type TrafficTotals,
} from "../lib/sockscap";

// Store for the standalone Sockscap window (plan §11). Holds engine status,
// capabilities, profiles, rule sources and stats, plus the lifecycle actions.
// All mutations route through the Rust commands, which re-validate.

interface SockscapStore {
  status: EngineState | null;
  capabilities: Capabilities | null;
  captureMode: string | null;
  capturePort: number | null;
  profiles: RoutingProfile[];
  ruleSources: RuleSource[];
  stats: TrafficTotals | null;
  loading: boolean;
  busy: boolean;
  error: string | null;

  refreshAll: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshRuleSources: () => Promise<void>;
  refreshStats: () => Promise<void>;

  saveProfile: (profile: RoutingProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;

  start: () => Promise<void>;
  stop: () => Promise<void>;
  recover: () => Promise<void>;
  clearStats: () => Promise<void>;
}

function message(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export const useSockscapStore = create<SockscapStore>((set, get) => ({
  status: null,
  capabilities: null,
  captureMode: null,
  capturePort: null,
  profiles: [],
  ruleSources: [],
  stats: null,
  loading: false,
  busy: false,
  error: null,

  refreshAll: async () => {
    set({ loading: true, error: null });
    try {
      const [status, profiles, ruleSources, stats] = await Promise.all([
        sockscap.status(),
        sockscap.listProfiles(),
        sockscap.listRuleSources(),
        sockscap.statsSnapshot(),
      ]);
      set({
        status: status.state,
        capabilities: status.capabilities,
        captureMode: status.captureMode ?? null,
        capturePort: status.capturePort ?? null,
        profiles,
        ruleSources,
        stats,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: message(e) });
    }
  },

  refreshStatus: async () => {
    try {
      const status = await sockscap.status();
      set({
        status: status.state,
        capabilities: status.capabilities,
        captureMode: status.captureMode ?? null,
        capturePort: status.capturePort ?? null,
      });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  refreshProfiles: async () => {
    try {
      set({ profiles: await sockscap.listProfiles() });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  refreshRuleSources: async () => {
    try {
      set({ ruleSources: await sockscap.listRuleSources() });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  refreshStats: async () => {
    try {
      set({ stats: await sockscap.statsSnapshot() });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  saveProfile: async (profile) => {
    set({ busy: true, error: null });
    try {
      await sockscap.upsertProfile(profile);
      await get().refreshProfiles();
    } catch (e) {
      set({ error: message(e) });
      throw e;
    } finally {
      set({ busy: false });
    }
  },

  deleteProfile: async (id) => {
    set({ busy: true, error: null });
    try {
      await sockscap.deleteProfile(id);
      await get().refreshProfiles();
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },

  start: async () => {
    set({ busy: true, error: null });
    try {
      const state = await sockscap.start();
      set({ status: state });
    } catch (e) {
      set({ error: message(e) });
      await get().refreshStatus();
    } finally {
      set({ busy: false });
    }
  },

  stop: async () => {
    set({ busy: true, error: null });
    try {
      set({ status: await sockscap.stop() });
    } catch (e) {
      set({ error: message(e) });
      await get().refreshStatus();
    } finally {
      set({ busy: false });
    }
  },

  recover: async () => {
    set({ busy: true, error: null });
    try {
      set({ status: await sockscap.recover() });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },

  clearStats: async () => {
    try {
      await sockscap.clearStats();
      await get().refreshStats();
    } catch (e) {
      set({ error: message(e) });
    }
  },
}));
