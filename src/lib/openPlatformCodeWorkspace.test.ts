import { beforeEach, describe, expect, it } from "vitest";
import { openPlatformCodeWorkspace } from "./openPlatformCodeWorkspace";
import { useAppStore } from "../stores/appStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../stores/workspacePlatformStore";
import type { CodeWorkspaceTabInfo } from "../types";

const project: CodeWorkspaceTabInfo = {
  repoRoot: "/repo", workspaceId: "recent-repo", name: "Project",
  roots: [{ id: "root-a", name: "repo", path: "/repo", kind: "git" }],
  looseFiles: [{ id: "loose", name: "notes.txt", path: "/notes.txt" }],
  initialFile: { kind: "loose", id: "loose", path: "/notes.txt" },
};

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "home", tabs: [{ id: "shell", type: "terminal", title: "shell", closable: true }], activeTabId: "shell" });
});

describe("editor entry point ownership", () => {
  it("opens complete multi-root/loose-file project definitions in Workspaces, leaving Sessions intact", () => {
    const id = openPlatformCodeWorkspace(project);
    const workspace = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    expect(workspace.codeWorkspace).toMatchObject(project);
    expect(workspace.rootFolders[0]).toMatchObject(project.roots![0]);
    expect(workspace.openTabs).toHaveLength(1);
    expect(workspace.openTabs[0].kind).toBe("code");
    expect(workspace.activeTabId).toBe(workspace.openTabs[0].id);
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["shell"]);
    useWorkspacePlatformStore.getState().reloadFromStorage();
    expect(useWorkspacePlatformStore.getState().getWorkspace(id)?.codeWorkspace).toMatchObject(project);
  });

  it("reuses the same project and editor instance after returning Home", () => {
    const id = openPlatformCodeWorkspace(project);
    const before = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    useAppStore.getState().setActiveSideTab("home");
    expect(openPlatformCodeWorkspace({ ...project, roots: project.roots!.map((root) => ({ ...root, id: "new-id" })) })).toBe(id);
    const after = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    expect(after.openTabs).toEqual(before.openTabs);
    expect(after.codeWorkspace?.workspaceInstanceId).toBe(before.codeWorkspace?.workspaceInstanceId);
    expect(useWorkspacePlatformStore.getState().workspaces).toHaveLength(2);
  });

  it("reuses a project created from the Workspaces UI by folder identity", () => {
    const existing = useWorkspacePlatformStore.getState().createWorkspace({ name: "Existing", rootPath: "/repo" });
    expect(openPlatformCodeWorkspace({ ...project, looseFiles: [] })).toBe(existing.id);
    expect(useWorkspacePlatformStore.getState().workspaces).toHaveLength(2);
  });

  it("routes context-free Code Editor to the default workspace without creating duplicate code tabs", () => {
    const id = openPlatformCodeWorkspace({ repoRoot: "" });
    expect(id).toBe(DEFAULT_WORKSPACE_ID);
    expect(openPlatformCodeWorkspace({ repoRoot: "" })).toBe(id);
    expect(useWorkspacePlatformStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspacePlatformStore.getState().getWorkspace(id)?.openTabs).toHaveLength(1);
  });

  it("keeps a restored editor's explicit recovery identity", () => {
    const id = openPlatformCodeWorkspace({ ...project, workspaceInstanceId: "old-session-instance" });
    expect(useWorkspacePlatformStore.getState().getWorkspace(id)?.codeWorkspace?.workspaceInstanceId).toBe("old-session-instance");
  });
});
