import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFile } from "./index";
import { useAppStore } from "../../stores/appStore";
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
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined });
  vi.mocked(explorerCanonicalPath).mockImplementation(async (path) => path);
});
describe("global open file routing", () => {
  it("deduplicates racing alias paths and activates the main viewer", async () => {
    vi.mocked(explorerCanonicalPath).mockResolvedValue("/real/document.md");
    const ids = await Promise.all([openFile({ path: "/alias/a.md" }, { context: "explorer" }), openFile({ path: "/real/document.md" }, { context: "mail" })]);
    expect(ids[0]).toBe(ids[1]); expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
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
});
