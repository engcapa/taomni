import { beforeEach, describe, expect, it } from "vitest";
import { useShellLayoutStore } from "./shellLayoutStore";
import { defaultShellLayout, SHELL_LAYOUT_KEY } from "../lib/shell/shellLayoutPersistence";

describe("Shell layout ownership and temporary navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    useShellLayoutStore.setState({ layout: defaultShellLayout(), initialized: false, writable: true, warning: null,
      navigatorOverlay: false, overlayTarget: null, taoOpen: false, overlay: null, panels: {}, activePanelByEdge: {} });
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
