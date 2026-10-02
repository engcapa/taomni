import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePanel } from "./FilePanel";
import { useSftpStore, type PaneState, type FilePanelStoreHook } from "../../stores/sftpStore";
import { useObjectStorageStore } from "../../stores/objectStorageStore";
import { sftpListRemote, sftpListLocalDetailed, sftpLocalHome, type FileEntry } from "../../lib/sftp";
import { storageListBuckets, storageListObjects } from "../../lib/objectStorage";

vi.mock("../../lib/sftp", async () => ({
  ...await vi.importActual<typeof import("../../lib/sftp")>("../../lib/sftp"),
  sftpListRemote: vi.fn(async () => []),
  sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
  sftpLocalHome: vi.fn(async () => "/home/me"),
}));
vi.mock("../../lib/objectStorage", () => ({ storageListBuckets: vi.fn(), storageListObjects: vi.fn() }));

const directory: FileEntry = { name: "Documents", path: "/work/Documents", size: 0, mtime: 0, mode: 0, fileType: "dir", isHidden: false };
function pane(path: string): PaneState {
  return { path, entries: [], selection: [], loading: false, error: null, skippedEntryCount: 0, entryDiagnostics: [], history: [path], historyIndex: 0, showHidden: false };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useSftpStore.setState({ sessions: { sid: { sessionId: "sid", attached: true, attaching: false, error: null,
    homeDir: "/home/remote", local: pane("/work"), remote: pane("/remote") } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function load() { await act(async () => { await vi.advanceTimersByTimeAsync(125); }); }

describe("FilePanel path provider wiring", () => {
  it.each(["local", "remote"] as const)("queries the %s filesystem without changing selection, entries or history", async (side) => {
    vi.mocked(sftpListLocalDetailed).mockResolvedValue({ entries: [directory], skippedCount: 0, diagnostics: [] });
    vi.mocked(sftpListRemote).mockResolvedValue([directory]);
    render(<FilePanel sessionId="sid" side={side} onItemDoubleClick={vi.fn()} />);
    const before = useSftpStore.getState().sessions.sid;
    fireEvent.click(screen.getByTestId(`sftp-${side}-path-edit`));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "/work/Doc" } });
    await load();
    expect(screen.getByRole("option")).toHaveTextContent("/work/Documents/");
    if (side === "local") expect(sftpListLocalDetailed).toHaveBeenCalledWith("/work/");
    else expect(sftpListRemote).toHaveBeenCalledWith("sid", "/work/");
    expect(useSftpStore.getState().sessions.sid).toBe(before);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(useSftpStore.getState().sessions.sid).toBe(before);
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(useSftpStore.getState().sessions.sid[side].path).toBe("/work/Documents/");
    expect(useSftpStore.getState().sessions.sid[side].history.at(-1)).toBe("/work/Documents/");
  });

  it("expands local home aliases and resolves manual relative paths against the pane", async () => {
    vi.mocked(sftpListLocalDetailed).mockResolvedValue({ entries: [{ ...directory, path: "/home/me/Documents" }], skippedCount: 0, diagnostics: [] });
    render(<FilePanel sessionId="sid" side="local" onItemDoubleClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId("sftp-local-path-edit"));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "~/Doc" } });
    await load();
    expect(sftpLocalHome).toHaveBeenCalled();
    expect(sftpListLocalDetailed).toHaveBeenCalledWith("/home/me/");
    expect(screen.getByRole("option")).toHaveTextContent("/home/me/Documents/");
    fireEvent.change(input, { target: { value: "../target" } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(useSftpStore.getState().sessions.sid.local.path).toBe("/work/../target");
  });

  it("lists buckets and prefixes through object storage without opening an SFTP channel", async () => {
    useObjectStorageStore.setState({ sessions: { sid: { sessionId: "sid", attached: true, attaching: false,
      error: null, homeDir: "/", config: null, local: pane("/work"), remote: pane("/") } } });
    vi.mocked(storageListBuckets).mockResolvedValue([{ name: "photos", createdAt: 0 }]);
    vi.mocked(storageListObjects).mockResolvedValue({ entries: [{ name: "2026", key: "2026/", size: 0, lastModified: 0, isDir: true }], nextToken: null });
    render(<FilePanel sessionId="sid" side="remote" store={useObjectStorageStore as unknown as FilePanelStoreHook} onItemDoubleClick={vi.fn()} />);
    const before = useObjectStorageStore.getState().sessions.sid;
    fireEvent.click(screen.getByTestId("sftp-remote-path-edit"));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "/ph" } });
    await load();
    expect(screen.getByRole("option")).toHaveTextContent("/photos/");
    fireEvent.keyDown(input, { key: "Tab" });
    await load();
    expect(storageListObjects).toHaveBeenCalledWith("sid", "photos", "", null);
    expect(screen.getByRole("option")).toHaveTextContent("/photos/2026/");
    expect(sftpListRemote).not.toHaveBeenCalled();
    expect(useObjectStorageStore.getState().sessions.sid).toBe(before);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useObjectStorageStore.getState().sessions.sid).toBe(before);
  });
});
