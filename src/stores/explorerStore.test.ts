import { beforeEach, describe, expect, it } from "vitest";
import { useExplorerStore } from "./explorerStore";
import { useDocumentStore } from "./documentStore";
import type { Tab } from "../types";

const folder: Tab = { id: "folder", type: "file-browser", title: "docs", closable: true, fileBrowser: { initialPath: "/docs", explorer: true } };
const viewer: Tab = { id: "viewer", type: "file-viewer", title: "notes.txt", closable: true, fileViewer: { path: "/docs/notes.txt", kind: "text", source: "local" } };

beforeEach(() => {
  localStorage.clear();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useDocumentStore.setState({ documents: {}, closeRequest: undefined });
});

describe("dedicated Explorer tab state", () => {
  it("opens viewers beside their source and preserves navigation metadata", () => {
    const store = useExplorerStore.getState();
    store.openTab(folder);
    store.openTab(viewer, true);
    expect(useExplorerStore.getState().tabs.map((tab) => tab.id)).toEqual(["folder", "viewer"]);
    useExplorerStore.getState().updateExplorerPath("folder", "/docs/sub", "sub");
    useExplorerStore.getState().updateViewerMode("viewer", "source");
    expect(useExplorerStore.getState().tabs[0]).toMatchObject({ title: "sub", fileBrowser: { initialPath: "/docs/sub" } });
    expect(useExplorerStore.getState().tabs[1].fileViewer?.mode).toBe("source");
    useExplorerStore.getState().moveTab("viewer", 0);
    expect(useExplorerStore.getState().activeTabId).toBe("viewer");
  });

  it("closes viewers and selects a neighbouring remaining tab", () => {
    const store = useExplorerStore.getState();
    store.openTab(folder);
    store.openTab(viewer, true);
    store.closeTab("viewer");
    expect(useExplorerStore.getState()).toMatchObject({ tabs: [folder], activeTabId: "folder" });
    store.closeTab("folder");
    expect(useExplorerStore.getState()).toMatchObject({ tabs: [], activeTabId: null });
  });

  it("defers dirty viewer closure to the shared save/discard guard", async () => {
    useExplorerStore.getState().openTab(viewer);
    await useDocumentStore.getState().open("/docs/notes.txt");
    useDocumentStore.setState((state) => {
      const document = Object.values(state.documents)[0];
      if (!document) return state;
      return { documents: { ...state.documents, [document.key]: { ...document, loading: false, dirty: true, content: "draft" } } };
    });
    useExplorerStore.getState().closeTab("viewer");
    expect(useExplorerStore.getState().tabs).toHaveLength(1);
    expect(useDocumentStore.getState().closeRequest?.paths).toEqual(["/docs/notes.txt"]);
    useDocumentStore.getState().closeRequest?.cancel?.();
    useDocumentStore.setState({ closeRequest: undefined });
    useExplorerStore.getState().closeTab("viewer");
    useDocumentStore.getState().closeRequest?.proceed();
    expect(useExplorerStore.getState().tabs).toHaveLength(0);
  });
});
