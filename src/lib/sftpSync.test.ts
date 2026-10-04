import { afterEach, describe, expect, it, vi } from "vitest";
import { useTransferStore } from "../stores/transferStore";
import type { TransferItem } from "./sftp";
import { attachSftpSync, detachSftpSync } from "./sftpSync";
import { mergeTransferSnapshot } from "./sftpTransferSnapshot";

vi.mock("../stores/sftpStore", () => ({ retainSftpResource: () => async () => undefined }));
const job = (id: string, bytes = 0, state: TransferItem["state"] = "queued"): TransferItem => ({
  id, sessionId: id, direction: "upload", kind: "file", localPath: "/local", remotePath: "/remote",
  bytes, size: 100, rate: 0, eta: 0, state, startedAt: 1,
});
class PeerChannel {
  static current: PeerChannel;
  onmessage?: (event: MessageEvent) => void;
  postMessage = vi.fn();
  close = vi.fn();
  constructor() { PeerChannel.current = this; }
  receive(items: TransferItem[], from = "peer", takeovers: string[] = []) { this.onmessage?.({ data: { type: "items", from, items, takeovers } } as MessageEvent); }
}
afterEach(() => { detachSftpSync(); useTransferStore.setState({ items: [] }); vi.unstubAllGlobals(); });

describe("SFTP job mirroring", () => {
  it("keeps concurrent local and peer jobs, publishes only owned jobs and clears only the peer's rows", () => {
    vi.stubGlobal("BroadcastChannel", PeerChannel);
    attachSftpSync();
    const channel = PeerChannel.current;
    useTransferStore.getState().add(job("local", 20, "running"));
    channel.receive([job("remote", 10, "running")]);
    expect(useTransferStore.getState().items.map((item) => item.id)).toEqual(["local", "remote"]);
    useTransferStore.getState().patch("local", { bytes: 40 });
    expect(channel.postMessage.mock.lastCall?.[0].items.map((item: TransferItem) => item.id)).toEqual(["local"]);
    channel.receive([job("local"), job("remote", 50, "running")]);
    expect(useTransferStore.getState().byId("local")?.bytes).toBe(40);
    channel.receive([]);
    expect(useTransferStore.getState().items.map((item) => item.id)).toEqual(["local"]);
  });
  it("preserves native progress ahead of a delayed snapshot and a terminal result ahead of stale active state", () => {
    const current = { ...job("remote", 70, "running"), viewWindowLabel: "child", panelId: "files" };
    expect(mergeTransferSnapshot(current, job("remote", 10, "running"))).toBe(current);
    expect(mergeTransferSnapshot(current, job("remote"))).toBe(current);
    const completed = { ...current, bytes: 100, state: "done" as const };
    expect(mergeTransferSnapshot(completed, job("remote", 100, "running"))).toBe(completed);
    const final = mergeTransferSnapshot(current, job("remote", 100, "done"));
    expect(final).toMatchObject({ bytes: 100, state: "done", viewWindowLabel: "child", panelId: "files" });
  });
  it("accepts an explicit retry but rejects a delayed snapshot from its previous attempt", () => {
    const completed = job("remote", 100, "done");
    const retry = { ...job("remote"), startedAt: 2 };
    expect(mergeTransferSnapshot(completed, retry).state).toBe("queued");
    expect(mergeTransferSnapshot(retry, completed)).toBe(retry);
  });
  it("publishes a retry initiated here and ignores the previous owner's delayed response", () => {
    vi.stubGlobal("BroadcastChannel", PeerChannel);
    attachSftpSync();
    const channel = PeerChannel.current;
    channel.receive([job("remote", 100, "error")]);
    useTransferStore.getState().patch("remote", { startedAt: 2, bytes: 0, state: "queued" });
    expect(channel.postMessage.mock.lastCall?.[0]).toMatchObject({ takeovers: ["remote"], items: [{ id: "remote", startedAt: 2, state: "queued" }] });
    channel.receive([job("remote", 100, "done")], "peer", ["remote"]);
    expect(useTransferStore.getState().byId("remote")).toMatchObject({ startedAt: 2, bytes: 0, state: "queued" });
  });
  it("announces verified interrupted-window adoption even when bytes and state stay unchanged", () => {
    vi.stubGlobal("BroadcastChannel", PeerChannel);
    attachSftpSync();
    const channel = PeerChannel.current;
    channel.receive([{ ...job("remote", 50, "running"), viewWindowLabel: "child", originWindowLabel: "child" }]);
    useTransferStore.getState().patch("remote", { viewWindowLabel: undefined });
    expect(channel.postMessage.mock.lastCall?.[0]).toMatchObject({ takeovers: ["remote"], items: [{ id: "remote", bytes: 50, state: "running", viewWindowLabel: undefined }] });
  });
});
