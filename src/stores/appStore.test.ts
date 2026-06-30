import { beforeEach, describe, expect, it } from "vitest";
import { computeNewTerminalTitle, useAppStore } from "./appStore";
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
    // Copy gets the next sequence number in the "Server" family.
    expect(copy.title).toBe("Server-1");
    expect(copy.type).toBe("terminal");
    expect(copy.closable).toBe(true);
    expect(copy.hasNewOutput).toBe(false);
  });

  it("increments the -N suffix across same-prefix open tabs", () => {
    useAppStore.setState({
      tabs: [
        tab("s0", { title: "Server" }),
        tab("s1", { title: "Server-1" }),
        tab("other", { title: "Other" }),
      ],
      activeTabId: "s0",
    });
    const activeTitle = () => {
      const { tabs, activeTabId } = useAppStore.getState();
      return tabs.find((t) => t.id === activeTabId)?.title;
    };
    // Duplicating the base bumps to the next free family number.
    useAppStore.getState().duplicateTab("s0");
    expect(activeTitle()).toBe("Server-2");
    // Duplicating an already-numbered member continues the same family.
    useAppStore.getState().duplicateTab("s1");
    expect(activeTitle()).toBe("Server-3");
  });

  it("only carries terminalInitialCwd onto terminal copies", () => {
    useAppStore.setState({
      tabs: [
        tab("term", { title: "Local" }),
        tab("rdp", { type: "rdp", title: "Desktop" }),
      ],
      activeTabId: "term",
    });
    useAppStore.getState().duplicateTab("term", { terminalInitialCwd: "/home/me" });
    expect(useAppStore.getState().tabs[1].terminalInitialCwd).toBe("/home/me");
    useAppStore.getState().duplicateTab("rdp", { terminalInitialCwd: "/home/me" });
    expect(useAppStore.getState().tabs.find((t) => t.id !== "rdp" && t.title === "Desktop-1")?.terminalInitialCwd).toBeUndefined();
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

describe("computeNewTerminalTitle", () => {
  it("keeps the requested title when no terminal title family exists", () => {
    expect(computeNewTerminalTitle("Local terminal", ["root@example.test"])).toBe("Local terminal");
  });

  it("adds the next -N suffix when the requested terminal title already exists", () => {
    expect(computeNewTerminalTitle("Local terminal", ["Local terminal", "Local terminal-1"])).toBe(
      "Local terminal-2",
    );
  });

  it("continues an existing suffixed family even when the base title is closed", () => {
    expect(computeNewTerminalTitle("PowerShell", ["PowerShell-2"])).toBe("PowerShell-3");
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

  it("clamps uiFontSize to the supported settings range", () => {
    useAppStore.getState().setUiFontSize(99);
    expect(useAppStore.getState().uiFontSize).toBe(18);
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("18");

    useAppStore.getState().setUiFontSize(3);
    expect(useAppStore.getState().uiFontSize).toBe(10);
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("10");
  });

  it("allows setting and persisting the welcome recent session limit", () => {
    useAppStore.getState().setWelcomeRecentSessionLimit(35);
    expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(35);
    expect(window.localStorage.getItem("taomni.welcomeRecentSessionLimit")).toBe("35");

    useAppStore.getState().setWelcomeRecentSessionLimit(250);
    expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(100);

    useAppStore.getState().setWelcomeRecentSessionLimit(-5);
    expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(1);
  });
});

describe("appStore.dbSelectedObjects", () => {
  beforeEach(() => {
    useAppStore.setState({ dbSelectedObjectsByTab: {} });
  });

  it("records, updates, and clears DB tab selected objects", () => {
    useAppStore.getState().setTabDbSelectedObjects("db-tab-1", [
      {
        catalog: "hive",
        schema: "default",
        name: "orders",
        kind: "table",
      },
      {
        catalog: "hive",
        schema: "default",
        name: "sp_sync",
        kind: "procedure",
      },
    ]);

    expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toMatchObject([
      {
        catalog: "hive",
        schema: "default",
        name: "orders",
        kind: "table",
      },
      {
        catalog: "hive",
        schema: "default",
        name: "sp_sync",
        kind: "procedure",
      },
    ]);

    useAppStore.getState().setTabDbSelectedObjects("db-tab-1", [
      {
        catalog: null,
        schema: "public",
        name: "report_v",
        kind: "view",
      },
    ]);
    expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toMatchObject([
      {
        catalog: null,
        schema: "public",
        name: "report_v",
        kind: "view",
      },
    ]);

    useAppStore.getState().setTabDbSelectedObjects("db-tab-1", null);
    expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toBeUndefined();
  });
});

describe("appStore.sidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ sidebarCollapsed: true });
  });

  it("persists explicit sidebar collapsed changes", () => {
    useAppStore.getState().setSidebarCollapsed(false);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("false");

    useAppStore.getState().setSidebarCollapsed(true);
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("true");
  });

  it("persists sidebar toggle changes", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("false");
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

