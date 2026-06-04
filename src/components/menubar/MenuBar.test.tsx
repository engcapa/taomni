import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuBar } from "./MenuBar";

const storeMock = vi.hoisted(() => ({
  importSessions: vi.fn(async () => undefined),
  setStatusMessage: vi.fn(),
}));

vi.mock("../../stores/sessionStore", () => ({
  useSessionStore: () => ({
    sessions: [],
    importSessions: storeMock.importSessions,
  }),
}));

vi.mock("../../stores/appStore", () => ({
  useAppStore: () => ({
    setStatusMessage: storeMock.setStatusMessage,
  }),
}));

describe("MenuBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not open a top-level menu on hover before one is active", () => {
    render(<MenuBar activeTabClosable ribbonVisible={false} quickConnectVisible={false} onCommand={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByTestId("menu-sessions"), { clientX: 80, clientY: 10 });

    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("omits inactive Games from the top-level menus", () => {
    render(<MenuBar activeTabClosable ribbonVisible={false} quickConnectVisible={false} onCommand={vi.fn()} />);

    expect(screen.queryByTestId("menu-games")).not.toBeInTheDocument();
  });

  it("adds a top-level Exit button after Help and routes it through the app exit command", () => {
    const onCommand = vi.fn();
    render(<MenuBar activeTabClosable ribbonVisible={false} quickConnectVisible={false} onCommand={onCommand} />);

    const help = screen.getByTestId("menu-help");
    const exit = screen.getByTestId("menu-exit");
    expect(help.compareDocumentPosition(exit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(exit);
    expect(onCommand).toHaveBeenCalledWith("exit");
  });

  it("switches top-level menus on hover after a menu has been opened", () => {
    render(<MenuBar activeTabClosable ribbonVisible={false} quickConnectVisible={false} onCommand={vi.fn()} />);

    fireEvent.click(screen.getByTestId("menu-terminal"), { clientX: 16, clientY: 10 });
    expect(screen.getByTestId("context-menu-item-new-local-terminal")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("menu-sessions"), { clientX: 90, clientY: 10 });

    expect(screen.getByTestId("context-menu-item-reload-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-new-local-terminal")).not.toBeInTheDocument();
  });

  it("exposes toolbar toggles from View and right-click menus", () => {
    const onCommand = vi.fn();
    render(<MenuBar activeTabClosable ribbonVisible={false} quickConnectVisible={false} onCommand={onCommand} />);

    fireEvent.click(screen.getByTestId("menu-view"), { clientX: 120, clientY: 10 });
    fireEvent.click(screen.getByTestId("context-menu-item-toggle-ribbon"));
    expect(onCommand).toHaveBeenCalledWith("toggle-ribbon");

    fireEvent.click(screen.getByTestId("menu-view"), { clientX: 120, clientY: 10 });
    fireEvent.click(screen.getByTestId("context-menu-item-toggle-quick-connect"));
    expect(onCommand).toHaveBeenCalledWith("toggle-quick-connect");

    fireEvent.contextMenu(screen.getByTestId("menu-bar"), { clientX: 140, clientY: 12 });
    expect(screen.getByTestId("context-menu-item-toggle-ribbon")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-toggle-quick-connect")).toBeInTheDocument();
  });
});
