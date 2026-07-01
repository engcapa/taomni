import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePanel } from "./WelcomePanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import type { SessionConfig } from "../lib/ipc";

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

    expect(screen.getByTestId("welcome-version")).toHaveTextContent(`Version ${__APP_VERSION__}`);
    expect(screen.getByTestId("welcome-version-footer")).toHaveTextContent(`v${__APP_VERSION__}`);
    expect(screen.queryByTestId("welcome-activity-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("welcome-open-chat-tao")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
  });

  it("shows recent sessions with filter, select, bulk open, and single open actions", async () => {
    const recentSessions: SessionConfig[] = [
      session("ssh-prod", "Prod SSH", "SSH", "prod.example.com", 22, 300),
      session("sftp-prod", "Prod SFTP", "SFTP", "files.example.com", 22, 200),
      session("redis-dev", "Redis Dev", "Redis", "redis.local", 6379, 100),
    ];
    const openSession = vi.fn();
    const openSessions = vi.fn();
    const editSession = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        recentSessions={recentSessions}
        onOpenRecentSession={openSession}
        onOpenRecentSessions={openSessions}
        onEditRecentSession={editSession}
        onRevealRecentSession={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    expect(screen.getByTestId("welcome-recent-sessions")).toBeInTheDocument();
    expect(screen.getAllByTestId("welcome-recent-session-row")).toHaveLength(3);

    fireEvent.change(screen.getByTestId("welcome-recent-filter"), {
      target: { value: "prod" },
    });
    expect(screen.getAllByTestId("welcome-recent-session-row")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("welcome-recent-sort"), {
      target: { value: "name-asc" },
    });
    expect(screen.getAllByTestId("welcome-recent-session-row")[0]).toHaveAttribute("data-session-name", "Prod SFTP");
    expect(screen.getByTestId("welcome-recent-settings").querySelector("svg")).toBeTruthy();

    fireEvent.click(screen.getByTestId("welcome-recent-open-filtered"));
    expect(openSessions).toHaveBeenLastCalledWith([recentSessions[1], recentSessions[0]]);

    fireEvent.click(screen.getByTestId("welcome-recent-select-filtered"));
    fireEvent.click(screen.getByTestId("welcome-recent-open-selected"));
    expect(openSessions).toHaveBeenLastCalledWith([recentSessions[1], recentSessions[0]]);

    const firstRow = screen.getAllByTestId("welcome-recent-session-row")[0];
    fireEvent.click(within(firstRow).getByTestId("welcome-recent-open"));
    expect(openSession).toHaveBeenCalledWith(recentSessions[1]);
    expect(openSession).toHaveBeenCalledTimes(1);
    fireEvent.click(within(firstRow).getByTestId("welcome-recent-details"));
    fireEvent.click(firstRow);
    expect(openSession).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(firstRow);
    expect(screen.getByTestId("context-menu-item-connect-selected-sessions-2")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-connect")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-edit")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-duplicate-selected-sessions-2")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-move-to-folder")).toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-delete-selected-sessions-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("context-menu-item-connect"));
    expect(openSession).toHaveBeenLastCalledWith(recentSessions[1]);

    fireEvent.contextMenu(firstRow);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    expect(editSession).toHaveBeenCalledWith(recentSessions[1]);
  });

  it("hides the mail card when there are no mail sessions", async () => {
    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("welcome-mail-card")).not.toBeInTheDocument();
  });

  it("shows configured mailboxes in the mail card and opens the clicked one", async () => {
    const mailSessions: SessionConfig[] = [
      { ...session("mail-work", "Work Mail", "Mail", "imap.example.com", 993, 0), username: "me@example.com" },
      { ...session("mail-personal", "Personal", "Mail", "imap.personal.com", 993, 0), username: "me@personal.com" },
    ];
    const openMail = vi.fn();

    render(
      <WelcomePanel
        onStartLocalTerminal={vi.fn()}
        onNewSession={vi.fn()}
        onOpenLocalPath={vi.fn()}
        mailSessions={mailSessions}
        onOpenMailSession={openMail}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("PowerShell")).toBeInTheDocument();
    });

    const card = screen.getByTestId("welcome-mail-card");
    expect(within(card).getAllByTestId("welcome-mail-session")).toHaveLength(2);

    fireEvent.click(within(card).getByRole("button", { name: "Open mailbox Work Mail" }));
    expect(openMail).toHaveBeenCalledWith(mailSessions[0]);
  });
});

function session(
  id: string,
  name: string,
  sessionType: string,
  host: string,
  port: number,
  lastConnectedAt: number,
): SessionConfig {
  return {
    id,
    name,
    session_type: sessionType,
    group_path: null,
    host,
    port,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: lastConnectedAt,
    sort_order: 0,
  };
}
