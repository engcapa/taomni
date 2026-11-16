import { create } from "zustand";
import { writeText } from "../lib/clipboard";
import { errorText, mfaErrorCode, type MfaErrorCode } from "../lib/mfa/format";
import {
  mfaAdd,
  mfaCodes,
  mfaDelete,
  mfaHotpNext,
  mfaInspect,
  mfaList,
  mfaMarkUsed,
  mfaReorder,
  mfaResetStore,
  mfaSetPrefs,
  mfaUpdate,
} from "../lib/mfa/ipc";
import { moveInCustomOrder } from "../lib/mfa/sort";
import type {
  MfaAccount,
  MfaAccountInput,
  MfaAccountPatch,
  MfaAddResult,
  MfaCode,
  MfaInspectItem,
  MfaPrefs,
  MfaSortMode,
} from "../lib/mfa/types";
import { useVaultStore, vaultSessionIsCurrent as vaultCurrent, invalidateVaultSensitiveResults, requireVaultUnlock } from "./vaultStore";

export type MfaLoadStatus = "idle" | "loading" | "ready" | "error";

interface MfaState {
  status: MfaLoadStatus;
  error: string | null;
  errorCode: MfaErrorCode | null;
  accounts: MfaAccount[];
  codes: Record<string, MfaCode>;
  prefs: MfaPrefs;
  query: string;
  lastCopied: { id: string; at: number } | null;

  load: () => Promise<void>;
  refreshCodes: (ids?: string[]) => Promise<void>;
  inspect: (inputs: MfaAccountInput[]) => Promise<MfaInspectItem[]>;
  addAccounts: (inputs: MfaAccountInput[], skipDuplicates: boolean) => Promise<MfaAddResult>;
  updateAccount: (id: string, patch: MfaAccountPatch) => Promise<MfaAccount>;
  togglePin: (id: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  moveAccount: (movingId: string, targetId: string) => Promise<void>;
  hotpNext: (id: string) => Promise<void>;
  /** Copy the current (or next) code; returns the copied digits. */
  copyCode: (id: string, which?: "current" | "next") => Promise<string | null>;
  setSortMode: (mode: MfaSortMode) => Promise<void>;
  setGroupFilter: (group: string) => Promise<void>;
  setQuery: (query: string) => void;
  resetStore: () => Promise<void>;
  clearError: () => void;
}

const DEFAULT_PREFS: MfaPrefs = { sortMode: "custom", groupFilter: "" };

function patchOf(account: MfaAccount): MfaAccountPatch {
  return {
    issuer: account.issuer,
    accountName: account.accountName,
    group: account.group,
    note: account.note,
    pinned: account.pinned,
  };
}

function replaceAccount(accounts: MfaAccount[], next: MfaAccount): MfaAccount[] {
  return accounts.map((account) => (account.id === next.id ? next : account));
}

let resetPending = false;
function vaultSessionIsCurrent(epoch: number): boolean {
  return !resetPending && vaultCurrent(epoch);
}

function requireSession(epoch: number): void {
  if (!vaultSessionIsCurrent(epoch)) throw new Error("VAULT_LOCKED");
}

let codesInFlight: { epoch: number; promise: Promise<void> } | null = null;
export const useMfaStore = create<MfaState>((set, get) => {
  /** Record an IPC failure; a locked vault sends the tab back to its gate. */
  const fail = (err: unknown, epoch: number): never => {
    if (!vaultSessionIsCurrent(epoch)) throw err;
    const code = mfaErrorCode(err);
    if (code === "VAULT_LOCKED") {
      requireVaultUnlock();
      set({ status: "error", error: errorText(err), errorCode: code });
      void useVaultStore.getState().refresh().catch(() => undefined);
    } else set({ error: errorText(err), errorCode: code });
    throw err;
  };

  return {
    status: "idle",
    error: null,
    errorCode: null,
    accounts: [],
    codes: {},
    prefs: DEFAULT_PREFS,
    query: "",
    lastCopied: null,

    load: async () => {
      const epoch = useVaultStore.getState().securityEpoch;
      if (!vaultSessionIsCurrent(epoch)) return;
      set({ status: "loading", error: null, errorCode: null });
      try {
        const snapshot = await mfaList();
        if (!vaultSessionIsCurrent(epoch)) return;
        set({ accounts: snapshot.accounts, prefs: snapshot.prefs ?? DEFAULT_PREFS });
        await get().refreshCodes();
        if (!vaultSessionIsCurrent(epoch)) return;
        set({ status: "ready" });
      } catch (err) {
        if (!vaultSessionIsCurrent(epoch)) return;
        set({ status: "error" });
        try {
          fail(err, epoch);
        } catch {
          // Surfaced through state; callers render the error panel.
        }
      }
    },

    refreshCodes: async (ids) => {
      const epoch = useVaultStore.getState().securityEpoch;
      if (!vaultSessionIsCurrent(epoch)) return;
      if (codesInFlight?.epoch === epoch && !ids) return codesInFlight.promise;
      const run = (async () => {
        try {
          const list = await mfaCodes(ids);
          if (!vaultSessionIsCurrent(epoch)) return;
          set((state) => {
            const codes = ids ? { ...state.codes } : {};
            for (const code of list) codes[code.id] = code;
            return { codes };
          });
        } catch (err) {
          if (vaultSessionIsCurrent(epoch)) fail(err, epoch);
        }
      })();
      if (!ids) {
        const pending: { epoch: number; promise: Promise<void> } = { epoch, promise: run.finally(() => {
          if (codesInFlight === pending) codesInFlight = null;
        }) };
        codesInFlight = pending;
        return pending.promise;
      }
      return run;
    },

    inspect: async (inputs) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      try {
        const result = await mfaInspect(inputs);
        requireSession(epoch);
        return result;
      } catch (err) {
        return fail(err, epoch);
      }
    },

    addAccounts: async (inputs, skipDuplicates) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      try {
        const result = await mfaAdd(inputs, skipDuplicates);
        requireSession(epoch);
        if (result.added.length > 0) {
          set((state) => ({ accounts: [...state.accounts, ...result.added], error: null, errorCode: null }));
          await get().refreshCodes(result.added.map((account) => account.id));
        }
        requireSession(epoch);
        return result;
      } catch (err) {
        return fail(err, epoch);
      }
    },

    updateAccount: async (id, patch) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      try {
        const updated = await mfaUpdate(id, patch);
        requireSession(epoch);
        set((state) => ({ accounts: replaceAccount(state.accounts, updated) }));
        return updated;
      } catch (err) {
        return fail(err, epoch);
      }
    },

    togglePin: async (id) => {
      const account = get().accounts.find((entry) => entry.id === id);
      if (!account) return;
      await get().updateAccount(id, { ...patchOf(account), pinned: !account.pinned });
    },

    deleteAccount: async (id) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      try {
        await mfaDelete(id);
        requireSession(epoch);
        set((state) => {
          const codes = { ...state.codes };
          delete codes[id];
          return { accounts: state.accounts.filter((account) => account.id !== id), codes };
        });
      } catch (err) {
        fail(err, epoch);
      }
    },

    moveAccount: async (movingId, targetId) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      const order = moveInCustomOrder(get().accounts, movingId, targetId);
      const previous = get().accounts;
      const rank = new Map(order.map((id, index) => [id, index]));
      set({ accounts: previous.map((account) => ({ ...account, sortOrder: rank.get(account.id) ?? account.sortOrder })) });
      try {
        await mfaReorder(order);
      } catch (err) {
        if (vaultSessionIsCurrent(epoch)) set({ accounts: previous });
        fail(err, epoch);
      }
    },

    hotpNext: async (id) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      try {
        const code = await mfaHotpNext(id);
        requireSession(epoch);
        set((state) => ({
          codes: { ...state.codes, [id]: code },
          accounts: state.accounts.map((account) => (account.id === id ? { ...account, counter: code.counter } : account)),
        }));
      } catch (err) {
        fail(err, epoch);
      }
    },

    copyCode: async (id, which = "current") => {
      const epoch = useVaultStore.getState().securityEpoch;
      if (!vaultSessionIsCurrent(epoch)) return null;
      const code = get().codes[id];
      const digits = which === "next" ? code?.nextCode : code?.code;
      if (!digits) return null;
      await writeText(digits);
      if (!vaultSessionIsCurrent(epoch)) return null;
      set({ lastCopied: { id, at: Date.now() } });
      // Usage feeds the recent/frequent sorts; a failure here must not undo the copy.
      void mfaMarkUsed(id)
        .then((updated) => {
          if (vaultSessionIsCurrent(epoch)) set((state) => ({ accounts: replaceAccount(state.accounts, updated) }));
        })
        .catch(() => undefined);
      return digits;
    },

    setSortMode: async (mode) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      const prefs = { ...get().prefs, sortMode: mode };
      set({ prefs });
      await mfaSetPrefs(prefs).catch((err: unknown) => fail(err, epoch));
    },

    setGroupFilter: async (group) => {
      const epoch = useVaultStore.getState().securityEpoch;
      requireSession(epoch);
      const prefs = { ...get().prefs, groupFilter: group };
      set({ prefs });
      await mfaSetPrefs(prefs).catch((err: unknown) => fail(err, epoch));
    },

    setQuery: (query) => set({ query }),

    resetStore: async () => {
      requireSession(useVaultStore.getState().securityEpoch);
      resetPending = true;
      const epoch = invalidateVaultSensitiveResults();
      set({ status: "loading" });
      try {
        await mfaResetStore();
      } catch (err) {
        resetPending = false;
        if (vaultSessionIsCurrent(epoch)) set({ status: "error" });
        fail(err, epoch);
      } finally {
        resetPending = false;
      }
      requireSession(epoch);
      set({ accounts: [], codes: {} });
      await get().load();
    },

    clearError: () => set({ error: null, errorCode: null }),
  };
});

// A lock request invalidates all prior async work before its native barrier
// finishes. Each new epoch has its own code request, including after re-unlock.
useVaultStore.subscribe((next, previous) => {
  if (next.securityEpoch === previous.securityEpoch && (next.state === "unlocked" || next.state === previous.state)) return;
  codesInFlight = null;
  useMfaStore.setState({ status: "idle", accounts: [], codes: {}, error: null, errorCode: null, lastCopied: null });
});
