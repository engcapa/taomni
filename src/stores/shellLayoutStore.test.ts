import { beforeEach, describe, expect, it } from "vitest";
import { useShellLayoutStore } from "./shellLayoutStore";
import { defaultShellLayout, SHELL_LAYOUT_KEY } from "../lib/shell/shellLayoutPersistence";

describe("Shell layout ownership and temporary navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    useShellLayoutStore.setState({ layout: defaultShellLayout(), initialized: false, writable: true, warning: null,
      navigatorOverlay: false, overlayTarget: null, taoOpen: false, overlay: null, panels: {}, activePanelByEdge: {},
      restoreRefByTab: {}, pinnedTabs: {}, laneOverrides: {}, mru: [], mruCycling: false,
      laneSelection: null, exiting: false });
    useShellLayoutStore.getState().initialize();
  });
  it("opens a temporarily hidden navigator and preserves the expanded preference on dismissal", () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    const shell = useShellLayoutStore.getState();
    shell.toggleNavigator("sessions", "home");
    expect(useShellLayoutStore.getState().navigatorOverlay).toBe(true);
    expect(useShellLayoutStore.getState().layout.navigator.collapsedByLane.home).toBe(false);
    useShellLayoutStore.setState({ navigatorOverlay: false, overlayTarget: null });
    expect(useShellLayoutStore.getState().layout.navigator.collapsedByLane.home).toBe(false);
    shell.toggleNavigator("sessions", "home");
    expect(useShellLayoutStore.getState().navigatorOverlay).toBe(true);
  });
  it("does not overwrite an external replacement on pagehide and allows an explicit reset", () => {
    const external = '{"version":999,"sentinel":"preserve"}';
    localStorage.setItem(SHELL_LAYOUT_KEY, external);
    useShellLayoutStore.getState().flush();
    expect(localStorage.getItem(SHELL_LAYOUT_KEY)).toBe(external);
    expect(useShellLayoutStore.getState().writable).toBe(false);
    useShellLayoutStore.getState().resetLayout();
    expect(JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY)!)).toMatchObject({ version: 2 });
  });
  it("keeps duplicate saved-session tabs independent from the original pin and lane preference", () => {
    const shell = useShellLayoutStore.getState(), source = { kind: "run-entry" as const, identity: "saved:alpha" };
    shell.bindRestoreSource("original", source, 1);
    shell.pinTab("original", true);
    shell.moveTab("original", "utility");
    shell.bindRestoreSource("copy", source, 2);
    expect(useShellLayoutStore.getState().pinnedTabs.copy).toBeUndefined();
    expect(useShellLayoutStore.getState().laneOverrides.copy).toBeUndefined();
    shell.pinTab("copy", false);
    shell.moveTab("copy", "build");
    expect(useShellLayoutStore.getState().layout.restoredTabs["run-entry:saved:alpha"]).toEqual({ pinned: true, laneOverride: "utility", order: 1 });
    expect(useShellLayoutStore.getState().pinnedTabs.original).toBe(true);
    expect(useShellLayoutStore.getState().laneOverrides.original).toBe("utility");
    shell.pruneTabs(["copy"]);
    shell.bindRestoreSource("copy", source, 1);
    expect(useShellLayoutStore.getState().layout.restoredTabs["run-entry:saved:alpha"]).toEqual({ pinned: false, laneOverride: "build", order: 1 });
  });
  it("records last-active identity when the active workspace model binds after activation", () => {
    const shell = useShellLayoutStore.getState();
    shell.visitTab("workspace-tab");
    shell.bindRestoreSource("workspace-tab", { kind: "workspace", workspaceInstanceId: "w1", workspace: { repoRoot: "/repo" } }, 1, true);
    shell.bindRestoreSource("background", { kind: "run-entry", identity: "saved:alpha" }, 2, false);
    shell.flush();
    expect(JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY)!).lastActiveRestoreRef).toBe("workspace:w1");
  });
  it.each([
    ["session", { kind: "run-entry", identity: "saved:alpha" }],
    ["workspace", { kind: "workspace", workspaceInstanceId: "w1", workspace: { repoRoot: "/repo" } }],
  ] as const)("keeps an explicitly selected empty lane when the active %s binds later", (_kind, source) => {
    const shell = useShellLayoutStore.getState();
    shell.visitTab("previous");
    shell.visitTab("pending");
    shell.selectLane("communicate");
    shell.bindRestoreSource("pending", source, 1, true);
    const state = useShellLayoutStore.getState();
    expect(state.laneSelection).toBe("communicate");
    expect(state.mru).toEqual(["pending", "previous"]);
    expect(state.layout.lastActiveRestoreRef).toBe(state.restoreRefByTab.pending);
    shell.flush();
    expect(JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY)!).lastActiveRestoreRef).toBe(state.restoreRefByTab.pending);
    shell.visitTab("previous");
    expect(useShellLayoutStore.getState().laneSelection).toBeNull();
  });
  it("restores a separate panel width for each owner without persisting a transient clamp", () => {
    const shell = useShellLayoutStore.getState();
    shell.bindRestoreSource("a", { kind: "run-entry", identity: "session:a" }, 1);
    const panel = { id: "tab:a:sftp", kind: "sftp" as const, owner: { kind: "tab" as const, tabId: "a", restoreRef: "run-entry:session:a" }, generation: 1,
      phase: "ready" as const, requestedOpen: true, pinned: true, placement: { kind: "dock" as const, edge: "right" as const }, operation: null, error: null };
    shell.registerPanel(panel);
    shell.resizePanel(panel.id, 420);
    shell.removePanel(panel.id);
    shell.registerPanel(panel);
    expect(useShellLayoutStore.getState().panels[panel.id].preferredSize).toBe(420);
  });
  it("preserves the recent-panel operation dialog when its destination suppresses Tao", () => {
    const shell = useShellLayoutStore.getState();
    shell.registerPanel({ id: "recent", kind: "sftp", owner: { kind: "tab", tabId: "a" }, generation: 1, phase: "initializing", requestedOpen: false, pinned: true, placement: { kind: "dock", edge: "right" }, operation: null, error: null });
    useShellLayoutStore.setState({ overlay: "panels", taoOpen: true });
    shell.openPanel("recent");
    expect(useShellLayoutStore.getState()).toMatchObject({ overlay: "panels", taoOpen: false });
    expect(useShellLayoutStore.getState().panels.recent.requestedOpen).toBe(true);
  });
});
