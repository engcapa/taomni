import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/appStore";
import { useSftpStore } from "../stores/sftpStore";
import { sftpChmod, sftpStat, type FileEntry } from "./sftp";
import { useSftpController } from "./sftpController";

vi.mock("./sftp", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sftp")>(),
  sftpChmod: vi.fn(async () => undefined),
  sftpStat: vi.fn(),
}));

const refreshPane = useSftpStore.getState().refreshPane;

beforeEach(() => {
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
