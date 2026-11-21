import { beforeEach, describe, expect, it } from "vitest";
import { useExplorerStore } from "./explorerStore";
import type { Tab } from "../types";

function makeFileTab(id: string, path: string, pinned = false): Tab {
  return {
    id,
    title: path.split("/").pop() || id,
    type: "file-viewer",
    closable: true,
    pinned,
    fileViewer: { path, kind: "text", mode: "notepad" },
  };
}

describe("explorerStore tab pinning & batch close", () => {
  beforeEach(() => {
    useExplorerStore.setState({ tabs: [], activeTabId: null });
  });

  it("pins tabs to the left while preserving relative order and protects them from batch closes", () => {
    const store = useExplorerStore.getState();
    store.openTab(makeFileTab("t1", "/preview/1.txt"));
    store.openTab(makeFileTab("t2", "/preview/2.txt"));
    store.openTab(makeFileTab("t3", "/preview/3.txt"));
    store.openTab(makeFileTab("t4", "/preview/4.txt"));

    // Pin t3 and t4 -> pinned order should stay [t3, t4, t1, t2]
    store.togglePinTab("t3");
    store.togglePinTab("t4");
    expect(useExplorerStore.getState().tabs.map((t) => t.id)).toEqual(["t3", "t4", "t1", "t2"]);

    // Close Left from t2 closes unpinned t1 only (keeps pinned t3, t4)
    useExplorerStore.getState().closeTabsLeft("t2");
    expect(useExplorerStore.getState().tabs.map((t) => t.id)).toEqual(["t3", "t4", "t2"]);

    // Close Right from t4 closes unpinned t2
    useExplorerStore.getState().closeTabsRight("t4");
    expect(useExplorerStore.getState().tabs.map((t) => t.id)).toEqual(["t3", "t4"]);

    // Re-add unpinned clean & dirty tabs; closeUnmodified skips dirty and pinned
    useExplorerStore.getState().openTab(makeFileTab("clean", "/preview/clean.txt"));
    useExplorerStore.getState().openTab(makeFileTab("dirty", "/preview/dirty.txt"));
    useExplorerStore.getState().closeUnmodifiedTabs((t) => t.id === "dirty");
    expect(useExplorerStore.getState().tabs.map((t) => t.id)).toEqual(["t3", "t4", "dirty"]);

    // closeUnpinned closes dirty unpinned tab while keeping pinned tabs
    useExplorerStore.getState().closeUnpinnedTabs();
    expect(useExplorerStore.getState().tabs.map((t) => t.id)).toEqual(["t3", "t4"]);
  });
});
