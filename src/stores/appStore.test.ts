import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./appStore";
import type { Tab } from "../types";

const tab = (id: string, overrides: Partial<Tab> = {}): Tab => ({
  id,
  type: "terminal",
  title: id,
  closable: true,
  ...overrides,
});

describe("appStore.moveTab", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [tab("a"), tab("b"), tab("c"), tab("d")],
      activeTabId: "a",
    });
  });

  it("moves a tab before a later target", () => {
    useAppStore.getState().moveTab("a", "c", "before");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves a tab after a later target", () => {
    useAppStore.getState().moveTab("a", "c", "after");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a tab before an earlier target", () => {
    useAppStore.getState().moveTab("d", "b", "before");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves a tab after an earlier target", () => {
    useAppStore.getState().moveTab("d", "b", "after");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("is a no-op when source and target are the same", () => {
    const before = useAppStore.getState().tabs;
    useAppStore.getState().moveTab("b", "b", "before");
    expect(useAppStore.getState().tabs).toBe(before);
  });

  it("is a no-op when dropping a tab onto its existing neighbor in the no-shift direction", () => {
    const before = useAppStore.getState().tabs;
    useAppStore.getState().moveTab("b", "a", "after");
    expect(useAppStore.getState().tabs).toBe(before);
    useAppStore.getState().moveTab("b", "c", "before");
    expect(useAppStore.getState().tabs).toBe(before);
  });

  it("ignores unknown ids", () => {
    const before = useAppStore.getState().tabs;
    useAppStore.getState().moveTab("missing", "a", "after");
    expect(useAppStore.getState().tabs).toBe(before);
    useAppStore.getState().moveTab("a", "missing", "after");
    expect(useAppStore.getState().tabs).toBe(before);
  });

  it("preserves the active tab id even after reordering", () => {
    useAppStore.setState({ activeTabId: "a" });
    useAppStore.getState().moveTab("a", "d", "after");
    expect(useAppStore.getState().activeTabId).toBe("a");
    expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("appStore.duplicateTab", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [tab("a"), tab("b"), tab("c"), tab("d")],
      activeTabId: "a",
    });
  });

  it("inserts the copy immediately to the right of the original (issue #120)", () => {
    useAppStore.getState().duplicateTab("b");
    const ids = useAppStore.getState().tabs.map((t) => t.id);
    expect(ids).toHaveLength(5);
    // Copy sits at index 2, right after the source "b" — not at the end.
    expect(ids.slice(0, 2)).toEqual(["a", "b"]);
    expect(ids.slice(3)).toEqual(["c", "d"]);
    expect(ids[2]).not.toBe("b");
  });

  it("activates the new copy", () => {
    useAppStore.getState().duplicateTab("b");
    const { tabs, activeTabId } = useAppStore.getState();
    expect(activeTabId).toBe(tabs[2].id);
  });

  it("carries over the source tab fields with a fresh closable copy", () => {
    useAppStore.setState({
      tabs: [tab("a"), tab("locked", { closable: false, title: "Server", hasNewOutput: true })],
      activeTabId: "a",
    });
    useAppStore.getState().duplicateTab("locked");
    const copy = useAppStore.getState().tabs[2];
    expect(copy.title).toBe("Server");
    expect(copy.type).toBe("terminal");
    expect(copy.closable).toBe(true);
    expect(copy.hasNewOutput).toBe(false);
  });

  it("mints a unique id distinct from the source", () => {
    useAppStore.getState().duplicateTab("a");
    const ids = useAppStore.getState().tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is a no-op for an unknown id", () => {
    const before = useAppStore.getState().tabs;
    useAppStore.getState().duplicateTab("missing");
    expect(useAppStore.getState().tabs).toBe(before);
  });

  it("duplicates the last tab adjacently, which is also the end", () => {
    useAppStore.getState().duplicateTab("d");
    const ids = useAppStore.getState().tabs.map((t) => t.id);
    expect(ids.slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    expect(ids).toHaveLength(5);
  });
});

describe("appStore.uiAppearance", () => {
  it("allows setting and persisting uiFontFamily", () => {
    const font = "Outfit, sans-serif";
    useAppStore.getState().setUiFontFamily(font);
    expect(useAppStore.getState().uiFontFamily).toBe(font);
    expect(window.localStorage.getItem("taomni.uiFontFamily")).toBe(font);
  });

  it("allows setting and persisting uiFontSize", () => {
    const size = 14;
    useAppStore.getState().setUiFontSize(size);
    expect(useAppStore.getState().uiFontSize).toBe(size);
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("14");
  });
});

describe("appStore.terminalSplit", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      tabs: [tab("a"), tab("b"), tab("settings", { type: "settings" })],
      activeTabId: "a",
      terminalSplitActive: false,
      terminalSplitLayout: "horizontal",
      terminalSplitInputLockedTabIds: new Set(),
      multiExecSelectedTabIds: new Set(),
    });
  });

  it("toggles terminal split view and keeps a terminal active", () => {
    useAppStore.setState({ activeTabId: "settings" });

    useAppStore.getState().toggleTerminalSplit();

    expect(useAppStore.getState().terminalSplitActive).toBe(true);
    expect(useAppStore.getState().activeTabId).toBe("a");

    useAppStore.getState().toggleTerminalSplit();

    expect(useAppStore.getState().terminalSplitActive).toBe(false);
  });

  it("persists terminal split layout", () => {
    useAppStore.getState().setTerminalSplitLayout("grid");

    expect(useAppStore.getState().terminalSplitLayout).toBe("grid");
    expect(window.localStorage.getItem("taomni.terminalSplitLayout")).toBe("grid");
  });

  it("toggles pane input locks", () => {
    useAppStore.getState().toggleTerminalSplitInputLock("b");

    expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(true);

    useAppStore.getState().toggleTerminalSplitInputLock("b");

    expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(false);
  });

  it("exits split when activating a non-terminal tab", () => {
    useAppStore.setState({ terminalSplitActive: true });

    useAppStore.getState().setActiveTab("settings");

    expect(useAppStore.getState().activeTabId).toBe("settings");
    expect(useAppStore.getState().terminalSplitActive).toBe(false);
  });

  it("cleans closed tab ids from split locks and MultiExec selection", () => {
    useAppStore.setState({
      terminalSplitActive: true,
      terminalSplitInputLockedTabIds: new Set(["b"]),
      multiExecSelectedTabIds: new Set(["a", "b"]),
    });

    useAppStore.getState().removeTab("b");

    expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(false);
    expect(useAppStore.getState().multiExecSelectedTabIds.has("b")).toBe(false);
    expect(useAppStore.getState().multiExecSelectedTabIds.has("a")).toBe(true);
  });
});

