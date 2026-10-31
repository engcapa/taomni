import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMainMenuBridge, type UseMainMenuBridgeContext } from "./useMainMenuBridge";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { workspaceEditorRuntimeId } from "../../lib/workspaceRuntimeIdentity";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { buildAppMenuSpec, installAppMenu } from "../../lib/nativeAppMenu";
import { useWorkspaceCommandRegistry } from "./useWorkspaceCommandRegistry";

vi.mock("../../lib/nativeAppMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nativeAppMenu")>();
  return { ...actual, buildAppMenuSpec: vi.fn(actual.buildAppMenuSpec), installAppMenu: vi.fn() };
});

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "workspaces" });
});
afterEach(cleanup);

it("yields file search from an empty workspace to its keymap without creating a session", () => {
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "HOME", rootPath: "/home/test" });
  const executeAction = vi.fn(async () => ({ kind: "applied" as const }));
  const registration = { items: [], snapshot: [], execute: vi.fn(), executeAction } satisfies WorkspaceCommandRegistration;
  const handleCommand = vi.fn();
  renderHook(() => useMainMenuBridge({
    dispatchMenuAction: vi.fn(), nativeMenu: false, activeTabClosable: false,
    importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
    quickConnectVisible: false, getActiveWorkspaceCommands: () => registration,
    subscribeWorkspaceCommands: () => () => {}, t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
    setActiveTab: vi.fn(), handleCommand,
    workspaceCommandRegistrationsRef: { current: { [workspaceEditorRuntimeId(workspace)]: registration } },
  }));
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  expect(executeAction).not.toHaveBeenCalled();
  expect(handleCommand).not.toHaveBeenCalled();
});

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
    quickConnectVisible: false, getActiveWorkspaceCommands: () => registration,
    subscribeWorkspaceCommands: () => () => {},
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

it("refreshes native menu state directly and releases its subscription on unmount", () => {
  vi.mocked(installAppMenu).mockResolvedValue(undefined);
  vi.mocked(buildAppMenuSpec).mockClear();
  let renders = 0;
  const { result, unmount } = renderHook(() => {
    renders++;
    const registry = useWorkspaceCommandRegistry();
    useMainMenuBridge({
      dispatchMenuAction: vi.fn(), nativeMenu: true, activeTabClosable: true,
      importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
      quickConnectVisible: false,
      getActiveWorkspaceCommands: () => registry.workspaceCommandRegistrationsRef.current.active ?? null,
      subscribeWorkspaceCommands: registry.subscribeWorkspaceCommands,
      t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
      setActiveTab: vi.fn(), handleCommand: vi.fn(),
      workspaceCommandRegistrationsRef: registry.workspaceCommandRegistrationsRef,
    });
    return registry;
  });
  const registration: WorkspaceCommandRegistration = {
    items: [{ id: "workspace.save", title: "Save", category: "File", enabled: true }],
    snapshot: [], execute: vi.fn(() => true), executeAction: vi.fn(async () => ({ kind: "applied" as const })),
  };
  expect(buildAppMenuSpec).toHaveBeenCalledTimes(1);
  act(() => result.current.handleWorkspaceCommandsChange("active", registration));
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceCommands: registration.items }));
  expect(buildAppMenuSpec).toHaveBeenCalledTimes(2);
  act(() => result.current.handleWorkspaceCommandsChange("hidden", registration));
  expect(buildAppMenuSpec).toHaveBeenCalledTimes(2);
  act(() => result.current.handleWorkspaceCommandsChange("active", null));
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceCommands: [] }));
  expect(renders).toBe(1);
  const publish = result.current.handleWorkspaceCommandsChange;
  unmount();
  act(() => publish("active", registration));
  expect(buildAppMenuSpec).toHaveBeenCalledTimes(3);
});

it("refreshes native close state and active command owner without a shell render", () => {
  vi.mocked(installAppMenu).mockResolvedValue(undefined);
  vi.mocked(buildAppMenuSpec).mockClear();
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.createWorkspace({ name: "Files", rootPath: "/public" });
  const registration: WorkspaceCommandRegistration = {
    items: [{ id: "workspace.save", title: "Save", category: "File", enabled: true }],
    snapshot: [], execute: vi.fn(() => true), executeAction: vi.fn(async () => ({ kind: "applied" as const })),
  };
  let renders = 0;
  const { unmount } = renderHook(() => {
    renders++;
    useMainMenuBridge({
      dispatchMenuAction: vi.fn(), nativeMenu: true, activeTabClosable: false,
      importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
      quickConnectVisible: false,
      getActiveWorkspaceCommands: () => {
        const current = platform.getWorkspace();
        return current?.openTabs.find((tab) => tab.id === current.activeTabId)?.kind === "file" ? registration : null;
      },
      subscribeWorkspaceCommands: () => () => {},
      t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
      setActiveTab: vi.fn(), handleCommand: vi.fn(),
      workspaceCommandRegistrationsRef: { current: {} },
    });
  });
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ activeTabClosable: false, workspaceCommands: [] }));
  let fileId = "";
  act(() => { fileId = platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0]!.id, path: "notes.txt" }).id; });
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ activeTabClosable: true, workspaceCommands: registration.items }));
  act(() => { platform.openLocalTerminalInWorkspace(workspace.id); });
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ activeTabClosable: true, workspaceCommands: [] }));
  act(() => platform.setActiveWorkspaceTab(workspace.id, fileId));
  expect(buildAppMenuSpec).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceCommands: registration.items }));
  expect(renders).toBe(1);
  unmount();
  const calls = vi.mocked(buildAppMenuSpec).mock.calls.length;
  act(() => platform.closeWorkspaceTab(workspace.id, fileId));
  expect(buildAppMenuSpec).toHaveBeenCalledTimes(calls);
});

it("ignores command publications that do not change any visible native menu state", () => {
  vi.mocked(installAppMenu).mockResolvedValue(undefined).mockClear();
  const { result } = renderHook(() => {
    const registry = useWorkspaceCommandRegistry();
    useMainMenuBridge({
      dispatchMenuAction: vi.fn(), nativeMenu: true, activeTabClosable: false,
      importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
      quickConnectVisible: false,
      getActiveWorkspaceCommands: () => registry.workspaceCommandRegistrationsRef.current.active ?? null,
      subscribeWorkspaceCommands: registry.subscribeWorkspaceCommands,
      t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
      setActiveTab: vi.fn(), handleCommand: vi.fn(),
      workspaceCommandRegistrationsRef: registry.workspaceCommandRegistrationsRef,
    });
    return registry;
  });
  const registration: WorkspaceCommandRegistration = {
    items: [{ id: "workspace.save", title: "Save", category: "File", enabled: true }],
    snapshot: [], execute: vi.fn(() => true), executeAction: vi.fn(async () => ({ kind: "applied" as const })),
  };
  act(() => result.current.handleWorkspaceCommandsChange("active", registration));
  const installed = vi.mocked(installAppMenu).mock.calls.length;
  act(() => result.current.handleWorkspaceCommandsChange("active", {
    ...registration, items: registration.items.map((item) => ({ ...item })),
  }));
  expect(installAppMenu).toHaveBeenCalledTimes(installed);
  act(() => result.current.handleWorkspaceCommandsChange("active", {
    ...registration, items: registration.items.map((item) => ({ ...item, enabled: false })),
  }));
  expect(installAppMenu).toHaveBeenCalledTimes(installed + 1);
});

it("retries a failed installation on the next publication with the same visible state", async () => {
  vi.mocked(installAppMenu).mockClear().mockRejectedValueOnce(new Error("AppKit unavailable"))
    .mockResolvedValue(undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let publish = () => {};
  const context: UseMainMenuBridgeContext = {
    dispatchMenuAction: vi.fn(), nativeMenu: true, activeTabClosable: false,
    importExport: { hasSessions: false } as UseMainMenuBridgeContext["importExport"],
    quickConnectVisible: false, getActiveWorkspaceCommands: () => null,
    subscribeWorkspaceCommands: (listener) => { publish = listener; return () => {}; },
    t: ((key: string) => key) as UseMainMenuBridgeContext["t"],
    setActiveTab: vi.fn(), handleCommand: vi.fn(), workspaceCommandRegistrationsRef: { current: {} },
  };
  try {
    renderHook(() => useMainMenuBridge(context));
    await act(async () => {});
    expect(installAppMenu).toHaveBeenCalledTimes(1);
    act(() => publish());
    await act(async () => {});
    expect(installAppMenu).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("Failed to install application menu", expect.any(Error));
  } finally {
    error.mockRestore();
  }
});
