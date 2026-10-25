import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabOverview } from "./TabOverview";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

const terminal = vi.hoisted(() => ({ text: "first output", read: vi.fn() }));
vi.mock("../../lib/terminal/terminalRegistry", () => ({
  getTerminal: (id: string) => id === "session-1" ? { getLastLines: () => { terminal.read(); return terminal.text; } } : undefined,
}));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  terminal.text = "first output";
  terminal.read.mockClear();
  useSessionStore.setState({ sessions: [] });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({
    activeSideTab: "sessions", activeTabId: "session-1", tabFilter: null,
    tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false },
      { id: "session-1", type: "terminal", title: "Build", closable: true }],
  });
  useTabOverviewStore.setState({ open: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useTabOverviewStore.getState().close(); });

it("shows live session output without Welcome and stops refreshing when closed", () => {
  render(<TabOverview />);
  expect(screen.getByTestId("tab-overview")).toHaveAttribute("data-scope", "sessions");
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  expect(screen.queryByText("Welcome")).not.toBeInTheDocument();
  expect(screen.getByTestId("tab-overview-summary")).toHaveTextContent("first output");
  terminal.text = "build completed";
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByTestId("tab-overview-summary")).toHaveTextContent("build completed");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("tab-overview")).not.toBeInTheDocument();
  const reads = terminal.read.mock.calls.length;
  act(() => vi.advanceTimersByTime(3000));
  expect(terminal.read).toHaveBeenCalledTimes(reads);
});

it("switches between current and all scopes and activates the correct workspace or session", () => {
  const ws = useWorkspacePlatformStore.getState();
  const workspace = ws.createWorkspace({ name: "Other workspace" });
  const tab = ws.openLocalTerminalInWorkspace(workspace.id);
  render(<TabOverview />);
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("tab-overview-all"));
  const cards = screen.getAllByTestId("tab-overview-card");
  expect(cards).toHaveLength(2);
  fireEvent.click(cards.find((card) => card.dataset.workspaceId === workspace.id)!);
  expect(useAppStore.getState().activeSideTab).toBe("workspaces");
  expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(workspace.id);
  expect(useWorkspacePlatformStore.getState().workspaces.find((entry) => entry.id === workspace.id)?.activeTabId).toBe(tab.id);
  act(() => useTabOverviewStore.setState({ open: true }));
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("tab-overview-all"));
  fireEvent.click(within(screen.getByTestId("tab-overview")).getByText("Build"));
  expect(useAppStore.getState().activeSideTab).toBe("sessions");
  expect(useAppStore.getState().activeTabId).toBe("session-1");
  expect(useAppStore.getState().tabFilter).toBeNull();
});

it("traps keyboard focus and restores the invoking button", () => {
  const button = document.createElement("button"); document.body.append(button); button.focus();
  render(<TabOverview />);
  const close = screen.getByTestId("tab-overview-close");
  expect(close).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(screen.getByTestId("tab-overview-card")).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(button).toHaveFocus();
  button.remove();
});
