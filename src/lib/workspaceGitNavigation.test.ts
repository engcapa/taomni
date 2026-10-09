import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceFileFromGit, workspaceFileForGitPath } from "./workspaceGitNavigation";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAppStore } from "../stores/appStore";
import type { Workspace } from "../types/workspace";

vi.mock("./workspacePersistence", () => ({ saveWorkspace: async (workspace: Workspace) => ({ ...workspace, revision: workspace.revision + 1 }) }));

const workspace: Workspace = {
  id: "owner", name: "Project", roots: [{ id: "root", name: "all repos", path: "/projects", kind: "folder" }],
  looseFiles: [], description: "", memberships: [], pinned: false, order: 0, revision: 1,
  createdAt: 1, updatedAt: 1, lastOpenedAt: 1,
  navigation: { activeSurface: "changes", navigatorCollapsed: true, rightPaneOpen: false },
};
beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id, canvas: "runtime" });
  useAppStore.setState({ tabs: [], activeTabId: "", recentWorkspaces: [] });
});
describe("Git to owning Files navigation", () => {
  it("resolves nested repos and Windows separators without confusing same-named files", () => {
    expect(workspaceFileForGitPath(workspace.roots, "/projects/repo-b", "same.txt")).toEqual({ kind: "root", rootId: "root", path: "repo-b/same.txt" });
    expect(workspaceFileForGitPath([{ id: "w", name: "win", path: "C:\\Work", kind: "folder" }], "c:/work/repo", "src\\a.ts")).toEqual({ kind: "root", rootId: "w", path: "repo/src/a.ts" });
    expect(workspaceFileForGitPath(workspace.roots, "/projects-other", "same.txt")).toBeNull();
    expect(workspaceFileForGitPath(workspace.roots, "/projects/repo", "../outside")).toBeNull();
  });
  it("reuses Files and emits a new request when reopening the same file", () => {
    openWorkspaceFileFromGit("owner", "/projects/repo-b", "same.txt");
    const first = useAppStore.getState().tabs[0];
    expect(first.codeWorkspace?.initialFile).toEqual({ kind: "root", rootId: "root", path: "repo-b/same.txt" });
    openWorkspaceFileFromGit("owner", "/projects/repo-b", "same.txt");
    const request = useAppStore.getState().tabs[0].codeWorkspace?.openFileRequest;
    openWorkspaceFileFromGit("owner", "/projects/repo-b", "same.txt");
    const tabs = useAppStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(first.id);
    expect(tabs[0].codeWorkspace?.openFileRequest?.id).not.toBe(request?.id);
    expect(tabs[0].codeWorkspace?.openFileRequest?.file).toEqual(request?.file);
    expect(useAppStore.getState().activeTabId).toBe(first.id);
  });
  it("does not create another workspace for a path outside the owning roots", () => {
    expect(openWorkspaceFileFromGit("owner", "/elsewhere", "same.txt")).toBe(true);
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(useAppStore.getState().statusMessage).toContain("outside");
  });
});
