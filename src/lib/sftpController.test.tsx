import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/appStore";
import { useSftpStore } from "../stores/sftpStore";
import { listenSftpComplete, listenSftpProgress, sftpCancelTransfer, sftpDownload, sftpChmod, sftpStat, type FileEntry } from "./sftp";
import { useTransferStore } from "../stores/transferStore";
import { useSftpController } from "./sftpController";

vi.mock("./sftp", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sftp")>(),
  sftpChmod: vi.fn(async () => undefined),
  sftpStat: vi.fn(),
  sftpDownload: vi.fn(async () => undefined),
  sftpCancelTransfer: vi.fn(async () => undefined),
  listenSftpProgress: vi.fn(async () => vi.fn()),
  listenSftpComplete: vi.fn(async () => vi.fn()),
  listenSftpPaused: vi.fn(async () => vi.fn()),
}));

const refreshPane = useSftpStore.getState().refreshPane;

beforeEach(() => {
  useTransferStore.setState({ items: [] });
  useAppStore.setState({ statusMessage: "" });
  useSftpStore.setState({ refreshPane: vi.fn(async () => undefined) });
});

afterEach(() => {
  useSftpStore.setState({ refreshPane });
  vi.clearAllMocks();
});

describe("remote chmod", () => {
  it("confirms the mode applied by the remote server", async () => {
    vi.mocked(sftpStat).mockResolvedValue({ mode: 0o100600 } as FileEntry);
    const { result } = renderHook(() => useSftpController("sftp-session"));

    await act(async () => {
      await result.current.chmod("/home/qa/file.txt", 0o600, "remote");
    });

    expect(sftpChmod).toHaveBeenCalledWith("sftp-session", "/home/qa/file.txt", 0o600, "remote");
    expect(sftpStat).toHaveBeenCalledWith("sftp-session", "/home/qa/file.txt", "remote");
    expect(useAppStore.getState().statusMessage).toContain("Permissions updated:");
  });

  it("reports servers that acknowledge chmod but leave the mode unchanged", async () => {
    vi.mocked(sftpStat).mockResolvedValue({ mode: 0o100644 } as FileEntry);
    const { result } = renderHook(() => useSftpController("sftp-session"));

    await act(async () => {
      await result.current.chmod("/C:/qa/file.txt", 0o600, "remote");
    });

    expect(useAppStore.getState().statusMessage).toContain(
      "chmod failed: remote server ignored requested permissions (expected 600, got 644)",
    );
  });
});


describe("transfer retry ownership", () => {
  it("ignores an old worker's completion after a cancelled download is retried", async () => {
    const { result } = renderHook(() => useSftpController("sftp-session"));
    const entry = { name: "file.txt", path: "/remote/file.txt", size: 50, fileType: "file" } as FileEntry;
    await act(async () => result.current.download(entry, "/local"));
    const oldId = useTransferStore.getState().items[0].id;
    const oldComplete = vi.mocked(listenSftpComplete).mock.calls[0][1];
    await act(async () => result.current.cancelTransfer(oldId));
    expect(sftpCancelTransfer).toHaveBeenCalledWith(oldId);
    expect(useTransferStore.getState().byId(oldId)?.state).toBe("queued");
    act(() => oldComplete({ success: false, error: "transfer cancelled" }));
    await act(async () => result.current.retryTransfer(oldId));
    const newId = useTransferStore.getState().items[0].id;
    expect(newId).not.toBe(oldId);
    expect(useTransferStore.getState().items).toHaveLength(1);
    expect(sftpDownload).toHaveBeenLastCalledWith("sftp-session", newId, entry.path, "/local/file.txt", false);
    const newProgress = vi.mocked(listenSftpProgress).mock.calls[1][1];
    const newComplete = vi.mocked(listenSftpComplete).mock.calls[1][1];
    act(() => {
      newProgress({ bytes: 30, total: 50, rate: 10, eta: 2, resumeBytes: 20 });
      oldComplete({ success: false, error: "transfer cancelled" });
    });
    expect(useTransferStore.getState().byId(newId)).toMatchObject({ state: "running", bytes: 30, resumeBytes: 20 });
    act(() => newComplete({ success: true }));
    expect(useTransferStore.getState().byId(newId)?.state).toBe("done");
    // Double clicks on the old Retry control cannot create another worker.
    await act(async () => result.current.retryTransfer(oldId));
    expect(sftpDownload).toHaveBeenCalledTimes(2);
  });
});
