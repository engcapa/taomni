/**
 * Cross-window mirror for the SFTP UI.
 *
 * Each Taomni window — main app or detached SFTP window — runs its own
 * `transferStore` and own `sftpStore`. When the user opens an SFTP browser
 * in its own window we want both windows to stay in sync:
 *
 *   1. The transfer queue (uploads/downloads kicked off in either window)
 *   2. The last terminal cwd hint — only the main window observes terminal
 *      OSC 7 responses, so a detached SFTP window has to be told the latest
 *      cwd available for explicit user-triggered sync.
 *
 * We use a single `BroadcastChannel` so messages stay scoped to same-origin
 * windows and never round-trip through the disk. Each broadcast is tagged
 * with a sender id and we ignore our own echoes to keep the loop
 * terminating.
 */
import { useTransferStore } from "../stores/transferStore";
import type { TransferItem } from "./sftp";
import { mergeTransferSnapshot } from "./sftpTransferSnapshot";

const CHANNEL = "taomni.sftp.sync";
const senderId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type ItemsMessage = {
  type: "items";
  from: string;
  items: TransferItem[];
  takeovers?: string[];
};

type CwdMessage = {
  type: "cwd";
  from: string;
  sessionId: string;
  cwd: string | null;
};

type RequestSnapshotMessage = {
  type: "request-snapshot";
  from: string;
};

type SyncMessage = ItemsMessage | CwdMessage | RequestSnapshotMessage;

type CwdListener = (sessionId: string, cwd: string | null) => void;

let channel: BroadcastChannel | null = null;
let unsubscribeStore: (() => void) | null = null;
let lastBroadcast = "";
let suppressNextBroadcast = false;
const transferOwners = new Map<string, string>();
const pendingTakeovers = new Set<string>();
const cwdListeners = new Set<CwdListener>();
const lastCwd = new Map<string, string | null>();

function snapshot(items: TransferItem[]): string {
  return items
    .map(
      (it) =>
        `${it.id}|${it.state}|${it.bytes}|${it.size}|${it.error ?? ""}|${it.finishedAt ?? 0}`,
    )
    .join(";");
}

function dispatch(msg: SyncMessage): void {
  if (!channel) return;
  try {
    channel.postMessage(msg);
  } catch {
    /* channel may have been closed */
  }
}

function ownedItems(items: TransferItem[]): TransferItem[] {
  return items.filter((item) => {
    if (!transferOwners.has(item.id) && !item.viewWindowLabel) transferOwners.set(item.id, senderId);
    return transferOwners.get(item.id) === senderId;
  });
}

export function attachSftpSync(): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  if (channel) return detachSftpSync;

  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => {};
  }

  channel.onmessage = (event: MessageEvent<SyncMessage>) => {
    const msg = event.data;
    if (!msg || msg.from === senderId) return;
    if (msg.type === "items") {
      // Each window publishes its own jobs. A full peer snapshot must neither
      // erase another window's rows nor echo stale progress back to its owner.
      const incomingIds = new Set(msg.items.map((item) => item.id));
      const items = useTransferStore.getState().items.filter((item) =>
        transferOwners.get(item.id) !== msg.from || incomingIds.has(item.id));
      for (const incoming of msg.items) {
        const owner = transferOwners.get(incoming.id);
        const index = items.findIndex((item) => item.id === incoming.id);
        const current = index < 0 ? undefined : items[index];
        if (current && incoming.startedAt < current.startedAt) continue;
        const takeover = msg.takeovers?.includes(incoming.id) === true;
        if (owner && owner !== msg.from && !takeover && !(current && incoming.startedAt > current.startedAt)) continue;
        transferOwners.set(incoming.id, msg.from);
        const merged = mergeTransferSnapshot(current, incoming);
        const item = takeover ? { ...merged, viewWindowLabel: incoming.viewWindowLabel } : merged;
        if (index < 0) items.push(item);
        else items[index] = item;
      }
      suppressNextBroadcast = true;
      useTransferStore.setState({ items });
      return;
    }
    if (msg.type === "cwd") {
      lastCwd.set(msg.sessionId, msg.cwd);
      cwdListeners.forEach((fn) => {
        try {
          fn(msg.sessionId, msg.cwd);
        } catch (err) {
          console.warn("[sftp-sync] cwd listener threw:", err);
        }
      });
      return;
    }
    if (msg.type === "request-snapshot") {
      // A peer just woke up and wants our current state. Push items and
      // any cwd hints we've cached locally so it can populate immediately.
      dispatch({
        type: "items",
        from: senderId,
        items: ownedItems(useTransferStore.getState().items),
      });
      lastCwd.forEach((cwd, sessionId) => {
        dispatch({ type: "cwd", from: senderId, sessionId, cwd });
      });
      return;
    }
  };

  unsubscribeStore = useTransferStore.subscribe((state, previous) => {
    if (!suppressNextBroadcast) {
      for (const item of state.items) {
        const before = previous.items.find((row) => row.id === item.id);
        if (before && (item.startedAt > before.startedAt || before.viewWindowLabel && !item.viewWindowLabel)) {
          // A retry initiated here owns the new attempt. The checked native
          // window lifecycle may also adopt an interrupted view's live job.
          transferOwners.set(item.id, senderId);
          pendingTakeovers.add(item.id);
        }
      }
    }
    const items = ownedItems(state.items);
    if (suppressNextBroadcast) {
      suppressNextBroadcast = false;
      lastBroadcast = snapshot(items);
      return;
    }
    const sig = snapshot(items);
    if (sig === lastBroadcast && !pendingTakeovers.size) return;
    lastBroadcast = sig;
    dispatch({ type: "items", from: senderId, items, takeovers: [...pendingTakeovers] });
    pendingTakeovers.clear();
  });

  // Ask peers for any state they already have (transfer rows + cwd hints)
  // so a freshly-opened detached window catches up without waiting for the
  // next user action.
  dispatch({ type: "request-snapshot", from: senderId });

  return detachSftpSync;
}

export function detachSftpSync(): void {
  unsubscribeStore?.();
  unsubscribeStore = null;
  try {
    channel?.close();
  } catch {
    /* noop */
  }
  channel = null;
  transferOwners.clear();
  pendingTakeovers.clear();
  lastBroadcast = "";
  suppressNextBroadcast = false;
}

/** Broadcast the latest terminal cwd hint for `sessionId`. */
export function broadcastCwdHint(sessionId: string, cwd: string | null): void {
  if (lastCwd.get(sessionId) === cwd) return;
  lastCwd.set(sessionId, cwd);
  dispatch({ type: "cwd", from: senderId, sessionId, cwd });
}

/** Subscribe to cwd-hint updates broadcast by other windows. */
export function subscribeCwdHint(fn: CwdListener): () => void {
  cwdListeners.add(fn);
  return () => {
    cwdListeners.delete(fn);
  };
}

/** Most-recent cwd we've seen for `sessionId` (from any window). */
export function getLatestCwdHint(sessionId: string): string | null {
  return lastCwd.get(sessionId) ?? null;
}
