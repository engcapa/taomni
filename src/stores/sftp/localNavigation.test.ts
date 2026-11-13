import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSftpStore } from "../sftpStore";
import { sftpListLocalDetailed, type DirectoryListing } from "../../lib/sftp";
import { emptyPane, freshSession } from "./listing";
import { inFlightLocalAttaches } from "./localLifetime";
import { sessionRefCounts } from "./lifetime";

vi.mock("../../lib/sftp", () => ({
  sftpListLocalDetailed: vi.fn(), sftpListRemote: vi.fn(), sftpLocalHome: vi.fn(async () => "/home/qa"),
  sftpLocalDrives: vi.fn(async () => []), sftpAttach: vi.fn(), sftpDetach: vi.fn(), sftpRealpath: vi.fn(),
}));
function listing(name = "file"): DirectoryListing {
  return { entries: [{ name, path: `/${name}`, size: 1, mtime: 0, mode: 0, fileType: "file", isHidden: false }], skippedCount: 0, diagnostics: [] };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.clearAllMocks(); inFlightLocalAttaches.clear(); sessionRefCounts.clear();
  useSftpStore.setState({ sessions: { tab: { ...freshSession("tab"), attached: true, local: { ...emptyPane(), path: "/before", history: ["/before"], historyIndex: 0, entries: listing("old").entries } } } });
  vi.mocked(sftpListLocalDetailed).mockResolvedValue(listing());
});
describe("local pane request ownership", () => {
  it("commits path/list/history together and preserves the old pane until successful", async () => {
    const request = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(request.promise);
    const next = useSftpStore.getState().navigate("tab", "local", "/after");
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/before", loading: true, entries: listing("old").entries });
    request.resolve(listing("new")); await next;
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/after", entries: listing("new").entries, history: ["/before", "/after"], historyIndex: 1, loading: false });
  });
  it("discards out-of-order navigation successes and failures", async () => {
    const old = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(old.promise);
    const first = useSftpStore.getState().navigate("tab", "local", "/slow");
    await useSftpStore.getState().navigate("tab", "local", "/fast");
    old.reject(new Error("old permission error")); await first;
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/fast", error: null, history: ["/before", "/fast"] });
  });
  it("does not let an old refresh overwrite newer navigation", async () => {
    const old = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(old.promise);
    const refresh = useSftpStore.getState().refreshPane("tab", "local");
    await useSftpStore.getState().navigate("tab", "local", "/fast");
    old.resolve(listing("stale")); await refresh;
    expect(useSftpStore.getState().sessions.tab.local.entries).toEqual(listing().entries);
    expect(useSftpStore.getState().sessions.tab.local.path).toBe("/fast");
  });
  it("does not resurrect a detached pane, even after reusing the same id", async () => {
    const old = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(old.promise);
    const navigation = useSftpStore.getState().navigate("tab", "local", "/slow");
    useSftpStore.getState().detachLocalOnly("tab");
    await useSftpStore.getState().attachLocalOnly("tab", "/new");
    old.resolve(listing("stale")); await navigation;
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/new", entries: listing().entries });
  });
  it("back/forward share stale protection and failed history leaves the committed index intact", async () => {
    await useSftpStore.getState().navigate("tab", "local", "/second");
    vi.mocked(sftpListLocalDetailed).mockRejectedValueOnce(new Error("no longer exists"));
    await useSftpStore.getState().navigateBack("tab", "local");
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/second", historyIndex: 1, error: "no longer exists" });
    await useSftpStore.getState().navigateBack("tab", "local");
    await useSftpStore.getState().navigateForward("tab", "local");
    expect(useSftpStore.getState().sessions.tab.local).toMatchObject({ path: "/second", historyIndex: 1 });
  });
});
describe("local attachment lifecycle", () => {
  it("joins simultaneous consumers then releases only after the last detach", async () => {
    const request = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(request.promise);
    const one = useSftpStore.getState().attachLocalOnly("shared", "/shared");
    const two = useSftpStore.getState().attachLocalOnly("shared", "/shared");
    await Promise.resolve();
    expect(sftpListLocalDetailed).toHaveBeenCalledTimes(1);
    useSftpStore.getState().detachLocalOnly("shared");
    request.resolve(listing()); await Promise.all([one, two]);
    expect(useSftpStore.getState().sessions.shared.attached).toBe(true);
    useSftpStore.getState().detachLocalOnly("shared");
    expect(useSftpStore.getState().sessions.shared).toBeUndefined();
  });
  it("a StrictMode detach/remount ignores the first attach and never leaks a released entry", async () => {
    const first = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(first.promise);
    const old = useSftpStore.getState().attachLocalOnly("strict", "/old");
    await Promise.resolve();
    useSftpStore.getState().detachLocalOnly("strict");
    await useSftpStore.getState().attachLocalOnly("strict", "/new");
    first.resolve(listing("old")); await old;
    expect(useSftpStore.getState().sessions.strict.local.path).toBe("/new");
    useSftpStore.getState().detachLocalOnly("strict");
    expect(useSftpStore.getState().sessions.strict).toBeUndefined();
  });
  it("navigation waits for initial attachment rather than being overwritten", async () => {
    const request = deferred<DirectoryListing>();
    vi.mocked(sftpListLocalDetailed).mockReturnValueOnce(request.promise);
    const attaching = useSftpStore.getState().attachLocalOnly("new", "/initial");
    const navigation = useSftpStore.getState().navigate("new", "local", "/requested");
    await Promise.resolve();
    request.resolve(listing("initial")); await Promise.all([attaching, navigation]);
    expect(useSftpStore.getState().sessions.new.local.path).toBe("/requested");
  });
});
