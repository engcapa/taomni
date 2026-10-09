import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceFolders } from "./useWorkspaceFolders";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { Workspace } from "../../../types/workspace";

vi.mock("../../../lib/workspacePersistence", () => ({ saveWorkspace: async (workspace: Workspace) => ({ ...workspace, revision: workspace.revision + 1 }) }));
afterEach(() => { cleanup(); useWorkspaceStore.setState({ workspaces: [] }); });
const folder = (id: string) => ({ id, path: `/${id}`, name: id, kind: "folder" as const });

it("shares folder edits with canonical Git discovery and accepts overview changes", async () => {
  const owner = { id: "owner", roots: [folder("a")], looseFiles: [], revision: 1, navigation: { activeSurface: "files" } } as unknown as Workspace;
  useWorkspaceStore.setState({ workspaces: [owner] });
  const { result } = renderHook(() => useWorkspaceFolders({ repoRoot: "/a", workspaceId: "owner", roots: owner.roots }));
  act(() => {
    result.current.setRoots((roots) => [...roots, folder("b")]);
    result.current.setRoots((roots) => [...roots, folder("c")]);
  });
  await waitFor(() => expect(useWorkspaceStore.getState().workspaces[0].roots.map((root) => root.id)).toEqual(["a", "b", "c"]));
  await act(async () => { await useWorkspaceStore.getState().patch("owner", { roots: [folder("b")] }); });
  await waitFor(() => expect(result.current.roots).toEqual([folder("b")]));
});

it("keeps a legacy editor local until a canonical Workspace exists", () => {
  useWorkspaceStore.setState({ workspaces: [] });
  const { result } = renderHook(() => useWorkspaceFolders({ repoRoot: "/a", workspaceId: "legacy", roots: [folder("a")] }));
  act(() => result.current.setRoots([folder("b")]));
  expect(result.current.roots).toEqual([folder("b")]);
  expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
});
