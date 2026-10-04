import { afterEach, describe, expect, it, vi } from "vitest";
import { useTransferStore, adoptWindowTransfers } from "../../stores/transferStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { readSftpWindowSnapshot, receiveWindowTransfers } from "./sftpWindowState";
import type { PanelWindowEnvelope } from "./types";
import type { TransferItem } from "../sftp";

const boundary = vi.hoisted(() => ({ progress: null as ((payload: any) => void) | null, complete: null as ((payload: any) => void) | null, detach: vi.fn().mockResolvedValue(undefined), off: vi.fn() }));
vi.mock("../sftp", async (importOriginal) => ({ ...await importOriginal<typeof import("../sftp")>(),
  listenSftpProgress: async (_id: string, fn: (payload: any) => void) => { boundary.progress = fn; return boundary.off; },
  listenSftpPaused: async () => boundary.off,
  listenSftpComplete: async (_id: string, fn: (payload: any) => void) => { boundary.complete = fn; return boundary.off; },
  sftpDetach: boundary.detach,
}));
const envelope: PanelWindowEnvelope = { version: 1, operationId: "operation", panelId: "files:owner", generation: 1, windowLabel: "sftp-child", event: "snapshot" };
const job: TransferItem = { id: "native-job", sessionId: "channel__detached", kind: "file", direction: "upload", localPath: "/local/中文.bin", remotePath: "/remote/中文.bin", bytes: 10, size: 100, eta: 1, rate: 10, state: "running", startedAt: 1 };
afterEach(() => { useTransferStore.setState({ items: [] }); useTaoAlertStore.getState().clearAll(); boundary.detach.mockClear(); boundary.off.mockClear(); vi.restoreAllMocks(); });
describe("SFTP window job ownership", () => {
  it("keeps a foreign view's lease in that view, then adopts and releases its real channel after destruction", async () => {
    await receiveWindowTransfers({ jobs: [job] }, envelope);
    expect(useTransferStore.getState().byId(job.id)?.viewWindowLabel).toBe(envelope.windowLabel);
    expect(boundary.detach).not.toHaveBeenCalled();
    adoptWindowTransfers(envelope.windowLabel);
    expect(useTransferStore.getState().byId(job.id)?.viewWindowLabel).toBeUndefined();
    boundary.progress!({ bytes: 70, total: 100, rate: 10, eta: 1 });
    expect(useTransferStore.getState().byId(job.id)?.bytes).toBe(70);
    boundary.complete!({ success: true });
    expect(useTransferStore.getState().byId(job.id)?.state).toBe("done");
    expect(boundary.detach).toHaveBeenCalledExactlyOnceWith(job.sessionId);
    expect(useTaoAlertStore.getState().transfer).toHaveLength(1);
    expect(boundary.off).toHaveBeenCalledTimes(3);
    await receiveWindowTransfers({ jobs: [job] }, envelope);
    expect(useTransferStore.getState().byId(job.id)?.state).toBe("done");
    expect(useTaoAlertStore.getState().transfer).toHaveLength(1);
  });
  it("imports a terminal snapshot once without retaining or closing the live child's channel", async () => {
    await receiveWindowTransfers({ jobs: [{ ...job, id: "finished-job", state: "error", error: "Network failed" }] }, envelope);
    const finishedAt = useTransferStore.getState().byId("finished-job")?.finishedAt;
    expect(useTaoAlertStore.getState().transfer).toHaveLength(1);
    expect(boundary.detach).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue((finishedAt ?? 0) + 5000);
    await receiveWindowTransfers({ jobs: [{ ...job, id: "finished-job", state: "error" }] }, envelope);
    expect(useTransferStore.getState().byId("finished-job")?.finishedAt).toBe(finishedAt);
    expect(useTaoAlertStore.getState().transfer).toHaveLength(1);
  });
  it("rejects invalid metadata and another connection's jobs at the window boundary", () => {
    expect(readSftpWindowSnapshot({ jobs: [job] }, job.sessionId)).not.toBeNull();
    expect(readSftpWindowSnapshot({ jobs: [job] }, "another-channel")).toBeNull();
    expect(readSftpWindowSnapshot({ jobs: [{ ...job, bytes: NaN }] }, job.sessionId)).toBeNull();
    expect(readSftpWindowSnapshot({ jobs: [], localSelection: [false] }, job.sessionId)).toBeNull();
  });
});
