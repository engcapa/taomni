import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../appStore";
import { createLayoutSlice } from "./layoutSlice";
import { WORKSPACE_SIDEBAR_COLLAPSED_KEY } from "./preferences";

function reloadLayout() {
  useAppStore.setState(createLayoutSlice(useAppStore.setState, useAppStore.getState, useAppStore));
}

beforeEach(() => {
  localStorage.clear();
  reloadLayout();
  useAppStore.setState({
    tabs: [{ id: "terminal", type: "terminal", title: "Session", closable: true }],
    activeTabId: "terminal",
  });
});

describe("Workspace navigator preference", () => {
  it("restores a collapsed workspace immediately after Home and a renderer reload", () => {
    useAppStore.getState().setActiveSideTab("workspaces");
    useAppStore.getState().setSidebarCollapsed(true);
    expect(localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_KEY)).toBe("true");
    useAppStore.getState().setActiveSideTab("home");
    reloadLayout();
    expect(useAppStore.getState().activeSideTab).toBe("home");
    useAppStore.getState().setActiveSideTab("workspaces");
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("persists expansion and keeps Home's automatic collapse transient", () => {
    useAppStore.getState().setActiveSideTab("workspaces");
    useAppStore.getState().setSidebarCollapsed(true);
    useAppStore.getState().toggleSidebar();
    expect(localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_KEY)).toBe("false");
    useAppStore.getState().setActiveSideTab("home");
    useAppStore.getState().setSidebarCollapsed(true);
    reloadLayout();
    useAppStore.getState().setActiveSideTab("workspaces");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("isolates Workspace changes from the active Sessions tab group", () => {
    const groups = useAppStore.getState().sidebarCollapsedByGroup;
    useAppStore.getState().setActiveSideTab("workspaces");
    useAppStore.getState().setSidebarCollapsed(true);
    useAppStore.getState().setSidebarCollapsed(false);
    useAppStore.getState().setActiveSideTab("sessions");
    expect(useAppStore.getState().sidebarCollapsedByGroup).toBe(groups);
    expect(localStorage.getItem("taomni.sidebarCollapsedByGroup.v1")).toBeNull();
    expect(localStorage.getItem("taomni.sidebarCollapsed")).toBeNull();
    useAppStore.getState().setActiveTab("terminal");
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    useAppStore.getState().setSidebarCollapsed(false);
    expect(useAppStore.getState().sidebarCollapsedByGroup.terminal).toBe(false);
    useAppStore.getState().setActiveSideTab("workspaces");
    useAppStore.getState().setSidebarCollapsed(true);
    expect(useAppStore.getState().sidebarCollapsedByGroup.terminal).toBe(false);
  });

  it("ignores hidden Sessions tab policy while a workspace is visible", () => {
    useAppStore.getState().setActiveSideTab("workspaces");
    useAppStore.getState().setSidebarCollapsed(false);
    useAppStore.getState().applySidebarForActiveTab();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    useAppStore.getState().setSidebarCollapsed(true);
    useAppStore.getState().setActiveSideTab("tools");
    useAppStore.getState().setSidebarCollapsed(false);
    useAppStore.getState().setActiveSideTab("workspaces");
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("retains the in-memory choice when storage is unavailable", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    try {
      useAppStore.getState().setActiveSideTab("workspaces");
      useAppStore.getState().setSidebarCollapsed(true);
      useAppStore.getState().setActiveSideTab("home");
      useAppStore.getState().setActiveSideTab("workspaces");
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});
