import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryNavigationRail } from "../PrimaryNavigationRail";
import { useAppStore } from "../../../stores/appStore";
import { useToolWindowStripeStore } from "../../editor/workspace/toolWindowStripeStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { setLocale } from "../../../lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function renderRail(compact = false) {
  return render(<PrimaryNavigationRail compact={compact} onOpenSettings={vi.fn()} />);
}

function railButtonOrder(): string[] {
  return screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("data-testid") ?? "")
    .filter(Boolean);
}

describe("PrimaryNavigationRail (TASK-02)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale("en");
    useAppStore.setState({ activeSideTab: "sessions", sidebarCollapsed: false, floatingMfa: { open: false, pinned: false, position: { left: 50, bottom: 30 }, searchQuery: "" } });
    useToolWindowStripeStore.setState({ settings: { showNames: false, leftWidth: 40, rightWidth: 40 } });
    useWorkspacePlatformStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("UT-WS-02-01: renders the five primary modes in order with Home first", () => {
    renderRail();
    const ids = railButtonOrder();
    const indexOf = (id: string) => ids.indexOf(id);
    expect(indexOf("nav-mode-home")).toBeGreaterThanOrEqual(0);
    expect(indexOf("nav-mode-home")).toBeLessThan(indexOf("nav-mode-workspaces"));
    expect(indexOf("nav-mode-workspaces")).toBeLessThan(indexOf("side-tab-sessions"));
    expect(indexOf("side-tab-sessions")).toBeLessThan(indexOf("nav-mode-agents"));
    expect(indexOf("nav-mode-agents")).toBeLessThan(indexOf("side-tab-tools"));
  });

  it("UT-WS-02-02: Workspaces mode fuses the IDEA tool window buttons into the rail", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    renderRail();
    const fused = screen.getByTestId("code-workspace-tool-rail-left");
    const ids = [
      "code-workspace-tool-rail-project",
      "code-workspace-tool-rail-sessions",
      "code-workspace-tool-rail-git",
      "code-workspace-tool-rail-structure",
      "code-workspace-bottom-tab-overflow",
    ];
    // DOM order must match the contract exactly.
    const positions = ids.map((id) => {
      const button = within(fused).getByTestId(id);
      return Array.from(fused.querySelectorAll<HTMLElement>("[data-testid]")).indexOf(button);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const id of ids) expect(within(fused).getByTestId(id)).toBeInTheDocument();
  });

  it("UT-WS-02-03: hides the workspace contextual buttons outside Workspaces mode", () => {
    for (const mode of ["home", "sessions", "agents", "tools"] as const) {
      useAppStore.setState({ activeSideTab: mode });
      const view = renderRail();
      expect(screen.queryByTestId("code-workspace-tool-rail-project")).not.toBeInTheDocument();
      expect(screen.queryByTestId("code-workspace-tool-rail-left")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("UT-WS-02-04: keeps the full IDEA overflow menu behind ⋯", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    renderRail();
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-overflow"));
    const text = document.body.textContent ?? "";
    for (const label of ["Terminal", "Problems", "Run", "Find", "Bookmarks", "TODO", "Services", "Database", "Show Tool Window Names", "Move to"]) {
      expect(text).toContain(label);
    }
  });

  it("UT-WS-02-05: orders the bottom six tools MFA → screenshot → chat → theme → language → settings", () => {
    renderRail();
    const bottom = screen.getByTestId("rail-bottom-tools");
    const ids = within(bottom)
      .queryAllByRole("button")
      .map((button) => button.getAttribute("data-testid") ?? "")
      .filter(Boolean);
    const ordered = ["rail-mfa-button", "system-screenshot", "system-screenshot-delay-toggle", "rail-chat-button", "theme-cycle", "language-switcher", "ribbon-settings"]
      .filter((id) => ids.includes(id));
    expect(ordered).toEqual([
      "rail-mfa-button",
      "system-screenshot",
      "system-screenshot-delay-toggle",
      "rail-chat-button",
      "theme-cycle",
      "language-switcher",
      "ribbon-settings",
    ]);
    const indexOf = (id: string) => ids.indexOf(id);
    expect(indexOf("rail-mfa-button")).toBeLessThan(indexOf("system-screenshot"));
    expect(indexOf("system-screenshot")).toBeLessThan(indexOf("rail-chat-button"));
    expect(indexOf("rail-chat-button")).toBeLessThan(indexOf("theme-cycle"));
    expect(indexOf("theme-cycle")).toBeLessThan(indexOf("language-switcher"));
    expect(indexOf("language-switcher")).toBeLessThan(indexOf("ribbon-settings"));
  });

  it("UT-WS-02-06: right-click toggles Show Tool Window Names both ways and persists", () => {
    renderRail();
    const rail = screen.getByTestId("sidebar-rail");
    fireEvent.contextMenu(rail);
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(true);
    expect(window.localStorage.getItem("taomni.codeWorkspace.toolWindowStripes.v1")).toContain('"showNames":true');
    fireEvent.contextMenu(rail);
    fireEvent.click(screen.getByTestId("sidebar-rail-menu-show-names"));
    expect(useToolWindowStripeStore.getState().settings.showNames).toBe(false);
  });

  it("UT-WS-02-07: language and theme switches work from the rail bottom", () => {
    renderRail();
    fireEvent.click(screen.getByTestId("language-switcher"));
    expect(screen.getByTestId("language-option-en")).toBeInTheDocument();
    expect(screen.getByTestId("language-option-zh-CN")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("language-option-en"));

    const themeButton = screen.getByTestId("theme-cycle");
    expect(themeButton.getAttribute("aria-label")).toBe("Cycle application theme");
    const before = window.localStorage.getItem("taomni.appTheme.v1");
    fireEvent.click(themeButton);
    expect(window.localStorage.getItem("taomni.appTheme.v1")).toBeTruthy();
    expect(window.localStorage.getItem("taomni.appTheme.v1")).not.toBe(before ?? null);
  });

  it("switches modes on click and collapses the sidebar when re-clicking the active mode", () => {
    renderRail();
    fireEvent.click(screen.getByTestId("nav-mode-workspaces"));
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    fireEvent.click(screen.getByTestId("nav-mode-workspaces"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    fireEvent.click(screen.getByTestId("nav-mode-home"));
    expect(useAppStore.getState().activeSideTab).toBe("home");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("UT-WS-04 wiring: the MFA button toggles the floating window state", () => {
    renderRail();
    fireEvent.click(screen.getByTestId("rail-mfa-button"));
    expect(useAppStore.getState().floatingMfa.open).toBe(true);
    fireEvent.click(screen.getByTestId("rail-mfa-button"));
    expect(useAppStore.getState().floatingMfa.open).toBe(false);
  });
});
