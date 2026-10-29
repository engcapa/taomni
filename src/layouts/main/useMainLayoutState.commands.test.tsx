import "../tests/mainLayout/harness";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { useMainLayoutState } from "./useMainLayoutState";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { workspaceEditorRuntimeId } from "../../lib/workspaceRuntimeIdentity";

afterEach(cleanup);

it("publishes current command ownership without rendering the main shell", async () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useMainLayoutState({});
  });
  await act(async () => {});
  const settled = renders;
  const registration: WorkspaceCommandRegistration = {
    items: [], snapshot: [], execute: vi.fn(() => true),
    executeAction: vi.fn(async () => ({ kind: "applied" as const })),
  };
  act(() => result.current.handleWorkspaceCommandsChange("editor", registration));
  expect(result.current.workspaceCommandRegistrationsRef.current.editor).toBe(registration);
  expect(renders).toBe(settled);
  act(() => result.current.handleWorkspaceCommandsChange("editor", null));
  expect(result.current.workspaceCommandRegistrationsRef.current.editor).toBeUndefined();
  expect(renders).toBe(settled);
});

it("reads active platform menu ownership without rendering the shell on file activation", async () => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "workspaces" });
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Files", rootPath: "/public" });
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useMainLayoutState({});
  });
  await act(async () => {});
  const registration: WorkspaceCommandRegistration = {
    items: [], snapshot: [], execute: vi.fn(() => true),
    executeAction: vi.fn(async () => ({ kind: "applied" as const })),
  };
  act(() => result.current.handleWorkspaceCommandsChange(workspaceEditorRuntimeId(workspace), registration));
  const settled = renders;
  let firstId = "";
  act(() => { firstId = platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0]!.id, path: "notes.txt" }).id; });
  expect(result.current.getActiveWorkspaceCommands()).toBe(registration);
  expect(renders).toBe(settled);
  act(() => { platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0]!.id, path: "page.html" }); });
  act(() => platform.setActiveWorkspaceTab(workspace.id, firstId));
  expect(result.current.getActiveWorkspaceCommands()).toBe(registration);
  expect(renders).toBe(settled);
  act(() => { platform.openLocalTerminalInWorkspace(workspace.id); });
  expect(result.current.getActiveWorkspaceCommands()).toBeNull();
  expect(renders).toBe(settled);
  act(() => platform.setActiveWorkspaceTab(workspace.id, firstId));
  expect(result.current.getActiveWorkspaceCommands()).toBe(registration);
  expect(renders).toBe(settled);
});
