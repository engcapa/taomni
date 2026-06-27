import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBar } from "./ControlBar";
import type { AppCommand } from "../menubar/commands";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../lib/runtime", () => ({
  getAppPlatform: () => "windows",
}));

vi.mock("./TabBar", () => ({
  TabBar: () => <div data-testid="tab-bar" />,
}));

vi.mock("./OpenTabsMenu", () => ({
  OpenTabsMenu: () => null,
}));

vi.mock("../window/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

vi.mock("../window/TitleBarTrayControls", () => ({
  TitleBarTrayControls: () => <div data-testid="titlebar-tray" />,
}));

vi.mock("../capture/CaptureIndicators", () => ({
  CaptureIndicators: () => <div data-testid="capture-indicators" />,
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

function renderControlBar(onCommand: (command: AppCommand) => void) {
  return render(
    <ControlBar
      activeTabClosable
      nativeMenu={false}
      xServerEnabled={false}
      quickConnectVisible={false}
      onCommand={onCommand}
      onToggleSidebar={vi.fn()}
      onStartLocalTerminal={vi.fn()}
      onConnectSession={vi.fn()}
      onOpenSessionEditor={vi.fn()}
      onCloseWindow={vi.fn()}
      slotRef={vi.fn()}
    />,
  );
}

describe("ControlBar settings button", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows settings as a left-side button and opens it without expanding the menu", () => {
    const onCommand = vi.fn();
    renderControlBar(onCommand);

    const mainMenu = screen.getByTestId("app-main-menu");
    const leftGroup = mainMenu.parentElement;
    expect(leftGroup).toBeTruthy();
    expect(within(leftGroup!).getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual([
      "app-main-menu",
      "sidebar-toggle",
      "ribbon-settings",
    ]);

    fireEvent.click(screen.getByTestId("ribbon-settings"));

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith("settings");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
