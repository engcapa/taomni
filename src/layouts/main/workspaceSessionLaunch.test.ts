import { describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../../lib/ipc";
import { buildWorkspaceSessionLaunch } from "./workspaceSessionLaunch";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function session(sessionType: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: `session-${sessionType}`,
    name: `${sessionType} session`,
    session_type: sessionType,
    group_path: null,
    host: "10.0.0.8",
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("buildWorkspaceSessionLaunch (TASK-07)", () => {
  it("maps every supported canonical session type to an isolated pane kind", () => {
    expect(buildWorkspaceSessionLaunch(session("SSH")).kind).toBe("terminal");
    expect(buildWorkspaceSessionLaunch(session("SSH")).ssh?.host).toBe("10.0.0.8");
    expect(buildWorkspaceSessionLaunch(session("LocalShell")).kind).toBe("terminal");
    expect(buildWorkspaceSessionLaunch(session("SFTP")).kind).toBe("sftp");
    expect(buildWorkspaceSessionLaunch(session("VNC")).kind).toBe("vnc");
    expect(buildWorkspaceSessionLaunch(session("RDP")).kind).toBe("rdp");
    expect(buildWorkspaceSessionLaunch(session("HBaseShell")).kind).toBe("hbase-shell");
    expect(buildWorkspaceSessionLaunch(session("Redis")).kind).toBe("redis");
    expect(buildWorkspaceSessionLaunch(session("MySQL")).kind).toBe("database");
    expect(buildWorkspaceSessionLaunch(session("Presto")).kind).toBe("database");
    expect(buildWorkspaceSessionLaunch(session("Telnet")).kind).toBe("terminal");
    expect(buildWorkspaceSessionLaunch(session("FTP")).kind).toBe("terminal");
  });

  it("never opens a local shell for an unsupported session type", () => {
    for (const type of ["File", "Browser", "Mail", "S3", "Proxy"]) {
      const launch = buildWorkspaceSessionLaunch(session(type));
      expect(launch.kind).toBeUndefined();
      expect(launch.unsupported).toBe(type);
    }
  });

  it("gives every workspace SFTP tab its own runtime id", () => {
    const launchA = buildWorkspaceSessionLaunch(session("SFTP"));
    const launchB = buildWorkspaceSessionLaunch(session("SFTP"));
    expect(launchA.sftp?.sessionId).toMatch(/^ws-sftp-session-SFTP-/);
    expect(launchA.sftp?.sessionId).not.toBe(launchB.sftp?.sessionId);
    expect(launchA.sftp?.sessionId).not.toBe(launchA.session.id);
  });

  it("keeps the RDP payload on the RDP pane instead of a terminal", () => {
    const launch = buildWorkspaceSessionLaunch(session("RDP", { port: 3389 }));
    expect(launch.kind).toBe("rdp");
    expect(launch.rdp?.port).toBe(3389);
    expect(launch.ssh).toBeUndefined();
  });
});
