import { create } from "zustand";
import type { TransferItem, TransferState } from "../lib/sftp";

interface TransferStoreState {
  items: TransferItem[];
  add: (item: TransferItem) => void;
  patch: (id: string, patch: Partial<TransferItem>) => void;
  remove: (id: string) => void;
  clearCompleted: () => void;
  setState: (id: string, state: TransferState, error?: string) => void;
  byId: (id: string) => TransferItem | undefined;
  bySession: (sessionId: string) => TransferItem[];
}

export const useTransferStore = create<TransferStoreState>((set, get) => ({
  items: [],

  add: (item) =>
    set((state) => ({ items: [...state.items, item] })),

  patch: (id, patch) =>
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    })),

  remove: (id) =>
    set((state) => ({ items: state.items.filter((it) => it.id !== id) })),

  clearCompleted: () =>
    set((state) => ({
      items: state.items.filter(
        (it) => it.state !== "done" && it.state !== "cancelled",
      ),
    })),

  setState: (id, transferState, error) =>
    set((state) => ({
      items: state.items.map((it) =>
        it.id === id
          ? {
              ...it,
              state: transferState,
              error: error ?? it.error,
              finishedAt:
                transferState === "done" ||
                transferState === "error" ||
                transferState === "cancelled"
                  ? Date.now()
                  : it.finishedAt,
            }
          : it,
      ),
    })),

  byId: (id) => get().items.find((it) => it.id === id),
  bySession: (sessionId) => get().items.filter((it) => it.sessionId === sessionId),
}));

export function newTransferId(): string {
  return `xfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
