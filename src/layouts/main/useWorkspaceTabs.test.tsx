import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceTabs, type UseWorkspaceTabsContext } from "./useWorkspaceTabs";

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "workspaces", activeTabId: "welcome" });
});
afterEach(cleanup);

function harness(tabs: Tab[] = []) {
  const context: UseWorkspaceTabsContext = {
    tabs, tabsRef: { current: tabs }, setActiveTab: vi.fn(), addTab: vi.fn(),
    updateGitTabInfo: vi.fn(), removeTab: vi.fn(), setStatusMessage: vi.fn(),
  };
  const rendered = vi.fn();
  renderHook(() => {
    rendered();
    return useWorkspaceTabs(context);
  });
  return { rendered, context };
}

it("keeps file activation and folder updates out of the shell Git ownership subscription", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Project", rootPath: "/public/project" });
  const rootId = workspace.rootFolders[0]!.id;
  const first = platform.openFileInWorkspace(workspace.id, { rootId, path: "notes.txt" });
  const second = platform.openFileInWorkspace(workspace.id, { rootId, path: "report.json" });
  const { rendered, context } = harness();
  const count = rendered.mock.calls.length;
  act(() => platform.setActiveWorkspaceTab(workspace.id, first.id));
  act(() => platform.setActiveWorkspaceTab(workspace.id, second.id));
  act(() => platform.addRootFolder(workspace.id, { path: "/public/other" }));
  expect(platform.getWorkspace(workspace.id)?.activeTabId).toBe(second.id);
  expect(platform.getWorkspace(workspace.id)?.rootFolders).toHaveLength(2);
  expect(rendered).toHaveBeenCalledTimes(count);
  expect(context.removeTab).not.toHaveBeenCalled();
});

it("closes a linked Git tab when its platform editor owner closes", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Project", rootPath: "/public/project" });
  const code = platform.openCodeWorkspaceTab(workspace.id);
  const linked: Tab = {
    id: "linked-git", type: "git", title: "Git", closable: true,
    git: { repoRoot: "/public/project", sourceWorkspaceInstanceId: `platform:${workspace.id}`,
      workspaceRoots: [{ id: "repo", name: "Project", path: "/public/project", repoRoot: "/public/project", rootIds: [] }] },
  };
  const { context } = harness([linked]);
  expect(context.removeTab).not.toHaveBeenCalled();
  act(() => platform.closeWorkspaceTab(workspace.id, code.id));
  expect(context.removeTab).toHaveBeenCalledExactlyOnceWith(linked.id);
});

it("tracks an imported editor's persistence identity when replacing its definition", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Imported", rootPath: "/public/imported" });
  platform.openCodeWorkspaceTab(workspace.id);
  platform.updateCodeWorkspace(workspace.id, { ...workspace.codeWorkspace, repoRoot: "/public/imported", workspaceInstanceId: "imported:one" });
  const linked: Tab = {
    id: "imported-git", type: "git", title: "Git", closable: true,
    git: { repoRoot: "/public/imported", sourceWorkspaceInstanceId: "imported:one",
      workspaceRoots: [{ id: "repo", name: "Imported", path: "/public/imported", repoRoot: "/public/imported", rootIds: [] }] },
  };
  const { context } = harness([linked]);
  expect(context.removeTab).not.toHaveBeenCalled();
  act(() => platform.updateCodeWorkspace(workspace.id, {
    ...platform.getWorkspace(workspace.id)!.codeWorkspace, repoRoot: "/public/imported", workspaceInstanceId: "imported:two",
  }));
  expect(context.removeTab).toHaveBeenCalledExactlyOnceWith(linked.id);
});
