import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileTree } from "../WorkspaceFileTree";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";

beforeEach(() => {
  window.localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview", name: "preview" });
});

afterEach(cleanup);

describe("WorkspaceFileTree", () => {
  it("keeps Git out of the root action row so the workspace has one primary Git entry", () => {
    const workspace = useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!;
    render(
      <WorkspaceFileTree
        workspace={workspace}
        createdNodes={[]}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
        onAddRoot={vi.fn()}
        onRemoveRoot={vi.fn()}
        onOpenGitForFile={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-tree-root")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tree-root-git")).not.toBeInTheDocument();
  });
});
