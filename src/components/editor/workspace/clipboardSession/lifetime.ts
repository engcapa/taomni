import { readTextResult, writeText, type ClipboardTextReadResult } from "../../../../lib/clipboard";
import {
  type ClipboardConsumerLease,
  type ClipboardPermissionAdapter,
  type GuardedClipboardIO,
  type GuardedSystemEffect,
  type GuardedSystemReadResult,
  type GuardedSystemWriteResult,
  type WorkspaceClipboardHandle,
  type WorkspaceClipboardSnapshot,
  type WorkspaceClipboardSnapshotV3,
  type WorkspaceSlotState,
} from "./model";
import { createDefaultClipboardPermissionAdapter } from "./permissions";
import { WorkspaceClipboardStore } from "./store";

export const slotStatesByWorkspace = new Map<string, WorkspaceSlotState>();

export function getOrCreateSlot(workspaceInstanceId: string): WorkspaceSlotState {
  let slot = slotStatesByWorkspace.get(workspaceInstanceId);
  if (!slot) {
    slot = {
      store: new WorkspaceClipboardStore(),
      payloadRevision: 0,
      historyRevision: 0,
      policyRevision: 0,
      permissionGeneration: 1,
      lifecycleRevision: 0,
      permission: "unknown",
      consumers: new Map(),
      listeners: new Set(),
      rootAcquisitions: 0,
      leaseSeq: 0,
      cachedSnapshot: null,
      cachedRevision: "",
    };
    slotStatesByWorkspace.set(workspaceInstanceId, slot);
  }
  return slot;
}

/**
 * Acquire one handle for an editor host instance. Refcounted per workspace
 * instance: the last `release()` clears and deletes the slot immediately, so
 * closing a workspace cannot leak its clipboard payload (§8.18.4/§8.27.2 lifecycle).
 */
export function acquireClipboardStore(
  workspaceInstanceId: string,
  options?: { permissionAdapter?: ClipboardPermissionAdapter; },
): WorkspaceClipboardHandle {
  const slot = getOrCreateSlot(workspaceInstanceId);
  slot.rootAcquisitions += 1;
  let handleReleased = false;

  const getSnapshot = (): WorkspaceClipboardSnapshotV3 => {
    const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
    const combinedRevision = `${current.payloadRevision}:${current.historyRevision}:${current.policyRevision}:${current.permissionGeneration}:${current.lifecycleRevision}:${current.consumers.size}`;
    if (!current.cachedSnapshot || current.cachedRevision !== combinedRevision) {
      current.cachedSnapshot = buildWorkspaceClipboardSnapshot(current);
      current.cachedRevision = combinedRevision;
    }
    return current.cachedSnapshot;
  };

  const notify = () => {
    const current = slotStatesByWorkspace.get(workspaceInstanceId);
    if (!current || current.listeners.size === 0) return;
    const snap = getSnapshot();
    for (const listener of current.listeners) {
      try {
        listener(snap);
      } catch {
        // ignore subscriber errors (§8.27.2 subscriber throw isolation)
      }
    }
  };

  const handle: WorkspaceClipboardHandle = {
    workspaceId: workspaceInstanceId,
    attachConsumer(consumerId?: string, kind: string = "editor"): ClipboardConsumerLease {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      current.leaseSeq += 1;
      const token = `lease-${workspaceInstanceId}-${current.leaseSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const id = consumerId || `anon-${current.leaseSeq}`;

      const entry = { token, id, kind };
      current.consumers.set(token, entry);
      current.lifecycleRevision += 1;
      notify();

      let active = true;
      const detachFn = function() {
        if (!active) return "already-detached";
        active = false;
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        if (liveSlot && liveSlot.consumers.has(token)) {
          liveSlot.consumers.delete(token);
          liveSlot.lifecycleRevision += 1;
          notify();
          return "detached";
        }
        return "already-detached";
      };

      const lease = Object.assign(detachFn, {
        token,
        consumerId: id,
        kind,
        detach: detachFn,
      }) as ClipboardConsumerLease;
      return lease;
    },
    getSnapshot,
    subscribe(listener) {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      current.listeners.add(listener);
      return () => {
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        liveSlot?.listeners.delete(listener);
      };
    },
    write: (input) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const session = current.store.write(input);
      current.payloadRevision += 1;
      if (current.store.historyExclusion() === "recorded") {
        current.historyRevision += 1;
      }
      notify();
      return session;
    },
    read: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.read();
    },
    clear: (reason) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.read() !== null || current.store.historyEntries().length > 0) {
        current.payloadRevision += 1;
        current.historyRevision += 1;
        current.store.clear(reason);
        notify();
      }
    },
    release() {
      if (handleReleased) return;
      handleReleased = true;
      const current = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!current) return;
      current.rootAcquisitions = Math.max(0, current.rootAcquisitions - 1);
      current.lifecycleRevision += 1;
      notify();
      if (current.rootAcquisitions > 0) {
        return;
      }
      // Deferred by a microtask so a synchronous view remount (cleanup →
      // setup in one commit) does not transiently wipe the payload; if no
      // re-acquire happens, the slot really is going away.
      queueMicrotask(() => {
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        if (!liveSlot || liveSlot.rootAcquisitions > 0) return;
        slotStatesByWorkspace.delete(workspaceInstanceId);
        liveSlot.store.clear("workspace-close");
        liveSlot.consumers.clear();
        liveSlot.listeners.clear();
      });
    },
    historyEntries: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyEntries();
    },
    pasteFromHistory(index) {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const session = current.store.pasteFromHistory(index);
      if (session) {
        current.payloadRevision += 1;
        notify();
      }
      return session;
    },
    removeHistoryEntry: (index) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const removed = current.store.removeHistoryEntry(index);
      if (removed) {
        current.historyRevision += 1;
        notify();
      }
      return removed;
    },
    clearHistory: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.historyEntries().length > 0) {
        current.historyRevision += 1;
        current.store.clearHistory();
        notify();
      }
    },
    setHistoryEnabled: (enabled) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.isHistoryEnabled() !== enabled) {
        current.policyRevision += 1;
        current.store.setHistoryEnabled(enabled);
        if (!enabled) {
          current.historyRevision += 1;
        }
        notify();
      }
    },
    isHistoryEnabled: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.isHistoryEnabled();
    },
    setHistoryLimits: (maxItems, maxTotalBytes) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const oldLimits = current.store.historyLimits();
      const nextItems = Math.min(50, Math.max(1, Math.floor(maxItems)));
      const nextBytes = Math.max(1024, Math.floor(maxTotalBytes));
      if (oldLimits.maxItems !== nextItems || oldLimits.maxTotalBytes !== nextBytes) {
        current.policyRevision += 1;
        current.store.setHistoryLimits(nextItems, nextBytes);
        notify();
      }
    },
    historyLimits: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyLimits();
    },
    historyExclusion: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyExclusion();
    },
    setPermission: (permission) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission !== permission) {
        current.permission = permission;
        current.permissionGeneration += 1;
        notify();
      }
    },
    permission: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.permission;
    },
    attachPermissionAdapter: (adapter: ClipboardPermissionAdapter) => {
      void handle.syncPermission(adapter);
      if (typeof adapter.subscribe === "function") {
        return adapter.subscribe((perm) => {
          handle.setPermission(perm);
        });
      }
      return () => { };
    },
    syncPermission: async (adapter?: ClipboardPermissionAdapter) => {
      const activeAdapter = adapter ?? createDefaultClipboardPermissionAdapter();
      try {
        const perm = await activeAdapter.queryPermission();
        handle.setPermission(perm);
        return perm;
      } catch {
        return handle.permission();
      }
    },
    writeSystemClipboard: async (text: string, io?: GuardedClipboardIO): Promise<GuardedSystemWriteResult> => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission === "denied") {
        return { outcome: "denied", systemEffect: "not-performed" };
      }
      const baseGeneration = current.permissionGeneration;
      const writeFn = io?.writeText ?? writeText;
      try {
        await writeFn(text);
      } catch (err) {
        return {
          outcome: "unavailable",
          error: err instanceof Error ? err.message : String(err),
          systemEffect: "unknown",
        };
      }
      const postSlot = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!postSlot || postSlot.permissionGeneration !== baseGeneration) {
        return {
          outcome: "stale-generation",
          baseGeneration,
          currentGeneration: postSlot ? postSlot.permissionGeneration : -1,
          systemEffect: "performed",
        };
      }
      if (postSlot.permission === "denied") {
        return { outcome: "denied", systemEffect: "performed" };
      }
      return { outcome: "success", systemEffect: "performed" };
    },
    readSystemClipboard: async (io?: GuardedClipboardIO): Promise<GuardedSystemReadResult> => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission === "denied") {
        return { outcome: "denied", systemEffect: "not-performed", fallbackSession: current.store.read() };
      }
      const baseGeneration = current.permissionGeneration;
      const readFn = io?.readTextResult ?? readTextResult;
      let res: ClipboardTextReadResult;
      try {
        res = await readFn();
      } catch (err) {
        const postSlot = slotStatesByWorkspace.get(workspaceInstanceId) ?? current;
        return {
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          systemEffect: "unknown",
          fallbackSession: postSlot.store.read(),
        };
      }
      const systemEffect: GuardedSystemEffect = res.ok ? "performed" : "unknown";
      const postSlot = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!postSlot || postSlot.permissionGeneration !== baseGeneration) {
        return {
          outcome: "stale-generation",
          baseGeneration,
          currentGeneration: postSlot ? postSlot.permissionGeneration : -1,
          systemEffect,
          fallbackSession: postSlot ? postSlot.store.read() : null,
        };
      }
      if (postSlot.permission === "denied") {
        return { outcome: "denied", systemEffect: "performed", fallbackSession: postSlot.store.read() };
      }
      if (!res.ok) {
        return { outcome: "unavailable", systemEffect: "unknown", fallbackSession: postSlot.store.read() };
      }
      return { outcome: "success", text: res.text, systemEffect: "performed" };
    },
  };

  if (options?.permissionAdapter) {
    handle.attachPermissionAdapter(options.permissionAdapter);
  }

  return handle;
}

/**
 * Single-slot store accessor retained for non-lifecycle call sites (context
 * menus, tests). New editor hosts must use `acquireClipboardStore`.
 */
export function clipboardStoreForWorkspace(workspaceId: string): WorkspaceClipboardStore {
  const slot = getOrCreateSlot(workspaceId);
  return slot.store;
}

/** Test/diagnostic reset of every workspace slot. */
export function resetWorkspaceClipboardStores(): void {
  slotStatesByWorkspace.clear();
}

export function buildWorkspaceClipboardSnapshot(slot: WorkspaceSlotState): WorkspaceClipboardSnapshot {
  return {
    payloadRevision: slot.payloadRevision,
    historyRevision: slot.historyRevision,
    policyRevision: slot.policyRevision,
    permissionGeneration: slot.permissionGeneration,
    lifecycleRevision: slot.lifecycleRevision,
    permission: slot.permission,
    consumers: Array.from(slot.consumers.values()),
    revision: slot.payloadRevision,
    history: slot.store.historyEntries(),
    exclusion: slot.store.historyExclusion(),
    isHistoryEnabled: slot.store.isHistoryEnabled(),
    limits: slot.store.historyLimits(),
    consumerCount: slot.consumers.size,
  };
}
