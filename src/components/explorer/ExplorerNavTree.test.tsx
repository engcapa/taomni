import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerNavTree } from "./ExplorerNavTree";
import { setExplorerPreferences } from "./explorerPreferences";
import { sftpListLocalDetailed, type FileEntry } from "../../lib/sftp";
vi.mock("../../lib/sftp", async (original) => ({ ...await original<typeof import("../../lib/sftp")>(),
  sftpLocalDrives: vi.fn(async () => [{ id: "root", path: "/", label: "/" }]), sftpListLocalDetailed: vi.fn(),
}));
vi.mock("../../stores/workspacePlatformStore", () => ({ useWorkspacePlatformStore: (selector: (state: { workspaces: [] }) => unknown) => selector({ workspaces: [] }) }));
const dir = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, fileType: "dir", size: 0, mode: 0, mtime: 0, isHidden: false });
const deferred = () => { let resolve!: (value: { entries: FileEntry[]; skippedCount: number; diagnostics: [] }) => void; const promise = new Promise<{ entries: FileEntry[]; skippedCount: number; diagnostics: [] }>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); setExplorerPreferences({ expandedPaths: [], pinnedPaths: [], showHidden: false });
  vi.mocked(sftpListLocalDetailed).mockImplementation(async (path) => ({ entries: path === "/" ? [dir("/home"), dir("/other")] : path === "/home" ? [dir("/home/qa")] : [], skippedCount: 0, diagnostics: [] }));
});
afterEach(cleanup);
describe("Explorer lazy navigation tree", () => {
  it("expands only ancestors of the committed path, selects it, and navigates through real tree rows", async () => {
    const navigate = vi.fn();
    render(<ExplorerNavTree home="/home/qa" path="/home/qa" dropPath={null} onNavigate={navigate} onOpenExplorer={vi.fn()} onOpenTerminal={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('[data-testid="explorer-nav-node"][data-path="/home/qa"]')).toHaveAttribute("aria-selected", "true"));
    expect(sftpListLocalDetailed).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sftpListLocalDetailed).mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/", "/home", "/home/qa"]));
    expect(sftpListLocalDetailed).not.toHaveBeenCalledWith("/other");
    fireEvent.click(document.querySelector('[data-testid="explorer-nav-node"][data-path="/other"]')!);
    expect(navigate).toHaveBeenCalledWith("/other");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(document.querySelector('[data-testid="explorer-nav-node"][data-path="/other"]')!, enter);
    expect(enter.defaultPrevented).toBe(true);
  });
  it("publishes read errors with a retry and remembers manual expansion", async () => {
    vi.mocked(sftpListLocalDetailed).mockRejectedValueOnce(new Error("Permission denied"));
    render(<ExplorerNavTree home="" path="/" dropPath={null} onNavigate={vi.fn()} onOpenExplorer={vi.fn()} onOpenTerminal={vi.fn()} />);
    const retry = await screen.findByText("Unable to read; retry");
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector('[data-testid="explorer-nav-node"][data-path="/other"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Expand other" }));
    await waitFor(() => expect(sftpListLocalDetailed).toHaveBeenCalledWith("/other"));
    expect(localStorage.getItem("taomni.explorer.view.v1")).toContain("/other");
  });
  it("cleans up a pending directory read on unmount without state resurrection", async () => {
    const pending = deferred();
    vi.mocked(sftpListLocalDetailed).mockReturnValue(pending.promise);
    const view = render(<ExplorerNavTree home="" path="/" dropPath={null} onNavigate={vi.fn()} onOpenExplorer={vi.fn()} onOpenTerminal={vi.fn()} />);
    view.unmount();
    await act(async () => pending.resolve({ entries: [dir("/late")], skippedCount: 0, diagnostics: [] }));
    expect(screen.queryByTestId("explorer-nav-tree")).not.toBeInTheDocument();
  });
});
