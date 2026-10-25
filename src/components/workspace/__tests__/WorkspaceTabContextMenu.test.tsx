import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { AppDialogProvider } from "../../../lib/appDialogs";
import { writeText } from "../../../lib/clipboard";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";

vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn() }));

const workspace = () => useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!;
function openMenu(id: string) {
  fireEvent.contextMenu(screen.getAllByTestId("workspace-tab").find((item) => item.dataset.tabId === id)!);
}
function setup() {
  const store = useWorkspacePlatformStore.getState();
  const first = store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  const second = store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  store.renameWorkspaceTab(DEFAULT_WORKSPACE_ID, first.id, "first");
  store.renameWorkspaceTab(DEFAULT_WORKSPACE_ID, second.id, "second");
  render(<AppDialogProvider><WorkspaceTabStrip /></AppDialogProvider>);
  return { first, second };
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "workspaces", cwdByTab: {}, terminalRuntimeByTab: {}, statusMessage: "Ready" });
  useSessionStore.setState({ sessions: [] });
  vi.mocked(writeText).mockReset().mockResolvedValue();
});
afterEach(cleanup);

describe("Workspace terminal tab context menu", () => {
  it("matches the main terminal menu order and disables moves beyond either edge", () => {
    const { first, second } = setup();
    openMenu(first.id);
    const menu = screen.getByTestId("workspace-tab-context-menu");
    expect(Array.from(menu.querySelectorAll('[data-testid^="workspace-tab-context-"]')).map((item) => item.getAttribute("data-testid"))).toEqual([
      "workspace-tab-context-close", "workspace-tab-context-close-others", "workspace-tab-context-close-all",
      "workspace-tab-context-rename", "workspace-tab-context-duplicate", "workspace-tab-context-copy-info",
      "workspace-tab-context-move-first", "workspace-tab-context-move-left", "workspace-tab-context-move-right", "workspace-tab-context-move-last",
    ]);
    expect(screen.getByTestId("workspace-tab-context-move-first")).toBeDisabled();
    expect(screen.getByTestId("workspace-tab-context-move-left")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    openMenu(second.id);
    expect(screen.getByTestId("workspace-tab-context-move-right")).toBeDisabled();
    expect(screen.getByTestId("workspace-tab-context-move-last")).toBeDisabled();
  });

  it("renames through the shared dialog, supports cancellation and persists the chosen title", async () => {
    const { first } = setup();
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-rename"));
    fireEvent.change(await screen.findByTestId("text-input-dialog-input"), { target: { value: "discarded" } });
    fireEvent.click(screen.getByTestId("text-input-dialog-cancel"));
    expect(workspace().openTabs[0].title).toBe("first");
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-rename"));
    fireEvent.change(await screen.findByTestId("text-input-dialog-input"), { target: { value: "  retained  " } });
    fireEvent.click(screen.getByTestId("text-input-dialog-confirm"));
    await waitFor(() => expect(workspace().openTabs[0].title).toBe("retained"));
    useWorkspacePlatformStore.getState().reloadFromStorage();
    expect(workspace().openTabs[0]).toMatchObject({ id: first.id, title: "retained" });
  });

  it("duplicates into an independent adjacent tab with the current directory and a sequenced title", () => {
    const { first, second } = setup();
    useAppStore.setState({ cwdByTab: { [first.id]: "/tmp/current directory" } });
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-duplicate"));
    const copy = workspace().openTabs[1];
    expect(workspace().openTabs.map((tab) => tab.id)).toEqual([first.id, copy.id, second.id]);
    expect(copy).toMatchObject({ title: "first-1", protocol: "Local", terminalInitialCwd: "/tmp/current directory" });
    expect(copy.id).not.toBe(first.id);
    expect(workspace().activeTabId).toBe(copy.id);
    expect(workspace().openTabs[0]).not.toHaveProperty("terminalInitialCwd");
    expect(useAppStore.getState().tabs.some((tab) => tab.id === copy.id)).toBe(false);
  });

  it("moves the original instance in all directions, retains the active tab and persists order", () => {
    const { first, second } = setup();
    const active = workspace().activeTabId;
    for (const [action, order] of [
      ["move-last", [second.id, first.id]], ["move-first", [first.id, second.id]],
      ["move-right", [second.id, first.id]], ["move-left", [first.id, second.id]],
    ] as const) {
      openMenu(first.id);
      fireEvent.click(screen.getByTestId(`workspace-tab-context-${action}`));
      expect(workspace().openTabs.map((tab) => tab.id)).toEqual(order);
      expect(workspace().activeTabId).toBe(active);
    }
    useWorkspacePlatformStore.getState().reloadFromStorage();
    expect(workspace().openTabs.map((tab) => tab.id)).toEqual([first.id, second.id]);
  });

  it("copies runtime metadata and no credentials, and reports clipboard errors", async () => {
    const { first } = setup();
    useAppStore.setState({ cwdByTab: { [first.id]: "/repo/src" }, terminalRuntimeByTab: { [first.id]: { state: "running", program: "tail", backendSessionId: "pty-123", activitySource: "input-heuristic", updatedAt: Date.now() } } });
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-copy-info"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = vi.mocked(writeText).mock.calls[0][0];
    expect(text).toContain("CWD: /repo/src");
    expect(text).toContain("Program: tail");
    expect(text).toContain("Backend session: pty-123");
    expect(text).toContain(`Tab ID: ${first.id}`);
    vi.mocked(writeText).mockRejectedValueOnce(new Error("clipboard unavailable"));
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-copy-info"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("clipboard unavailable"));
  });

  it("closes only this workspace's closable tabs and preserves the selected tab for Close others", () => {
    const { first } = setup();
    const store = useWorkspacePlatformStore.getState();
    const other = store.createWorkspace({ name: "other" });
    const unrelated = store.openLocalTerminalInWorkspace(other.id);
    store.setActiveWorkspace(DEFAULT_WORKSPACE_ID);
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-close-others"));
    expect(workspace().openTabs.map((tab) => tab.id)).toEqual([first.id]);
    expect(workspace().activeTabId).toBe(first.id);
    expect(store.getWorkspace(other.id)?.openTabs[0].id).toBe(unrelated.id);
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-close-all"));
    expect(workspace().openTabs).toEqual([]);
    expect(workspace().activeTabId).toBe("");
    expect(store.getWorkspace(other.id)?.openTabs[0].id).toBe(unrelated.id);
  });

  it("closes one tab and keeps its neighbor available", () => {
    const { first, second } = setup();
    openMenu(first.id);
    fireEvent.click(screen.getByTestId("workspace-tab-context-close"));
    expect(workspace().openTabs.map((tab) => tab.id)).toEqual([second.id]);
    expect(workspace().activeTabId).toBe(second.id);
  });
});
