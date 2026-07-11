import { beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultCodeWorkspaceUi,
  selectCodeWorkspaceUi,
  useCodeWorkspaceStore,
} from "./codeWorkspaceStore";

describe("codeWorkspaceStore", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
  });

  it("creates isolated UI state per workspace instance id", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws-a");
    store.ensureInstance("ws-b");
    store.patchInstance("ws-a", { bottomDockOpen: false, activeKey: "file:1" });
    store.patchInstance("ws-b", { rightPaneOpen: true, searchEverywhereMode: "classes" });

    const a = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-a");
    const b = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws-b");
    expect(a.bottomDockOpen).toBe(false);
    expect(a.activeKey).toBe("file:1");
    expect(a.rightPaneOpen).toBe(false);
    expect(b.rightPaneOpen).toBe(true);
    expect(b.searchEverywhereMode).toBe("classes");
    expect(b.bottomDockOpen).toBe(true);
  });

  it("disposes instance state without affecting others", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("keep");
    store.ensureInstance("drop");
    store.patchInstance("keep", { languagePanelOpen: false });
    store.disposeInstance("drop");
    expect(useCodeWorkspaceStore.getState().byInstanceId.drop).toBeUndefined();
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "keep").languagePanelOpen).toBe(false);
  });

  it("tracks open-order and markdown modes on the instance slice", () => {
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance("ws");
    store.setOpenOrder("ws", ["a", "b"]);
    store.setActiveKey("ws", "b");
    store.setMarkdownMode("ws", "b", "split");
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "ws");
    expect(ui.openOrder).toEqual(["a", "b"]);
    expect(ui.activeKey).toBe("b");
    expect(ui.markdownModes.b).toBe("split");
  });

  it("exposes defaults for unknown instances without mutating the map", () => {
    const defaults = createDefaultCodeWorkspaceUi();
    const missing = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "missing");
    expect(missing).toEqual(defaults);
    expect(useCodeWorkspaceStore.getState().byInstanceId.missing).toBeUndefined();
  });
});
