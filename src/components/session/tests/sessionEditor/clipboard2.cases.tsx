import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { setLocale } from "../../../../lib/i18n";
import { ipcMocks, renderEditor } from "./harness";

export function registerSessionEditorClipboard2Cases() {

  it("persists Terminal settings through the session store save path", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("Remote host"), "dev.example.com");
    await user.click(screen.getByRole("button", { name: /terminal settings/i }));

    await user.click(screen.getByLabelText("Terminal font"));
    await user.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
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
    ["VNC", "session-vnc-policies"],
    ["Browser", "bookmark-settings"],
  ])("hides Terminal settings for %s sessions", async (initialProto, expectedSectionTestId) => {
    renderEditor(undefined, { initialProto });

    await waitFor(() => expect(screen.getByTestId(expectedSectionTestId)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /terminal settings/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-appearance-settings")).not.toBeInTheDocument();
  });

  it("shows the VNC section in English with the in-session Properties wording", async () => {
    renderEditor(undefined, { initialProto: "VNC" });
    const english = await screen.findByTestId("session-vnc-policies");
    expect(english).toHaveTextContent("Security policy");
    expect(screen.getByRole("option", { name: "Allow unauthenticated None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Scale Automatically" })).toBeInTheDocument();
    expect(english).toHaveTextContent("Share the desktop with other viewers");
    expect(english).toHaveTextContent("None is rejected unless explicitly allowed.");
  });

  it("localizes the VNC section labels, options and note in Chinese", async () => {
    setLocale("zh-CN");
    renderEditor(undefined, { initialProto: "VNC" });
    const chinese = await screen.findByTestId("session-vnc-policies");
    for (const text of ["安全策略", "画质", "缩放", "按键", "剪贴板", "输入", "连接时剪贴板", "连接", "除非明确允许，否则拒绝 None。"]) {
      expect(chinese).toHaveTextContent(text);
    }
    const policy = screen.getByTestId("session-vnc-security-policy");
    expect(Array.from((policy as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      "优先使用最强的可用方式",
      "要求加密的 RA2",
      "兼容旧服务器（不允许 None）",
      "优先不加密（服务器提供时用未加密的 VNCAuth）",
      "允许无认证的 None",
    ]);
    expect(chinese).not.toHaveTextContent("Security policy");
    expect(chinese).not.toHaveTextContent("Share the desktop with other viewers");
  });

  it("persists VNC security, clipboard, and view-only policies", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "VNC" });

    await user.type(screen.getByTestId("session-host"), "vnc.example.test");
    await user.selectOptions(screen.getByTestId("session-vnc-security-policy"), "require-encryption");
    await user.selectOptions(screen.getByTestId("session-vnc-clipboard-policy"), "server-to-client");
    await user.click(screen.getByTestId("session-vnc-view-only"));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ipcMocks.saveSession.mock.calls[0][0].options_json)).toMatchObject({
      vncSecurityPolicy: "require-encryption",
      vncClipboardPolicy: "server-to-client",
      vncViewOnly: true,
    });
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
    // New Presto sessions default to Trino; switch to Presto for the legacy path.
    await user.selectOptions(screen.getByLabelText("Presto/Trino engine"), "Presto");
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
      dbPrestoDialect: "presto",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists Trino dialect and includes it on database test-connection payload", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "Presto" });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Remote host"), "trino.example.com");
    await user.type(screen.getByLabelText("Database username"), "analyst");
    // New sessions already default to Trino; keep it and require catalog for test.
    await user.selectOptions(screen.getByLabelText("Presto/Trino engine"), "Trino");
    await user.type(screen.getByLabelText("Presto catalog"), "hive");
    await user.type(screen.getByLabelText("Presto schema"), "sales");

    await user.click(screen.getByTestId("db-test-connection"));

    await waitFor(() => expect(ipcMocks.dbTestConnection).toHaveBeenCalledTimes(1));
    expect(ipcMocks.dbTestConnection.mock.calls[0][0]).toMatchObject({
      engine: "Presto",
      host: "trino.example.com",
      catalog: "hive",
      database: "sales",
      prestoDialect: "trino",
    });
    await waitFor(() => expect(screen.getByTestId("alert-dialog")).toBeInTheDocument());
    await user.click(screen.getByTestId("alert-dialog-ok"));

    await user.click(screen.getByRole("button", { name: "OK" }));
    const savedOptions = JSON.parse(ipcMocks.saveSession.mock.calls[0][0].options_json);
    expect(savedOptions).toMatchObject({
      dbCatalog: "hive",
      dbDatabase: "sales",
      dbPrestoDialect: "trino",
    });
  });
}
