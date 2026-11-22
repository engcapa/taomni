import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlBar } from "../ControlBar";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useTabOverviewStore } from "../../../stores/tabOverviewStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import type { AppCommand } from "../../menubar/commands";

vi.mock("../../window/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock("../OpenTabsMenu", () => ({
  OpenTabsMenu: ({ open }: { open: boolean }) => (open ? <div data-testid="open-tabs-menu">menu</div> : null),
}));

vi.mock("../../menubar/useSessionImportExport", () => ({
  useSessionImportExport: () => ({
    hasSessions: false,
    importJson: vi.fn(),
    importMoba: vi.fn(),
    importCsv: vi.fn(),
    importOpenSsh: vi.fn(),
    exportJson: vi.fn(),
    exportMoba: vi.fn(),
    exportCsv: vi.fn(),
    exportHtml: vi.fn(),
    previewNode: null,
  }),
}));

vi.mock("../../../stores/updateStore", () => ({
  useUpdateStore: (selector: (state: { status: string; availableVersion: string | null; openDialog: () => void }) => unknown) =>
    selector({ status: "idle", availableVersion: null, openDialog: vi.fn() }),
}));

function renderShell(overrides: Partial<Parameters<typeof ControlBar>[0]> = {}) {
  return render(
    <ControlBar
      activeTabClosable
      nativeMenu={false}
      xServerEnabled={false}
      quickConnectVisible={false}
      onCommand={vi.fn() as (command: AppCommand) => void}
      onToggleSidebar={vi.fn()}
      onStartLocalTerminal={vi.fn()}
      onConnectSession={vi.fn()}
      onOpenSessionEditor={vi.fn()}
      onOpenGlobalSearch={vi.fn()}
      onCloseWindow={vi.fn()}
      slotRef={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState({
    activeSideTab: "sessions",
    sidebarCollapsed: false,
    tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
    activeTabId: "welcome",
  });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useTabOverviewStore.getState().close();
});

afterEach(() => {
  cleanup();
});

describe("ControlBar shared toolbar (TASK-03)", () => {
  it("UT-WS-03-01 renders exactly one 33px control bar and no extra top row", () => {
    renderShell();
    const bars = document.querySelectorAll('[data-testid="control-bar"]');
    expect(bars).toHaveLength(1);
    const bar = bars[0] as HTMLElement;
    expect(bar.className).toContain("h-8");
    // No legacy second top row and no decorative three-dot chrome.
    expect(document.querySelector('[data-testid="titlebar-secondary"]')).toBeNull();
    expect(document.querySelector('[data-testid="titlebar-three-dots"]')).toBeNull();
    expect(bar.textContent ?? "").not.toMatch(/●\s*●\s*●/);
  });

  it("UT-WS-03-02 toggles the left sidebar and no longer exposes a right-sidebar control", () => {
    const onToggleSidebar = vi.fn();
    renderShell({ onToggleSidebar });
    fireEvent.click(screen.getByTestId("toggle-left-sidebar"));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    // The right context sidebar collapse trigger and panel were removed in
    // every main view; only the left navigator toggle remains on the toolbar.
    expect(screen.queryByTestId("toggle-right-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-sidebar-resize-handle")).not.toBeInTheDocument();
  });

  it("UT-WS-03-03 switches the middle strip by primary mode without mixing tabs", () => {
    const workspace = useWorkspacePlatformStore.getState();
    const workspaceId = workspace.workspaces[0].id;
    workspace.openLocalTerminalInWorkspace(workspaceId);

    useAppStore.setState({ activeSideTab: "workspaces" });
    const { rerender } = renderShell();
    const strip = screen.getByTestId("workspace-tab-strip");
    expect(within(strip).getAllByTestId("workspace-tab")).toHaveLength(1);
    expect(screen.queryByTestId("tab-bar")).not.toBeInTheDocument();

    useAppStore.setState({ activeSideTab: "sessions" });
    rerender(
      <ControlBar
        activeTabClosable
        nativeMenu={false}
        xServerEnabled={false}
        quickConnectVisible={false}
        onCommand={vi.fn()}
        onToggleSidebar={vi.fn()}
        onStartLocalTerminal={vi.fn()}
        onConnectSession={vi.fn()}
        onOpenSessionEditor={vi.fn()}
        onCloseWindow={vi.fn()}
        slotRef={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tab-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tab-strip")).not.toBeInTheDocument();
    expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs).toHaveLength(1);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it("UT-WS-03-04 keeps every app main-menu entry", () => {
    renderShell();
    fireEvent.click(screen.getByTestId("app-main-menu"));
    for (const testId of [
      "context-menu-item-new-local-terminal",
      "context-menu-item-new-remote-session",
      "context-menu-item-new-sftp",
      "context-menu-item-sessions",
      "context-menu-item-view",
      "context-menu-item-tools",
      "context-menu-item-settings",
      "context-menu-item-help",
      "context-menu-item-exit",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    fireEvent.mouseOver(screen.getByTestId("context-menu-item-sessions"));
    expect(screen.getByTestId("menu-import-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("menu-export-sessions")).toBeInTheDocument();
  });

  it("UT-WS-03-05 keeps the large overview and the open-tabs filter menu", () => {
    renderShell();
    expect(screen.queryByTestId("tab-details-hover")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-overview-trigger")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-more"));
    expect(screen.getByTestId("open-tabs-menu")).toBeInTheDocument();
  });

  it("UT-WS-03-07 keeps each main view's top-right actions to search and the large overview", () => {
    const expected: Record<string, string[]> = {
      home: ["home-toolbar-workspaces", "home-toolbar-sessions", "global-search-trigger", "tab-overview-trigger"],
      sessions: ["tab-more", "global-search-trigger", "tab-overview-trigger", "titlebar-actions-more"],
      workspaces: ["workspace-tabs-filter-trigger", "global-search-trigger", "tab-overview-trigger", "titlebar-actions-more"],
      explorer: ["explorer-tabs-filter-trigger", "global-search-trigger", "tab-overview-trigger"],
      tools: ["tools-toolbar-workspaces", "global-search-trigger", "tab-overview-trigger"],
      agents: ["global-search-trigger", "tab-overview-trigger"],
    };
    useExplorerStore.setState({
      tabs: [{ id: "e1", type: "file-browser", title: "Documents", closable: true,
        fileBrowser: { initialPath: "/docs", explorer: true } } as never],
      activeTabId: "e1",
    });
    renderShell();
    for (const [mode, testIds] of Object.entries(expected)) {
      act(() => useAppStore.setState({ activeSideTab: mode as never }));
      expect(screen.getByTestId("platform-toolbar-actions")).toHaveAttribute("data-mode", mode);
      expect(screen.getByTestId("platform-toolbar-actions").querySelectorAll("button"))
        .toHaveLength(testIds.length);
      expect(Array.from(screen.getByTestId("platform-toolbar-actions").querySelectorAll("button"))
        .map((button) => button.getAttribute("data-testid"))).toEqual(testIds);
      // The retired right context sidebar must not leak back into any mode,
      // including Home whose two launch pills stay unchanged.
      expect(screen.queryByTestId("toggle-right-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("right-sidebar")).not.toBeInTheDocument();
    }
  });

  it("UT-WS-03-08 opens and closes the large overview from every main view", () => {
    renderShell();
    for (const mode of ["home", "sessions", "workspaces", "explorer", "tools"] as const) {
      act(() => useAppStore.setState({ activeSideTab: mode }));
      expect(useTabOverviewStore.getState().open).toBe(false);
      fireEvent.click(screen.getByTestId("tab-overview-trigger"));
      expect(useTabOverviewStore.getState().open).toBe(true);
      fireEvent.click(screen.getByTestId("tab-overview-trigger"));
      expect(useTabOverviewStore.getState().open).toBe(false);
    }
  });

  it("UT-WS-03-06 exposes the global search trigger and the sidebar collapse affordance of the shared toolbar", () => {
    const onOpenGlobalSearch = vi.fn();
    renderShell({ onOpenGlobalSearch });
    fireEvent.click(screen.getByTestId("global-search-trigger"));
    expect(onOpenGlobalSearch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("toggle-left-sidebar")).toHaveAttribute("aria-pressed");
    // The draggable left panel handle lives in MainLayoutView and is exercised
    // end-to-end by TC-WS-001/TC-WS-005; its id is part of the AC-11 contract.
    expect(screen.getByTestId("toggle-left-sidebar")).toBeInTheDocument();
  });
});
