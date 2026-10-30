import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GlobalCommandModal } from "./GlobalCommandModal";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useSessionStore } from "../../stores/sessionStore";

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ globalSearchOpen: false });
  useSessionStore.setState({ sessions: [] });
});
afterEach(cleanup);

it("does not rebuild the workspace/file search index while the palette is closed", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Public project", rootPath: "/public" });
  platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0]!.id, path: "notes.txt" });
  const initial = useWorkspacePlatformStore.getState().workspaces;
  const iterate = vi.spyOn(initial, Symbol.iterator);
  render(<GlobalCommandModal />);
  expect(screen.queryByTestId("global-search-modal")).not.toBeInTheDocument();
  expect(iterate).not.toHaveBeenCalled();
  act(() => useWorkspaceUiStore.getState().openGlobalSearch());
  expect(iterate).toHaveBeenCalled();
  act(() => useWorkspaceUiStore.getState().closeGlobalSearch());
  const next = initial.map((item) => ({ ...item }));
  const iterateNext = vi.spyOn(next, Symbol.iterator);
  act(() => useWorkspacePlatformStore.setState({ workspaces: next }));
  expect(iterateNext).not.toHaveBeenCalled();
});

it("reopens with fresh files and empty query, focuses input and activates the current file once", async () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Public project", rootPath: "/public" });
  const rootId = workspace.rootFolders[0]!.id;
  const first = platform.openFileInWorkspace(workspace.id, { rootId, path: "notes.txt" });
  render(<GlobalCommandModal />);
  act(() => useWorkspaceUiStore.getState().openGlobalSearch());
  const input = screen.getByTestId("global-search-input");
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: "notes.txt" } });
  expect(screen.getAllByTestId("global-search-result")).toHaveLength(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useWorkspaceUiStore.getState().globalSearchOpen).toBe(false);
  let latest = first;
  act(() => {
    latest = platform.openFileInWorkspace(workspace.id, { rootId, path: "new.py" });
    platform.setActiveWorkspaceTab(workspace.id, first.id);
  });
  act(() => useWorkspaceUiStore.getState().openGlobalSearch());
  const reopened = screen.getByTestId("global-search-input");
  expect(reopened).toHaveValue("");
  await waitFor(() => expect(reopened).toHaveFocus());
  fireEvent.change(reopened, { target: { value: "new.py" } });
  const result = screen.getAllByTestId("global-search-result");
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveAttribute("data-result-id", `file-${workspace.id}-${latest.id}`);
  fireEvent.keyDown(reopened, { key: "Enter" });
  expect(useWorkspacePlatformStore.getState().getWorkspace()?.activeTabId).toBe(latest.id);
  expect(useWorkspaceUiStore.getState().globalSearchOpen).toBe(false);
  expect(screen.queryByTestId("global-search-modal")).not.toBeInTheDocument();
  act(() => useWorkspaceUiStore.getState().openGlobalSearch());
  screen.getByTestId("global-search-input").blur();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("global-search-modal")).not.toBeInTheDocument();
});
