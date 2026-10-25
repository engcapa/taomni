import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileBrowserConnection } from "./useFileBrowserConnection";
import { useSftpStore } from "../../../stores/sftpStore";
import { sftpAttach, sftpListRemote } from "../../../lib/sftp";

vi.mock("../../../lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../../lib/ipc", () => ({
  listenSshAuthPrompt: vi.fn(async () => () => {}), submitSshAuthResponse: vi.fn(),
}));
vi.mock("../../../lib/sftp", () => ({
  sftpAttach: vi.fn(), sftpDetach: vi.fn(async () => {}),
  sftpRealpath: vi.fn(async (_id: string, path: string) => path),
  sftpListRemote: vi.fn(async () => []),
  sftpLocalHome: vi.fn(async () => "/local"),
  sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
}));
beforeEach(() => { vi.clearAllMocks(); useSftpStore.setState({ sessions: {} }); });
afterEach(cleanup);

it("opens the detached initial directory when no user navigation has happened", async () => {
  vi.mocked(sftpAttach).mockResolvedValueOnce({ homeDir: "/home/qa" });
  const sid = "detached-connection-initial";
  const { unmount } = renderHook(() => useFileBrowserConnection({
    props: { sessionId: sid, host: "localhost", port: 22, username: "qa", authMethod: "gssapi", authData: null, initialPath: "/initial" },
    navigate: useSftpStore.getState().navigate, setStatus: vi.fn(), t: (key: string) => key,
  }));
  await waitFor(() => expect(useSftpStore.getState().sessions[sid]?.remote.path).toBe("/initial"));
  expect(vi.mocked(sftpListRemote).mock.calls.map((call) => call[1])).toEqual(["/home/qa", "/initial"]);
  unmount();
});

it("keeps a user navigation made during detached attach instead of restoring the initial directory over it", async () => {
  let connected!: (value: { homeDir: string }) => void;
  vi.mocked(sftpAttach).mockImplementationOnce(() => new Promise((resolve) => { connected = resolve; }));
  const sid = "detached-connection-navigation";
  const { unmount } = renderHook(() => useFileBrowserConnection({
    props: { sessionId: sid, host: "localhost", port: 22, username: "qa", authMethod: "gssapi", authData: null, initialPath: "/home/qa" },
    navigate: useSftpStore.getState().navigate, setStatus: vi.fn(), t: (key: string) => key,
  }));
  await waitFor(() => expect(sftpAttach).toHaveBeenCalledOnce());
  await act(async () => {
    const navigate = useSftpStore.getState().navigate(sid, "remote", "/project");
    connected({ homeDir: "/home/qa" });
    await navigate;
  });
  await waitFor(() => expect(useSftpStore.getState().sessions[sid].remote.path).toBe("/project"));
  expect(vi.mocked(sftpListRemote).mock.calls.map((call) => call[1])).toEqual(["/home/qa", "/project"]);
  unmount();
});
