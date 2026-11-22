import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabOverview } from "./TabOverview";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import type { Tab } from "../../types";

const explorerFolder = (id: string, title: string, path: string): Tab => ({
  id, type: "file-browser", title, closable: true, fileBrowser: { initialPath: path, explorer: true },
});
const explorerViewer = (id: string, title: string, path: string): Tab => ({
  id, type: "file-viewer", title, closable: true, fileViewer: { path, kind: "text", mode: "source", source: "local" },
});

const terminal = vi.hoisted(() => ({ text: "first output", read: vi.fn() }));
vi.mock("../../lib/terminal/terminalRegistry", () => {
  const entry = { getLastLines: () => { terminal.read(); return terminal.text; } };
  return { getTerminal: (id: string) => id === "session-1" ? entry : null };
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  terminal.text = "first output";
  terminal.read.mockClear();
  useSessionStore.setState({ sessions: [] });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({
    activeSideTab: "sessions", activeTabId: "session-1", tabFilter: null, sidebarCollapsed: false,
    tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false },
      { id: "session-1", type: "terminal", title: "Build", closable: true }],
  });
  useTabOverviewStore.setState({ open: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useTabOverviewStore.getState().close(); });

it.each([false, true])("keeps the Sessions sidebar collapsed=%s when selecting a card", (sidebarCollapsed) => {
  useAppStore.setState({ sidebarCollapsed, tabFilter: { kind: "protocol", protocol: "ssh" } });
  render(<TabOverview />);
  fireEvent.click(screen.getByTestId("tab-overview-card"));
  expect(useAppStore.getState().sidebarCollapsed).toBe(sidebarCollapsed);
  expect(useAppStore.getState().activeSideTab).toBe("sessions");
  expect(useAppStore.getState().activeTabId).toBe("session-1");
  expect(useAppStore.getState().tabFilter).toBeNull();
  expect(screen.queryByTestId("tab-overview")).not.toBeInTheDocument();
});

it("shows live session output without Welcome and stops refreshing when closed", () => {
  render(<TabOverview />);
  expect(screen.getByTestId("tab-overview")).toHaveAttribute("data-scope", "sessions");
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  expect(screen.queryByText("Welcome")).not.toBeInTheDocument();
  expect(screen.getByTestId("tab-overview-summary")).toHaveTextContent("first output");
  terminal.text = "build completed";
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByTestId("tab-overview-summary")).toHaveTextContent("build completed");
  expect(screen.getByTestId("tab-overview-card")).toHaveAttribute("data-output-active", "true");
  expect(screen.getByTestId("tab-overview-output-badge")).toBeVisible();
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByTestId("tab-overview-card")).not.toHaveAttribute("data-output-active");
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

it("opens the Explorer overview scope and activates the chosen Explorer tab", () => {
  useAppStore.setState({ activeSideTab: "explorer", sidebarCollapsed: true });
  useExplorerStore.setState({
    tabs: [explorerFolder("f1", "Downloads", "/home/me/Downloads"), explorerViewer("v1", "README.md", "/home/me/Downloads/README.md")],
    activeTabId: "f1",
  });
  render(<TabOverview />);
  expect(screen.getByTestId("tab-overview")).toHaveAttribute("data-scope", "explorer");
  const cards = screen.getAllByTestId("tab-overview-card");
  expect(cards).toHaveLength(2);
  expect(cards[0]).toHaveAttribute("data-surface", "explorer");
  expect(cards[0]).toHaveAttribute("data-tab-id", "f1");
  expect(cards[0]).toHaveAttribute("data-active", "true");
  expect(cards[0]).toHaveTextContent("EXPL");
  expect(cards[0]).toHaveTextContent("/home/me/Downloads");
  expect(cards[1]).toHaveTextContent("VIEW");
  expect(screen.getByTestId("tab-overview-current")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(cards[1]);
  expect(useAppStore.getState().activeSideTab).toBe("explorer");
  expect(useExplorerStore.getState().activeTabId).toBe("v1");
  expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  expect(screen.queryByTestId("tab-overview")).not.toBeInTheDocument();
});

it("includes Explorer tabs in the all scope from other surfaces and filters them by path", () => {
  useAppStore.setState({ activeSideTab: "sessions" });
  useExplorerStore.setState({
    tabs: [explorerFolder("f1", "Downloads", "/home/me/Downloads")],
    activeTabId: "f1",
  });
  render(<TabOverview />);
  fireEvent.click(screen.getByTestId("tab-overview-all"));
  const cards = screen.getAllByTestId("tab-overview-card");
  expect(cards).toHaveLength(2);
  expect(cards.filter((card) => card.dataset.surface === "explorer")).toHaveLength(1);
  fireEvent.change(screen.getByTestId("tab-overview-search"), { target: { value: "Downloads" } });
  const filtered = screen.getAllByTestId("tab-overview-card");
  expect(filtered).toHaveLength(1);
  expect(filtered[0]).toHaveAttribute("data-tab-id", "f1");
  fireEvent.click(filtered[0]);
  expect(useAppStore.getState().activeSideTab).toBe("explorer");
  expect(useExplorerStore.getState().activeTabId).toBe("f1");
});

it("keeps Workspace and Explorer cards together in the all scope", () => {
  const ws = useWorkspacePlatformStore.getState();
  const workspace = ws.createWorkspace({ name: "Explorer mix" });
  ws.openLocalTerminalInWorkspace(workspace.id);
  useExplorerStore.setState({ tabs: [explorerFolder("f1", "Downloads", "/home/me/Downloads")], activeTabId: "f1" });
  useAppStore.setState({ activeSideTab: "home" });
  render(<TabOverview />);
  expect(screen.getByTestId("tab-overview")).toHaveAttribute("data-scope", "all");
  const surfaces = screen.getAllByTestId("tab-overview-card").map((card) => card.dataset.surface);
  expect(surfaces).toEqual(expect.arrayContaining(["sessions", "workspaces", "explorer"]));
});

it("filters fuzzy preview text, preserves query across scopes and clears without navigation", () => {
  const ws = useWorkspacePlatformStore.getState();
  const workspace = ws.createWorkspace({ name: "中文 workspace" });
  ws.openLocalTerminalInWorkspace(workspace.id);
  render(<TabOverview />);
  const input = screen.getByTestId("tab-overview-search");
  fireEvent.change(input, { target: { value: "fstot" } });
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "中文" } });
  expect(screen.queryByTestId("tab-overview-card")).not.toBeInTheDocument();
  expect(screen.getByTestId("tab-overview-empty")).toBeVisible();
  fireEvent.click(screen.getByTestId("tab-overview-all"));
  expect(input).toHaveValue("中文");
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(1);
  expect(screen.getByTestId("tab-overview-card")).toHaveAttribute("data-workspace-id", workspace.id);
  fireEvent.click(screen.getByTestId("tab-overview-search-clear"));
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(screen.getAllByTestId("tab-overview-card")).toHaveLength(2);
  expect(useAppStore.getState().activeTabId).toBe("session-1");
});

it("activates the first search result on Enter but leaves IME composition alone", () => {
  render(<TabOverview />);
  const input = screen.getByTestId("tab-overview-search");
  fireEvent.change(input, { target: { value: "bld" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape", isComposing: true });
  expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.queryByTestId("tab-overview")).not.toBeInTheDocument();
  expect(useAppStore.getState().activeTabId).toBe("session-1");
});

it("matches a new output in the open search without moving focus", () => {
  render(<TabOverview />);
  const input = screen.getByTestId("tab-overview-search");
  fireEvent.change(input, { target: { value: "completed" } });
  expect(screen.queryByTestId("tab-overview-card")).not.toBeInTheDocument();
  terminal.text = "build completed";
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByTestId("tab-overview-card")).toHaveAttribute("data-tab-id", "session-1");
  expect(screen.getByTestId("tab-overview-output-badge")).toBeVisible();
  expect(input).toHaveFocus();
});

it("moves focus with arrows and enlarges a hovered card only after the dwell time", () => {
  useAppStore.setState((state) => ({
    tabs: [...state.tabs, { id: "session-2", type: "terminal", title: "Review", closable: true }],
  }));
  render(<TabOverview />);
  const [first, second] = screen.getAllByTestId("tab-overview-card");
  fireEvent.keyDown(screen.getByTestId("tab-overview-search"), { key: "ArrowDown" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(second).toHaveFocus();
  expect(useAppStore.getState().activeTabId).toBe("session-1");

  fireEvent.mouseEnter(second);
  act(() => vi.advanceTimersByTime(1_999));
  expect(screen.queryByTestId("tab-overview-enlarged")).toBeNull();
  fireEvent.mouseLeave(second);
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByTestId("tab-overview-enlarged")).toBeNull();

  fireEvent.mouseEnter(second);
  act(() => vi.advanceTimersByTime(2_000));
  const enlarged = screen.getByTestId("tab-overview-enlarged");
  expect(enlarged).toHaveAttribute("data-tab-id", "session-2");
  expect(useAppStore.getState().activeTabId).toBe("session-1");
  fireEvent.mouseLeave(second, { relatedTarget: enlarged });
  expect(enlarged).toBeVisible();
  fireEvent.click(enlarged);
  expect(screen.queryByTestId("tab-overview-enlarged")).toBeNull();
  expect(useAppStore.getState().activeTabId).toBe("session-2");
});

it("places endpoint metadata in the footer so the header gives maximum room to titles", () => {
  const ws = useWorkspacePlatformStore.getState();
  const workspace = ws.createWorkspace({ name: "My Workspace" });
  ws.openFileInWorkspace(workspace.id, {
    rootId: "root-1",
    path: "src/components/tabbar/overview/OverviewTitle.tsx",
    name: "OverviewTitle.tsx",
  });
  useAppStore.setState({ activeSideTab: "workspaces" });
  render(<TabOverview />);
  const card = screen.getByTestId("tab-overview-card");
  const header = card.querySelector(".taomni-overview-card-header")!;
  const footer = card.querySelector(".taomni-overview-card-footer")!;
  expect(within(header as HTMLElement).getByTestId("tab-overview-card-title")).toHaveTextContent("OverviewTitle.tsx");
  expect(header.textContent).not.toContain("src/components/tabbar/overview/OverviewTitle.tsx");
  expect(footer).toHaveTextContent("My Workspace");
  expect(footer).toHaveTextContent("src/components/tabbar/overview/OverviewTitle.tsx");
});

it("traps keyboard focus and restores the invoking button", () => {
  const button = document.createElement("button"); document.body.append(button); button.focus();
  render(<TabOverview />);
  const close = screen.getByTestId("tab-overview-close");
  expect(screen.getByTestId("tab-overview-search")).toHaveFocus();
  close.focus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(screen.getByTestId("tab-overview-card")).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(button).toHaveFocus();
  button.remove();
});
