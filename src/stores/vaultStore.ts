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
  /** Invalidates sensitive work as soon as a password transition is requested. */
  securityEpoch: number;
  transitionPending: boolean;
  /** Failed lock confirmation keeps the UI gated until an explicit unlock. */
  requiresUnlock: boolean;

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

let transitionQueue: Promise<void> = Promise.resolve();
function serializeTransition(action: () => Promise<void>): Promise<void> {
  const result = transitionQueue.then(action);
  transitionQueue = result.catch(() => undefined);
  return result;
}

let refreshSequence = 0;
export const useVaultStore = create<VaultStore>((set, get) => ({
  state: "empty",
  entryCount: 0,
  loading: false,
  entries: [],
  securityEpoch: 0,
  transitionPending: false,
  requiresUnlock: false,

  refresh: async () => {
    const epoch = get().securityEpoch;
    const sequence = ++refreshSequence;
    set({ loading: true });
    try {
      const status = await vaultStatus();
      if (sequence !== refreshSequence || epoch !== get().securityEpoch || get().transitionPending) return;
      const state = get().requiresUnlock ? "locked" : status.state;
      set({
        state,
        entryCount: status.entry_count,
        securityEpoch: epoch + (state === get().state ? 0 : 1),
      });
    } finally {
      if (sequence === refreshSequence) set({ loading: false });
    }
  },

  init: async (masterPassword) => {
    const epoch = get().securityEpoch + 1;
    set({ securityEpoch: epoch, transitionPending: true });
    try {
      await serializeTransition(async () => {
        await vaultInit(masterPassword);
        const status = await vaultStatus();
        if (epoch === get().securityEpoch) set({ state: status.state, entryCount: status.entry_count, requiresUnlock: false, transitionPending: false });
      });
    } finally {
      if (epoch === get().securityEpoch) set({ transitionPending: false });
    }
  },

  unlock: async (masterPassword) => {
    const epoch = get().securityEpoch + 1;
    set({ securityEpoch: epoch, transitionPending: true });
    try {
      await serializeTransition(async () => {
        await vaultUnlock(masterPassword);
        const status = await vaultStatus();
        if (epoch === get().securityEpoch) set({ state: status.state, entryCount: status.entry_count, requiresUnlock: false, transitionPending: false });
      });
    } finally {
      if (epoch === get().securityEpoch) set({ transitionPending: false });
    }
  },

  lock: async () => {
    const epoch = get().securityEpoch + 1;
    set({ state: "locked", entries: [], securityEpoch: epoch, transitionPending: true, requiresUnlock: true });
    try {
      await serializeTransition(() => vaultLock());
    } finally {
      if (epoch === get().securityEpoch) set({ transitionPending: false });
    }
  },

  changeMaster: async (oldPassword, newPassword) => {
    const epoch = get().securityEpoch + 1;
    set({ securityEpoch: epoch, transitionPending: true });
    try {
      await serializeTransition(() => vaultChangeMaster(oldPassword, newPassword));
    } finally {
      if (epoch === get().securityEpoch) set({ transitionPending: false });
    }
  },

  reloadEntries: async () => {
    const epoch = get().securityEpoch;
    const list = await vaultList();
    if (epoch !== get().securityEpoch || get().transitionPending || get().requiresUnlock) return;
    set({ entries: list, entryCount: list.length });
  },

  deleteEntry: async (id) => {
    const epoch = get().securityEpoch;
    await vaultDelete(id);
    const list = await vaultList();
    if (epoch !== get().securityEpoch || get().transitionPending || get().requiresUnlock) return;
    set({ entries: list, entryCount: list.length });
  },
}));

export function vaultSessionIsCurrent(epoch: number): boolean {
  const state = useVaultStore.getState();
  return state.securityEpoch === epoch && state.state === "unlocked" && !state.transitionPending && !state.requiresUnlock;
}

export function invalidateVaultSensitiveResults(): number {
  const securityEpoch = useVaultStore.getState().securityEpoch + 1;
  useVaultStore.setState({ securityEpoch });
  return securityEpoch;
}

/** Native rejection may precede a status refresh or come from another view. */
export function requireVaultUnlock(): void {
  useVaultStore.setState((state) => ({
    state: "locked",
    entries: [],
    securityEpoch: state.securityEpoch + 1,
    requiresUnlock: true,
    transitionPending: false,
  }));
}
