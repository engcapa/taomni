import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useAppStore } from "../../stores/appStore";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { defaultStripeSettings } from "../editor/workspace/toolWindowLayout";

beforeEach(() => {
  useAppStore.setState({ activeSideTab: "sessions", sidebarCollapsed: false });
  useToolWindowStripeStore.setState({ settings: defaultStripeSettings() });
});

afterEach(() => {
  cleanup();
  useMainRailHostStore.setState({ host: null });
  vi.unstubAllGlobals();
});

describe("Sidebar rail (ED-PARITY-027)", () => {
  it("publishes the tool window host only in the collapsed rail", () => {
    const { unmount } = render(<Sidebar compact />);
    const host = screen.getByTestId("sidebar-tool-window-rail");
    expect(useMainRailHostStore.getState().host).toBe(host);
    unmount();
    expect(useMainRailHostStore.getState().host).toBeNull();
    render(<Sidebar />);
    expect(screen.queryByTestId("sidebar-tool-window-rail")).toBeNull();
    expect(useMainRailHostStore.getState().host).toBeNull();
  });

  it("opens and collapses the permanent panels using the shared tool window buttons", () => {
    const { rerender } = render(<Sidebar compact />);
    const sessions = screen.getByTestId("side-tab-sessions");
    const tools = screen.getByTestId("side-tab-tools");
    expect(sessions.tagName).toBe("BUTTON");
    expect(tools.querySelector("svg")).toBeTruthy();
    expect(sessions).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tools);
    expect(useAppStore.getState()).toMatchObject({ activeSideTab: "tools", sidebarCollapsed: false });
    rerender(<Sidebar />);
    expect(screen.getByTestId("side-tab-tools")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sidebar-tools-panel")).toBeVisible();
    fireEvent.click(screen.getByTestId("side-tab-tools"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    act(() => useAppStore.setState({ sidebarCollapsed: false }));
    fireEvent.doubleClick(screen.getByTestId("side-tab-sessions"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("shares the persisted names preference in both sidebar layouts and keeps both entries", () => {
    const { rerender } = render(<Sidebar compact />);
    expect(screen.getByTestId("side-tab-sessions").textContent).not.toBe("");
    fireEvent.contextMenu(screen.getByTestId("side-tab-tools"));
    const menu = screen.getByTestId("context-menu");
    expect(within(menu).getAllByTestId("sidebar-rail-menu-show-names")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(false);
    expect(JSON.parse(localStorage.getItem("taomni.codeWorkspace.toolWindowStripes.v1")!).showNames).toBe(false);
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "40px" });
    expect(screen.getByTestId("side-tab-sessions").textContent).toBe("");
    expect(screen.getByTestId("side-tab-tools")).toHaveAttribute("aria-label");
    rerender(<Sidebar />);
    expect(screen.getByTestId("side-tab-sessions")).toBeVisible();
    act(() => useToolWindowStripeStore.getState().toggleShowNames());
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "59px" });
    expect(screen.getByTestId("side-tab-tools").textContent).not.toBe("");
  });

  it.each([true, false])("opens the names menu from the empty rail and Settings without tab tools (compact=%s)", (compact) => {
    useAppStore.setState({ activeSideTab: "tools" });
    render(<Sidebar compact={compact} />);
    fireEvent.contextMenu(screen.getByTestId("sidebar-rail"));
    expect(screen.getAllByTestId("context-menu")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(screen.getByTestId("side-tab-tools")).toHaveTextContent("");
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(false);

    fireEvent.contextMenu(screen.getByTestId("ribbon-settings"));
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(true);
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "59px" });
  });

  it.each([true, false])("shows Settings names with the other actions and keeps it clickable (compact=%s)", (compact) => {
    useAppStore.setState({ activeSideTab: "tools" });
    const onOpenSettings = vi.fn();
    render(<Sidebar compact={compact} onOpenSettings={onOpenSettings} />);
    const settings = screen.getByTestId("ribbon-settings");
    expect(settings).toHaveTextContent(/^Settings$/);
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    act(() => useToolWindowStripeStore.getState().toggleShowNames());
    expect(settings.textContent).toBe("");
    expect(settings).toHaveAttribute("aria-label", "Settings");
    expect(settings.querySelector("svg")).toBeTruthy();
    fireEvent.contextMenu(settings);
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(settings).toHaveTextContent(/^Settings$/);
  });

  it.each([true, false])("resizes the rail by pointer and keyboard without tab tools (compact=%s)", (compact) => {
    useAppStore.setState({ activeSideTab: "tools" });
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<Sidebar compact={compact} />);
    const handle = screen.getByTestId("sidebar-rail-resize");
    fireEvent.pointerDown(handle, { button: 0, clientX: 59 });
    fireEvent.pointerMove(window, { clientX: 79 });
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "79px" });
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 95 });
    expect(useToolWindowStripeStore.getState().settings.leftWidth).toBe(79);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "83px" });
    expect(JSON.parse(localStorage.getItem("taomni.codeWorkspace.toolWindowStripes.v1")!).leftWidth).toBe(83);

    fireEvent.pointerDown(handle, { button: 0, clientX: 83 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "100px" });
    fireEvent.pointerMove(window, { clientX: 0 });
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "40px" });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(useToolWindowStripeStore.getState().settings.leftWidth).toBe(40);
  });

  it("cleans up an active rail drag when names are hidden and restores the saved width", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<Sidebar compact />);
    fireEvent.pointerDown(screen.getByTestId("sidebar-rail-resize"), { button: 0, clientX: 59 });
    fireEvent.pointerMove(window, { clientX: 79 });
    act(() => useToolWindowStripeStore.getState().toggleShowNames());
    expect(screen.queryByTestId("sidebar-rail-resize")).toBeNull();
    fireEvent.pointerMove(window, { clientX: 95 });
    expect(useToolWindowStripeStore.getState().settings.leftWidth).toBe(79);
    act(() => useToolWindowStripeStore.getState().toggleShowNames());
    expect(screen.getByTestId("sidebar-rail")).toHaveStyle({ width: "79px" });
  });

  it("keeps a double-click collapsed when its first click swaps the sidebar mount", () => {
    function SwitchingSidebar() {
      const compact = useAppStore((state) => state.sidebarCollapsed);
      return <Sidebar key={compact ? "compact" : "expanded"} compact={compact} />;
    }
    render(<SwitchingSidebar />);
    const expandedButton = screen.getByTestId("side-tab-sessions");
    fireEvent.click(expandedButton, { detail: 1 });
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    const compactButton = screen.getByTestId("side-tab-sessions");
    expect(compactButton).not.toBe(expandedButton);
    fireEvent.click(compactButton, { detail: 2 });
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.getByTestId("sidebar-tool-window-rail")).toBeVisible();
  });
});
