import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlBar } from "../ControlBar";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";

const tabBarMocks = vi.hoisted(() => ({
  renders: 0,
  props: [] as Array<{ tabs?: unknown[] }>,
}));

const openTabsMocks = vi.hoisted(() => ({
  renders: 0,
  props: [] as Array<{ open?: boolean }>,
}));

vi.mock("../TabBar", () => ({
  TabBar: (props: Record<string, unknown>) => {
    tabBarMocks.renders += 1;
    tabBarMocks.props.push(props);
    return <div data-testid="tab-bar" />;
  },
}));

vi.mock("../OpenTabsMenu", () => ({
  OpenTabsMenu: (props: { open?: boolean }) => {
    openTabsMocks.renders += 1;
    openTabsMocks.props.push(props);
    return props.open ? <div data-testid="open-tabs-menu" /> : null;
  },
}));

vi.mock("../../window/TitleBarTrayControls", () => ({
  TitleBarTrayControls: () => <div data-testid="titlebar-tray" />,
}));

vi.mock("../../screenshot/ScreenshotMenuButton", () => ({
  ScreenshotMenuButton: () => <div data-testid="system-screenshot" />,
}));

vi.mock("../../../stores/updateStore", () => ({
  useUpdateStore: (selector: (state: { status: string; availableVersion: string | null; openDialog: () => void }) => unknown) =>
    selector({ status: "idle", availableVersion: null, openDialog: () => undefined }),
}));

vi.mock("../menubar/useSessionImportExport", () => ({
  useSessionImportExport: () => ({
    hasSessions: false,
    importJson: vi.fn(),
    importMoba: vi.fn(),
    importCsv: vi.fn(),
    downloadCsvTemplate: vi.fn(),
    importOpenSsh: vi.fn(),
    exportJson: vi.fn(),
    exportMoba: vi.fn(),
    exportCsv: vi.fn(),
    exportHtml: vi.fn(),
    previewNode: null,
  }),
}));

function renderControlBar() {
  return render(
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
}

describe("ControlBar shared toolbar (TASK-03)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeSideTab: "sessions",
      sidebarCollapsed: false,
      rightSidebarCollapsed: true,
      globalSearchOpen: false,
      tabs: [],
      activeTabId: null,
    });
    useWorkspacePlatformStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    tabBarMocks.renders = 0;
    tabBarMocks.props.length = 0;
    openTabsMocks.renders = 0;
    openTabsMocks.props.length = 0;
  });

  it("UT-WS-03-01: renders a single 33px shared toolbar without extra top rows", () => {
    renderControlBar();
    const bars = screen.getAllByTestId("control-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0].className).toContain("h-8");
    // No decorative window dots from early prototypes.
    expect(document.querySelector(".window-decoration-dots")).toBeNull();
    expect(screen.queryByTestId("window-decoration-dots")).not.toBeInTheDocument();
  });

  it("UT-WS-03-02: left/right collapse buttons drive the layout state", () => {
    const onToggleSidebar = vi.fn();
    render(
      <ControlBar
        activeTabClosable
        nativeMenu={false}
        xServerEnabled={false}
        quickConnectVisible={false}
        onCommand={vi.fn()}
        onToggleSidebar={onToggleSidebar}
        onStartLocalTerminal={vi.fn()}
        onConnectSession={vi.fn()}
        onOpenSessionEditor={vi.fn()}
        onCloseWindow={vi.fn()}
        slotRef={vi.fn()}
      />,
    );
    // The left toggle goes through the layout prop (store toggle in prod).
    fireEvent.click(screen.getByTestId("toggle-left-sidebar"));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    // The right toggle flips the store directly.
    expect(useAppStore.getState().rightSidebarCollapsed).toBe(true);
    fireEvent.click(screen.getByTestId("toggle-right-sidebar"));
    expect(useAppStore.getState().rightSidebarCollapsed).toBe(false);
    fireEvent.click(screen.getByTestId("toggle-right-sidebar"));
    expect(useAppStore.getState().rightSidebarCollapsed).toBe(true);
  });

  it("UT-WS-03-03: swaps the middle tab strip per mode without cross-pollution", () => {
    useAppStore.setState({ activeSideTab: "workspaces" });
    let view = renderControlBar();
    expect(screen.getByTestId("workspace-tab-strip")).toBeInTheDocument();
    // The session TabBar stays mounted but hidden while in Workspaces mode.
    expect(screen.getByTestId("tab-bar")).not.toBeVisible();

    view.unmount();
    cleanup();
    useAppStore.setState({ activeSideTab: "sessions" });
    view = renderControlBar();
    expect(screen.getByTestId("tab-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tab-strip")).not.toBeInTheDocument();

    view.unmount();
    cleanup();
    useAppStore.setState({ activeSideTab: "home" });
    view = renderControlBar();
    expect(screen.getByTestId("tab-bar")).toBeInTheDocument();
    view.unmount();
  });

  it("UT-WS-03-04: keeps every app-main-menu entry", () => {
    renderControlBar();
    fireEvent.click(screen.getByTestId("app-main-menu"));
    const text = document.body.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    for (const label of [
      "New local terminal",
      "New remote session",
      "New SFTP",
      "Sessions",
      "View",
      "Tools",
      "Settings",
      "Help",
      "Exit",
    ]) {
      expect(text).toContain(label);
    }
    // Import/export submenu entries remain available under Sessions.
    fireEvent.mouseEnter(screen.getByTestId("context-menu-item-sessions"));
    expect(document.body.textContent ?? "").toContain("Import");
  });

  it("UT-WS-03-05: preserves tab details hover and the open-tabs menu", () => {
    renderControlBar();
    expect(screen.getByTestId("tab-details-hover")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-more"));
    expect(screen.getByTestId("open-tabs-menu")).toBeInTheDocument();
  });

  it("exposes the global search trigger that opens the Ctrl+K palette state", () => {
    renderControlBar();
    fireEvent.click(screen.getByTestId("global-search-trigger"));
    expect(useAppStore.getState().globalSearchOpen).toBe(true);
  });
});
