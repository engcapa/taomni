import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceNavigator } from "./WorkspaceNavigator";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSessionStore } from "../../stores/sessionStore";
import { recentWorkspaceIdFromParts, useAppStore } from "../../stores/appStore";
import type { Workspace } from "../../types/workspace";
import type { SessionConfig } from "../../lib/ipc";

vi.mock("../../lib/workspacePersistence", () => ({
  saveWorkspace: async (workspace: Workspace) => ({ ...workspace, revision: workspace.revision + 1 }),
}));

const session = { id: "shared", name: "Shared shell", session_type: "LocalShell" } as SessionConfig;
const workspace = (id: string): Workspace => ({
  id, name: id, description: "", roots: [], looseFiles: [], revision: 1,
  pinned: false, order: 0, createdAt: 1, updatedAt: 1, lastOpenedAt: 1,
  navigation: { activeSurface: "overview", navigatorCollapsed: false, rightPaneOpen: false },
  memberships: [{ workspaceId: id, sessionId: session.id, role: "primary", order: 0, pinned: false }],
});

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: [workspace("A"), workspace("B")], activeWorkspaceId: "A", section: "work", canvas: "workspace", error: null, hydrated: true });
  useSessionStore.setState({ sessions: [session], hydrated: true });
  useAppStore.setState({ recentWorkspaces: [], sidebarCollapsed: false });
});
afterEach(cleanup);

describe("Workspace navigator workflows", () => {
  it("does not offer to import the current Files surface as another workspace", () => {
    const roots = [{ id: "root-a", name: "project", path: "/project", kind: "folder" as const }];
    useWorkspaceStore.setState({ workspaces: [{ ...workspace("A"), roots }] });
    useAppStore.setState({ recentWorkspaces: [
      { id: recentWorkspaceIdFromParts(roots), name: "A", roots, looseFiles: [], lastOpenedAt: 1, isGitRepo: false },
      { id: "legacy-unimported", name: "Legacy", roots: [], looseFiles: [], lastOpenedAt: 1, isGitRepo: false },
    ] });
    render(<WorkspaceNavigator />);
    expect(screen.queryByRole("button", { name: "Import A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import Legacy" })).toBeEnabled();
  });

  it("opens a canonical reference with explicit Workspace context", () => {
    const connect = vi.fn();
    render(<WorkspaceNavigator onConnectSession={connect} />);
    fireEvent.click(screen.getByRole("button", { name: "Shared shell" }));
    expect(connect).toHaveBeenCalledWith(session, "A");
    fireEvent.click(screen.getByTestId("workspace-row-B"));
    fireEvent.click(screen.getByRole("button", { name: "Shared shell" }));
    expect(connect).toHaveBeenLastCalledWith(session, "B");
    expect(useSessionStore.getState().sessions).toEqual([session]);
  });

  it("removes only the selected Workspace reference and never promotes another primary", async () => {
    render(<WorkspaceNavigator />);
    fireEvent.click(screen.getByRole("button", { name: "Remove reference" }));
    await screen.findByText("No primary session selected.");
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === "B")?.memberships).toHaveLength(1);
    expect(useSessionStore.getState().sessions).toEqual([session]);
  });

  it("keeps missing references recoverable without opening a connection", async () => {
    useSessionStore.setState({ sessions: [] });
    const connect = vi.fn();
    render(<WorkspaceNavigator onConnectSession={connect} />);
    const reference = within(screen.getByTestId("workspace-reference-shared"));
    expect(reference.getByRole("button", { name: "shared · unavailable" })).toBeDisabled();
    expect(reference.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(reference.getByRole("button", { name: "Remove reference" }));
    await waitFor(() => expect(screen.queryByTestId("workspace-reference-shared")).not.toBeInTheDocument());
  });

  it("changes role explicitly and hides navigation without altering ownership", async () => {
    render(<WorkspaceNavigator />);
    fireEvent.change(screen.getByRole("combobox", { name: "Role for Shared shell" }), { target: { value: "reference" } });
    await screen.findByText("No primary session selected.");
    fireEvent.click(screen.getByTestId("workspace-hide"));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("A");
    expect(useWorkspaceStore.getState().workspaces[0].memberships[0].role).toBe("reference");
  });
});
