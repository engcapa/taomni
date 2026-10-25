import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { setLocale } from "../../../../lib/i18n";
import { checkboxInLabel, ipcMocks, renderEditor } from "./harness";

export function registerSessionEditorClipboard1Cases() {

  it("keeps primary actions reachable when UI text grows", () => {
    renderEditor();

    const editor = screen.getByTestId("session-editor");
    expect(editor).toHaveClass("max-w-[calc(100vw-24px)]", "max-h-[calc(100vh-24px)]");

    const protocolPicker = screen.getByTestId("session-proto-ssh").parentElement?.parentElement;
    expect(protocolPicker).toHaveClass("overflow-y-auto");

    const save = screen.getByTestId("session-save");
    const primaryActions = save.parentElement;
    expect(primaryActions).toHaveClass("shrink-0");

    const footer = primaryActions?.parentElement;
    expect(footer).toHaveClass("flex-wrap");
    expect(footer?.firstElementChild).toHaveClass("min-w-0", "flex-wrap");
    expect(screen.getByTitle(/Will be saved to/)).toHaveClass("min-w-0", "truncate");
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
    expect(screen.getByTestId("session-ssh-browser-type")).toHaveTextContent("SFTP protocol (recommended)");
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
      sshBrowser: "sftp",
    });
    expect(JSON.parse(savedConfig.options_json)).not.toHaveProperty("followPath");
    expect(JSON.parse(savedConfig.options_json)).not.toHaveProperty("osc7AutoInject");
  });

  it("updates Terminal settings preview and numeric fields", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    expect(screen.getByLabelText("Terminal font")).toHaveTextContent("Cascadia Mono");

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

    const proxySelect = screen.getByTestId("session-proxy-kind");
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

    const proxySelect = screen.getByTestId("session-proxy-kind");
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
    // Full success text is shown in a modal (footer is truncated summary only).
    await waitFor(() => expect(screen.getByTestId("alert-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("alert-dialog-message")).toHaveTextContent("Database connection OK");
    await user.click(screen.getByTestId("alert-dialog-ok"));
  });

  it("shows the full database test failure in a modal, including empty-body 502 detail", async () => {
    const user = userEvent.setup();
    ipcMocks.dbTestConnection.mockRejectedValueOnce(
      new Error("Presto error (502 Bad Gateway): "),
    );
    const prestoSession = {
      id: "presto-1",
      name: "trino",
      session_type: "Presto",
      group_path: null,
      host: "trino.example.com",
      port: 8080,
      username: "analyst",
      auth_method: "Password" as const,
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbPrestoDialect: "trino",
      }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    };
    renderEditor(prestoSession);

    await user.click(screen.getByTestId("db-test-connection"));

    await waitFor(() => expect(screen.getByTestId("alert-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-tone", "error");
    expect(screen.getByText("Connection test failed")).toBeInTheDocument();
    const message = screen.getByTestId("alert-dialog-message");
    expect(message).toHaveTextContent("Presto error (502 Bad Gateway):");
    expect(message).toHaveTextContent("No additional detail was returned by the server.");
    await user.click(screen.getByTestId("alert-dialog-ok"));
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
}
