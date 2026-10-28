import { beforeEach, expect, it } from "vitest";
import { useAppStore } from "../../../stores/appStore";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { workspaceEditorInstanceId } from "../../../lib/workspaceRuntimeIdentity";
import { revealWorkspaceFolder } from "../workspaceFolderReveal";

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: true });
});

it("reveals the selected root without dropping other tree expansion", () => {
  const editor = useCodeWorkspaceStore.getState();
  const id = workspaceEditorInstanceId(useWorkspacePlatformStore.getState().getWorkspace()!);
  editor.updateExpandedRootIds(id, ["old-root"]);
  editor.updateExpandedDirKeys(id, ["old-root:src"]);
  editor.patchInstance(id, { languagePanelOpen: false });
  useWorkspacePlatformStore.getState().setActiveLeftToolWindow(DEFAULT_WORKSPACE_ID, "sessions");
  revealWorkspaceFolder(DEFAULT_WORKSPACE_ID, "selected-root");
  const ui = useCodeWorkspaceStore.getState().byInstanceId[id];
  expect(ui.expandedRootIds).toEqual(["old-root", "selected-root"]);
  expect(ui.expandedDirKeys).toEqual(["old-root:src", "selected-root:"]);
  expect(ui.languagePanelOpen).toBe(true);
  expect(useWorkspacePlatformStore.getState().getWorkspace()?.activeLeftToolWindow).toBe("project");
  expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  revealWorkspaceFolder(DEFAULT_WORKSPACE_ID, "selected-root");
  expect(useCodeWorkspaceStore.getState().byInstanceId[id].expandedRootIds).toHaveLength(2);
});

it.each(["other-workspace", "other-mode"])("ignores a late folder selection after switching to %s", (target) => {
  const platform = useWorkspacePlatformStore.getState();
  if (target === "other-workspace") {
    platform.setActiveWorkspace(platform.createWorkspace({ name: "Other" }).id);
  } else useAppStore.setState({ activeSideTab: "home" });
  revealWorkspaceFolder(DEFAULT_WORKSPACE_ID, "late-root");
  expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  expect(useCodeWorkspaceStore.getState().byInstanceId).toEqual({});
});
