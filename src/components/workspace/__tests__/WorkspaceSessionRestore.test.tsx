import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceSessionPane } from "../WorkspaceSessionPane";
import { useSessionStore } from "../../../stores/sessionStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { createDefaultWorkspace, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import type { SessionConfig } from "../../../lib/ipc";

const surfaces = vi.hoisted(() => ({ terminal: vi.fn(), sftp: vi.fn() }));
vi.mock("../../terminal/TerminalPanel", () => ({ TerminalPanel: (props: unknown) => { surfaces.terminal(props); return <div data-testid="terminal-runtime" />; } }));
vi.mock("../../filebrowser/FileBrowser", () => ({ FileBrowser: (props: unknown) => { surfaces.sftp(props); return <div data-testid="sftp-runtime" />; } }));

const saved: SessionConfig = {
  id: "restored-ssh", name: "Saved SSH", session_type: "SSH", host: "qa.invalid", port: 22,
  username: "qa", auth_method: "Password", options_json: '{"passwordRef":"vault:qa-reference"}',
  group_path: null, sort_order: 0, created_at: 1, updated_at: 1, last_connected_at: null,
};
beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useSessionStore.setState({ sessions: [], loaded: false, loading: false, loadError: null, markConnected: vi.fn(async () => {}) });
  useVaultStore.setState({ state: "unlocked", refresh: vi.fn(async () => {}) });
  vi.clearAllMocks();
});
afterEach(cleanup);

function open(session = saved) {
  const workspace = createDefaultWorkspace();
  const tab = useWorkspacePlatformStore.getState().openSessionInWorkspace(workspace.id, session);
  return { workspace, tab, visible: true };
}

it("does not start a local shell while a persisted SSH record is still loading", () => {
  render(<WorkspaceSessionPane {...open()} />);
  expect(screen.getByTestId("workspace-session-unavailable")).toHaveAttribute("data-state", "loading");
  expect(surfaces.terminal).not.toHaveBeenCalled();
  act(() => useSessionStore.setState({ loaded: true, sessions: [saved] }));
  expect(surfaces.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ ssh: expect.objectContaining({ authData: "vault:qa-reference" }) }));
});

it("keeps a removed session as a recoverable tab without creating any process", () => {
  useSessionStore.setState({ loaded: true });
  const props = open();
  render(<WorkspaceSessionPane {...props} />);
  expect(screen.getByTestId("workspace-session-unavailable")).toHaveAttribute("data-state", "missing");
  expect(surfaces.terminal).not.toHaveBeenCalled();
  expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs[0].id).toBe(props.tab.id);
});

it("preserves configured LocalShell executable and arguments across storage bootstrap", () => {
  const shell = { ...saved, session_type: "LocalShell", options_json: '{"localShellPath":"/bin/qa-shell","localShellArgs":["--login"]}' };
  useSessionStore.setState({ loaded: true, sessions: [shell] });
  const props = open(shell);
  window.dispatchEvent(new Event("pagehide"));
  useWorkspacePlatformStore.getState().reloadFromStorage();
  expect(useWorkspacePlatformStore.getState().workspaces[0].openTabs[0].kind).toBe("terminal");
  render(<WorkspaceSessionPane {...props} />);
  expect(surfaces.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ localShell: { id: "/bin/qa-shell", name: "Saved SSH", args: ["--login"] } }));
});

it("defers vault-backed runtime creation until credentials are unlocked", () => {
  useSessionStore.setState({ loaded: true, sessions: [saved] });
  useVaultStore.setState({ state: "locked" });
  render(<WorkspaceSessionPane {...open()} />);
  expect(screen.getByTestId("workspace-session-access")).toBeVisible();
  expect(surfaces.terminal).not.toHaveBeenCalled();
  act(() => useVaultStore.setState({ state: "unlocked" }));
  expect(screen.getByTestId("terminal-runtime")).toBeVisible();
});

it("cancels missing-password authentication without losing the tab and can retry", () => {
  const session = { ...saved, options_json: "{}" };
  useSessionStore.setState({ loaded: true, sessions: [session] });
  render(<WorkspaceSessionPane {...open(session)} />);
  expect(screen.getByTestId("auth-prompt")).toBeVisible();
  fireEvent.click(screen.getByTestId("auth-cancel"));
  expect(screen.queryByTestId("auth-prompt")).not.toBeInTheDocument();
  expect(surfaces.terminal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("workspace-session-connect"));
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "one-shot-qa" } });
  fireEvent.submit(screen.getByTestId("auth-prompt"));
  expect(surfaces.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ ssh: expect.objectContaining({ authData: "one-shot-qa" }) }));
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem("taomni.platformWorkspaces.v1")).not.toContain("one-shot-qa");
});

it("restores SFTP credentials and path mappings on its independent runtime", () => {
  const session = { ...saved, session_type: "SFTP", options_json: '{"passwordRef":"vault:qa-reference","pathMappings":[{"localPath":"/qa","remotePath":"/remote"}]}' };
  useSessionStore.setState({ loaded: true, sessions: [session] });
  const props = open(session);
  render(<WorkspaceSessionPane {...props} />);
  expect(surfaces.sftp).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: props.tab.id, authData: "vault:qa-reference" }));
});
