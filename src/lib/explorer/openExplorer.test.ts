import { beforeEach, describe, expect, it, vi } from "vitest";
import { explorerPathKey, openExplorer } from "./openExplorer";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { freshSession } from "../../stores/sftp/listing";

const api = vi.hoisted(() => ({ canonical: vi.fn(async (path: string) => path), home: vi.fn(async () => "/home/dev") }));
vi.mock("../explorer", () => ({ explorerCanonicalPath: api.canonical }));
vi.mock("../sftp", async (original) => ({ ...await original<typeof import("../sftp")>(), sftpLocalHome: api.home }));

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ tabs: [], activeTabId: null, activeSideTab: "home", tabFilter: null });
  useSftpStore.setState({ sessions: {} });
  api.canonical.mockImplementation(async (path) => path);
  api.home.mockResolvedValue("/home/dev");
});

describe("unified Explorer entry", () => {
  it("opens home and serializes rapid entry activations before the pane attaches", async () => {
    const [a, b] = await Promise.all([openExplorer(), openExplorer("/home/dev")]);
    expect(a).toBe(b);
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().tabs[0]).toMatchObject({ type: "file-browser", fileBrowser: { initialPath: "/home/dev", explorer: true } });
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
  });

  it("matches the committed current directory, not creation path", async () => {
    const a = await openExplorer("/a");
    const session = freshSession(a);
    session.local.path = "/b";
    useSftpStore.setState({ sessions: { [a]: session } });
    expect(await openExplorer("/b")).toBe(a);
    expect(await openExplorer("/a")).not.toBe(a);
    expect(useAppStore.getState().tabs).toHaveLength(2);
  });

  it("forceNew creates an independent tab without navigating the original", async () => {
    const a = await openExplorer("/a");
    const b = await openExplorer("/a", { forceNew: true });
    expect(a).not.toBe(b);
    expect(useAppStore.getState().tabs.map((tab) => tab.fileBrowser?.initialPath)).toEqual(["/a", "/a"]);
  });

  it("uses native canonical aliases and Windows slash/case spelling", async () => {
    api.canonical.mockImplementation(async (path) => path === "/alias" ? "/real" : path);
    expect(await openExplorer("/alias")).toBe(await openExplorer("/real"));
    expect(await openExplorer("C:\\Users\\Dev")).toBe(await openExplorer("c:/users/dev/"));
    expect(await openExplorer("\\\\server\\Share\\folder")).toBe(await openExplorer("//SERVER/share/folder/"));
    expect(explorerPathKey("/Folder")).not.toBe(explorerPathKey("/folder"));
    expect(explorerPathKey("\\\\?\\C:\\Users\\Dev")).toBe(explorerPathKey("c:/users/dev"));
  });

  it("does not conflate main and individual workspace scopes", async () => {
    const workspaceId = DEFAULT_WORKSPACE_ID;
    const other = useWorkspacePlatformStore.getState().createWorkspace({ name: "Other", rootPath: "/a" });
    const main = await openExplorer("/a");
    const first = await openExplorer("/a", { workspaceId });
    const second = await openExplorer("/a", { workspaceId: other.id });
    expect(new Set([main, first, second]).size).toBe(3);
    expect(await openExplorer("/a", { workspaceId })).toBe(first);
    const duplicate = await openExplorer("/a", { workspaceId, forceNew: true });
    expect(duplicate).not.toBe(first);
    expect(useWorkspacePlatformStore.getState().getWorkspace(workspaceId)?.openTabs).toHaveLength(2);
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
  });

  it("does not reactivate a tab closed during canonical lookup", async () => {
    const first = await openExplorer("/a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.canonical.mockImplementation(async (path) => { await gate; return path; });
    const pending = openExplorer("/a");
    useAppStore.getState().removeTab(first);
    release();
    expect(await pending).not.toBe(first);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it("reveals main Explorer from workspaces and clears stale filters on create and reuse", async () => {
    useAppStore.setState({ activeSideTab: "workspaces", tabFilter: { kind: "query", text: "hidden" } });
    const first = await openExplorer("/main");
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "sessions", activeTabId: first, tabFilter: null });
    useAppStore.setState({ activeSideTab: "workspaces", activeTabId: null, tabFilter: { kind: "query", text: "hidden" } });
    expect(await openExplorer("/main")).toBe(first);
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "sessions", activeTabId: first, tabFilter: null });
    useAppStore.setState({ activeSideTab: "tools" });
    await openExplorer("/tools");
    expect(useAppStore.getState().activeSideTab).toBe("tools");
  });

  it("keeps an error/recovery tab available when canonicalization fails", async () => {
    api.canonical.mockRejectedValue(new Error("permission denied"));
    const id = await openExplorer("/unreadable");
    expect(useAppStore.getState().tabs.find((tab) => tab.id === id)?.fileBrowser?.initialPath).toBe("/unreadable");
  });

  it("keeps legacy saved File sessions eligible for deduplication without losing session linkage", async () => {
    useAppStore.setState({ tabs: [{ id: "legacy", title: "Saved files", type: "file-browser", closable: true,
      sessionId: "saved-session", fileBrowser: { initialPath: "/a" } }] });
    expect(await openExplorer("/a")).toBe("legacy");
    expect(useAppStore.getState().tabs[0].sessionId).toBe("saved-session");
  });
});
