import { create } from "zustand";
import type { TransferItem, TransferState } from "../lib/sftp";
import { retainSftpResource } from "./sftpStore";
import { shellResourceLeases } from "../lib/shell/panelRegistry";
import { useTaoAlertStore } from "./taoAlertStore";
import { useShellLayoutStore } from "./shellLayoutStore";

const jobReleases = new Map<string, () => void>();
export function isTransferActive(state: TransferState): boolean { return !["done", "error", "cancelled"].includes(state); }
function retainJob(item: TransferItem) {
  if (!isTransferActive(item.state) || jobReleases.has(item.id)) return;
  const releaseConnection = retainSftpResource(item.sessionId);
  const releaseLease = shellResourceLeases.acquire(`sftp:${item.sessionId}`, item.id, "job");
  jobReleases.set(item.id, () => { releaseLease(); void releaseConnection(); });
}
function releaseTerminalJobs(items: TransferItem[]) {
  for (const item of items) if (!isTransferActive(item.state)) { jobReleases.get(item.id)?.(); jobReleases.delete(item.id); }
}

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

  add: (item) => {
    if (get().items.some((existing) => existing.id === item.id)) return;
    retainJob(item);
    set((state) => ({ items: [...state.items, item] }));
  },

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

useTransferStore.subscribe((state, previous) => {
  releaseTerminalJobs(state.items);
  for (const item of previous.items) if (!state.items.some((job) => job.id === item.id)) { jobReleases.get(item.id)?.(); jobReleases.delete(item.id); }
  for (const item of state.items) {
    const before = previous.items.find((job) => job.id === item.id);
    if (!before || before.state === item.state || !["done", "error"].includes(item.state)) continue;
    const panel = Object.values(useShellLayoutStore.getState().panels).find((p) => p.kind === "sftp" &&
      (p.owner.kind === "background" ? p.owner.resourceKey === `sftp:${item.sessionId}` : item.sessionId === `attached-${p.owner.tabId}`));
    useTaoAlertStore.getState().pushTransfer(item.id, item.remotePath ?? item.localPath ?? item.id, item.state === "error", panel?.id);
  }
});
