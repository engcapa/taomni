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
import { useVaultStore } from "./vaultStore";

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

let codesInFlight: Promise<void> | null = null;
export const useMfaStore = create<MfaState>((set, get) => {
  /** Record an IPC failure; a locked vault sends the tab back to its gate. */
  const fail = (err: unknown): never => {
    const code = mfaErrorCode(err);
    set({ error: errorText(err), errorCode: code });
    if (code === "VAULT_LOCKED") void useVaultStore.getState().refresh().catch(() => undefined);
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
      set({ status: "loading", error: null, errorCode: null });
      try {
        const snapshot = await mfaList();
        set({ accounts: snapshot.accounts, prefs: snapshot.prefs ?? DEFAULT_PREFS });
        await get().refreshCodes();
        set({ status: "ready" });
      } catch (err) {
        set({ status: "error" });
        try {
          fail(err);
        } catch {
          // Surfaced through state; callers render the error panel.
        }
      }
    },

    refreshCodes: async (ids) => {
      if (codesInFlight && !ids) return codesInFlight;
      const run = (async () => {
        try {
          const list = await mfaCodes(ids);
          set((state) => {
            const codes = ids ? { ...state.codes } : {};
            for (const code of list) codes[code.id] = code;
            return { codes };
          });
        } catch (err) {
          fail(err);
        }
      })();
      if (!ids) {
        codesInFlight = run.finally(() => {
          codesInFlight = null;
        });
        return codesInFlight;
      }
      return run;
    },

    inspect: (inputs) => mfaInspect(inputs).catch(fail),

    addAccounts: async (inputs, skipDuplicates) => {
      try {
        const result = await mfaAdd(inputs, skipDuplicates);
        if (result.added.length > 0) {
          set((state) => ({ accounts: [...state.accounts, ...result.added], error: null, errorCode: null }));
          await get().refreshCodes(result.added.map((account) => account.id));
        }
        return result;
      } catch (err) {
        return fail(err);
      }
    },

    updateAccount: async (id, patch) => {
      try {
        const updated = await mfaUpdate(id, patch);
        set((state) => ({ accounts: replaceAccount(state.accounts, updated) }));
        return updated;
      } catch (err) {
        return fail(err);
      }
    },

    togglePin: async (id) => {
      const account = get().accounts.find((entry) => entry.id === id);
      if (!account) return;
      await get().updateAccount(id, { ...patchOf(account), pinned: !account.pinned });
    },

    deleteAccount: async (id) => {
      try {
        await mfaDelete(id);
        set((state) => {
          const codes = { ...state.codes };
          delete codes[id];
          return { accounts: state.accounts.filter((account) => account.id !== id), codes };
        });
      } catch (err) {
        fail(err);
      }
    },

    moveAccount: async (movingId, targetId) => {
      const order = moveInCustomOrder(get().accounts, movingId, targetId);
      const previous = get().accounts;
      const rank = new Map(order.map((id, index) => [id, index]));
      set({ accounts: previous.map((account) => ({ ...account, sortOrder: rank.get(account.id) ?? account.sortOrder })) });
      try {
        await mfaReorder(order);
      } catch (err) {
        set({ accounts: previous });
        fail(err);
      }
    },

    hotpNext: async (id) => {
      try {
        const code = await mfaHotpNext(id);
        set((state) => ({
          codes: { ...state.codes, [id]: code },
          accounts: state.accounts.map((account) => (account.id === id ? { ...account, counter: code.counter } : account)),
        }));
      } catch (err) {
        fail(err);
      }
    },

    copyCode: async (id, which = "current") => {
      const code = get().codes[id];
      const digits = which === "next" ? code?.nextCode : code?.code;
      if (!digits) return null;
      await writeText(digits);
      set({ lastCopied: { id, at: Date.now() } });
      // Usage feeds the recent/frequent sorts; a failure here must not undo the copy.
      void mfaMarkUsed(id)
        .then((updated) => set((state) => ({ accounts: replaceAccount(state.accounts, updated) })))
        .catch(() => undefined);
      return digits;
    },

    setSortMode: async (mode) => {
      const prefs = { ...get().prefs, sortMode: mode };
      set({ prefs });
      await mfaSetPrefs(prefs).catch(fail);
    },

    setGroupFilter: async (group) => {
      const prefs = { ...get().prefs, groupFilter: group };
      set({ prefs });
      await mfaSetPrefs(prefs).catch(fail);
    },

    setQuery: (query) => set({ query }),

    resetStore: async () => {
      try {
        await mfaResetStore();
      } catch (err) {
        fail(err);
      }
      set({ accounts: [], codes: {} });
      await get().load();
    },

    clearError: () => set({ error: null, errorCode: null }),
  };
});
