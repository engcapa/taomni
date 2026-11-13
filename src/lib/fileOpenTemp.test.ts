import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./openFile", () => ({ openFile: vi.fn(async () => "viewer") }));
vi.mock("./sftp", () => ({ sftpStat: vi.fn(async () => ({ fileType: "file" })) }));
vi.mock("./viewer", () => ({ viewerCreateTemp: vi.fn(async (name: string) => ({ path: `/controlled/${name}`, token: "token" })), viewerReleaseTemp: vi.fn(async () => {}) }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("controlled temporary file opening", () => {
  it("deduplicates overlapping downloads, keeps context and marks every open read-only", async () => {
    const { openTemporaryFile } = await import("./fileOpenTemp");
    const { openFile } = await import("./openFile");
    let done!: () => void;
    const download = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
    const request = { key: "mail:1", fileName: "a.txt", source: "mail-attachment" as const, readOnlyReason: "Mail read-only", download };
    const a = openTemporaryFile(request, { context: "mail" });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const b = openTemporaryFile(request, { context: "mail" });
    done();
    await Promise.all([a, b]);
    expect(download).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith({ path: "/controlled/a.txt", source: "mail-attachment", readOnlyReason: "Mail read-only" }, { context: "mail" });
  });

  it("releases a stopped failed mail download but retains SFTP partials for retry", async () => {
    const { openTemporaryFile } = await import("./fileOpenTemp");
    const { viewerCreateTemp, viewerReleaseTemp } = await import("./viewer");
    const download = vi.fn<() => Promise<void>>(async () => { throw new Error("cancelled"); });
    const mail = { key: "mail:2", fileName: "b.txt", source: "mail-attachment" as const, readOnlyReason: "read-only", download };
    await expect(openTemporaryFile(mail, { context: "mail" })).rejects.toThrow("cancelled");
    expect(viewerReleaseTemp).toHaveBeenCalledWith("/controlled/b.txt");
    const remote = { ...mail, key: "sftp:2", source: "remote-temp" as const, retainPartialOnFailure: true };
    await expect(openTemporaryFile(remote, { context: "sftp" })).rejects.toThrow("cancelled");
    const allocations = vi.mocked(viewerCreateTemp).mock.calls.length;
    download.mockResolvedValueOnce(undefined);
    await openTemporaryFile(remote, { context: "sftp" });
    expect(viewerCreateTemp).toHaveBeenCalledTimes(allocations);
    expect(viewerReleaseTemp).toHaveBeenCalledTimes(1);
  });

  it("allocates again after the final host has released its copy", async () => {
    const { openTemporaryFile } = await import("./fileOpenTemp");
    const { viewerCreateTemp } = await import("./viewer");
    const { sftpStat } = await import("./sftp");
    const request = { key: "mail:3", fileName: "c.txt", source: "mail-attachment" as const, readOnlyReason: "read-only", download: vi.fn(async () => {}) };
    await openTemporaryFile(request, { context: "mail" });
    vi.mocked(sftpStat).mockRejectedValueOnce(new Error("not_found"));
    await openTemporaryFile(request, { context: "mail" });
    expect(viewerCreateTemp).toHaveBeenCalledTimes(2);
  });
});
