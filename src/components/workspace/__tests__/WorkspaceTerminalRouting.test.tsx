import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryNavigationRail } from "../../sidebar/PrimaryNavigationRail";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { AppDialogProvider } from "../../../lib/appDialogs";
import { useAppStore } from "../../../stores/appStore";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { useMainRailHostStore } from "../../../stores/mainRailHostStore";
import { useWorkspaceEditorStore } from "../../../stores/workspaceEditorStore";
import { useWorkspaceEditorHostStore } from "../../../stores/workspaceEditorHostStore";
import { useWorkspacePlatformStore, DEFAULT_WORKSPACE_ID } from "../../../stores/workspacePlatformStore";
import { useWorkspaceRailStore } from "../../../stores/workspaceRailStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { workspaceBoundary } from "./workspaceBoundary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((command: string, args: Record<string, unknown>) => workspaceBoundary.invoke(command, args)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../WorkspaceGitPanel", () => ({ WorkspaceGitPanel: () => null }));
const terminals = vi.hoisted(() => ({ started: vi.fn(), stopped: vi.fn() }));
vi.mock("../../terminal/TerminalPanel", () => ({ TerminalPanel: ({ tabId, visible }: { tabId: string; visible: boolean }) => {
  const [output, setOutput] = useState("");
  useEffect(() => {
    terminals.started(tabId);
    return () => terminals.stopped(tabId);
  }, [tabId]);
  return <div data-testid="test-terminal" data-terminal-id={tabId} data-visible={visible}>
    <button onClick={() => setOutput((previous) => `${previous}output\n`)}>Execute terminal command</button>
    <output>{output}</output>
  </div>;
} }));
vi.mock("../WorkspaceSessionPane", () => ({ WorkspaceSessionPane: ({ tab }: { tab: { id: string; title: string } }) => (
  <div data-testid={`test-session-${tab.id}`}>{tab.title} retained session content</div>
) }));

function Shell({ visible = true }: { visible?: boolean }) {
  return <AppDialogProvider>
    <PrimaryNavigationRail railHostRef={useMainRailHostStore.getState().setHost} />
    <WorkspaceSidebar onOpenSessionPicker={vi.fn()} />
    <WorkspaceMainPanel visible={visible} />
  </AppDialogProvider>;
}

const workspace = () => useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!;
const railTerminal = () => within(screen.getByTestId("sidebar-tool-window-rail")).getByTestId("code-workspace-bottom-tab-terminal");

beforeEach(() => {
  localStorage.clear();
  workspaceBoundary.reset();
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useWorkspaceRailStore.setState({ forceMerge: true });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ canvasLayouts: {}, fsModal: null, sessionPickerOpen: false });
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false, codeWorkspaceByTab: {} });
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("workspace Terminal rail routing (#797)", () => {
  it.each(["terminal", "database", "sftp", "git"] as const)("keeps the selected %s canvas and exact tab list", async (kind) => {
    const platform = useWorkspacePlatformStore.getState();
    const tab = platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    useWorkspacePlatformStore.setState({ workspaces: [{ ...workspace(), openTabs: [{ ...tab, kind }] }] });
    render(<Shell />);
    await screen.findByTestId("code-workspace-bottom-tab-terminal");
    const before = workspace().openTabs;
    fireEvent.click(railTerminal());
    expect(workspace().activeTabId).toBe(tab.id);
    expect(workspace().openTabs).toEqual(before);
    expect(await screen.findByTestId("workspace-bottom-dock")).toBeVisible();
    expect(railTerminal()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(railTerminal());
    expect(screen.getByTestId("workspace-bottom-dock")).not.toBeVisible();
    expect(railTerminal()).toHaveAttribute("aria-pressed", "false");
    expect(workspace().activeTabId).toBe(tab.id);
  });

  it("does not recreate a closed Code Workspace and keeps one terminal across hide/show and modes", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const code = platform.openCodeWorkspaceTab(DEFAULT_WORKSPACE_ID);
    const session = platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    platform.closeWorkspaceTab(DEFAULT_WORKSPACE_ID, code.id);
    const { rerender, unmount } = render(<Shell />);
    await screen.findByTestId("code-workspace-bottom-tab-terminal");
    fireEvent.click(railTerminal());
    expect(workspace().activeTabId).toBe(session.id);
    expect(workspace().openTabs.map((tab) => tab.kind)).toEqual(["terminal"]);
    const terminal = await screen.findByTestId("test-terminal");
    fireEvent.click(within(terminal).getByRole("button"));
    expect(terminal).toHaveTextContent("output");
    fireEvent.click(screen.getByTestId("workspace-dock-close"));
    expect(terminal).not.toBeVisible();
    fireEvent.click(railTerminal());
    expect(await screen.findByTestId("test-terminal")).toBe(terminal);
    expect(terminal).toHaveTextContent("output");
    act(() => useAppStore.setState({ activeSideTab: "home" }));
    rerender(<Shell visible={false} />);
    await waitFor(() => expect(terminal).toHaveAttribute("data-visible", "false"));
    act(() => useAppStore.setState({ activeSideTab: "workspaces" }));
    rerender(<Shell />);
    await waitFor(() => expect(terminal).toHaveAttribute("data-visible", "true"));
    expect(terminals.started).toHaveBeenCalledTimes(1);
    expect(terminals.stopped).not.toHaveBeenCalled();
    expect(screen.getByTestId(`test-session-${session.id}`)).toBeVisible();
    unmount();
    expect(terminals.stopped).toHaveBeenCalledTimes(1);
    expect(useWorkspaceEditorHostStore.getState().terminalHosts).toEqual({});
  });

  it("keeps context-menu Hide and overflow Show on the visible workspace dock", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const session = platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    render(<Shell />);
    await screen.findByTestId("code-workspace-bottom-tab-terminal");
    fireEvent.click(railTerminal());
    await screen.findByTestId("test-terminal");
    fireEvent.contextMenu(railTerminal());
    fireEvent.click(await screen.findByTestId("code-workspace-tool-rail-menu-toggle"));
    expect(screen.getByTestId("workspace-bottom-dock")).not.toBeVisible();
    fireEvent.click(within(screen.getByTestId("sidebar-tool-window-rail")).getByTestId("code-workspace-bottom-tab-overflow"));
    fireEvent.click(await screen.findByTestId("code-workspace-bottom-tab-overflow-terminal"));
    expect(screen.getByTestId("workspace-bottom-dock")).toBeVisible();
    expect(workspace().activeTabId).toBe(session.id);
    expect(terminals.started).toHaveBeenCalledTimes(1);
  });

  it("isolates terminal content by workspace and retains the first owner on return", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const second = platform.createWorkspace({ name: "Second" });
    platform.openLocalTerminalInWorkspace(second.id);
    platform.setActiveWorkspace(DEFAULT_WORKSPACE_ID);
    platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
    render(<Shell />);
    await screen.findByTestId("code-workspace-bottom-tab-terminal");
    fireEvent.click(railTerminal());
    const firstTerminal = await screen.findByTestId("test-terminal");
    fireEvent.click(within(firstTerminal).getByRole("button"));
    act(() => platform.setActiveWorkspace(second.id));
    await waitFor(() => expect(firstTerminal).not.toBeVisible());
    await waitFor(() => expect(screen.getByTestId("sidebar-tool-window-rail").querySelectorAll('[data-testid="code-workspace-bottom-tab-terminal"]')).toHaveLength(1));
    fireEvent.click(railTerminal());
    await waitFor(() => expect(screen.getAllByTestId("test-terminal")).toHaveLength(2));
    act(() => platform.setActiveWorkspace(DEFAULT_WORKSPACE_ID));
    await waitFor(() => expect(firstTerminal).toBeVisible());
    expect(firstTerminal).toHaveTextContent("output");
    expect(terminals.started).toHaveBeenCalledTimes(2);
    expect(terminals.stopped).not.toHaveBeenCalled();
  });

  it("uses the existing editor terminal in both contexts without remounting its content", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const code = platform.openCodeWorkspaceTab(DEFAULT_WORKSPACE_ID);
    render(<Shell />);
    await screen.findByTestId("code-workspace-bottom-tab-terminal");
    fireEvent.click(railTerminal());
    const terminal = await screen.findByTestId("test-terminal");
    fireEvent.click(within(terminal).getByRole("button"));
    expect(screen.getByTestId("code-workspace-bottom-dock")).toBeVisible();
    expect(workspace().activeTabId).toBe(code.id);
    act(() => { platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID); });
    const sessionId = workspace().activeTabId;
    fireEvent.click(railTerminal());
    expect(workspace().activeTabId).toBe(sessionId);
    expect(screen.getByTestId("test-terminal")).toBe(terminal);
    expect(screen.getByTestId("workspace-bottom-dock")).toContainElement(terminal);
    expect(terminal).toBeVisible();
    act(() => platform.setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, code.id));
    fireEvent.click(railTerminal());
    fireEvent.click(railTerminal());
    expect(screen.getByTestId("test-terminal")).toBe(terminal);
    expect(terminal).toHaveTextContent("output");
    expect(terminals.started).toHaveBeenCalledTimes(1);
    expect(terminals.stopped).not.toHaveBeenCalled();
  });
});
