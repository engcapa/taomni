import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPLORER_TABS_KEY, explorerTabSnapshot, readExplorerTabSnapshot, setExplorerRestoreEnabled, writeExplorerTabSnapshot } from "./tabRecovery";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import type { Tab } from "../../types";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

const explorer: Tab = { id: "files", type: "file-browser", title: "Current", closable: true,
  sessionId: "saved", fileBrowser: { initialPath: "/current", explorer: true } };
const viewer: Tab = { id: "viewer", type: "file-viewer", title: "note.txt", closable: true,
  fileViewer: { path: "/current/note.txt", kind: "text", source: "local" } };

let useExplorerTabRecovery: () => void;

beforeEach(async () => {
  const actualApp = await import("../../stores/appStore");
  const actualWorkspace = await import("../../stores/workspacePlatformStore");
  const actualExplorer = await import("../../stores/explorerStore");
  vi.resetModules();
  vi.doMock("../../stores/appStore", () => actualApp);
  vi.doMock("../../stores/workspacePlatformStore", () => actualWorkspace);
  vi.doMock("../../stores/explorerStore", () => actualExplorer);
  ({ useExplorerTabRecovery } = await import("./useExplorerTabRecovery"));
  vi.useFakeTimers();
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("dedicated Explorer recovery", () => {
  it("stores Explorer and local viewer metadata while excluding unrelated and remote tabs", () => {
    const unrelated: Tab = { id: "shell", type: "terminal", title: "Shell", closable: true };
    const remote = { ...viewer, id: "remote", fileViewer: { ...viewer.fileViewer!, source: "remote-temp" as const } };
    writeExplorerTabSnapshot([unrelated, explorer, viewer, remote], viewer.id);
    expect(readExplorerTabSnapshot()).toEqual({ tabs: [explorer, viewer], activeTabId: viewer.id });
    expect(explorerTabSnapshot([explorer], null).tabs[0].fileBrowser?.initialPath).toBe("/current");
  });

  it("ignores malformed and duplicate records", () => {
    localStorage.setItem(EXPLORER_TABS_KEY, JSON.stringify({ tabs: [null, explorer, explorer, { id: 1, type: "file-browser" }], activeTabId: "files" }));
    expect(readExplorerTabSnapshot().tabs).toEqual([explorer]);
    localStorage.setItem(EXPLORER_TABS_KEY, "not-json");
    expect(readExplorerTabSnapshot().tabs).toEqual([]);
  });

  it("restores into the dedicated store and records close removal including the final empty snapshot", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    const { unmount } = renderHook(() => useExplorerTabRecovery());
    expect(useExplorerStore.getState()).toMatchObject({ tabs: [explorer], activeTabId: explorer.id });
    expect(useAppStore.getState()).toMatchObject({ tabs: [{ id: "welcome" }], activeSideTab: "explorer" });
    act(() => { useExplorerStore.getState().closeTab("files"); vi.advanceTimersByTime(200); });
    expect(readExplorerTabSnapshot().tabs).toEqual([]);
    unmount();
    renderHook(() => useExplorerTabRecovery());
    expect(useExplorerStore.getState().tabs).toEqual([]);
  });

  it("does not overwrite tabs opened before recovery and observes explicit opt-out", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    act(() => useExplorerStore.getState().openTab({ ...explorer, id: "new", title: "new" }));
    const first = renderHook(() => useExplorerTabRecovery());
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["new"]);
    first.unmount();
    act(() => setExplorerRestoreEnabled(false));
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
    act(() => useExplorerStore.getState().closeTab("new"));
    renderHook(() => useExplorerTabRecovery());
    expect(useExplorerStore.getState().tabs).toEqual([]);
  });

  it("does not throw when restricted storage rejects preference writes", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => setExplorerRestoreEnabled(false)).not.toThrow();
    write.mockRestore();
  });

  it("retains the active Explorer when a Sessions terminal is restored", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useExplorerStore.getState().openTab(explorer); vi.advanceTimersByTime(200); });
    act(() => { useAppStore.getState().addTab({ id: "terminal", type: "terminal", title: "Terminal", closable: true }); vi.advanceTimersByTime(200); });
    expect(readExplorerTabSnapshot().activeTabId).toBe(explorer.id);
  });

  it("flushes the latest navigation on immediate page hide", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useExplorerStore.getState().openTab(explorer); window.dispatchEvent(new Event("pagehide")); });
    expect(readExplorerTabSnapshot().tabs[0].fileBrowser?.initialPath).toBe("/current");
  });

  it("does not steal an existing workspace selection when Explorer recovery exists", () => {
    writeExplorerTabSnapshot([explorer], explorer.id);
    const store = useWorkspacePlatformStore.getState();
    const workspace = store.createWorkspace({ name: "Existing", rootPath: "/repo" });
    const tab = store.openLocalTerminalInWorkspace(workspace.id);
    useAppStore.setState({ activeSideTab: "workspaces" });
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(store.getWorkspace(workspace.id)?.activeTabId).toBe(tab.id);
    expect(useExplorerStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(true);
  });

  it("keeps Home foreground when that was the explicit exit selection", () => {
    writeExplorerTabSnapshot([explorer], explorer.id, null);
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "home", activeTabId: "welcome" });
    expect(useExplorerStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(true);
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
    expect(useExplorerStore.getState().activeTabId).toBe(explorer.id);
    act(() => { useExplorerStore.getState().closeTab(explorer.id); useAppStore.getState().setActiveSideTab("home"); });
    first.unmount();
    writeExplorerTabSnapshot([explorer], explorer.id);
    renderHook(() => useExplorerTabRecovery());
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "home", activeTabId: "welcome" });
    expect(useExplorerStore.getState().tabs.some((tab) => tab.id === explorer.id)).toBe(false);
  });

  it("does not resurrect old tabs after external reset clears storage before unload", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useExplorerStore.getState().openTab(explorer); vi.advanceTimersByTime(200); });
    localStorage.clear();
    act(() => { window.dispatchEvent(new Event("beforeunload")); window.dispatchEvent(new Event("pagehide")); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("respects an external reset even before the first persistence debounce", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => useExplorerStore.getState().openTab(explorer));
    localStorage.clear();
    act(() => { vi.advanceTimersByTime(200); window.dispatchEvent(new Event("beforeunload")); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("does not re-enable recovery when a disabled preference is cleared by a profile reset", () => {
    setExplorerRestoreEnabled(false);
    renderHook(() => useExplorerTabRecovery());
    act(() => useExplorerStore.getState().openTab(explorer));
    localStorage.clear();
    act(() => { window.dispatchEvent(new Event("beforeunload")); vi.advanceTimersByTime(200); });
    expect(localStorage.getItem(EXPLORER_TABS_KEY)).toBeNull();
  });

  it("preserves imported recovery metadata rather than overwriting it during teardown", () => {
    const first = renderHook(() => useExplorerTabRecovery());
    act(() => useExplorerStore.getState().openTab(explorer));
    const imported = { ...explorer, id: "imported", fileBrowser: { initialPath: "/imported", explorer: true as const } };
    writeExplorerTabSnapshot([imported], imported.id, null);
    first.unmount();
    expect(readExplorerTabSnapshot().tabs).toEqual([imported]);
  });

  it("migrates a legacy Sessions Explorer into the dedicated host", () => {
    useAppStore.setState({ tabs: [explorer], activeTabId: explorer.id, activeSideTab: "sessions" });
    renderHook(() => useExplorerTabRecovery());
    expect(useExplorerStore.getState().tabs).toEqual([explorer]);
    expect(useAppStore.getState()).toMatchObject({ tabs: [], activeSideTab: "explorer" });
  });
});
