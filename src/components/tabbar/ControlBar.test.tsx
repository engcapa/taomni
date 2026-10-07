import { useWorkspaceStore } from "../../stores/workspaceStore";
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
      onToggleSidebar={vi.fn()}
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
  it("hides windows by default and offers an explicit current-window capture", () => {
    renderControlBar(vi.fn());
    fireEvent.click(screen.getByTestId("system-screenshot"));
    expect(captureMocks.open).toHaveBeenCalledWith(undefined, false);
  });

  it("closes capture options and includes the current window when requested", () => {
    renderControlBar(vi.fn());
    fireEvent.click(screen.getByTestId("system-screenshot-delay-toggle"));
    fireEvent.click(screen.getByTestId("system-screenshot-current-window"));
    expect(captureMocks.open).toHaveBeenCalledWith(undefined, true);
    expect(screen.queryByTestId("system-screenshot-delay-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("capture-indicators")).not.toBeInTheDocument();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    tabBarMocks.props.length = 0;
    openTabsMocks.props.length = 0;
  });

  it("keeps only the app menu in the left button group", () => {
    const onCommand = vi.fn();
    renderControlBar(onCommand);

    const mainMenu = screen.getByTestId("app-main-menu");
    const leftGroup = mainMenu.parentElement;
    expect(leftGroup).toBeTruthy();
    expect(within(leftGroup!).getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual([
      "app-main-menu",
    ]);
    expect(screen.queryByTestId("sidebar-toggle")).not.toBeInTheDocument();
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

  it("opens global search and workspace creation without business tabs", () => {
    renderControlBar(vi.fn());
    expect(screen.queryByTestId("tab-bar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("global-search"));
    expect(useWorkspaceStore.getState().commandCenterOpen).toBe(true);
    fireEvent.click(screen.getByTestId("global-new"));
    expect(useWorkspaceStore.getState().createDialogOpen).toBe(true);
  });

  it("preserves dragging and maximize gestures in the global header", () => {
    renderControlBar(vi.fn());
    const handle = screen.getByTestId("window-drag-handle");

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
