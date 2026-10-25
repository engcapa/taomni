import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryNavigationRail } from "../PrimaryNavigationRail";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useToolWindowStripeStore } from "../../editor/workspace/toolWindowStripeStore";
import { defaultStripeSettings } from "../../editor/workspace/toolWindowLayout";

const MODE_ORDER = [
  "nav-mode-home",
  "nav-mode-workspaces",
  "side-tab-sessions",
  "nav-mode-agents",
  "side-tab-tools",
];

const BOTTOM_ORDER = [
  "rail-mfa-button",
  "system-screenshot",
  "rail-chat-button",
  "theme-cycle",
  "language-switcher",
  "ribbon-settings",
];

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState({
    activeSideTab: "sessions",
    sidebarCollapsed: false,
    floatingMfa: { open: false, pinned: false, position: { left: 50, bottom: 30 }, searchQuery: "" },
  });
  useToolWindowStripeStore.setState({ settings: { ...defaultStripeSettings(), showNames: true } });
  useWorkspacePlatformStore.getState().reloadFromStorage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrimaryNavigationRail (TASK-02)", () => {
  it("UT-WS-02-01 renders the five primary modes in order with Home first", () => {
    render(<PrimaryNavigationRail />);
    const rail = screen.getByTestId("sidebar-rail");
    const modeGroup = within(rail).getByTestId("rail-mode-group");
    const order = Array.from(modeGroup.querySelectorAll<HTMLElement>("button")).map((button) => button.dataset.testid);
    expect(order).toEqual(MODE_ORDER);
    expect(within(rail).getByTestId("nav-mode-home").getAttribute("aria-label")).toBe("Home");
  });

  it("UT-WS-02-02 merges the IDEA workspace tool windows into the primary rail", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    render(<PrimaryNavigationRail />);
    const merged = screen.getByTestId("workspace-merged-tool-rail");
    expect(merged).toBeInTheDocument();
    expect(within(merged).getByTestId("code-workspace-tool-rail-left")).toBeInTheDocument();
    const order = Array.from(merged.querySelectorAll<HTMLElement>("button")).map((button) => button.dataset.testid);
    expect(order).toEqual([
      "code-workspace-tool-rail-project",
      "code-workspace-tool-rail-sessions",
      "code-workspace-tool-rail-git",
      "code-workspace-tool-rail-structure",
      "code-workspace-bottom-tab-overflow",
    ]);
  });

  it("opens Sessions from Home without replacing the active editor group's preference", () => {
    useAppStore.setState({
      activeSideTab: "home",
      sidebarCollapsed: true,
      tabs: [{ id: "code", type: "code-workspace", title: "Code", closable: true }],
      activeTabId: "code",
      mergeToolWindowRail: true,
      sidebarCollapsedByGroup: { "code-workspace": true, terminal: true, other: false },
    });
    render(<PrimaryNavigationRail compact />);
    fireEvent.click(screen.getByTestId("side-tab-sessions"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarCollapsedByGroup["code-workspace"]).toBe(true);
    act(() => useAppStore.getState().setActiveTab("code"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    // Explicitly expanding the rail in Sessions still saves the user's choice.
    fireEvent.click(screen.getByTestId("side-tab-sessions"));
    expect(useAppStore.getState().sidebarCollapsedByGroup["code-workspace"]).toBe(false);
  });

  it("UT-WS-02-03 hides the workspace tool windows outside Workspaces mode", () => {
    for (const mode of ["home", "sessions", "agents", "tools"] as const) {
      useAppStore.setState({ activeSideTab: mode });
      const { unmount } = render(<PrimaryNavigationRail />);
      expect(screen.queryByTestId("code-workspace-tool-rail-project")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workspace-merged-tool-rail")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("UT-WS-02-04 keeps every IDEA tool window entry in the overflow menu", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    render(<PrimaryNavigationRail />);
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-overflow"));
    const menu = screen.getByTestId("context-menu");
    const labels = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], button')).map((entry) => entry.textContent ?? "");
    const flat = labels.join(" | ");
    for (const expected of ["Terminal", "Problems", "Run / Debug", "Find", "Bookmarks", "TODO", "Services", "Database", "Show Tool Window Names", "Move to"]) {
      expect(flat).toContain(expected);
    }
  });

  it("UT-WS-02-05 orders the six bottom global tools exactly as specified", () => {
    render(<PrimaryNavigationRail />);
    const bottom = screen.getByTestId("rail-bottom-tools");
    const order = Array.from(bottom.querySelectorAll<HTMLElement>("[data-testid]"))
      .map((element) => element.dataset.testid)
      .filter((value): value is string => BOTTOM_ORDER.includes(value ?? ""));
    expect(order.slice(0, 6)).toEqual(BOTTOM_ORDER);
    // MFA sits above the screenshot entry, language directly below theme.
    const mfa = screen.getByTestId("rail-mfa-button").getBoundingClientRect();
    const screenshot = screen.getByTestId("system-screenshot").getBoundingClientRect();
    expect(mfa.top).toBeLessThanOrEqual(screenshot.top);
  });

  it("UT-WS-02-06 toggles Show Tool Window Names from the rail context menu", () => {
    render(<PrimaryNavigationRail />);
    expect(screen.getByTestId("side-tab-sessions").textContent).toBe("Sessions");
    fireEvent.contextMenu(screen.getByTestId("side-tab-tools"));
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(false);
    expect(screen.getByTestId("side-tab-sessions").textContent).toBe("");
    expect(JSON.parse(window.localStorage.getItem("taomni.codeWorkspace.toolWindowStripes.v1")!).showNames).toBe(false);

    fireEvent.contextMenu(screen.getByTestId("nav-mode-home"));
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(screen.getByTestId("side-tab-sessions").textContent).toBe("Sessions");
  });

  it("UT-WS-02-07 cycles the theme and switches the language from the rail bottom group", () => {
    render(<PrimaryNavigationRail />);
    const theme = screen.getByTestId("theme-cycle");
    expect(theme).toHaveAttribute("aria-label", "Cycle application theme");
    const initial = window.localStorage.getItem("taomni.appTheme.v1");
    fireEvent.click(theme);
    expect(window.localStorage.getItem("taomni.appTheme.v1")).not.toBe(initial);

    fireEvent.click(screen.getByTestId("language-switcher"));
    expect(screen.getByTestId("language-option-en")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("language-option-zh-CN"));
    expect(window.localStorage.getItem("taomni.locale.v1")).toBe("zh-CN");
    fireEvent.click(screen.getByTestId("language-switcher"));
    fireEvent.click(screen.getByTestId("language-option-en"));
    expect(window.localStorage.getItem("taomni.locale.v1")).toBe("en");
  });
});
