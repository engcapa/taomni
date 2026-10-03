import { create } from "zustand";
import {
  vaultStatus,
  vaultInit,
  vaultUnlock,
  vaultLock,
  vaultChangeMaster,
  vaultDelete,
  vaultList,
  type VaultEntrySummary,
  type VaultStateKind,
} from "../lib/ipc";

interface VaultStore {
  state: VaultStateKind;
  entryCount: number;
  loading: boolean;
  entries: VaultEntrySummary[];

  /** Pull fresh status from the backend (state + entry_count). */
  refresh: () => Promise<void>;
  /** First-time setup. Fails if vault already initialized. */
  init: (masterPassword: string) => Promise<void>;
  /** Unlock with master password. Throws on bad password. */
  unlock: (masterPassword: string) => Promise<void>;
  /** Explicit lock — clears the in-memory root key. */
  lock: () => Promise<void>;
  /** Change master password. Re-encrypts every entry. */
  changeMaster: (oldPassword: string, newPassword: string) => Promise<void>;
  /** Load summary list (label, kind, timestamps — no plaintext). */
  reloadEntries: () => Promise<void>;
  /** Delete one entry by id. Stale `vault:<id>` references will fail to resolve. */
  deleteEntry: (id: string) => Promise<void>;
}

export const useVaultStore = create<VaultStore>((set) => ({
  state: "empty",
  entryCount: 0,
  loading: false,
  entries: [],

  refresh: async () => {
    set({ loading: true });
    try {
      const status = await vaultStatus();
      set({ state: status.state, entryCount: status.entry_count });
    } finally {
      set({ loading: false });
    }
  },

  init: async (masterPassword) => {
    await vaultInit(masterPassword);
    const status = await vaultStatus();
    set({ state: status.state, entryCount: status.entry_count });
  },

  unlock: async (masterPassword) => {
    await vaultUnlock(masterPassword);
    const status = await vaultStatus();
    set({ state: status.state, entryCount: status.entry_count });
  },

  lock: async () => {
    await vaultLock();
    set({ state: "locked", entries: [] });
  },

  changeMaster: async (oldPassword, newPassword) => {
    await vaultChangeMaster(oldPassword, newPassword);
  },

  reloadEntries: async () => {
    const list = await vaultList();
    set({ entries: list, entryCount: list.length });
  },

  deleteEntry: async (id) => {
    await vaultDelete(id);
    const list = await vaultList();
    set({ entries: list, entryCount: list.length });
  },
}));
