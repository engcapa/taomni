import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentWorkspace } from "../types";

const ipc = vi.hoisted(() => ({ list: vi.fn(), pick: vi.fn() }));
vi.mock("../lib/editor/workspace", () => ({ workspaceListDir: ipc.list }));
vi.mock("../lib/ipc", () => ({ selectFolderPath: ipc.pick }));
import { useRecentWorkspaceLaunch } from "./useRecentWorkspaceLaunch";
const workspace: RecentWorkspace = { id: "recent", name: "Project", roots: [{ id: "root", name: "root", path: "/old", kind: "folder" }], looseFiles: [], lastOpenedAt: 1, isGitRepo: false };
describe("recent workspace launch and repair", () => {
  beforeEach(() => { ipc.list.mockReset().mockResolvedValue({ state: "ready" }); ipc.pick.mockReset(); });
  afterEach(cleanup);
  it("deduplicates opening and awaits actual model readiness", async () => {
    let ready!: () => void;
    const opener = vi.fn(() => new Promise<void>((r) => { ready = r; }));
    const { result } = renderHook(() => useRecentWorkspaceLaunch(opener, vi.fn()));
    let one!: Promise<void>, two!: Promise<void>;
    await act(async () => { one = result.current.open(workspace); two = result.current.open(workspace); });
    expect(one).toBe(two); expect(opener).toHaveBeenCalledTimes(1);
    expect(result.current.launches.recent.state).toBe("opening");
    await act(async () => { ready(); await one; });
    expect(result.current.launches.recent.state).toBe("ready");
  });
  it("keeps a failed record and allows retry without making a tab", async () => {
    const opener = vi.fn(), replace = vi.fn();
    ipc.list.mockResolvedValueOnce({ state: "failed", message: "Permission denied" });
    const { result } = renderHook(() => useRecentWorkspaceLaunch(opener, replace));
    await act(async () => { await result.current.open(workspace); });
    expect(result.current.launches.recent).toMatchObject({ state: "failed", rootPath: "/old", error: expect.stringContaining("Permission denied") });
    expect(opener).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    await act(async () => { await result.current.open(workspace); });
    expect(opener).toHaveBeenCalledTimes(1);
  });
  it("deduplicates a pending picker and preserves the original record on cancel", async () => {
    let choose!: (path: string | null) => void;
    ipc.pick.mockImplementation(() => new Promise((r) => { choose = r; }));
    const opener = vi.fn(), replace = vi.fn();
    const { result } = renderHook(() => useRecentWorkspaceLaunch(opener, replace));
    let run!: Promise<void>;
    await act(async () => { run = result.current.relocate(workspace); await result.current.relocate(workspace); await result.current.open(workspace); });
    expect(ipc.pick).toHaveBeenCalledTimes(1); expect(opener).not.toHaveBeenCalled();
    await act(async () => { choose(null); await run; });
    expect(replace).not.toHaveBeenCalled();
    ipc.pick.mockResolvedValue("/new");
    await act(async () => { await result.current.relocate(workspace); });
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: "recent", roots: [expect.objectContaining({ id: "root", path: "/new" })] }));
    expect(opener).toHaveBeenCalledWith(replace.mock.calls[0][0]);
  });
  it("does not replace the recent root when a selected directory is unavailable", async () => {
    ipc.pick.mockResolvedValue("/denied"); ipc.list.mockResolvedValue({ state: "failed", message: "Denied" });
    const replace = vi.fn(), opener = vi.fn();
    const { result } = renderHook(() => useRecentWorkspaceLaunch(opener, replace));
    await act(async () => { await result.current.relocate(workspace); });
    expect(replace).not.toHaveBeenCalled(); expect(opener).not.toHaveBeenCalled();
    expect(result.current.launches.recent).toMatchObject({ state: "failed", rootPath: "/old" });
  });
});
