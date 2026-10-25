import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMainMenuBridge, type UseMainMenuBridgeContext } from "./useMainMenuBridge";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { workspaceEditorRuntimeId } from "../../lib/workspaceRuntimeIdentity";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";

vi.mock("../../lib/nativeAppMenu", () => ({ buildAppMenuSpec: vi.fn(), installAppMenu: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "workspaces" });
});
afterEach(cleanup);

it("reopens through the shared editor registration for either a file or code tab", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Project", rootPath: "/project" });
  const file = platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0]!.id, path: "main.ts" });
  const executeAction = vi.fn(async () => ({ kind: "applied" as const }));
  const registration = {
    items: [], snapshot: [], execute: vi.fn(), executeAction,
    shellShortcutClaims: [{
      ownerId: workspace.id, actionId: "workspace.reopenClosedTab", scope: "active-workspace",
      priority: 40, enabled: true, canExecute: true, disabledReason: null,
    }],
  } satisfies WorkspaceCommandRegistration;
  const handleCommand = vi.fn();
  renderHook(() => useMainMenuBridge({
    dispatchMenuAction: vi.fn(), nativeMenu: false, activeTabClosable: true,
    importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
    quickConnectVisible: false, activeWorkspaceCommandRegistration: registration,
    t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
    setActiveTab: vi.fn(), handleCommand,
    workspaceCommandRegistrationsRef: { current: { [workspaceEditorRuntimeId(workspace)]: registration } },
  }));
  const reopen = () => fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
  expect(platform.getWorkspace()?.activeTabId).toBe(file.id);
  reopen();
  expect(executeAction).toHaveBeenLastCalledWith("workspace.reopenClosedTab");
  const code = platform.openCodeWorkspaceTab(workspace.id);
  expect(platform.getWorkspace()?.activeTabId).toBe(code.id);
  reopen();
  expect(executeAction).toHaveBeenCalledTimes(2);
  expect(handleCommand).not.toHaveBeenCalled();
  platform.openLocalTerminalInWorkspace(workspace.id);
  reopen();
  expect(executeAction).toHaveBeenCalledTimes(2);
  expect(handleCommand).toHaveBeenCalledWith("new-terminal");
});
