import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryNavigationRail } from "../PrimaryNavigationRail";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useToolWindowStripeStore } from "../../editor/workspace/toolWindowStripeStore";
import { defaultStripeSettings } from "../../editor/workspace/toolWindowLayout";
import { useChatStore } from "../../../stores/chatStore";
import { useAiStore } from "../../../stores/aiStore";
import { DEFAULT_CONFIG } from "../../../stores/ai/defaults";

const MODE_ORDER = [
  "nav-mode-home",
  "nav-mode-workspaces",
  "side-tab-sessions",
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
  useAiStore.setState({ config: null });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PrimaryNavigationRail (TASK-02)", () => {
  it("removes the shared Chat entry when AI is disabled and restores it when enabled", () => {
    render(<PrimaryNavigationRail />);
    expect(screen.getByTestId("rail-chat-button")).toBeVisible();
    act(() => useAiStore.setState({ config: { ...DEFAULT_CONFIG, fully_disabled: true } }));
    expect(screen.queryByTestId("rail-chat-button")).not.toBeInTheDocument();
    act(() => useAiStore.setState({ config: { ...DEFAULT_CONFIG, fully_disabled: false } }));
    expect(screen.getByTestId("rail-chat-button")).toBeVisible();
  });
  it("reuses the bottom Chat button for the active session's remembered chat identity", async () => {
    const toggle = vi.spyOn(useChatStore.getState(), "toggleTabChat").mockResolvedValue();
    useAppStore.setState({ activeTabId: "session-a", tabs: [
      { id: "session-a", type: "terminal", title: "A", closable: true, chatTabId: "remembered-a" },
      { id: "session-b", type: "database", title: "B", closable: true },
    ] });
    render(<PrimaryNavigationRail />);
    fireEvent.click(screen.getByTestId("rail-chat-button"));
    expect(toggle).toHaveBeenLastCalledWith("remembered-a");
    act(() => useAppStore.getState().setActiveTab("session-b"));
    fireEvent.click(screen.getByTestId("rail-chat-button"));
    expect(toggle).toHaveBeenLastCalledWith("session-b");
  });
  it("UT-WS-02-01 renders the four primary modes in order with Home first", () => {
    render(<PrimaryNavigationRail />);
    const rail = screen.getByTestId("sidebar-rail");
    const modeGroup = within(rail).getByTestId("rail-mode-group");
    const order = Array.from(modeGroup.querySelectorAll<HTMLElement>("button")).map((button) => button.dataset.testid);
    expect(order).toEqual(MODE_ORDER);
    expect(within(rail).getByTestId("nav-mode-home").getAttribute("aria-label")).toBe("Home");
  });

  it("provides one shared tool host even before an empty workspace has files", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    const attach = vi.fn();
    render(<PrimaryNavigationRail railHostRef={attach} />);
    expect(attach).toHaveBeenCalledWith(screen.getByTestId("sidebar-tool-window-rail"));
    expect(screen.queryByTestId("workspace-merged-tool-rail")).not.toBeInTheDocument();
    // Real workspace tools and actions are exercised with their runtime in
    // WorkspaceGitIntegration, rather than a second mock tool implementation.
    expect(screen.queryByTestId("code-workspace-tool-rail-project")).not.toBeInTheDocument();
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
