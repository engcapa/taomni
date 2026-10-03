import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
