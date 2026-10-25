import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ipcMocks, mailMocks, renderEditor } from "./harness";

export function registerSessionEditorLifecycle3Cases() {

  it("hydrates a saved Presto session without dialect as Presto engine", async () => {
    renderEditor({
      id: "old-presto",
      name: "Legacy Presto",
      session_type: "Presto",
      group_path: null,
      host: "presto.example.com",
      port: 8080,
      username: "analyst",
      auth_method: "None",
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbDatabase: "sales",
      }),
      created_at: 1,
      updated_at: 1,
      last_connected_at: null,
      sort_order: 0,
    });

    await waitFor(() => expect(screen.getByTestId("session-database-section")).toBeInTheDocument());
    expect(screen.getByLabelText("Presto/Trino engine")).toHaveValue("Presto");
    expect(screen.getByLabelText("Presto catalog")).toHaveValue("hive");
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
    await user.click(screen.getByLabelText("Terminal font"));
    await user.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
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
    await user.type(screen.getByTestId("mail-storage-directory"), "D:\\complete-mail");
    await user.selectOptions(screen.getByTestId("mail-storage-mode"), "include");
    fireEvent.change(screen.getByTestId("mail-storage-folder-names"), { target: { value: "INBOX\nProjects/Work\nINBOX\n" } });

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
    expect(savedOptions.mailStorageDirectory).toBe("D:\\complete-mail");
    expect(savedOptions.mailFullMessageMode).toBe("include");
    expect(savedOptions.mailFullMessageFolders).toEqual(["INBOX", "Projects/Work"]);
    expect(savedOptions.passwordRef).toBe("vault:pwd");
    expect(savedOptions.terminalProfile).toMatchObject({
      theme: "code:dracula",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies Gmail and Outlook mail provider presets", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    expect(screen.getByLabelText("Mail auth mode")).toHaveValue("oauth2");
    expect(screen.getByLabelText("IMAP server")).toHaveValue("imap.gmail.com");
    expect(screen.getByLabelText("IMAP port")).toHaveValue("993");
    expect(screen.getByLabelText("SMTP server")).toHaveValue("smtp.gmail.com");
    expect(screen.getByLabelText("SMTP port")).toHaveValue("587");

    await user.selectOptions(screen.getByLabelText("Mail provider"), "outlook");
    expect(screen.getByLabelText("IMAP server")).toHaveValue("outlook.office365.com");
    expect(screen.getByLabelText("SMTP server")).toHaveValue("smtp-mail.outlook.com");
    expect(screen.getByLabelText("OAuth flow")).toHaveValue("device");
    expect(screen.queryByLabelText("OAuth client secret")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    await user.selectOptions(screen.getByLabelText("Mail auth mode"), "password");
    await user.type(screen.getByLabelText("Mail email or username"), "me@gmail.com");
    await user.type(screen.getByLabelText("Mail password or app password token"), "gmail-app-secret");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);

    expect(savedConfig).toMatchObject({
      session_type: "Mail",
      host: "imap.gmail.com",
      port: 993,
      username: "me@gmail.com",
    });
    expect(savedOptions.mailProvider).toBe("gmail");
    expect(savedOptions.mailAuthMode).toBe("password");
    expect(savedOptions.mailSmtpHost).toBe("smtp.gmail.com");
    expect(savedOptions.mailSmtpPort).toBe("587");
    expect(savedOptions.mailSmtpSecurity).toBe("STARTTLS");
    expect(savedOptions.passwordRef).toBe("vault:pwd");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves mail session Network tab proxy settings", async () => {
    const user = userEvent.setup();
    const { onClose } = renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    await user.selectOptions(screen.getByLabelText("Mail auth mode"), "password");
    await user.type(screen.getByLabelText("Mail email or username"), "me@gmail.com");
    await user.type(screen.getByLabelText("Mail password or app password token"), "gmail-app-secret");

    await user.click(screen.getByRole("button", { name: /network settings/i }));
    const proxySelect = screen.getByTestId("session-proxy-kind");
    await user.selectOptions(proxySelect, "HTTP CONNECT");
    await user.type(screen.getByLabelText("Proxy host"), "proxy.mail.corp");
    await user.type(screen.getByLabelText("Proxy port"), "8080");
    await user.type(screen.getByLabelText("Proxy username"), "mail-user");

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    const savedConfig = ipcMocks.saveSession.mock.calls[0][0];
    const savedOptions = JSON.parse(savedConfig.options_json);
    expect(savedConfig.session_type).toBe("Mail");
    expect(savedOptions.networkSettings).toMatchObject({
      proxyKind: "http",
      proxyHost: "proxy.mail.corp",
      proxyPort: "8080",
      proxyUser: "mail-user",
    });
    expect(savedOptions.mailProvider).toBe("gmail");
    expect(savedOptions.mailAuthMode).toBe("password");
  });

  it("authorizes Gmail OAuth using the Mail Network tab settings", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "Mail" });

    await user.selectOptions(screen.getByLabelText("Mail provider"), "gmail");
    expect(screen.getByLabelText("OAuth flow")).toHaveValue("browser");
    await user.type(screen.getByLabelText("Mail email or username"), "me@gmail.com");
    await user.type(screen.getByLabelText("OAuth client ID"), "google-client-id");

    await user.click(screen.getByRole("button", { name: /network settings/i }));
    const proxySelect = screen.getByTestId("session-proxy-kind");
    await user.selectOptions(proxySelect, "SOCKS 5");
    await user.type(screen.getByLabelText("Proxy host"), "socks.mail.corp");
    await user.type(screen.getByLabelText("Proxy port"), "1080");

    await user.click(screen.getByRole("button", { name: /mail account/i }));
    await user.click(screen.getByTestId("mail-oauth-connect"));

    await waitFor(() => expect(mailMocks.mailOAuthAuthorize).toHaveBeenCalledTimes(1));
    const oauthRequest = (mailMocks.mailOAuthAuthorize.mock.calls[0] as unknown[])[0];
    expect(oauthRequest).toMatchObject({
      provider: "gmail",
      emailAddress: "me@gmail.com",
      clientId: "google-client-id",
      networkSettings: {
        proxyKind: "socks5",
        proxyHost: "socks.mail.corp",
        proxyPort: 1080,
      },
    });
    expect(screen.getByText("OAuth2 connected.")).toBeInTheDocument();
  });
}
