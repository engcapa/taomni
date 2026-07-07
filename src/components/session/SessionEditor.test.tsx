import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEditor } from "./SessionEditor";
import { setLocale } from "../../lib/i18n";

const ipcMocks = vi.hoisted(() => ({
  testSshConnection: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  markSessionConnected: vi.fn(),
  listSessionGroups: vi.fn(),
  saveSessionGroup: vi.fn(),
  deleteSessionGroup: vi.fn(),
  listSystemFonts: vi.fn(),
  listWslDistros: vi.fn(),
  listLocalShells: vi.fn(),
  hbaseTestConnection: vi.fn(),
  dbTestConnection: vi.fn(),
  vaultPut: vi.fn(async () => ({ id: "vault-pwd", reference: "vault:pwd" })),
  isVaultReference: (val: string) => typeof val === "string" && val.startsWith("vault:"),
  isVaultLockedError: (_err: any) => false,
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

vi.mock("../../lib/runtime", () => ({
  getAppPlatform: () => "windows",
}));

vi.mock("../../lib/vaultGate", () => ({
  ensureVaultReady: vi.fn(async () => true),
}));

function renderEditor(
  session?: ComponentProps<typeof SessionEditor>["session"],
  props: Partial<Omit<ComponentProps<typeof SessionEditor>, "session" | "onClose">> = {},
) {
  const onClose = vi.fn();
  render(<SessionEditor session={session} onClose={onClose} {...props} />);
  return { onClose };
}

function checkboxInLabel(text: string): HTMLInputElement {
  const input = screen.getByText(text).closest("label")?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Checkbox not found: ${text}`);
  return input;
}

describe("SessionEditor SSH settings tabs", { timeout: 15_000 }, () => {
  beforeEach(() => {
    setLocale("en");
    Object.values(ipcMocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) {
        (mock as any).mockReset();
      }
    });
    window.localStorage.clear();
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.saveSession.mockResolvedValue(undefined);
    ipcMocks.deleteSession.mockResolvedValue(undefined);
    ipcMocks.saveSessionGroup.mockResolvedValue(undefined);
    ipcMocks.testSshConnection.mockResolvedValue("Connection successful");
    ipcMocks.listSystemFonts.mockResolvedValue(["Cascadia Mono", "Consolas", "JetBrains Mono", "Source Code Pro"]);
    ipcMocks.listLocalShells.mockResolvedValue([
      {
        id: "bash",
        name: "Bash",
        path: "/bin/bash",
        args: ["--login"],
        isDefault: true,
        canElevate: false,
      },
    ]);
    ipcMocks.hbaseTestConnection.mockResolvedValue("HBase REST connection OK");
    ipcMocks.dbTestConnection.mockResolvedValue("Database connection OK");
    ipcMocks.listWslDistros.mockResolvedValue([
      { name: "Ubuntu", isDefault: true, state: "Stopped", version: 2 },
    ]);
    ipcMocks.vaultPut.mockResolvedValue({ id: "vault-pwd", reference: "vault:pwd" });
  });

  afterEach(() => {
    setLocale("en");
    cleanup();
  });

  it("switches between all SSH settings sections", async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByTestId("advanced-ssh-settings")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));
    expect(screen.getByTestId("terminal-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("advanced-ssh-settings")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /network settings/i }));
    expect(screen.getByTestId("network-settings")).toBeInTheDocument();
    expect(screen.getByText("Local port forwarding")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /bookmark settings/i }));
    expect(screen.getByTestId("bookmark-settings")).toBeInTheDocument();
    expect(screen.getByLabelText("Session name")).toBeInTheDocument();
  });

  it("keeps Advanced SSH authentication controls interactive from label clicks", async () => {
    const user = userEvent.setup();
    renderEditor();

    const keyPath = screen.getByLabelText("Private key path");
    expect(keyPath).toBeDisabled();

    await user.click(screen.getByText("Use private key"));
    expect(keyPath).toBeEnabled();

    await user.type(keyPath, "~/.ssh/id_ed25519");
    expect(keyPath).toHaveValue("~/.ssh/id_ed25519");

    await user.click(screen.getByText("Password / keyboard-interactive"));
    expect(keyPath).toBeDisabled();

    const doNotExit = screen.getByLabelText("Do not exit after command ends");
    expect(doNotExit).toBeChecked();
    await user.click(screen.getByText("Do not exit after command ends"));
    expect(doNotExit).not.toBeChecked();
  });

  it("loads and preserves saved Advanced SSH options", async () => {
    const user = userEvent.setup();
    const session = {
      id: "ssh-1",
      name: "saved-prod",
      session_type: "SSH",
      group_path: null,
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      auth_method: "Agent" as const,
      options_json: JSON.stringify({
        x11: false,
        compression: true,
        startupCmd: "tmux new -A -s main",
        doNotExit: true,
        remoteEnv: "Interactive shell",
        sshBrowser: "Disabled",
        followPath: false,
        osc7AutoInject: false,
      }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(session);

    expect(checkboxInLabel("Use SSH compression (slow links)")).toBeChecked();
    expect(checkboxInLabel("Enable")).not.toBeChecked();
    // X11 is off, so the Trusted sub-option is disabled (can't pick a trust
    // mode for forwarding that isn't happening).
    expect(checkboxInLabel("Trusted")).toBeDisabled();
    expect(screen.getByLabelText("Execute command")).toHaveValue("tmux new -A -s main");
    expect(screen.getByLabelText("Do not exit after command ends")).toBeChecked();
    expect(screen.getByDisplayValue("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Follow SSH path (experimental)")).not.toBeInTheDocument();
    expect(screen.queryByText("Auto-inject OSC 7 cwd reporting")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OK" }));

    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      x11: false,
      x11Trusted: true,
      compression: true,
      startupCmd: "tmux new -A -s main",
      doNotExit: true,
      sshBrowser: "Disabled",
    });
    expect(JSON.parse(savedConfig.options_json)).not.toHaveProperty("followPath");
    expect(JSON.parse(savedConfig.options_json)).not.toHaveProperty("osc7AutoInject");
  });

  it("updates Terminal settings preview and numeric fields", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    await waitFor(() => expect(screen.getByRole("option", { name: "Cascadia Mono" })).toBeInTheDocument());
    expect(screen.getByLabelText("Terminal font")).toHaveValue("Cascadia Mono");

    const background = screen.getByLabelText("Terminal background hex");
    await user.clear(background);
    await user.type(background, "#123456");
    expect(screen.getByTestId("terminal-preview")).toHaveStyle({ background: "#123456" });

    const foreground = screen.getByLabelText("Terminal foreground hex");
    await user.clear(foreground);
    await user.type(foreground, "#fedcba");
    expect(screen.getByTestId("terminal-preview")).toHaveStyle({ color: "#fedcba" });

    const scrollback = screen.getByLabelText("Scrollback lines");
    await user.clear(scrollback);
    await user.type(scrollback, "20000");
    expect(scrollback).toHaveValue("20000");
  });

  it("adds and removes Network local port forwarding rows", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /network settings/i }));

    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();

    await user.type(screen.getByLabelText("New forward local address"), "127.0.0.1:9090");
    await user.type(screen.getByLabelText("New forward remote address"), "metrics.lan:9090");
    await user.type(screen.getByLabelText("New forward description"), "Metrics");
    expect(add).toBeEnabled();

    await user.click(add);
    expect(screen.getByDisplayValue("127.0.0.1:9090")).toBeInTheDocument();
    expect(screen.getByDisplayValue("metrics.lan:9090")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Metrics")).toBeInTheDocument();
    expect(screen.getByLabelText("New forward local address")).toHaveValue("");

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await user.click(removeButtons[removeButtons.length - 1]);
    expect(screen.queryByDisplayValue("127.0.0.1:9090")).not.toBeInTheDocument();
  });

  it("round-trips Network settings on save and load", async () => {
    const user = userEvent.setup();

    // First, save a session with custom network settings.
    const { onClose } = renderEditor();
    await user.type(screen.getByLabelText("Remote host"), "net.example.com");
    await user.click(screen.getByRole("button", { name: /network settings/i }));

    const proxySelect = screen.getByDisplayValue("None — direct connection");
    await user.selectOptions(proxySelect, "HTTP CONNECT");
    await user.type(screen.getByLabelText("Proxy host"), "proxy.corp");
    await user.type(screen.getByLabelText("Proxy port"), "3128");
    await user.type(screen.getByLabelText("Proxy username"), "alice");
    await user.type(screen.getByLabelText("Proxy password"), "s3cret");

    // Add a local forwarding row
    await user.type(screen.getByLabelText("New forward local address"), "127.0.0.1:5432");
    await user.type(screen.getByLabelText("New forward remote address"), "db.lan:5432");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const saved = ipcMocks.saveSession.mock.calls[0][0];
    const opts = JSON.parse(saved.options_json);
    expect(opts.networkSettings).toMatchObject({
      proxyKind: "http",
      proxyHost: "proxy.corp",
      proxyPort: "3128",
      proxyUser: "alice",
    });
    expect(opts.networkSettings.localForwards).toHaveLength(1);
    expect(opts.networkSettings.localForwards[0]).toMatchObject({
      local: "127.0.0.1:5432",
      remote: "db.lan:5432",
    });
    // Proxy password must NOT be persisted unless "Save in vault" was ticked.
    expect(opts.networkSettings.proxyPass).toBe("");

    // Now reopen the editor with the saved options and verify hydration.
    cleanup();
    ipcMocks.saveSession.mockClear();
    const reopened = {
      id: saved.id,
      name: saved.name,
      session_type: "SSH",
      group_path: null,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      auth_method: "Password" as const,
      options_json: saved.options_json,
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(reopened);
    await user.click(screen.getByRole("button", { name: /network settings/i }));
    expect(screen.getByDisplayValue("HTTP CONNECT")).toBeInTheDocument();
    expect(screen.getByDisplayValue("proxy.corp")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3128")).toBeInTheDocument();
    expect(screen.getByDisplayValue("127.0.0.1:5432")).toBeInTheDocument();
    expect(screen.getByDisplayValue("db.lan:5432")).toBeInTheDocument();
  }, 10_000);

  it("imports an OpenSSH command pasted into the host field", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor();
    const hostInput = screen.getByTestId("session-host");

    fireEvent.paste(hostInput, {
      clipboardData: {
        getData: () =>
          "ssh -p 2222 -i ~/.ssh/prod_key -J ops@bastion.example.test:2200 " +
          "-L 127.0.0.1:15432:127.0.0.1:5432 -C -X -4 -o ServerAliveInterval=45 " +
          "deploy@app.example.test tmux new -A -s main",
      },
    });

    expect(hostInput).toHaveValue("app.example.test");
    expect(screen.getByTestId("session-port")).toHaveValue("2222");
    expect(screen.getByTestId("session-user")).toHaveValue("deploy");
    expect(screen.getByLabelText("Private key path")).toHaveValue("~/.ssh/prod_key");
    expect(screen.getByLabelText("Execute command")).toHaveValue("tmux new -A -s main");
    expect(screen.getByText("SSH command imported into this session.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = ipcMocks.saveSession.mock.calls[0][0];
    expect(saved).toMatchObject({
      session_type: "SSH",
      host: "app.example.test",
      port: 2222,
      username: "deploy",
      auth_method: { PrivateKey: { key_path: "~/.ssh/prod_key" } },
    });
    const options = JSON.parse(saved.options_json);
    expect(options).toMatchObject({
      x11: true,
      x11Trusted: false,
      compression: true,
      startupCmd: "tmux new -A -s main",
      doNotExit: false,
      networkSettings: {
        proxyKind: "ssh-tunnel",
        jumpHost: "bastion.example.test",
        jumpPort: "2200",
        jumpUser: "ops",
        keepAlive: true,
        keepAliveIntervalSecs: "45",
        ipVersion: "ipv4",
      },
    });
    expect(options.networkSettings.localForwards).toEqual([
      expect.objectContaining({
        local: "127.0.0.1:15432",
        remote: "127.0.0.1:5432",
      }),
    ]);
  });

  it("persists localized Local SSH tunnel selection as a stable proxy kind", async () => {
    setLocale("zh-CN");
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    await user.type(screen.getByLabelText("远程主机"), "app.internal");
    await user.click(screen.getByRole("button", { name: "网络设置" }));

    const proxySelect = screen.getByDisplayValue("无 — 直连");
    await user.selectOptions(proxySelect, screen.getByRole("option", { name: "本地 SSH 隧道" }));
    await user.type(screen.getByLabelText("跳板机主机"), "bastion.internal");
    await user.type(screen.getByLabelText("跳板机用户"), "ops");

    await user.click(screen.getByTestId("session-save"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const saved = ipcMocks.saveSession.mock.calls[0][0];
    const opts = JSON.parse(saved.options_json);
    expect(opts.networkSettings).toMatchObject({
      proxyKind: "ssh-tunnel",
      jumpHost: "bastion.internal",
      jumpUser: "ops",
    });
  });

  it("forwards proxy/jump network settings when testing a DB connection", async () => {
    const user = userEvent.setup();
    // A saved MySQL session reachable only through an SSH jump host.
    const dbSession = {
      id: "db-1",
      name: "prod-mysql",
      session_type: "MySQL",
      group_path: null,
      host: "db.internal",
      port: 3306,
      username: "app",
      auth_method: "Password" as const,
      options_json: JSON.stringify({
        networkSettings: {
          proxyKind: "ssh-tunnel",
          jumpHost: "bastion.corp",
          jumpPort: "22",
          jumpUser: "ops",
          jumpAuthKind: "Password",
        },
      }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(dbSession);

    await user.click(screen.getByTestId("db-test-connection"));

    await waitFor(() => expect(ipcMocks.dbTestConnection).toHaveBeenCalledTimes(1));
    const info = ipcMocks.dbTestConnection.mock.calls[0][0];
    expect(info.engine).toBe("MySQL");
    expect(info.host).toBe("db.internal");
    // The probe must carry the jump-host settings; otherwise the backend dials
    // the unreachable target directly and the test fails even though a saved
    // connection (which forwards them) would succeed.
    expect(info.networkSettings).toMatchObject({
      proxyKind: "ssh-tunnel",
      jumpHost: "bastion.corp",
      jumpUser: "ops",
      jumpPort: 22,
    });
  });

  it.each(["SSH", "SFTP"] as const)("uses saved vault password ref when testing a %s session", async (sessionType) => {
    const user = userEvent.setup();
    const session = {
      id: `${sessionType.toLowerCase()}-saved-password`,
      name: `${sessionType} saved password`,
      session_type: sessionType,
      group_path: null,
      host: "saved.example.com",
      port: 22,
      username: "deploy",
      auth_method: "Password" as const,
      options_json: JSON.stringify({ passwordRef: "vault:pwd" }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(session);

    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(ipcMocks.testSshConnection).toHaveBeenCalledTimes(1));
    expect(ipcMocks.testSshConnection).toHaveBeenCalledWith(
      "saved.example.com",
      22,
      "deploy",
      "Password",
      "vault:pwd",
      expect.any(String),
    );
  });

  it("persists Bookmark settings through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "prod.example.com");
    await user.click(screen.getByRole("button", { name: /bookmark settings/i }));

    await user.type(screen.getByLabelText("Session name"), "prod-web");
    await user.selectOptions(screen.getByDisplayValue("User sessions"), "User sessions / Production");
    await user.type(screen.getByLabelText("Description notes"), "Primary production host");
    await user.type(screen.getByLabelText("Tags"), "prod,web");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(savedConfig).toMatchObject({
      name: "prod-web",
      session_type: "SSH",
      group_path: "User sessions / Production",
      host: "prod.example.com",
      port: 22,
    });
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      description: "Primary production host",
      tags: "prod,web",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Terminal settings through the session store save path", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "dev.example.com");
    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "12");
    const scrollback = screen.getByLabelText("Scrollback lines");
    await user.clear(scrollback);
    await user.type(scrollback, "20000");
    await user.click(screen.getByLabelText("Save scrollback to log file on disconnect"));
    await user.click(screen.getByLabelText("Enable keyword highlighting"));
    await user.selectOptions(screen.getByLabelText("Terminal cursor"), "Vertical bar (steady)");

    await user.click(screen.getByRole("button", { name: "OK" }));

    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(JSON.parse(savedConfig.options_json).terminalProfile).toMatchObject({
      fontSize: 12,
      scrollback: 20000,
      loggingEnabled: true,
      syntaxMode: "keywords",
      cursorStyle: "bar",
      cursorBlink: false,
    });
    expect(JSON.parse(savedConfig.options_json).terminalProfile.fontFamily).toContain("JetBrains Mono");
  });

  it("defaults new SSH sessions to the global terminal default profile", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("taomni.terminalDefaultProfile.v1", JSON.stringify({
      fontSize: 17,
      theme: "kanagawa-wave",
    }));
    renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "default-profile.example.com");
    await user.click(screen.getByRole("button", { name: "OK" }));

    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(JSON.parse(savedConfig.options_json).terminalProfile).toMatchObject({
      fontSize: 17,
      theme: "kanagawa-wave",
    });
  });

  it("persists WSL launch options through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "WSL" });

    await waitFor(() => expect(screen.getByTestId("session-wsl-section")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wsl-distro")).toHaveValue("Ubuntu"));

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "LocalShell",
      name: "WSL: Ubuntu",
      host: "",
      port: 0,
      auth_method: "None",
    });
    expect(savedOptions).toMatchObject({
      wslDistro: "Ubuntu",
      localShellPath: "wsl.exe",
      localShellArgs: ["-d", "Ubuntu"],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["FTP", 21],
    ["Telnet", 23],
    ["Rlogin", 513],
    ["Mosh", 60001],
  ])("persists %s as an implemented command terminal client type", async (initialProto, expectedPort) => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto });

    expect(screen.queryByTestId("session-planned-client-note")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Remote host"), `${initialProto.toLowerCase()}.example.com`);
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    expect(ipcMocks.saveSession.mock.calls[0][0]).toMatchObject({
      session_type: initialProto,
      host: `${initialProto.toLowerCase()}.example.com`,
      port: expectedPort,
      auth_method: "None",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Serial device settings as a command terminal client", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Serial" });

    expect(screen.queryByTestId("session-planned-client-note")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Device *"), "/dev/ttyUSB0");
    await user.clear(screen.getByLabelText("Baud"));
    await user.type(screen.getByLabelText("Baud"), "57600");
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(savedConfig).toMatchObject({
      session_type: "Serial",
      host: "/dev/ttyUSB0",
      port: 0,
      auth_method: "None",
    });
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      serialDevice: "/dev/ttyUSB0",
      serialBaud: "57600",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Browser sessions as URL clients without a planned-client warning", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Browser" });

    expect(screen.queryByTestId("session-planned-client-note")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("session-host"), "https://docs.example.test/path");
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    expect(ipcMocks.saveSession.mock.calls[0][0]).toMatchObject({
      session_type: "Browser",
      host: "https://docs.example.test/path",
      port: 0,
      auth_method: "None",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SFTP", "advanced-ssh-settings"],
    ["VNC", "network-settings"],
    ["Browser", "network-settings"],
  ])("hides Terminal settings for %s sessions", async (initialProto, expectedSectionTestId) => {
    renderEditor(undefined, { initialProto });

    await waitFor(() => expect(screen.getByTestId(expectedSectionTestId)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /terminal settings/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-appearance-settings")).not.toBeInTheDocument();
  });

  it.each([
    [
      "RDP",
      {
        id: "old-rdp",
        name: "Old RDP",
        session_type: "RDP",
        group_path: null,
        host: "rdp.example.com",
        port: 3389,
        username: "user",
        auth_method: "None" as const,
        options_json: JSON.stringify({ domain: "CORP", terminalProfile: { fontSize: 18 } }),
        created_at: 1,
        updated_at: 1,
        last_connected_at: null,
        sort_order: 0,
      },
    ],
    [
      "Presto",
      {
        id: "old-presto",
        name: "Old Presto",
        session_type: "Presto",
        group_path: null,
        host: "presto.example.com",
        port: 8080,
        username: "analyst",
        auth_method: "None" as const,
        options_json: JSON.stringify({ dbCatalog: "hive", terminalProfile: { theme: "classic" } }),
        created_at: 1,
        updated_at: 1,
        last_connected_at: null,
        sort_order: 0,
      },
    ],
    [
      "S3",
      {
        id: "old-s3",
        name: "Old S3",
        session_type: "S3",
        group_path: null,
        host: "s3.example.com",
        port: 443,
        username: null,
        auth_method: "None" as const,
        options_json: JSON.stringify({ endpoint: "https://s3.example.com", terminalProfile: { fontSize: 20 } }),
        created_at: 1,
        updated_at: 1,
        last_connected_at: null,
        sort_order: 0,
      },
    ],
  ])("removes stale terminalProfile when saving %s sessions", async (_label, session) => {
    const user = userEvent.setup();
    renderEditor(session);

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedOptions = JSON.parse(ipcMocks.saveSession.mock.calls[0][0].options_json);
    expect(savedOptions).not.toHaveProperty("terminalProfile");
  });

  it("persists local Shell launch options through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Shell" });

    await waitFor(() => expect(screen.getByTestId("local-shell-select")).toHaveValue("__default__"));
    await waitFor(() => expect(screen.getByRole("option", { name: /Bash/ })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Local shell"), "/bin/bash");
    expect(screen.getByLabelText("Executable")).toHaveValue("/bin/bash");
    expect(screen.getByLabelText("Arguments")).toHaveValue("--login");

    await user.clear(screen.getByLabelText("Arguments"));
    await user.type(screen.getByLabelText("Arguments"), "--login -i");
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    expect(savedConfig).toMatchObject({
      session_type: "LocalShell",
      host: "",
      port: 0,
      auth_method: "None",
    });
    expect(JSON.parse(savedConfig.options_json)).toMatchObject({
      localShellPath: "/bin/bash",
      localShellArgs: ["--login", "-i"],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists RDP options through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "RDP" });

    await waitFor(() => expect(screen.getByTestId("session-rdp-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "rdp.example.com");
    await user.type(screen.getByLabelText("Domain"), "CORP");
    await user.selectOptions(screen.getByLabelText("Color depth"), "16");
    await user.click(screen.getByRole("radio", { name: "Disable" }));
    await user.click(screen.getByRole("checkbox", { name: "Sync clipboard" }));
    await user.click(screen.getByRole("checkbox", { name: "Drive redirection" }));

    const driveLabel = screen.getByLabelText("Drive label");
    await user.clear(driveLabel);
    await user.type(driveLabel, "SHAREDIR");
    await user.type(screen.getByLabelText("Local folder"), "D:\\shared");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "RDP",
      host: "rdp.example.com",
      port: 3389,
    });
    expect(savedOptions).toMatchObject({
      domain: "CORP",
      colorDepth: 16,
      redirectAudio: "off",
      redirectClipboard: false,
      redirectDrive: {
        enabled: true,
        label: "SHAREDIR",
        path: "D:\\shared",
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists RDP session password through the vault save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "RDP" });

    await waitFor(() => expect(screen.getByTestId("session-rdp-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "rdp.example.com");
    await user.type(screen.getByLabelText("Password"), "secret123");

    const saveCheckbox = screen.getByRole("checkbox", { name: /save in vault/i }) as HTMLInputElement;
    if (!saveCheckbox.checked) {
      await user.click(saveCheckbox);
    }

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.vaultPut).toHaveBeenCalledTimes(1);
    expect(ipcMocks.vaultPut).toHaveBeenCalledWith("rdp-password", "user@rdp.example.com:3389", "secret123");

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "RDP",
      host: "rdp.example.com",
      port: 3389,
    });
    expect(savedOptions).toMatchObject({
      passwordRef: "vault:pwd",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Proxy session password through the vault save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Proxy" });

    await waitFor(() => expect(screen.getByTestId("session-proxy-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "proxy.corp");
    await user.type(screen.getByLabelText("Password"), "s3cret");

    const saveCheckbox = screen.getByRole("checkbox", { name: /save in vault/i }) as HTMLInputElement;
    if (!saveCheckbox.checked) {
      await user.click(saveCheckbox);
    }

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.vaultPut).toHaveBeenCalledTimes(1);
    expect(ipcMocks.vaultPut).toHaveBeenCalledWith("proxy-password", "user@proxy.corp:3128", "s3cret");

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "Proxy",
      host: "proxy.corp",
      port: 3128,
    });
    expect(savedOptions).toMatchObject({
      passwordRef: "vault:pwd",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Presto database settings through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Presto" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "presto.example.com");
    await user.type(screen.getByLabelText("Database username"), "analyst");
    await user.type(screen.getByLabelText("Presto catalog"), "hive");
    await user.type(screen.getByLabelText("Presto schema"), "sales");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "Presto",
      host: "presto.example.com",
      port: 8080,
      username: "analyst",
    });
    expect(savedOptions).toMatchObject({
      dbCatalog: "hive",
      dbDatabase: "sales",
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists SQL Server database settings with the default port", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "SQLServer" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "sql.example.com");
    await user.type(screen.getByLabelText("Database username"), "sa");
    await user.type(screen.getByLabelText("Database name"), "warehouse");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "SQLServer",
      host: "sql.example.com",
      port: 1433,
      username: "sa",
    });
    expect(savedOptions).toMatchObject({
      dbDatabase: "warehouse",
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Oracle database settings with the default port", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Oracle" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "oracle.example.com");
    await user.type(screen.getByLabelText("Database username"), "billing");
    await user.type(screen.getByLabelText("Oracle service or schema"), "ORCLPDB1");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "Oracle",
      host: "oracle.example.com",
      port: 1521,
      username: "billing",
    });
    expect(savedOptions).toMatchObject({
      dbDatabase: "ORCLPDB1",
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists PanWeiDB database settings through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "PanWeiDB" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "192.168.152.250");
    await user.clear(screen.getByLabelText("Port"));
    await user.type(screen.getByLabelText("Port"), "17700");
    await user.type(screen.getByLabelText("Database username"), "panwei_omm");
    await user.type(screen.getByLabelText("Database name"), "panweidb");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "PanWeiDB",
      host: "192.168.152.250",
      port: 17700,
      username: "panwei_omm",
    });
    expect(savedOptions).toMatchObject({
      dbDatabase: "panweidb",
      dbSsl: false,
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists StarRocks database settings with the FE query port", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "StarRocks" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "sr.example.com");
    await user.type(screen.getByLabelText("Database username"), "reader");
    await user.type(screen.getByLabelText("Database name"), "warehouse");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "StarRocks",
      host: "sr.example.com",
      port: 9030,
      username: "reader",
    });
    expect(savedOptions).toMatchObject({
      dbDatabase: "warehouse",
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists HBase shell REST settings through the session store save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "HBaseShell" });

    await waitFor(() => expect(screen.getByTestId("session-hbase-section")).toBeInTheDocument());
    // Switch to REST mode first so the REST-only host/port fields render.
    await user.selectOptions(screen.getByTestId("hbase-connection-mode"), "rest");
    await user.type(screen.getByLabelText("Remote host"), "hbase-rest.example.com");
    await user.type(screen.getByLabelText("HBase username"), "root");
    await user.type(screen.getByLabelText("HBase namespace"), "prod");
    await user.type(screen.getByLabelText("HBase REST path"), "/gateway/hbase");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "HBaseShell",
      host: "hbase-rest.example.com",
      port: 8080,
      username: "root",
    });
    expect(savedOptions).toMatchObject({
      hbaseNamespace: "prod",
      hbaseRestPath: "/gateway/hbase",
      hbaseConnectionMode: "rest",
      dbTimeout: "15",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists HBase native RPC settings (ZooKeeper quorum) through the save path", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "HBaseShell" });

    await waitFor(() => expect(screen.getByTestId("session-hbase-section")).toBeInTheDocument());
    // Native is the default mode; host/port are hidden and the ZK quorum field
    // replaces them.
    expect(screen.queryByLabelText("Remote host")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("HBase ZooKeeper quorum"), "zk1:2181,zk2:2181");
    await user.type(screen.getByLabelText("HBase namespace"), "prod");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "HBaseShell",
      host: "",
    });
    expect(savedOptions).toMatchObject({
      hbaseConnectionMode: "native",
      hbaseZkQuorum: "zk1:2181,zk2:2181",
      hbaseNamespace: "prod",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists HBase Kerberos settings including krb5.conf path and keytab", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "HBaseShell" });

    await waitFor(() => expect(screen.getByTestId("session-hbase-section")).toBeInTheDocument());
    // Native mode: no host/port fields; a ZK quorum (or hbase-site.xml) supplies
    // the connection target, and auth is configured directly.
    await user.type(screen.getByLabelText("HBase ZooKeeper quorum"), "zk1:2181,zk2:2181");
    await user.selectOptions(screen.getByTestId("hbase-auth-method"), "kerberos");
    await user.type(screen.getByLabelText("HBase service principal"), "hbase/_HOST@EMR.367593.COM");
    await user.type(screen.getByLabelText("HBase keytab file path"), "/path/to/keytab");

    await waitFor(() => expect(screen.getByLabelText("HBase client principal")).toBeInTheDocument());
    await user.type(screen.getByLabelText("HBase client principal"), "user@EMR.367593.COM");

    await user.type(screen.getByLabelText("HBase krb5 config file path"), "/path/to/krb5.conf");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      session_type: "HBaseShell",
      host: "",
    });
    expect(savedOptions).toMatchObject({
      hbaseConnectionMode: "native",
      hbaseAuthMethod: "kerberos",
      hbaseServicePrincipal: "hbase/_HOST@EMR.367593.COM",
      hbasePrincipal: "user@EMR.367593.COM",
      hbaseKeytabPath: "/path/to/keytab",
      hbaseKrb5ConfPath: "/path/to/krb5.conf",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists edited Terminal settings for an existing session", async () => {
    const user = userEvent.setup();
    const session = {
      id: "existing-terminal-profile",
      name: "prod-shell",
      session_type: "SSH",
      group_path: null,
      host: "prod.example.com",
      port: 22,
      username: "root",
      auth_method: "Password" as const,
      options_json: JSON.stringify({
        compression: true,
        terminalProfile: {
          fontFamily: "Consolas, monospace",
          fontSize: 14,
          fontLigatures: false,
          theme: "classic",
          scrollback: 10000,
          cursorStyle: "block",
          cursorBlink: true,
          showScrollbar: true,
          copyOnSelect: false,
          rightClickBehavior: "menu",
          readOnly: false,
          bracketedPaste: true,
          multilinePasteConfirm: true,
          syntaxMode: "default",
          loggingEnabled: false,
        },
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: 20,
      sort_order: 0,
    };
    const { onClose } = renderEditor(session);

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));
    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByTestId("terminal-theme-select"));
    await user.click(screen.getByTestId("terminal-theme-option-termius-dark"));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig).toMatchObject({
      id: "existing-terminal-profile",
      name: "prod-shell",
      host: "prod.example.com",
      username: "root",
      created_at: 10,
      last_connected_at: 20,
    });
    expect(savedOptions.compression).toBe(true);
    expect(savedOptions.terminalProfile).toMatchObject({
      fontSize: 18,
      theme: "termius-dark",
    });
    expect(savedOptions.terminalProfile.fontFamily).toContain("JetBrains Mono");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves mail sessions with username identity and appearance settings", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    expect(screen.queryByTestId("session-host")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("IMAP server"), "imap.example.com");
    await user.type(screen.getByLabelText("Mail email or username"), "me@example.com");
    await user.type(screen.getByLabelText("Mail password or app password token"), "imap-secret");
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");
    await user.type(screen.getByLabelText("Mail save directory"), "D:\\mail-cache");

    await user.click(screen.getByRole("button", { name: /appearance/i }));
    expect(screen.getByTestId("mail-appearance-settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Terminal font size")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Terminal cursor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scrollback lines")).not.toBeInTheDocument();
    expect(screen.getByTestId("mail-appearance-preview")).toBeInTheDocument();
    const themeSelect = screen.getByTestId("mail-theme-select");
    await user.click(themeSelect);
    expect(screen.getByTestId("mail-theme-option-code-dracula")).toBeInTheDocument();
    expect(screen.getByTestId("mail-theme-option-terminal-termius-dark")).toBeInTheDocument();
    await user.click(screen.getByTestId("mail-theme-option-code-dracula"));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);

    expect(savedConfig).toMatchObject({
      session_type: "Mail",
      host: "imap.example.com",
      port: 993,
      username: "me@example.com",
      auth_method: "Password",
    });
    expect(savedOptions.mailEmailAddress).toBeUndefined();
    expect(savedOptions.mailSmtpHost).toBe("smtp.example.com");
    expect(savedOptions.mailSaveDirectory).toBe("D:\\mail-cache");
    expect(savedOptions.passwordRef).toBe("vault:pwd");
    expect(savedOptions.terminalProfile).toMatchObject({
      theme: "code:dracula",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("defaults new mail sessions to follow the application theme", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    await user.type(screen.getByLabelText("IMAP server"), "imap.example.com");
    await user.type(screen.getByLabelText("Mail email or username"), "me@example.com");
    await user.type(screen.getByLabelText("Mail password or app password token"), "imap-secret");
    await user.type(screen.getByLabelText("SMTP server"), "smtp.example.com");

    await user.click(screen.getByRole("button", { name: /appearance/i }));
    expect(await screen.findByTestId("mail-appearance-settings")).toBeInTheDocument();
    const systemTheme = await screen.findByTestId("mail-theme-select");
    expect(systemTheme).toHaveTextContent("Match app theme");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);

    expect(savedConfig.session_type).toBe("Mail");
    expect(savedOptions.terminalProfile).toMatchObject({
      theme: "system",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
