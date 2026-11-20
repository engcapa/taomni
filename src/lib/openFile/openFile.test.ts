import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFile } from "./index";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useWorkspacePlatformStore, DEFAULT_WORKSPACE_ID } from "../../stores/workspacePlatformStore";
import { useDocumentStore } from "../../stores/documentStore";
import { explorerCanonicalPath } from "../explorer";
import { sftpOpenPath } from "../sftp";
import { resetFileOpenPreferences, setFileOpenPreferences } from "./preferences";
vi.mock("../explorer", () => ({ explorerCanonicalPath: vi.fn(async (path: string) => path) }));
vi.mock("../sftp", async (original) => ({ ...await original<typeof import("../sftp")>(), sftpOpenPath: vi.fn(async () => {}) }));
vi.mock("../openPlatformCodeWorkspace", () => ({ openPlatformCodeWorkspace: vi.fn(() => "code") }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); resetFileOpenPreferences();
  useAppStore.setState({ tabs: [], activeTabId: null, activeSideTab: "home", codeWorkspaceByTab: {} });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined });
  vi.mocked(explorerCanonicalPath).mockImplementation(async (path) => path);
});
afterEach(() => vi.useRealTimers());
describe("global open file routing", () => {
  it("deduplicates racing alias paths and activates the main viewer", async () => {
    vi.mocked(explorerCanonicalPath).mockResolvedValue("/real/document.md");
    const ids = await Promise.all([openFile({ path: "/alias/a.md" }, { context: "explorer" }), openFile({ path: "/real/document.md" }, { context: "mail" })]);
    expect(ids[0]).toBe(ids[1]); expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
  });
  it("deduplicates repeated terminal links without overriding later tab navigation", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ tabs: [{ id: "terminal", type: "terminal", title: "Shell", closable: true }], activeTabId: "terminal" });
    const first = await openFile("/docs/a.txt", { context: "terminal-link" });
    useAppStore.getState().setActiveTab("terminal");
    const second = await openFile("/docs/a.txt", { context: "terminal-link" });
    expect(second).toBe(first);
    expect(useAppStore.getState().activeTabId).toBe(first);
    expect(useAppStore.getState().tabs).toHaveLength(2);
    useAppStore.getState().setActiveTab("terminal");
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().activeTabId).toBe("terminal");
  });
  it("keeps workspace scope distinct without creating two document keys", async () => {
    const main = await openFile({ path: "/docs/a.txt" }, { context: "explorer" });
    const workspace = await openFile({ path: "/docs/a.txt" }, { context: "workspace", workspaceId: DEFAULT_WORKSPACE_ID });
    expect(workspace).not.toBe(main);
    const tab = useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!.openTabs[0];
    expect(tab.kind).toBe("viewer"); expect(tab.fileViewer?.path).toBe("/docs/a.txt");
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
  });
  it("uses persisted extension preference and alternate override", async () => {
    setFileOpenPreferences({ associations: { txt: "system" } });
    await openFile({ path: "/docs/a.txt" }, { context: "explorer" });
    expect(sftpOpenPath).toHaveBeenCalledWith("/docs/a.txt");
    await openFile({ path: "/docs/a.txt" }, { context: "explorer", alternate: true });
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });
  it("keeps unsupported binary and PDF external even if Taomni is requested", async () => {
    await openFile({ path: "/docs/a.pdf" }, { context: "explorer", mode: "taomni" });
    await openFile({ path: "/docs/a.zip" }, { context: "explorer", mode: "taomni" });
    expect(sftpOpenPath).toHaveBeenCalledTimes(2); expect(useAppStore.getState().tabs).toHaveLength(0);
  });
  it("treats remote text/source copies as read-only, never writable IDE documents", async () => {
    await openFile({ path: "/tmp/example.rs", source: "remote-temp" }, { context: "sftp", mode: "workspace" });
    expect(useAppStore.getState().tabs[0].fileViewer).toMatchObject({ kind: "text", source: "remote-temp", readOnlyReason: expect.stringContaining("Read-only") });
  });
  it("activates a root file owner before its editor context is published", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const root = platform.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/project" })!;
    const tab = platform.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "docs/a.txt" });
    await openFile({ path: "/project/docs/a.txt" }, { context: "explorer" });
    expect(platform.getWorkspace(DEFAULT_WORKSPACE_ID)?.activeTabId).toBe(tab.id);
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });
  it("still opens missing paths as a recoverable error pane", async () => {
    vi.mocked(explorerCanonicalPath).mockRejectedValue(new Error("not_found"));
    await openFile({ path: "/missing.txt" }, { context: "explorer" });
    expect(useAppStore.getState().tabs[0].fileViewer?.path).toBe("/missing.txt");
  });
  it("keeps source and text viewers inside the dedicated Explorer surface", async () => {
    useAppStore.setState({ activeSideTab: "explorer" });
    const source = await openFile({ path: "/docs/example.rs" }, { context: "explorer", host: "explorer" });
    const text = await openFile({ path: "/docs/notes.txt" }, { context: "explorer-command" });
    expect(source).not.toBe(text);
    expect(useExplorerStore.getState().tabs.map((tab) => tab.type)).toEqual(["file-viewer", "file-viewer"]);
    expect(useExplorerStore.getState().tabs[0].fileViewer).toMatchObject({ path: "/docs/example.rs", kind: "source" });
    expect(useExplorerStore.getState().activeTabId).toBe(text);
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "explorer", tabs: [] });
    expect(await openFile({ path: "/docs/example.rs" }, { context: "explorer", mode: "source" })).toBe(source);
    expect(useExplorerStore.getState().tabs).toHaveLength(2);
  });
});
