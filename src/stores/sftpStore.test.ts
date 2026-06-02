import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSftpStore, type PaneState, type SftpSessionState } from "./sftpStore";
import { sftpListRemote, type FileEntry } from "../lib/sftp";

vi.mock("../lib/sftp", () => ({
  sftpListRemote: vi.fn(),
  sftpListLocal: vi.fn(),
  sftpLocalHome: vi.fn(),
  sftpLocalDrives: vi.fn(),
  sftpAttach: vi.fn(),
  sftpDetach: vi.fn(),
  sftpRealpath: vi.fn(),
}));

const charsetSwitchEntry: FileEntry = {
  name: "!now_UTF-8,next_gb18030",
  path: "/!now_UTF-8,next_gb18030",
  fileType: "dir",
  size: 0,
  mtime: 0,
  mode: 0,
  isHidden: false,
};

const hostEntry: FileEntry = {
  name: "ssh_ecs-user@worker",
  path: "/ssh_ecs-user@worker",
  fileType: "dir",
  size: 0,
  mtime: 0,
  mode: 0,
  isHidden: false,
};

function pane(path: string, entries: FileEntry[]): PaneState {
  return {
    path,
    entries,
    selection: [],
    loading: false,
    error: null,
    history: path ? [path] : [],
    historyIndex: path ? 0 : -1,
    showHidden: false,
  };
}

function session(): SftpSessionState {
  return {
    sessionId: "sid",
    attached: true,
    attaching: false,
    homeDir: "/",
    error: null,
    remote: pane("/", [charsetSwitchEntry]),
    local: pane("", []),
  };
}

describe("sftpStore", () => {
  beforeEach(() => {
    vi.mocked(sftpListRemote).mockReset();
    useSftpStore.setState({ sessions: { sid: session() } });
  });

  it("refreshes the current remote directory after a bastion charset switch signal", async () => {
    vi.mocked(sftpListRemote).mockImplementation(async (_sessionId, path) => {
      if (path === charsetSwitchEntry.path) {
        throw new Error(
          "Failed to read /!now_UTF-8,next_gb18030: Failure: character is changed please refresh directory",
        );
      }
      if (path === "/") return [hostEntry];
      return [];
    });

    await useSftpStore.getState().navigate("sid", "remote", charsetSwitchEntry.path);

    const remote = useSftpStore.getState().sessions.sid.remote;
    expect(remote.path).toBe("/");
    expect(remote.error).toBeNull();
    expect(remote.loading).toBe(false);
    expect(remote.entries).toEqual([hostEntry]);
    expect(vi.mocked(sftpListRemote).mock.calls).toEqual([
      ["sid", charsetSwitchEntry.path],
      ["sid", "/"],
    ]);
  });
});
