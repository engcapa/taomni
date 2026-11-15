import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useDocumentStore } from "../../stores/documentStore";
const originalDocument = globalThis.document;
beforeEach(() => {
  localStorage.clear(); useDocumentStore.setState({ documents: {} });
  useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }], activeTabId: "welcome", activeSideTab: "home" });
  vi.resetModules();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("restores a foreground viewer after sibling Explorer recovery activated its fallback", async () => {
  // Mock the hook's stores to the same live instances after resetModules.
  vi.doMock("../../stores/appStore", () => ({ useAppStore }));
  vi.doMock("../../stores/documentStore", () => ({ useDocumentStore }));
  const { useViewerRecovery, VIEWER_TABS_KEY } = await import("./useViewerRecovery");
  localStorage.setItem(VIEWER_TABS_KEY, JSON.stringify({ tabs: [{ id: "restored-viewer", type: "file-viewer", title: "note.txt", closable: true, fileViewer: { path: "/note.txt", kind: "text", source: "local" } }], activeTabId: "restored-viewer" }));
  renderHook(() => {
    useEffect(() => useAppStore.setState((state) => ({ tabs: [...state.tabs, { id: "explorer", type: "file-browser", title: "docs", closable: true, fileBrowser: { initialPath: "/docs" } }], activeTabId: "explorer", activeSideTab: "sessions" })), []);
    useViewerRecovery();
  });
  expect(useAppStore.getState().activeTabId).toBe("restored-viewer");
  expect(useAppStore.getState().tabs.some((tab) => tab.id === "explorer")).toBe(true);
  expect(globalThis.document).toBe(originalDocument);
});
