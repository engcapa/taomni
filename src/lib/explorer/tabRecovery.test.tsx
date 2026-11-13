import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPLORER_TABS_KEY, explorerTabSnapshot, readExplorerTabSnapshot, setExplorerRestoreEnabled, writeExplorerTabSnapshot } from "./tabRecovery";
import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

const explorer: Tab = { id: "files", type: "file-browser", title: "Current", closable: true,
  sessionId: "saved", fileBrowser: { initialPath: "/current", explorer: true } };

let useExplorerTabRecovery: () => void;

beforeEach(async () => {
  // New module instance models a new renderer document for startup recovery.
  // Stores and all other dependencies remain shared for realistic reload state.
  const actualApp = await import("../../stores/appStore");
  const actualWorkspace = await import("../../stores/workspacePlatformStore");
  vi.resetModules();
  vi.doMock("../../stores/appStore", () => actualApp);
  vi.doMock("../../stores/workspacePlatformStore", () => actualWorkspace);
  ({ useExplorerTabRecovery } = await import("./useExplorerTabRecovery"));
  vi.useFakeTimers();
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Explorer recovery metadata", () => {
  it("stores only Explorer tabs and preserves saved session association and current directory", () => {
    const unrelated: Tab = { id: "shell", type: "terminal", title: "Shell", closable: true };
    writeExplorerTabSnapshot([unrelated, explorer], explorer.id);
    expect(readExplorerTabSnapshot()).toEqual({ tabs: [explorer], activeTabId: explorer.id });
    expect(explorerTabSnapshot([explorer], null).tabs[0].fileBrowser?.initialPath).toBe("/current");
  });

  it("ignores malformed and duplicate records without affecting the application", () => {
    localStorage.setItem(EXPLORER_TABS_KEY, JSON.stringify({ tabs: [null, explorer, explorer, { id: 1, type: "file-browser" }], activeTabId: "files" }));
    expect(readExplorerTabSnapshot().tabs).toEqual([explorer]);
    localStorage.setItem(EXPLORER_TABS_KEY, "not-json");
    expect(readExplorerTabSnapshot().tabs).toEqual([]);
  });

  it("restores once and records close removal including the final empty snapshot", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    const { unmount } = renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["welcome", "files"]);
    expect(useAppStore.getState().activeTabId).toBe("files");
    act(() => { useAppStore.getState().removeTab("files"); vi.advanceTimersByTime(200); });
    expect(readExplorerTabSnapshot().tabs).toEqual([]);
    unmount();
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["welcome"]);
  });

  it("does not overwrite tabs opened before recovery and observes explicit opt-out", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    act(() => useAppStore.getState().addTab({ ...explorer, id: "new", title: "new" }));
    const first = renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["welcome", "new"]);
    first.unmount();
    act(() => setExplorerRestoreEnabled(false));
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
    act(() => useAppStore.getState().removeTab("new"));
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["welcome"]);
  });

  it("does not throw when restricted storage rejects preference writes", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => setExplorerRestoreEnabled(false)).not.toThrow();
    write.mockRestore();
  });

  it("retains the last active Explorer when the current terminal is not restored", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useAppStore.getState().addTab(explorer); vi.advanceTimersByTime(200); });
    act(() => { useAppStore.getState().addTab({ id: "terminal", type: "terminal", title: "Terminal", closable: true }); vi.advanceTimersByTime(200); });
    expect(readExplorerTabSnapshot().activeTabId).toBe(explorer.id);
  });

  it("flushes the latest navigation on immediate page hide", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useAppStore.getState().addTab(explorer); window.dispatchEvent(new Event("pagehide")); });
    expect(readExplorerTabSnapshot().tabs[0].fileBrowser?.initialPath).toBe("/current");
  });

  it("does not steal an existing workspace selection when main Explorer recovery exists", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.createWorkspace({ name: "Existing", rootPath: "/repo" });
    const tab = store.openLocalTerminalInWorkspace(workspace.id);
    useAppStore.setState({ activeSideTab: "workspaces" });
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useAppStore.getState().activeTabId).toBe("welcome");
    expect(store.getWorkspace(workspace.id)?.activeTabId).toBe(tab.id);
    expect(useAppStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(true);
  });

  it("keeps Home foreground when that was the explicit exit selection", () => {
    writeExplorerTabSnapshot([explorer], explorer.id, null);
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "home", activeTabId: "welcome" });
    expect(useAppStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(true);
  });

  it("does not override an already opened main terminal on startup", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    useAppStore.getState().addTab({ id: "shell", type: "terminal", title: "Shell", closable: true });
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "sessions", activeTabId: "shell" });
  });

  it("does not repeat startup restoration on conditional remount or StrictMode replay", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    const first = renderHook(() => useExplorerTabRecovery(), { wrapper: StrictMode });
    expect(useAppStore.getState().activeTabId).toBe(explorer.id);
    act(() => { useAppStore.getState().removeTab(explorer.id); useAppStore.getState().setActiveSideTab("home"); });
    first.unmount();
    // A stale/imported record appearing later is not a second startup signal.
    writeExplorerTabSnapshot([explorer], explorer.id);
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "home", activeTabId: "welcome" });
    expect(useAppStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(false);
  });

  it("does not resurrect old tabs after external reset clears storage before unload", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useAppStore.getState().addTab(explorer); vi.advanceTimersByTime(200); });
    localStorage.clear();
    act(() => { window.dispatchEvent(new Event("beforeunload")); window.dispatchEvent(new Event("pagehide")); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("respects an external reset even before the first Explorer persistence debounce", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => useAppStore.getState().addTab(explorer));
    localStorage.clear();
    act(() => { vi.advanceTimersByTime(200); window.dispatchEvent(new Event("beforeunload")); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("does not re-enable recovery when a disabled preference is cleared by a profile reset", () => {
    setExplorerRestoreEnabled(false);
    renderHook(() => useExplorerTabRecovery());
    act(() => useAppStore.getState().addTab(explorer));
    localStorage.clear();
    act(() => { window.dispatchEvent(new Event("beforeunload")); vi.advanceTimersByTime(200); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("preserves imported recovery metadata rather than overwriting it during teardown", () => {
    const first = renderHook(() => useExplorerTabRecovery());
    act(() => useAppStore.getState().addTab(explorer));
    const imported = { ...explorer, id: "imported", fileBrowser: { initialPath: "/imported", explorer: true as const } };
    writeExplorerTabSnapshot([imported], imported.id, null);
    first.unmount();
    expect(readExplorerTabSnapshot().tabs).toEqual([imported]);
  });

  it("restores the Explorer workspace foreground rather than a stale main Explorer after reload", async () => {
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.createWorkspace({ name: "Explorer workspace", rootPath: "/repo" });
    const workspaceTab = store.addExplorerTab(workspace.id, "/repo/current");
    const first = renderHook(() => useExplorerTabRecovery());
    act(() => {
      useAppStore.getState().addTab(explorer);
      useAppStore.getState().setActiveSideTab("workspaces");
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(readExplorerTabSnapshot().foreground).toEqual({ kind: "workspace", workspaceId: workspace.id, tabId: workspaceTab.id });
    first.unmount();
    useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
    vi.resetModules();
    const nextDocument = await import("./useExplorerTabRecovery");
    renderHook(() => nextDocument.useExplorerTabRecovery());
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(store.getWorkspace(workspace.id)?.activeTabId).toBe(workspaceTab.id);
    expect(useAppStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(true);
  });

  it("persists independent workspace Explorer current paths and close removal", () => {
    const store = useWorkspacePlatformStore.getState();
    const a = store.addExplorerTab(DEFAULT_WORKSPACE_ID, "/a");
    const b = store.addExplorerTab(DEFAULT_WORKSPACE_ID, "/b");
    store.updateExplorerPath(DEFAULT_WORKSPACE_ID, a.id, "/current");
    store.closeWorkspaceTab(DEFAULT_WORKSPACE_ID, b.id);
    window.dispatchEvent(new Event("pagehide"));
    store.reloadFromStorage();
    expect(store.getWorkspace(DEFAULT_WORKSPACE_ID)?.openTabs).toEqual([
      expect.objectContaining({ id: a.id, kind: "explorer", title: "current", explorerPath: "/current" }),
    ]);
  });
});
