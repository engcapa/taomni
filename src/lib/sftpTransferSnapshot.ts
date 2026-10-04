import type { TransferItem } from "./sftp";

/** Merge a mirrored job without rolling an acknowledged attempt backwards. */
export function mergeTransferSnapshot(current: TransferItem | undefined, incoming: TransferItem): TransferItem {
  if (!current) return incoming;
  if (incoming.startedAt < current.startedAt) return current;
  const terminal = (item: TransferItem) => ["done", "error", "cancelled"].includes(item.state);
  if (incoming.startedAt === current.startedAt && (
    terminal(current)
    || !terminal(incoming) && (incoming.bytes < current.bytes
      || incoming.state === "queued" && current.state !== "queued")
  )) return current;
  return {
    ...incoming,
    bytes: incoming.startedAt === current.startedAt ? Math.max(current.bytes, incoming.bytes) : incoming.bytes,
    viewWindowLabel: current.viewWindowLabel ?? incoming.viewWindowLabel,
    originWindowLabel: current.originWindowLabel ?? incoming.originWindowLabel,
    panelId: current.panelId ?? incoming.panelId,
  };
}
