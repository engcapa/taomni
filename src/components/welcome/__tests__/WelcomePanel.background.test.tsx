import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipcMocks, workspace } from "../../tests/welcomePanel/harness";
import { WelcomePanel } from "../../WelcomePanel";
import { useAppStore } from "../../../stores/appStore";

const renderLaunchCards = vi.hoisted(() => vi.fn());
vi.mock("../PlatformLaunchCards", () => ({ PlatformLaunchCards: () => {
  renderLaunchCards();
  return <div>Home launch cards</div>;
} }));

beforeEach(() => {
  ipcMocks.listLocalShells.mockResolvedValue([]);
  ipcMocks.listCommonLocalDirectories.mockResolvedValue([]);
  ipcMocks.listWslDistros.mockResolvedValue([]);
  ipcMocks.listenWelcomeDirectoriesChanged.mockResolvedValue(() => undefined);
  useAppStore.setState({ recentWorkspaces: [workspace("a", "Alpha", "/alpha", 1, "folder")] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("preserves Home filters while hidden and refreshes current history and handlers when shown", async () => {
  const open = vi.fn();
  const nextOpen = vi.fn();
  const props = { onStartLocalTerminal: vi.fn(), onNewSession: vi.fn(), onOpenRecentWorkspace: open };
  const { rerender } = render(<WelcomePanel {...props} active />);
  await waitFor(() => expect(ipcMocks.listLocalShells).toHaveBeenCalled());
  const workspaceTab = screen.getByTestId("welcome-history-tab-workspaces");
  fireEvent.click(workspaceTab);
  const query = screen.getByTestId("welcome-recent-workspace-filter");
  fireEvent.change(query, { target: { value: "Alpha" } });
  rerender(<WelcomePanel {...props} active={false} />);
  const rendersWhileHidden = renderLaunchCards.mock.calls.length;
  act(() => useAppStore.setState({ recentWorkspaces: [workspace("b", "Beta", "/beta", 2, "folder")] }));
  rerender(<WelcomePanel {...props} onOpenRecentWorkspace={nextOpen} active={false} />);
  expect(renderLaunchCards).toHaveBeenCalledTimes(rendersWhileHidden);
  expect(query).toHaveValue("Alpha");
  rerender(<WelcomePanel {...props} onOpenRecentWorkspace={nextOpen} active />);
  expect(screen.getByTestId("welcome-recent-workspace-filter")).toHaveValue("Alpha");
  fireEvent.change(screen.getByTestId("welcome-recent-workspace-filter"), { target: { value: "Beta" } });
  fireEvent.click(screen.getByText("Beta"));
  expect(nextOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  expect(open).not.toHaveBeenCalled();
});
