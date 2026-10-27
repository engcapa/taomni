import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkspacePlatformStore, type WorkspaceIsolatedTab } from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { WorkspaceTabsFilter } from "../WorkspaceTabsFilter";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";

function tab(id: string, kind: WorkspaceIsolatedTab["kind"], title: string, extra: Partial<WorkspaceIsolatedTab> = {}): WorkspaceIsolatedTab {
  return { id, workspaceId: "one", kind, title, closable: true, createdAt: 1, ...extra };
}

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  const base = useWorkspacePlatformStore.getState().workspaces[0];
  useWorkspacePlatformStore.setState({ activeWorkspaceId: "one", workspaces: [
    { ...base, id: "one", openTabs: [tab("readme", "file", "README", { filePath: "Docs/README.md" }),
      tab("notes", "file", "Notes"), tab("ssh", "terminal", "Production", { sessionId: "remote", protocol: "SSH", host: "node.example" }),
      tab("local", "terminal", "Local")], activeTabId: "local" },
    { ...base, id: "two", openTabs: [tab("other", "file", "Other", { workspaceId: "two" })], activeTabId: "other" },
  ] });
  useWorkspaceUiStore.setState({ tabFilters: {} });
});
afterEach(cleanup);

function renderNavigation() {
  return render(<><WorkspaceTabStrip /><WorkspaceTabsFilter /></>);
}

describe("workspace classification and search popover", () => {
  it("filters the strip, preserves all owned tabs, handles no matches and clears", () => {
    renderNavigation();
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-trigger"));
    expect(screen.getByTestId("workspace-tabs-filter-search")).toHaveFocus();
    fireEvent.click(screen.getByTestId("workspace-tab-filter-files"));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(2);
    expect(useWorkspacePlatformStore.getState().workspaces[0].activeTabId).toBe("readme");
    fireEvent.change(screen.getByTestId("workspace-tabs-filter-search"), { target: { value: "docs/" } });
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("workspace-tabs-filter-search"), { target: { value: "missing" } });
    expect(screen.queryAllByTestId("workspace-tab")).toHaveLength(0);
    expect(screen.getByTestId("workspace-tabs-filter-empty")).toBeInTheDocument();
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(4);
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-clear"));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4);
  });

  it("keeps workspace filters independent and restores the trigger focus on Escape", () => {
    renderNavigation();
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-trigger"));
    fireEvent.change(screen.getByTestId("workspace-tabs-filter-search"), { target: { value: "node.example" } });
    fireEvent.keyDown(screen.getByTestId("workspace-tabs-filter-search"), { key: "Escape" });
    expect(screen.queryByTestId("workspace-tabs-filter-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-tabs-filter-trigger")).toHaveFocus();
    act(() => useWorkspacePlatformStore.setState({ activeWorkspaceId: "two" }));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-trigger"));
    expect(screen.getByTestId("workspace-tabs-filter-search")).toHaveValue("");
    act(() => useWorkspacePlatformStore.setState({ activeWorkspaceId: "one" }));
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-trigger"));
    expect(screen.getByTestId("workspace-tabs-filter-search")).toHaveValue("node.example");
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1);
  });

  it("selects a result with Enter and reveals a newly opened tab through a previous filter", () => {
    renderNavigation();
    fireEvent.click(screen.getByTestId("workspace-tabs-filter-trigger"));
    fireEvent.click(screen.getByTestId("workspace-tab-filter-files"));
    fireEvent.keyDown(screen.getByTestId("workspace-tabs-filter-search"), { key: "Enter" });
    expect(screen.queryByTestId("workspace-tabs-filter-menu")).not.toBeInTheDocument();
    act(() => useWorkspacePlatformStore.getState().openLocalTerminalInWorkspace("one"));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(5);
    expect(screen.queryByTestId("workspace-tab-filter-chip")).not.toBeInTheDocument();
  });
});
