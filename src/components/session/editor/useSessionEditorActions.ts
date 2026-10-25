import { type ClipboardEvent } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import { selectFilePath, selectFolderPath, selectPrivateKeyFile } from "../../../lib/ipc";
import { DEFAULT_NETWORK_SETTINGS } from "../../../lib/networkSettings";
import { parseSshConnectionCommand, parseUserHostPort } from "../../../lib/quickConnect";
import { SYSTEM_TERMINAL_THEME } from "../../../lib/terminalProfile";
import {
  createBuildDbConnectInfo,
  createBuildHBaseConnectInfo,
  createHandleTestConnection,
  createHandleTestDbConnection,
  createHandleTestHBaseConnection,
  createHandleTestProxyConnection,
} from "./connectionProbes";
import { createHandleMailOAuthConnect } from "./mailAuthentication";
import { type MailProvider, defaultMailOAuthFlow, MAIL_PROVIDER_PRESETS } from "./mailPolicy";
import { createHandleDelete, createHandleNewFolder, createHandleSave, createHandleSaveAsProxySession, createHandleSaveTemplate } from "./persistenceActions";
import { createSessionReset } from "./reset";
import { createSessionSerialization } from "./serialization";
import { type Proto, cloneNetworkSettings, DB_PROTOS, DEFAULT_PORTS, defaultTerminalProfileForProto } from "./sessionPolicy";
import { useSessionEditorState } from "./useSessionEditorState";


export interface UseSessionEditorActionsContext {
  form: ReturnType<typeof useSessionEditorState>;
  session: SessionConfig | undefined;
  onClose: () => void;
  defaultGroupPath: string | null;
}

export function useSessionEditorActions(context: UseSessionEditorActionsContext) {
  const { form, session, onClose, defaultGroupPath } = context;

  const handleProtoChange = (p: Proto) => {
    form.setProto(p);
    form.setPort(String(DEFAULT_PORTS[p] ?? 22));
    // For File proto only the Bookmark sub-tab is meaningful; jump there so
    // the user lands on the relevant content.
    if (p === "File") form.setSection("bookmark");
    // Data-client protos open straight to the dedicated settings tab.
    if (DB_PROTOS.includes(p) || p === "HBaseShell") form.setSection("database");
    // Proxy proto opens to its settings tab.
    if (p === "Proxy") form.setSection("proxy");
    if (p === "Mail") {
      form.setSection("mail");
      form.setSpecifyUser(true);
      form.setSaveInVault(true);
      form.mailForm.setMailSmtpSaveInVault(true);
      form.setTerminalProfile((current) => ({ ...current, theme: SYSTEM_TERMINAL_THEME }));
    } else {
      form.setTerminalProfile((current) => current.theme === SYSTEM_TERMINAL_THEME
        ? { ...current, theme: defaultTerminalProfileForProto(p).theme }
        : current);
    }
    // Object storage opens straight to its settings tab.
    if (p === "S3") form.setSection("objectstorage");
  };

  const handleMailProviderChange = (provider: MailProvider) => {
    form.mailForm.setMailProvider(provider);
    form.mailForm.setMailAuthMode(provider === "custom" ? "password" : "oauth2");
    form.mailForm.setMailOauthFlow(defaultMailOAuthFlow(provider));
    form.mailForm.setMailOauthDeviceInfo(null);
    form.mailForm.setMailOauthStatus(null);
    const preset = MAIL_PROVIDER_PRESETS[provider];
    if (!preset) return;

    form.setHost(preset.imapHost);
    form.setPort(preset.imapPort);
    form.mailForm.setMailImapSecurity(preset.imapSecurity);
    form.mailForm.setMailSmtpHost(preset.smtpHost);
    form.mailForm.setMailSmtpPort(preset.smtpPort);
    form.mailForm.setMailSmtpSecurity(preset.smtpSecurity);
    form.mailForm.setMailSmtpUseImapAuth(preset.smtpUseImapAuth);
  };

  /* Keep authMethod in sync with the radio group */
  const handleAuthRadio = (v: string) => {
    form.setAuthRadio(v);
    if (v === "password") {
      form.setAuthMethod("Password");
      form.setUsePrivKey(false);
    } else if (v === "privatekey") {
      form.setAuthMethod("PrivateKey");
      form.setUsePrivKey(true);
    } else if (v === "agent") {
      form.setAuthMethod("Agent");
      form.setUsePrivKey(false);
    } else {
      form.setAuthMethod("Gssapi");
      form.setUsePrivKey(false);
    }
  };
  const { validate, buildConfig, buildOptionsJson } = createSessionSerialization({
    bookmark: form.bookmark,
    passwordRef: form.passwordRef,
    networkSettings: form.networkSettings,
    mailForm: form.mailForm,
    session,
    supportsTerminalAppearance: form.supportsTerminalAppearance,
    isMail: form.isMail,
    proto: form.proto,
    shellForm: form.shellForm,
    serialDevice: form.serialDevice,
    serialBaud: form.serialBaud,
    rdpOptions: form.rdpOptions,
    vncSecurityPolicy: form.vncSecurityPolicy,
    vncViewOnly: form.vncViewOnly,
    vncClipboardPolicy: form.vncClipboardPolicy,
    vncViewer: form.vncViewer,
    isDb: form.isDb,
    databaseForm: form.databaseForm,
    isProxy: form.isProxy,
    proxyKind: form.proxyKind,
    proxyTestUrl: form.proxyTestUrl,
    oss: form.oss,
    isHBase: form.isHBase,
    terminalProfile: form.terminalProfile,
    x11: form.x11,
    x11Trusted: form.x11Trusted,
    compression: form.compression,
    startupCmd: form.startupCmd,
    description: form.description,
    tags: form.tags,
    doNotExit: form.doNotExit,
    disableAiWrite: form.disableAiWrite,
    remoteEnv: form.remoteEnv,
    usePrivKey: form.usePrivKey,
    fileEmbedInTab: form.fileEmbedInTab,
    fileExtraArgs: form.fileExtraArgs,
    pathMappings: form.pathMappings,
    authMethod: form.authMethod,
    keyPath: form.keyPath,
    name: form.name,
    t: form.t,
    username: form.username,
    host: form.host,
    port: form.port,
    groupPath: form.groupPath,
    needsHost: form.needsHost,
    saveInVault: form.saveInVault,
    password: form.password,
    isSSH: form.isSSH,
    specifyUser: form.specifyUser,
  });

  const handleSave = createHandleSave({
    validate,
    setSaveError: form.setSaveError,
    passwordRef: form.passwordRef,
    isSSH: form.isSSH,
    isDb: form.isDb,
    isHBase: form.isHBase,
    proto: form.proto,
    isProxy: form.isProxy,
    isMail: form.isMail,
    authMethod: form.authMethod,
    mailAuthMode: form.mailForm.mailAuthMode,
    saveInVault: form.saveInVault,
    password: form.password,
    t: form.t,
    username: form.username,
    host: form.host,
    port: form.port,
    setPasswordRef: form.setPasswordRef,
    setPassword: form.setPassword,
    networkSettings: form.networkSettings,
    setNetworkSettings: form.setNetworkSettings,
    mailSmtpPasswordRef: form.mailForm.mailSmtpPasswordRef,
    mailSmtpUseImapAuth: form.mailForm.mailSmtpUseImapAuth,
    mailSmtpSaveInVault: form.mailForm.mailSmtpSaveInVault,
    mailSmtpPassword: form.mailForm.mailSmtpPassword,
    mailSmtpUsername: form.mailForm.mailSmtpUsername,
    mailSmtpHost: form.mailForm.mailSmtpHost,
    mailSmtpPort: form.mailForm.mailSmtpPort,
    setMailSmtpPasswordRef: form.mailForm.setMailSmtpPasswordRef,
    setMailSmtpPassword: form.mailForm.setMailSmtpPassword,
    mailOauthClientSecretRef: form.mailForm.mailOauthClientSecretRef,
    mailProvider: form.mailForm.mailProvider,
    mailOauthFlow: form.mailForm.mailOauthFlow,
    setMailOauthClientSecretRef: form.mailForm.setMailOauthClientSecretRef,
    setMailOauthClientSecret: form.mailForm.setMailOauthClientSecret,
    mailOauthClientSecretSaveInVault: form.mailForm.mailOauthClientSecretSaveInVault,
    mailOauthClientSecret: form.mailForm.mailOauthClientSecret,
    oss: form.oss,
    setOss: form.setOss,
    buildConfig,
    buildOptionsJson,
    mailOauthTokenRef: form.mailForm.mailOauthTokenRef,
    mailOauthExpiresAt: form.mailForm.mailOauthExpiresAt,
    mailOauthScope: form.mailForm.mailOauthScope,
    isEdit: form.isEdit,
    updateSession: form.updateSession,
    addSession: form.addSession,
    onClose,
  });

  const handleSaveTemplate = createHandleSaveTemplate({
    validate,
    setSaveError: form.setSaveError,
    buildConfig,
    t: form.t,
    name: form.name,
    host: form.host,
    proto: form.proto,
    addSession: form.addSession,
    setTestResult: form.setTestResult,
  });
  const { handleReset } = createSessionReset({
    setBookmark: form.setBookmark,
    session,
    setProto: form.setProto,
    setSection: form.setSection,
    setName: form.setName,
    setHost: form.setHost,
    setPort: form.setPort,
    setUsername: form.setUsername,
    setSpecifyUser: form.setSpecifyUser,
    setGroupPath: form.setGroupPath,
    defaultGroupPath,
    setAuthMethod: form.setAuthMethod,
    setAuthRadio: form.setAuthRadio,
    setKeyPath: form.setKeyPath,
    setPassword: form.setPassword,
    setPasswordRef: form.setPasswordRef,
    setSaveInVault: form.setSaveInVault,
    setX11: form.setX11,
    setX11Trusted: form.setX11Trusted,
    setCompression: form.setCompression,
    setStartupCmd: form.setStartupCmd,
    setDoNotExit: form.setDoNotExit,
    setDisableAiWrite: form.setDisableAiWrite,
    setRemoteEnv: form.setRemoteEnv,
    setUsePrivKey: form.setUsePrivKey,
    setDescription: form.setDescription,
    setTags: form.setTags,
    setFileEmbedInTab: form.setFileEmbedInTab,
    setFileExtraArgs: form.setFileExtraArgs,
    databaseForm: form.databaseForm,
    setTerminalProfile: form.setTerminalProfile,
    setNetworkSettings: form.setNetworkSettings,
    setSerialDevice: form.setSerialDevice,
    setSerialBaud: form.setSerialBaud,
    shellForm: form.shellForm,
    setRdpOptions: form.setRdpOptions,
    setVncSecurityPolicy: form.setVncSecurityPolicy,
    setVncViewOnly: form.setVncViewOnly,
    setVncViewer: form.setVncViewer,
    setVncClipboardPolicy: form.setVncClipboardPolicy,
    setPathMappings: form.setPathMappings,
    mailForm: form.mailForm,
    setOss: form.setOss,
    setSaveError: form.setSaveError,
    setTestResult: form.setTestResult,
  });

  const applySshCommandText = (value: string): boolean => {
    const parsed = parseSshConnectionCommand(value);
    if (!parsed) return false;

    form.setProto("SSH");
    form.setSection("advanced");
    form.setHost(parsed.host);
    form.setPort(String(parsed.port || DEFAULT_PORTS.SSH));
    form.setUsername(parsed.username ?? "");
    form.setSpecifyUser(!!parsed.username);
    form.setName((current) => current || `ssh://${parsed.username ? `${parsed.username}@` : ""}${parsed.host}:${parsed.port || DEFAULT_PORTS.SSH}`);
    form.setPassword("");
    form.setPasswordRef("");
    form.setSaveInVault(false);
    form.setX11(parsed.options.x11);
    form.setX11Trusted(parsed.options.x11Trusted);
    form.setCompression(parsed.options.compression ?? false);
    form.setStartupCmd(parsed.options.startupCmd ?? "");
    form.setDoNotExit(parsed.options.doNotExit ?? true);
    form.setRemoteEnv("Interactive shell");
    if (parsed.keyPath) {
      form.setAuthMethod("PrivateKey");
      form.setAuthRadio("privatekey");
      form.setUsePrivKey(true);
      form.setKeyPath(parsed.keyPath);
    } else {
      form.setAuthMethod("Password");
      form.setAuthRadio("password");
      form.setUsePrivKey(false);
      form.setKeyPath("");
    }
    form.setNetworkSettings(cloneNetworkSettings(parsed.options.networkSettings ?? DEFAULT_NETWORK_SETTINGS));
    form.setSaveError(null);
    form.setTestResult({ ok: true, msg: form.t("sessionEditor2.sshCommandImported") });
    return true;
  };

  const handleHostLookup = () => {
    if (applySshCommandText(form.host)) return;

    let parsed: ReturnType<typeof parseUserHostPort> = null;
    try {
      parsed = parseUserHostPort(form.host);
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    form.setHost(parsed.host);
    if (parsed.username) {
      form.setUsername(parsed.username);
      form.setSpecifyUser(true);
    }
    if (parsed.port) form.setPort(String(parsed.port));
  };

  const handleHostPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text || !applySshCommandText(text)) return;
    event.preventDefault();
  };

  const handleBrowseKey = async () => {
    form.setSaveError(null);
    try {
      const selected = await selectPrivateKeyFile(form.keyPath || "~/.ssh/id_ed25519");
      if (!selected) return;
      form.setKeyPath(selected.trim());
      form.setUsePrivKey(true);
      handleAuthRadio("privatekey");
    } catch (err) {
      form.setSaveError(form.t("sessionEditor2.errKeyChooser", { error: String(err) }));
    }
  };

  const handleBrowseFileTarget = async () => {
    form.setSaveError(null);
    try {
      const selected = await selectFilePath(form.host || undefined);
      if (selected) form.setHost(selected.trim());
    } catch (err) {
      form.setSaveError(form.t("sessionEditor2.errFileChooser", { error: String(err) }));
    }
  };

  const handleBrowseFolderTarget = async () => {
    form.setSaveError(null);
    try {
      const selected = await selectFolderPath(form.host || undefined);
      if (selected) form.setHost(selected.trim());
    } catch (err) {
      form.setSaveError(form.t("sessionEditor2.errFolderChooser", { error: String(err) }));
    }
  };

  const handleBrowseMailSaveDirectory = async () => {
    form.setSaveError(null);
    try {
      const selected = await selectFolderPath(form.mailForm.mailSaveDirectory || undefined);
      if (selected) form.mailForm.setMailSaveDirectory(selected.trim());
    } catch (err) {
      form.setSaveError(`Failed to choose mail save directory: ${String(err)}`);
    }
  };

  const handleMailOAuthConnect = createHandleMailOAuthConnect({
    setMailOauthStatus: form.mailForm.setMailOauthStatus,
    mailProvider: form.mailForm.mailProvider,
    mailOauthFlow: form.mailForm.mailOauthFlow,
    username: form.username,
    mailOauthClientId: form.mailForm.mailOauthClientId,
    mailOauthClientSecret: form.mailForm.mailOauthClientSecret,
    mailOauthClientSecretRef: form.mailForm.mailOauthClientSecretRef,
    t: form.t,
    setMailOauthConnecting: form.mailForm.setMailOauthConnecting,
    setMailOauthDeviceInfo: form.mailForm.setMailOauthDeviceInfo,
    session,
    networkSettings: form.networkSettings,
    setMailAuthMode: form.mailForm.setMailAuthMode,
    setMailOauthTokenRef: form.mailForm.setMailOauthTokenRef,
    setMailOauthExpiresAt: form.mailForm.setMailOauthExpiresAt,
    setMailOauthScope: form.mailForm.setMailOauthScope,
  });

  const handleNewFolder = createHandleNewFolder({
    t: form.t,
    groupPath: form.groupPath,
    setGroupPath: form.setGroupPath,
    createFolderPath: form.createFolderPath,
  });

  const handleDelete = createHandleDelete({
    session,
    t: form.t,
    removeSession: form.removeSession,
    onClose,
  });

  const handleTestConnection = createHandleTestConnection({
    host: form.host,
    username: form.username,
    presentTestOutcome: form.presentTestOutcome,
    t: form.t,
    password: form.password,
    passwordRef: form.passwordRef,
    authMethod: form.authMethod,
    compression: form.compression,
    setTesting: form.setTesting,
    setTestResult: form.setTestResult,
    keyPath: form.keyPath,
    port: form.port,
    networkSettings: form.networkSettings,
  });

  /** Build a one-shot `DbConnectInfo` from the current editor state. The
   *  password prefers the freshly-typed plaintext, falling back to a saved
   *  vault reference (resolved server-side). */
  const buildDbConnectInfo = createBuildDbConnectInfo({
    session,
    proto: form.proto,
    host: form.host,
    port: form.port,
    username: form.username,
    password: form.password,
    passwordRef: form.passwordRef,
    dbCatalog: form.databaseForm.dbCatalog,
    dbDatabase: form.databaseForm.dbDatabase,
    dbSsl: form.databaseForm.dbSsl,
    dbTimeout: form.databaseForm.dbTimeout,
    dbHttpPort: form.databaseForm.dbHttpPort,
    dbChProtocol: form.databaseForm.dbChProtocol,
    dbPrestoDialect: form.databaseForm.dbPrestoDialect,
    dbRedisIndex: form.databaseForm.dbRedisIndex,
    networkSettings: form.networkSettings,
  });

  const buildHBaseConnectInfo = createBuildHBaseConnectInfo({
    session,
    host: form.host,
    port: form.port,
    username: form.username,
    password: form.password,
    passwordRef: form.passwordRef,
    dbSsl: form.databaseForm.dbSsl,
    dbTimeout: form.databaseForm.dbTimeout,
    hbaseRestPath: form.databaseForm.hbaseRestPath,
    hbaseNamespace: form.databaseForm.hbaseNamespace,
    hbaseConnectionMode: form.databaseForm.hbaseConnectionMode,
    hbaseZkQuorum: form.databaseForm.hbaseZkQuorum,
    hbaseZkRoot: form.databaseForm.hbaseZkRoot,
    hbaseEffectiveUser: form.databaseForm.hbaseEffectiveUser,
    hbaseAuthMethod: form.databaseForm.hbaseAuthMethod,
    hbaseServicePrincipal: form.databaseForm.hbaseServicePrincipal,
    hbasePrincipal: form.databaseForm.hbasePrincipal,
    hbaseKeytabPath: form.databaseForm.hbaseKeytabPath,
    hbaseKrb5ConfPath: form.databaseForm.hbaseKrb5ConfPath,
    hbaseSitePath: form.databaseForm.hbaseSitePath,
  });

  const handleTestDbConnection = createHandleTestDbConnection({
    host: form.host,
    presentTestOutcome: form.presentTestOutcome,
    t: form.t,
    proto: form.proto,
    dbCatalog: form.databaseForm.dbCatalog,
    setTesting: form.setTesting,
    setTestResult: form.setTestResult,
    buildDbConnectInfo,
  });

  const handleTestHBaseConnection = createHandleTestHBaseConnection({
    hbaseConnectionMode: form.databaseForm.hbaseConnectionMode,
    host: form.host,
    presentTestOutcome: form.presentTestOutcome,
    hbaseSitePath: form.databaseForm.hbaseSitePath,
    hbaseZkQuorum: form.databaseForm.hbaseZkQuorum,
    setTesting: form.setTesting,
    setTestResult: form.setTestResult,
    buildHBaseConnectInfo,
  });

  const handleTestProxyConnection = createHandleTestProxyConnection({
    host: form.host,
    presentTestOutcome: form.presentTestOutcome,
    t: form.t,
    setTesting: form.setTesting,
    setTestResult: form.setTestResult,
    proxyTestUrl: form.proxyTestUrl,
    proxyKind: form.proxyKind,
    port: form.port,
    username: form.username,
    password: form.password,
    passwordRef: form.passwordRef,
  });

  const handleSaveAsProxySession = createHandleSaveAsProxySession({
    networkSettings: form.networkSettings,
    setTestResult: form.setTestResult,
    t: form.t,
    addSession: form.addSession,
  });
  return {
    handleTestConnection,
    handleTestDbConnection,
    handleTestHBaseConnection,
    handleTestProxyConnection,
    handleSave,
    handleProtoChange,
    handleHostPaste,
    handleHostLookup,
    handleBrowseFolderTarget,
    handleBrowseFileTarget,
    handleAuthRadio,
    handleBrowseKey,
    handleMailProviderChange,
    handleMailOAuthConnect,
    handleBrowseMailSaveDirectory,
    handleSaveAsProxySession,
    handleNewFolder,
    handleSaveTemplate,
    handleReset,
    handleDelete,
  };
}
