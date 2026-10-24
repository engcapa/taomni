import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBar } from "./ControlBar";
import type { AppCommand } from "../menubar/commands";

const windowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
}));
const captureMocks = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }));
vi.mock("../../lib/screenshot", async (original) => ({
  ...await original<typeof import("../../lib/screenshot")>(), openScreenshotOverlay: captureMocks.open,
}));
const tabBarMocks = vi.hoisted(() => ({ props: [] as Array<{ detailsRevealExternal?: boolean }> }));
const openTabsMocks = vi.hoisted(() => ({ props: [] as Array<{ onDetachActiveTab?: () => void }> }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks,
}));

vi.mock("../../lib/runtime", () => ({
  getAppPlatform: () => "windows",
}));

vi.mock("./TabBar", () => ({
  TabBar: (props: { detailsRevealExternal?: boolean }) => {
    tabBarMocks.props.push(props);
    return <div data-testid="tab-bar"><div data-window-drag data-testid="tabbar-drag-region" /></div>;
  },
}));

vi.mock("./OpenTabsMenu", () => ({
  OpenTabsMenu: (props: { onDetachActiveTab?: () => void }) => {
    openTabsMocks.props.push(props);
    return null;
  },
}));

vi.mock("../window/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock("../window/TitleBarTrayControls", () => ({
  TitleBarTrayControls: () => <div data-testid="titlebar-tray" />,
}));

vi.mock("../menubar/useSessionImportExport", () => ({
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

vi.mock("../../stores/updateStore", () => ({
  useUpdateStore: (selector: (state: { status: string; availableVersion: string | null; openDialog: () => void }) => unknown) =>
    selector({
      status: "idle",
      availableVersion: null,
      openDialog: vi.fn(),
    }),
}));

function renderControlBar(
  onCommand: (command: AppCommand) => void,
  workspace: {
    commands?: Parameters<typeof ControlBar>[0]["workspaceCommands"];
    onCommand?: (commandId: string) => void;
    onToggleSidebar?: () => void;
  } = {},
  onDetachActiveTab?: () => void,
) {
  return render(
    <ControlBar
      activeTabClosable
      nativeMenu={false}
      xServerEnabled={false}
      quickConnectVisible={false}
      workspaceCommands={workspace.commands}
      onCommand={onCommand}
      onWorkspaceCommand={workspace.onCommand}
      onToggleSidebar={workspace.onToggleSidebar ?? vi.fn()}
      onStartLocalTerminal={vi.fn()}
      onConnectSession={vi.fn()}
      onOpenSessionEditor={vi.fn()}
      onDetachActiveTab={onDetachActiveTab}
      onCloseWindow={vi.fn()}
      slotRef={vi.fn()}
    />,
  );
}

describe("ControlBar settings button", () => {
  it("moves the screenshot entry out of the shared toolbar (rail owns it now)", () => {
    renderControlBar(vi.fn());
    // v6.1 AC-04: the ScreenshotMenuButton lives in the primary rail's bottom
    // tools group; the 33px toolbar must not grow a second entry.
    expect(screen.queryByTestId("system-screenshot")).not.toBeInTheDocument();
    expect(screen.getByTestId("global-search-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("toggle-right-sidebar")).toBeInTheDocument();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    tabBarMocks.props.length = 0;
    openTabsMocks.props.length = 0;
  });

  it("keeps the left collapse toggle and the app menu in the left button group", () => {
    const onCommand = vi.fn();
    const onToggleSidebar = vi.fn();
    renderControlBar(onCommand, { onToggleSidebar });

    const mainMenu = screen.getByTestId("app-main-menu");
    const leftGroup = mainMenu.parentElement;
    expect(leftGroup).toBeTruthy();
    expect(within(leftGroup!).getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual([
      "toggle-left-sidebar",
      "app-main-menu",
    ]);
    fireEvent.click(screen.getByTestId("toggle-left-sidebar"));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("ribbon-settings")).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("exposes commands contributed by the active Code Workspace", () => {
    const onWorkspaceCommand = vi.fn();
    renderControlBar(vi.fn(), {
      commands: [
        { id: "workspace.findInFiles", title: "Find in Files", category: "Search", keybinding: "Ctrl+Shift+F", enabled: true },
      ],
      onCommand: onWorkspaceCommand,
    });

    fireEvent.click(screen.getByTestId("app-main-menu"));
    fireEvent.mouseEnter(screen.getByTestId("context-menu-item-tools"));
    fireEvent.mouseEnter(screen.getByTestId("context-menu-workspace-actions"));
    fireEvent.click(screen.getByTestId("context-menu-workspace-command-workspace.findInFiles"));
    expect(onWorkspaceCommand).toHaveBeenCalledWith("workspace.findInFiles");
  });

  it("uses the button before More to reveal tab details on hover", () => {
    renderControlBar(vi.fn());
    const button = screen.getByTestId("tab-details-hover");

    expect(tabBarMocks.props.at(-1)?.detailsRevealExternal).toBe(false);
    fireEvent.mouseEnter(button);
    expect(tabBarMocks.props.at(-1)?.detailsRevealExternal).toBe(true);
    fireEvent.mouseLeave(button);
    expect(tabBarMocks.props.at(-1)?.detailsRevealExternal).toBe(false);
  });

  it("preserves dragging and maximize gestures in the tab strip filler", () => {
    renderControlBar(vi.fn());
    const handle = screen.getByTestId("tabbar-drag-region");

    fireEvent.mouseDown(handle, { button: 0, detail: 1 });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(handle, { button: 0, detail: 2 });
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("app-main-menu"), { button: 0, detail: 1 });
    expect(windowMocks.startDragging).toHaveBeenCalledTimes(1);
  });

  it("forwards the active detach action into the More menu", () => {
    const onDetach = vi.fn();
    renderControlBar(vi.fn(), {}, onDetach);
    expect(openTabsMocks.props.at(-1)?.onDetachActiveTab).toBe(onDetach);
  });
});
