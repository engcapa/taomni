import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultShellLayout } from "../../lib/shell/shellLayoutPersistence";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { TabBar } from "../tabbar/TabBar";
import { TabNavigator } from "./TabNavigator";

vi.mock("../../lib/ipc", () => ({
  listLocalShells: vi.fn(async () => []),
  listWslDistros: vi.fn(async () => []),
}));

// jsdom has no scrolling implementation; real focus and stores remain mounted.
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

beforeEach(() => {
  useSessionStore.setState({ sessions: [] });
  useAppStore.setState({
    tabs: [
      { id: "welcome", type: "welcome", title: "Home", closable: false },
      { id: "terminal-a", type: "terminal", title: "Terminal A", closable: true },
    ],
    activeTabId: "welcome", tabFilter: null, multiExecActive: false,
    terminalRuntimeByTab: {}, codeWorkspaceByTab: {}, cwdByTab: {},
  });
  useShellLayoutStore.setState({
    layout: defaultShellLayout(), overlay: null, laneSelection: null,
    pinnedTabs: {}, laneOverrides: {}, mru: ["welcome", "terminal-a"],
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderNavigator() {
  return render(<>
    <button data-testid="opener" onClick={() => useShellLayoutStore.getState().setOverlay("overview")}>Overview</button>
    <TabBar shellMode onStartLocalTerminal={vi.fn()} onConnectSession={vi.fn()} onOpenSessionEditor={vi.fn()} />
    <TabNavigator onNewSession={vi.fn()} />
  </>);
}

describe("TabNavigator focus handoff", () => {
  it("keeps the Overview menu rename input focused until its edited title is committed", () => {
    renderNavigator();
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    const card = screen.getAllByTestId("shell-tab-card").find((node) => node.dataset.tabId === "terminal-a")!;
    fireEvent.click(within(card).getByTestId("shell-tab-card-more"));
    fireEvent.click(screen.getByTestId("shell-tab-rename"));
    const input = screen.getByTestId("tab-title-input");
    expect(input).toHaveFocus();
    expect(screen.queryByTestId("shell-overview")).not.toBeInTheDocument();
    expect(useAppStore.getState().activeTabId).toBe("terminal-a");
    fireEvent.change(input, { target: { value: "Renamed 中文" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useAppStore.getState().tabs.find((tab) => tab.id === "terminal-a")?.title).toBe("Renamed 中文");
    expect(screen.queryByTestId("tab-title-input")).not.toBeInTheDocument();
  });

  it.each(["overview", "quick"] as const)("returns focus after Escape and reopening %s", (overlay) => {
    renderNavigator();
    const opener = screen.getByTestId("opener");
    for (let attempt = 0; attempt < 2; attempt++) {
      opener.focus();
      act(() => useShellLayoutStore.getState().setOverlay(overlay));
      const input = screen.getByTestId(overlay === "quick" ? "shell-quick-input" : "shell-tab-search");
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(useShellLayoutStore.getState().overlay).toBeNull();
      expect(opener).toHaveFocus();
    }
  });

  it("returns focus when the Overview is dismissed with its close button", () => {
    renderNavigator();
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByTestId("shell-tab-navigator-close");
    close.focus();
    fireEvent.click(close);
    expect(opener).toHaveFocus();
  });
});
