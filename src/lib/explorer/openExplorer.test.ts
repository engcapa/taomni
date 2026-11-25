import { beforeEach, describe, expect, it, vi } from "vitest";
import { explorerPathKey, openExplorer } from "./openExplorer";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useWorkspacePlatformStore, DEFAULT_WORKSPACE_ID } from "../../stores/workspacePlatformStore";
import { freshSession } from "../../stores/sftp/listing";

const api = vi.hoisted(() => ({ canonical: vi.fn(async (path: string) => path), home: vi.fn(async () => "/home/dev") }));
vi.mock("../explorer", () => ({ explorerCanonicalPath: api.canonical }));
vi.mock("../sftp", async (original) => ({ ...await original<typeof import("../sftp")>(), sftpLocalHome: api.home }));

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ tabs: [], activeTabId: null, activeSideTab: "home", tabFilter: null });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useSftpStore.setState({ sessions: {} });
  api.canonical.mockImplementation(async (path) => path);
  api.home.mockResolvedValue("/home/dev");
});

describe("unified Explorer entry", () => {
  it("opens home in the dedicated surface and serializes rapid activations", async () => {
    const [a, b] = await Promise.all([openExplorer(), openExplorer("/home/dev")]);
    expect(a).toBe(b);
    expect(useExplorerStore.getState().tabs).toHaveLength(1);
    expect(useExplorerStore.getState().tabs[0]).toMatchObject({ type: "file-browser", fileBrowser: { initialPath: "/home/dev", explorer: true } });
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "explorer", tabs: [] });
  });

  it("matches the committed current directory rather than the creation path", async () => {
    const a = await openExplorer("/a");
    const session = freshSession(a);
    session.local.path = "/b";
    useSftpStore.setState({ sessions: { [a]: session } });
    expect(await openExplorer("/b")).toBe(a);
    expect(await openExplorer("/a")).not.toBe(a);
    expect(useExplorerStore.getState().tabs).toHaveLength(2);
  });

  it("forceNew creates an independent tab without navigating the original", async () => {
    const a = await openExplorer("/a");
    const b = await openExplorer("/a", { forceNew: true });
    expect(a).not.toBe(b);
    expect(useExplorerStore.getState().tabs.map((tab) => tab.fileBrowser?.initialPath)).toEqual(["/a", "/a"]);
  });

  it("uses native canonical aliases and Windows slash/case spelling", async () => {
    api.canonical.mockImplementation(async (path) => path === "/alias" ? "/real" : path);
    expect(await openExplorer("/alias")).toBe(await openExplorer("/real"));
    expect(await openExplorer("C:\\Users\\Dev")).toBe(await openExplorer("c:/users/dev/"));
    expect(await openExplorer("\\\\server\\Share\\folder")).toBe(await openExplorer("//SERVER/share/folder/"));
    expect(explorerPathKey("/Folder")).not.toBe(explorerPathKey("/folder"));
    expect(explorerPathKey("\\\\?\\C:\\Users\\Dev")).toBe(explorerPathKey("c:/users/dev"));
  });

  it("redirects every workspace-scoped caller into the same dedicated surface", async () => {
    const first = await openExplorer("/a", { workspaceId: DEFAULT_WORKSPACE_ID });
    expect(await openExplorer("/a", { workspaceId: "another-workspace" })).toBe(first);
    expect(useExplorerStore.getState().tabs).toHaveLength(1);
    expect(useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)?.openTabs).toHaveLength(0);
    expect(useAppStore.getState().activeSideTab).toBe("explorer");
  });

  it("does not reactivate a tab closed during canonical lookup", async () => {
    const first = await openExplorer("/a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.canonical.mockImplementation(async (path) => { await gate; return path; });
    const pending = openExplorer("/a");
    useExplorerStore.getState().closeTab(first);
    release();
    expect(await pending).not.toBe(first);
    expect(useExplorerStore.getState().tabs).toHaveLength(1);
  });

  it("reveals Explorer from other surfaces and clears stale Sessions filters", async () => {
    useAppStore.setState({ activeSideTab: "workspaces", tabFilter: { kind: "query", text: "hidden" } });
    const first = await openExplorer("/main");
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "explorer", tabFilter: null });
    useAppStore.setState({ activeSideTab: "workspaces", tabFilter: { kind: "query", text: "hidden" } });
    expect(await openExplorer("/main")).toBe(first);
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "explorer", tabFilter: null });
    useAppStore.setState({ activeSideTab: "tools" });
    await openExplorer("/tools");
    expect(useAppStore.getState().activeSideTab).toBe("explorer");
  });

  it("keeps an error/recovery tab available when canonicalization fails", async () => {
    api.canonical.mockRejectedValue(new Error("permission denied"));
    const id = await openExplorer("/unreadable");
    expect(useExplorerStore.getState().tabs.find((tab) => tab.id === id)?.fileBrowser?.initialPath).toBe("/unreadable");
  });

  it("migrates legacy Sessions tabs without losing saved session linkage", async () => {
    useAppStore.setState({ tabs: [{ id: "legacy", title: "Saved files", type: "file-browser", closable: true,
      sessionId: "saved-session", fileBrowser: { initialPath: "/a" } }] });
    expect(await openExplorer("/a")).toBe("legacy");
    expect(useExplorerStore.getState().tabs[0].sessionId).toBe("saved-session");
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });
});
