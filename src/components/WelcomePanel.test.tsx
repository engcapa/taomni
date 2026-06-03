import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "./WelcomePanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";

const ipcMocks = vi.hoisted(() => ({
  listLocalShells: vi.fn(),
  listWslDistros: vi.fn(),
  openLocalShellAsAdministrator: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  listLocalShells: ipcMocks.listLocalShells,
  listWslDistros: ipcMocks.listWslDistros,
  openLocalShellAsAdministrator: ipcMocks.openLocalShellAsAdministrator,
}));

vi.mock("../lib/runtime", () => ({
  getAppPlatform: () => "linux",
}));

vi.mock("../lib/sftp", () => ({
  sftpLocalHome: vi.fn(async () => "/home/test"),
}));

describe("WelcomePanel", () => {
  beforeEach(() => {
    ipcMocks.listLocalShells.mockResolvedValue([
      {
        id: "powershell",
        name: "PowerShell",
        path: "powershell.exe",
        isDefault: true,
        canElevate: true,
      },
    ]);
    ipcMocks.listWslDistros.mockResolvedValue([]);
    ipcMocks.openLocalShellAsAdministrator.mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      statusMessage: "Ready",
    });
    useSessionStore.setState({
      sessions: [],
      groups: [],
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the Taomni brand mark as T while keeping the header version", async () => {
    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );

    const brandMark = screen.getByTestId("welcome-brand-mark");
    expect(brandMark).toHaveTextContent("T");
    expect(brandMark).not.toHaveTextContent("N");
    expect(brandMark).toHaveClass("w-12", "h-12");

    expect(screen.getByTestId("welcome-version")).toHaveTextContent("Version 0.2.4");
    expect(screen.getByTestId("welcome-version-footer")).toHaveTextContent("v0.2.4");

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
  });
});
