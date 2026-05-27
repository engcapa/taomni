import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/sessionStore";
import type { SessionConfig, SessionGroup } from "../../lib/ipc";
import { SessionTree } from "./SessionTree";

const ipcMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => undefined),
  deleteSessionGroup: vi.fn(async () => undefined),
  importExternalBashSessions: vi.fn(async () => []),
  importPuttySessions: vi.fn(async () => []),
  importWslSessions: vi.fn(async () => []),
  isVaultLockedError: vi.fn(() => false),
  keychainLookupBatch: vi.fn(async () => []),
  listSessionGroups: vi.fn<() => Promise<SessionGroup[]>>(async () => []),
  listSessions: vi.fn<() => Promise<SessionConfig[]>>(async () => []),
  markSessionConnected: vi.fn(async () => 0),
  readPlistSessionFile: vi.fn(async () => ({ text: "", path: "", relativePath: "" })),
  saveSession: vi.fn(async () => undefined),
  saveSessionGroup: vi.fn(async () => undefined),
  scanLocalSessionFiles: vi.fn(async () => []),
  selectFilePath: vi.fn(async () => null),
  tabbyDecryptVault: vi.fn(async () => ({ secrets: [] })),
  vaultPut: vi.fn(async () => ({ id: "vault-test", reference: "vault:test" })),
}));

vi.mock("../../lib/ipc", () => ipcMocks);

function makeSession(id: string, name: string, groupPath: string): SessionConfig {
  return {
    id,
    name,
    session_type: "SSH",
    group_path: groupPath,
    host: `${id}.example.test`,
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
  };
}

function makeGroup(path: string): SessionGroup {
  return {
    id: path,
    name: path,
    parent_id: null,
    sort_order: 0,
    icon: null,
  };
}

function sessionRow(id: string): HTMLElement {
  const row = document.querySelector(`[data-testid="session-tree-item"][data-session-id="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`Session row ${id} not found`);
  return row;
}

describe("SessionTree multi-select connect", () => {
  const sessions = [
    makeSession("ipy-145", "145.216", "ipy"),
    makeSession("person-cloudcone", "cloudcone-cf-tun-local", "person"),
    makeSession("ipy-152", "152.92", "ipy"),
  ];
  const groups = [makeGroup("ipy"), makeGroup("person")];

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.listSessions.mockResolvedValue(sessions);
    ipcMocks.listSessionGroups.mockResolvedValue(groups);
    useSessionStore.setState({
      sessions,
      groups,
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("connects Ctrl-selected sessions across folders from the session context menu", () => {
    const onConnectSession = vi.fn();
    render(<SessionTree onConnectSession={onConnectSession} />);

    fireEvent.click(screen.getByText("ipy"));
    fireEvent.click(screen.getByText("person"));

    fireEvent.click(sessionRow("ipy-145"), { ctrlKey: true });
    fireEvent.click(sessionRow("person-cloudcone"), { ctrlKey: true });

    expect(sessionRow("ipy-145")).toHaveAttribute("data-selected", "true");
    expect(sessionRow("person-cloudcone")).toHaveAttribute("data-selected", "true");

    fireEvent.contextMenu(sessionRow("person-cloudcone"));
    fireEvent.click(screen.getByTestId("context-menu-item-connect-selected-sessions-2"));

    expect(onConnectSession).toHaveBeenCalledTimes(2);
    expect(onConnectSession.mock.calls.map(([session]) => session.id)).toEqual([
      "ipy-145",
      "person-cloudcone",
    ]);
  });

  it("labels saved WSL sessions as WSL in the tree", () => {
    const wslSession: SessionConfig = {
      ...makeSession("wsl-ubuntu", "WSL: Ubuntu", "ipy"),
      session_type: "LocalShell",
      host: "",
      port: 0,
      username: null,
      options_json: JSON.stringify({
        localShellPath: "wsl.exe",
        localShellArgs: ["-d", "Ubuntu"],
      }),
    };
    ipcMocks.listSessions.mockResolvedValue([wslSession]);
    useSessionStore.setState({
      sessions: [wslSession],
      groups,
      loading: false,
      selectedSessionId: null,
      searchQuery: "",
    });

    render(<SessionTree />);
    fireEvent.click(screen.getByText("ipy"));

    expect(sessionRow("wsl-ubuntu")).toHaveAttribute("data-session-type", "WSL");
    expect(sessionRow("wsl-ubuntu")).toHaveTextContent("WSL");
  });
});
