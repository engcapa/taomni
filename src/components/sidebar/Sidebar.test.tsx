import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { defaultStripeSettings } from "../editor/workspace/toolWindowLayout";

beforeEach(() => {
  useAppStore.setState({ activeSideTab: "sessions", sidebarCollapsed: false });
  useToolWindowStripeStore.setState({ settings: defaultStripeSettings() });
  useSessionStore.setState({ sessions: [], groups: [], selectedSessionId: null, selectedSessionIds: [], searchQuery: "" });
});

afterEach(() => {
  cleanup();
  useMainRailHostStore.setState({ host: null });
});

describe("Sidebar rail (ED-PARITY-027)", () => {
  it("keeps the same expanded session tree, selection and scroll position across Navigator pages", () => {
    useSessionStore.setState({ sessions: [{
      id: "retained-tree-session", name: "Retained SSH", session_type: "SSH", group_path: "User sessions / Shell / 甲",
      host: "example.test", port: 22, username: "qa", auth_method: "Agent", options_json: "{}",
      created_at: 1, updated_at: 1, last_connected_at: null, sort_order: 0,
    }] });
    render(<Sidebar navigatorOnly />);
    const tree = screen.getByTestId("session-tree");
    const folder = (path: string) => tree.querySelector(`[data-testid="session-tree-folder"][data-folder-path="${path}"]`)!;
    fireEvent.click(folder("Shell"));
    fireEvent.click(folder("Shell / 甲"));
    const row = screen.getByTestId("session-tree-item");
    fireEvent.click(row);
    tree.scrollTop = 35;
    act(() => useAppStore.getState().setActiveSideTab("tools"));
    expect(tree).not.toBeVisible();
    expect(screen.getByTestId("sidebar-tools-panel")).toBeVisible();
    act(() => useAppStore.getState().setActiveSideTab("sessions"));
    expect(screen.getByTestId("session-tree")).toBe(tree);
    expect(screen.getByTestId("session-tree-item")).toBe(row);
    expect(row).toBeVisible();
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(tree.scrollTop).toBe(35);
  });

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
