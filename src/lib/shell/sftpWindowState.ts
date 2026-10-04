import { useTransferStore, isTransferActive } from "../../stores/transferStore";
import { trackSftpTransfer } from "../sftpTransferTracking";
import type { TransferItem } from "../sftp";
import type { PanelWindowEnvelope } from "./types";

export interface SftpWindowSnapshot { localPath?: string; remotePath?: string; localSelection?: string[]; remoteSelection?: string[]; jobs: TransferItem[] }
export function readSftpWindowSnapshot(value: unknown, sessionId: string): SftpWindowSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const data = value as SftpWindowSnapshot;
  if (!Array.isArray(data.jobs) || data.jobs.length > 200) return null;
  if ([data.localPath, data.remotePath].some((path) => path !== undefined && typeof path !== "string")) return null;
  if ([data.localSelection, data.remoteSelection].some((paths) => paths !== undefined && (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")))) return null;
  if (data.jobs.some((job) => job.sessionId !== sessionId || typeof job.id !== "string" || typeof job.localPath !== "string" || typeof job.remotePath !== "string" || !["queued", "running", "paused", "done", "error", "cancelled"].includes(job.state) || ![job.size, job.bytes, job.rate, job.eta, job.startedAt].every(Number.isFinite) || !["upload", "download"].includes(job.direction) || !["file", "dir"].includes(job.kind))) return null;
  return data;
}
export async function receiveWindowTransfers(snapshot: SftpWindowSnapshot, envelope: PanelWindowEnvelope) {
  const store = useTransferStore.getState();
  for (const original of snapshot.jobs) {
    const item = { ...original, viewWindowLabel: envelope.windowLabel, originWindowLabel: envelope.windowLabel, panelId: envelope.panelId };
    const current = store.byId(item.id);
    if (current && !isTransferActive(current.state) && isTransferActive(item.state) && current.startedAt === item.startedAt) continue;
    if (!current) store.add({ ...item, state: "queued" });
    store.patch(item.id, { ...item, state: store.byId(item.id)!.state });
    if (isTransferActive(item.state)) {
      store.patch(item.id, { state: item.state });
      await trackSftpTransfer(item.id, item.sessionId);
    } else store.setState(item.id, item.state, item.error ?? undefined);
  }
}
