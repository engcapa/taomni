import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceCodeHost } from "../useWorkspaceCodeHost";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useAppStore } from "../../../stores/appStore";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => "explorer"), platform: vi.fn(() => "linux") }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: mocks.open }));
vi.mock("../../../lib/runtime", async (original) => ({ ...await original<typeof import("../../../lib/runtime")>(), getAppPlatform: mocks.platform }));

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspacePlatformStore.getState().addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/project" });
  useAppStore.setState({ activeSideTab: "workspaces", sidebarCollapsed: false });
  mocks.platform.mockReturnValue("linux");
  mocks.open.mockClear();
});
afterEach(cleanup);

function mount() {
  const workspace = useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!;
  return renderHook(() => useWorkspaceCodeHost(workspace, true, true));
}

describe("workspace Explorer navigation entry", () => {
  it("opens the workspace root without changing the project-tree lens", () => {
    const { result } = mount();
    act(() => result.current?.navigationItems.find((item) => item.testId === "code-workspace-tool-rail-explorer")?.onSelect());
    expect(mocks.open).toHaveBeenCalledWith("/project", { workspaceId: DEFAULT_WORKSPACE_ID });
    expect(useWorkspacePlatformStore.getState().getWorkspace()?.activeLeftToolWindow).toBe("project");
  });

  it("accepts Alt+3 and the macOS Option Digit3 physical key without stealing editable or IME input", () => {
    mocks.platform.mockReturnValue("macos");
    const { result } = mount();
    expect(result.current?.navigationItems.find((item) => item.id === "workspace-explorer")?.shortcut).toBe("Option+3");
    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true });
    fireEvent.keyDown(window, { key: "£", code: "Digit3", altKey: true });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "3", code: "Digit3", altKey: true });
    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true, ctrlKey: true });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("removes the shortcut listener on unmount", () => {
    const { unmount } = mount();
    unmount();
    fireEvent.keyDown(window, { key: "3", code: "Digit3", altKey: true });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
