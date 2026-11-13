import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPLORER_TABS_KEY, explorerTabSnapshot, readExplorerTabSnapshot, setExplorerRestoreEnabled, writeExplorerTabSnapshot } from "./tabRecovery";
import { useExplorerTabRecovery } from "./useExplorerTabRecovery";
import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

const explorer: Tab = { id: "files", type: "file-browser", title: "Current", closable: true,
  sessionId: "saved", fileBrowser: { initialPath: "/current", explorer: true } };

beforeEach(() => {
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

  it("flushes the latest navigation on immediate page hide", () => {
    renderHook(() => useExplorerTabRecovery());
    act(() => { useAppStore.getState().addTab(explorer); window.dispatchEvent(new Event("pagehide")); });
    expect(readExplorerTabSnapshot().tabs[0].fileBrowser?.initialPath).toBe("/current");
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
