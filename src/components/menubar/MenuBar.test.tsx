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
    render(<MenuBar activeTabClosable onCommand={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByTestId("menu-sessions"), { clientX: 80, clientY: 10 });

    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("omits inactive Games from the top-level menus", () => {
    render(<MenuBar activeTabClosable onCommand={vi.fn()} />);

    expect(screen.queryByTestId("menu-games")).not.toBeInTheDocument();
  });

  it("switches top-level menus on hover after a menu has been opened", () => {
    render(<MenuBar activeTabClosable onCommand={vi.fn()} />);

    fireEvent.click(screen.getByTestId("menu-terminal"), { clientX: 16, clientY: 10 });
    expect(screen.getByTestId("context-menu-item-new-local-terminal")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("menu-sessions"), { clientX: 90, clientY: 10 });

    expect(screen.getByTestId("context-menu-item-reload-sessions")).toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-new-local-terminal")).not.toBeInTheDocument();
  });
});
