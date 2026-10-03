import { describe, expect, it } from "vitest";
import type { SessionConfig } from "./ipc";
import {
  buildConnectionCommand,
  sessionSupportsConnectionCommand,
  type BuildConnectionCommandOptions,
  type ConnectionCommandBuildResult,
} from "./sessionConnectionCommand";

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "session-1",
    name: "Session 1",
    session_type: "SSH",
    group_path: null,
    host: "example.test",
    port: 22,
    username: "alice",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

function ok(result: ConnectionCommandBuildResult): Extract<ConnectionCommandBuildResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected command, got ${result.reason}`);
  return result;
}

function build(config: SessionConfig, options: BuildConnectionCommandOptions): string {
  return ok(buildConnectionCommand(config, options)).command;
}

describe("sessionConnectionCommand", () => {
  it("detects command-line capable session types", () => {
    expect(sessionSupportsConnectionCommand(session({ session_type: "SSH" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "SFTP" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "FTP" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "Telnet" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "Rlogin" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "Mosh" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "Serial" }))).toBe(true);
    expect(sessionSupportsConnectionCommand(session({ session_type: "RDP" }))).toBe(false);
  });

  it("builds a POSIX SSH command with port and private key", () => {
    const command = build(session({
      port: 2222,
      auth_method: { PrivateKey: { key_path: "~/.ssh/id_ed25519" } },
    }), { platform: "posix" });

    expect(command).toBe("ssh -p 2222 -i ~/.ssh/id_ed25519 alice@example.test");
  });

  it("quotes PowerShell SSH arguments with spaces", () => {
    const command = build(session({
      host: "prod host.example.test",
      port: 2200,
      auth_method: { PrivateKey: { key_path: "C:\\Users\\me\\.ssh\\prod key" } },
    }), { platform: "powershell" });

    expect(command).toBe("ssh.exe -p 2200 -i 'C:\\Users\\me\\.ssh\\prod key' 'alice@prod host.example.test'");
  });

  it("builds SSH with a manual jump host", () => {
    const command = build(session({
      options_json: JSON.stringify({
        networkSettings: {
          proxyKind: "ssh-tunnel",
          jumpHost: "jump.example.test",
          jumpPort: "2201",
          jumpUser: "ops",
        },
      }),
    }), { platform: "posix", sshPreset: "jump" });

    expect(command).toBe("ssh -p 22 -J ops@jump.example.test:2201 alice@example.test");
  });

  it("builds SSH with forwards", () => {
    const command = build(session({
      options_json: JSON.stringify({
        networkSettings: {
          localForwards: [
            { id: "f1", local: "127.0.0.1:15432", remote: "127.0.0.1:5432", desc: "" },
            { id: "f2", local: "127.0.0.1:18080", remote: "10.0.0.5:80", desc: "" },
          ],
        },
      }),
    }), { platform: "posix", sshPreset: "forwards" });

    expect(command).toBe(
      "ssh -p 22 -L 127.0.0.1:15432:127.0.0.1:5432 -L 127.0.0.1:18080:10.0.0.5:80 alice@example.test",
    );
  });

  it("builds SSH full common options from saved options", () => {
    const command = build(session({
      port: 2222,
      options_json: JSON.stringify({
        compression: true,
        x11: true,
        x11Trusted: false,
        networkSettings: {
          keepAlive: true,
          keepAliveIntervalSecs: "45",
          ipVersion: "ipv6",
          localForwards: [
            { id: "f1", local: "127.0.0.1:15432", remote: "127.0.0.1:5432", desc: "" },
          ],
          proxyKind: "ssh-tunnel",
          jumpHost: "jump.example.test",
          jumpPort: "22",
          jumpUser: "ops",
        },
      }),
    }), { platform: "posix", sshPreset: "full" });

    expect(command).toBe(
      "ssh -p 2222 -J ops@jump.example.test:22 -L 127.0.0.1:15432:127.0.0.1:5432 -C -X -6 -o ServerAliveInterval=45 alice@example.test",
    );
  });

  it("builds SSH jump from a saved session", () => {
    const jump = session({
      id: "jump-1",
      host: "bastion.example.test",
      port: 2220,
      username: "jumpuser",
    });
    const command = build(session({
      options_json: JSON.stringify({
        networkSettings: {
          proxyKind: "ssh-tunnel",
          jumpSessionId: "jump-1",
        },
      }),
    }), { platform: "posix", sshPreset: "jump", allSessions: [jump] });

    expect(command).toBe("ssh -p 22 -J jumpuser@bastion.example.test:2220 alice@example.test");
  });

  it("reports missing jump and forwards for SSH presets", () => {
    expect(buildConnectionCommand(session(), { platform: "posix", sshPreset: "jump" })).toMatchObject({
      ok: false,
      reason: "missing-jump-host",
    });
    expect(buildConnectionCommand(session(), { platform: "posix", sshPreset: "forwards" })).toMatchObject({
      ok: false,
      reason: "missing-local-forwards",
    });
  });

  it("builds an SFTP command with OpenSSH options", () => {
    const command = build(session({
      session_type: "SFTP",
      username: null,
      port: 2022,
      auth_method: { PrivateKey: { key_path: "~/.ssh/sftp key" } },
    }), { platform: "posix" });

    expect(command).toBe("sftp -P 2022 -i ~/'.ssh/sftp key' root@example.test");
  });

  it("builds FTP, Telnet, Rlogin, and Mosh commands", () => {
    expect(build(session({
      session_type: "FTP",
      host: "ftp.example.test",
      port: 2121,
      username: "ignored",
    }), { platform: "powershell" })).toBe("ftp.exe ftp.example.test 2121");

    expect(build(session({
      session_type: "Telnet",
      host: "telnet.example.test",
      port: 2323,
      username: "ops",
    }), { platform: "posix" })).toBe("telnet -l ops telnet.example.test 2323");

    expect(build(session({
      session_type: "Rlogin",
      host: "rlogin.example.test",
      port: 1513,
      username: "ops",
    }), { platform: "posix" })).toBe("rlogin -l ops -p 1513 rlogin.example.test");

    expect(build(session({
      session_type: "Mosh",
      host: "mosh.example.test",
      port: 60001,
      username: "ops",
    }), { platform: "powershell" })).toBe("mosh.exe --port=60001 ops@mosh.example.test");
  });

  it("builds serial commands for POSIX and PowerShell", () => {
    const serial = session({
      session_type: "Serial",
      host: "/dev/ttyUSB0",
      port: 0,
      username: null,
      options_json: JSON.stringify({ serialBaud: "57600" }),
    });

    expect(build(serial, { platform: "posix" })).toBe("screen /dev/ttyUSB0 57600");
    expect(build({
      ...serial,
      host: "COM3",
    }, { platform: "powershell" })).toBe("plink.exe -serial COM3 -sercfg 57600,8,n,1,N");
  });

  it("uses bracketed IPv6 targets for SSH-family commands", () => {
    expect(build(session({
      host: "2001:db8::10",
    }), { platform: "posix" })).toBe("ssh -p 22 alice@[2001:db8::10]");
  });
});
