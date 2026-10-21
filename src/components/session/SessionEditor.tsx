import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useModalShortcuts, getShortcutSuffixes } from "../../hooks/useModalShortcuts";
import { X, Terminal as TerminalIcon, Monitor, Folder, Wifi, Bookmark, Shield, FlaskConical, FileText, Cloud, Save, RotateCcw, Network, HelpCircle, Database, Mail, Palette } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import { selectFilePath, selectFolderPath, selectPrivateKeyFile } from "../../lib/ipc";
import { DEFAULT_NETWORK_SETTINGS, getSessionNetworkSettings, type NetworkSettings as NetworkSettingsValue } from "../../lib/networkSettings";
import { parseSshConnectionCommand, parseUserHostPort } from "../../lib/quickConnect";
import { SESSION_ROOT_LABEL, collectFolderPaths, folderOptionLabel, toStoredGroupPath } from "../../lib/sessionPaths";
import { alertAppDialog } from "../../lib/appDialogs";
import type { SessionConfig } from "../../lib/ipc";
import { SYSTEM_TERMINAL_THEME, parseSessionOptions, type TerminalProfile } from "../../lib/terminalProfile";
import { supportsTerminalAppearanceSessionType } from "../../lib/sessionTerminalTheme";
import { parseRdpOptions, type RdpOptions } from "../../types/rdp";
import { RdpOptionsForm } from "./forms/RdpOptionsForm";
import { ObjectStorageSettings, ossFormFromOptions, type OssFormState } from "./ObjectStorageSettings";
import { WslOptionsForm } from "./forms/WslOptionsForm";
import { LocalShellOptionsForm } from "./forms/LocalShellOptionsForm";
import { MailAppearanceSettings } from "../mail/MailAppearanceSettings";
import { useT } from "../../lib/i18n";
import { normalizeVncScaling, VNC_SCALE_PERCENTAGES } from "../../lib/vnc";
import { parseVncViewerOptions, type VncViewerOptions } from "../../lib/vncOptions";
import { PathMappingsEditor, parsePathMappings as parsePathMappingsFromOptions } from "../filebrowser/PathMappingsEditor";
import type { SftpPathMapping } from "../../types";
import { sessionTypeToProto, type Proto, type SectionTab, DEFAULT_PORTS, optionString, extractAuthType, extractKeyPath, optionBoolean, initialTerminalProfileForProto, DB_PROTOS, PLANNED_CLIENT_PROTOS, protoToSessionType, defaultTerminalProfileForProto, cloneNetworkSettings, PROTOS } from "./editor/sessionPolicy";
import { type MailProvider, defaultMailOAuthFlow, MAIL_PROVIDER_PRESETS } from "./editor/mailPolicy";
import { Field, Select } from "./editor/Fields";
import { AdvancedSshSettings } from "./editor/SshSettings";
import { TerminalSettings } from "./editor/TerminalSettings";
import { MailSettings } from "./editor/MailSettings";
import { DatabaseSettings } from "./editor/DatabaseSettings";
import { HBaseSettings } from "./editor/HBaseSettings";
import { NetworkSettings, DbNetworkSettings } from "./editor/NetworkSettings";
import { BookmarkSettings } from "./editor/BookmarkSettings";
import { SessionConnectionFields } from "./editor/SessionConnectionFields";
import { createHandleSave, createHandleSaveTemplate, createHandleNewFolder, createHandleDelete, createHandleSaveAsProxySession } from "./editor/persistenceActions";
import { createHandleMailOAuthConnect } from "./editor/mailAuthentication";
import { createHandleTestConnection, createBuildDbConnectInfo, createBuildHBaseConnectInfo, createHandleTestDbConnection, createHandleTestHBaseConnection, createHandleTestProxyConnection } from "./editor/connectionProbes";
import { useMailSessionForm } from "./editor/useMailSessionForm";
import { useLocalShellForm } from "./editor/useLocalShellForm";
import { useDatabaseSessionForm } from "./editor/useDatabaseSessionForm";
import { createSessionSerialization } from "./editor/serialization";
import { createSessionReset } from "./editor/reset";









/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
interface SessionEditorProps {
  session?: SessionConfig;
  defaultGroupPath?: string | null;
  /**
   * Pre-select the protocol when creating a *new* session (no `session`
   * prop). Accepts a session-type string (e.g. `"SFTP"`, `"SSH"`); falls
   * back to SSH if unrecognized. Ignored when editing an existing session.
   */
  initialProto?: string;
  onClose: () => void;
}









export function SessionEditor({ session, defaultGroupPath = null, initialProto, onClose }: SessionEditorProps) {
  const t = useT();
  const { addSession, updateSession, removeSession, createFolderPath, sessions, groups } = useSessionStore();
  const isEdit = !!session;

  const initialOptions = useMemo(() => parseSessionOptions(session?.options_json), [session?.options_json]);
  const initialProtoValue = session
    ? sessionTypeToProto(session.session_type, session.options_json)
    : sessionTypeToProto(initialProto);

  /* --- core fields --- */
  const [proto, setProto] = useState<Proto>(initialProtoValue);
  const [section, setSection] = useState<SectionTab>("advanced");
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(
    String(session?.port ?? DEFAULT_PORTS[initialProtoValue] ?? 22),
  );
  const initialUsername = initialProtoValue === "Mail"
    ? session?.username ?? optionString(initialOptions, "mailEmailAddress", "")
    : session?.username ?? "";
  const [username, setUsername] = useState(initialUsername);
  const [specifyUser, setSpecifyUser] = useState(!!initialUsername || initialProtoValue === "Mail");
  const [groupPath, setGroupPath] = useState(
    toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "",
  );

  /* --- auth --- */
  const [authMethod, setAuthMethod] = useState(
    extractAuthType(session?.auth_method),
  );
  const [authRadio, setAuthRadio] = useState<string>(() => {
    const t = extractAuthType(session?.auth_method);
    if (t === "PrivateKey") return "privatekey";
    if (t === "Agent") return "agent";
    if (t === "None") return "gssapi";
    return "password";
  });
  const [keyPath, setKeyPath] = useState(
    extractKeyPath(session?.auth_method),
  );
  const [password, setPassword] = useState("");
  const [passwordRef, setPasswordRef] = useState<string>(
    () => optionString(initialOptions, "passwordRef", ""),
  );
  const [saveInVault, setSaveInVault] = useState<boolean>(
    () => !!passwordRef || initialProtoValue === "Mail",
  );
  const vaultState = useVaultStore((s) => s.state);

  /* --- advanced SSH --- */
  const [x11, setX11] = useState(() => optionBoolean(initialOptions, "x11", true));
  const [x11Trusted, setX11Trusted] = useState(() => optionBoolean(initialOptions, "x11Trusted", true));
  const [compression, setCompression] = useState(() => optionBoolean(initialOptions, "compression", false));
  const [startupCmd, setStartupCmd] = useState(() => optionString(initialOptions, "startupCmd", ""));
  const [doNotExit, setDoNotExit] = useState(() => optionBoolean(initialOptions, "doNotExit", true));
  const [remoteEnv, setRemoteEnv] = useState(() => optionString(initialOptions, "remoteEnv", "Interactive shell"));
  const [sshBrowser, setSshBrowser] = useState(() => optionString(initialOptions, "sshBrowser", "SFTP protocol (recommended)"));
  const [usePrivKey, setUsePrivKey] = useState(
    extractAuthType(session?.auth_method) === "PrivateKey",
  );

  /* --- bookmark --- */
  const [description, setDescription] = useState(() => optionString(initialOptions, "description", ""));
  const [tags, setTags] = useState(() => optionString(initialOptions, "tags", ""));
  /* --- AI safety --- */
  const [disableAiWrite, setDisableAiWrite] = useState(() => optionBoolean(initialOptions, "disableAiWrite", false));

  /* --- vault refresh on mount so the Save in vault checkbox state is correct --- */
  const refreshVault = useVaultStore((s) => s.refresh);
  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  /* --- file session options --- */
  const [fileEmbedInTab, setFileEmbedInTab] = useState(() => optionBoolean(initialOptions, "fileEmbedInTab", true));
  const [fileExtraArgs, setFileExtraArgs] = useState(() => optionString(initialOptions, "fileExtraArgs", ""));
  const databaseForm = useDatabaseSessionForm({
    initialOptions,
    session,
  });

  /* --- proxy session options --- */
  const [proxyKind, setProxyKind] = useState<"http" | "socks5">(() => {
    const v = optionString(initialOptions, "proxyKind", "http");
    return v === "socks5" ? "socks5" : "http";
  });
  const [proxyTestUrl, setProxyTestUrl] = useState(() => optionString(initialOptions, "testUrl", "www.google.com:443"));
  const mailForm = useMailSessionForm({
    initialOptions,
    session,
    initialProtoValue,
  });

  /* --- terminal profile --- */
  const [terminalProfile, setTerminalProfile] = useState<TerminalProfile>(() =>
    initialTerminalProfileForProto(session?.options_json, initialProtoValue),
  );

  /* --- serial client options --- */
  const [serialDevice, setSerialDevice] = useState(() =>
    session?.session_type === "Serial" ? session.host : optionString(initialOptions, "serialDevice", ""),
  );
  const [serialBaud, setSerialBaud] = useState(() =>
    optionString(initialOptions, "serialBaud", "115200"),
  );
  const shellForm = useLocalShellForm({
    session,
    proto,
  });

  /* --- RDP options --- */
  const [rdpOptions, setRdpOptions] = useState<RdpOptions>(() =>
    parseRdpOptions(session?.options_json),
  );

  /* --- VNC production policies --- */
  const [vncSecurityPolicy, setVncSecurityPolicy] = useState<
    "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" | "prefer-off"
  >(() => {
    const value = optionString(initialOptions, "vncSecurityPolicy", "prefer-encryption");
    return value === "require-encryption" || value === "legacy-compatible" || value === "allow-none"
      || value === "prefer-off"
      ? value
      : "prefer-encryption";
  });
  // VNC-CONN-001: RealVNC Options, saved as flat vnc* keys (vncOptions.ts).
  const [vncViewer, setVncViewer] = useState<VncViewerOptions>(() => parseVncViewerOptions(initialOptions));
  const [vncViewOnly, setVncViewOnly] = useState(() => optionBoolean(initialOptions, "vncViewOnly", false));
  const [vncClipboardPolicy, setVncClipboardPolicy] = useState<
    "disabled" | "client-to-server" | "server-to-client" | "bidirectional"
  >(() => {
    const value = optionString(initialOptions, "vncClipboardPolicy", "bidirectional");
    return value === "disabled" || value === "client-to-server" || value === "server-to-client"
      ? value
      : "bidirectional";
  });

  /* --- SFTP path mappings --- */
  const [pathMappings, setPathMappings] = useState<SftpPathMapping[]>(() =>
    parsePathMappingsFromOptions(session?.options_json),
  );

  /* --- object storage (S3 / Azure Blob) --- */
  const [oss, setOss] = useState<OssFormState>(() => ossFormFromOptions(session?.options_json));

  /* --- network settings --- */
  const [networkSettings, setNetworkSettings] = useState<NetworkSettingsValue>(
    () => getSessionNetworkSettings(session?.options_json),
  );

  /* --- test connection --- */
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Footer short status + modal with the full success / error text (errors often overflow the footer). */
  const presentTestOutcome = (ok: boolean, rawMessage: string) => {
    let message = rawMessage.trimEnd();
    if (!message) {
      message = ok ? t("sessionEditor2.testConnection") : t("sessionEditor2.testFailedTitle");
    } else if (!ok && /:\s*$/.test(message)) {
      // e.g. "Presto error (502 Bad Gateway): " with an empty HTTP body
      message = `${message}\n\n${t("sessionEditor2.testEmptyDetail")}`;
    }
    setTestResult({ ok, msg: message });
    void alertAppDialog({
      title: ok ? t("sessionEditor2.testSuccessTitle") : t("sessionEditor2.testFailedTitle"),
      message,
      okLabel: t("sessionEditor2.ok"),
      tone: ok ? "success" : "error",
    });
  };

  /* --- derived --- */
  const needsHost = !["Serial", "File", "Shell", "WSL", "HBaseShell", "S3"].includes(proto);
  const isSSH = ["SSH", "SFTP"].includes(proto);
  const isRdp = proto === "RDP";
  const isDb = DB_PROTOS.includes(proto);
  const isHBase = proto === "HBaseShell";
  const isProxy = proto === "Proxy";
  const isMail = proto === "Mail";
  const isObjectStorage = proto === "S3";
  const isPlannedClient = PLANNED_CLIENT_PROTOS.has(proto);
  const supportsTerminalAppearance = supportsTerminalAppearanceSessionType(protoToSessionType(proto));
  const folderOptions = useMemo(() => {
    const options = new Set<string>([
      SESSION_ROOT_LABEL,
      "User sessions / Production",
      "User sessions / Development",
      "User sessions / Quick & local",
    ]);

    for (const path of collectFolderPaths(sessions, groups)) {
      options.add(folderOptionLabel(path));
    }

    if (groupPath) {
      options.add(folderOptionLabel(groupPath));
    }

    return [...options].sort((a, b) => {
      if (a === SESSION_ROOT_LABEL) return -1;
      if (b === SESSION_ROOT_LABEL) return 1;
      return a.localeCompare(b);
    });
  }, [groupPath, groups, sessions]);

  const handleProtoChange = (p: Proto) => {
    setProto(p);
    setPort(String(DEFAULT_PORTS[p] ?? 22));
    // For File proto only the Bookmark sub-tab is meaningful; jump there so
    // the user lands on the relevant content.
    if (p === "File") setSection("bookmark");
    // Data-client protos open straight to the dedicated settings tab.
    if (DB_PROTOS.includes(p) || p === "HBaseShell") setSection("database");
    // Proxy proto opens to its settings tab.
    if (p === "Proxy") setSection("proxy");
    if (p === "Mail") {
      setSection("mail");
      setSpecifyUser(true);
      setSaveInVault(true);
      mailForm.setMailSmtpSaveInVault(true);
      setTerminalProfile((current) => ({ ...current, theme: SYSTEM_TERMINAL_THEME }));
    } else {
      setTerminalProfile((current) => current.theme === SYSTEM_TERMINAL_THEME
        ? { ...current, theme: defaultTerminalProfileForProto(p).theme }
        : current);
    }
    // Object storage opens straight to its settings tab.
    if (p === "S3") setSection("objectstorage");
  };

  const handleMailProviderChange = (provider: MailProvider) => {
    mailForm.setMailProvider(provider);
    mailForm.setMailAuthMode(provider === "custom" ? "password" : "oauth2");
    mailForm.setMailOauthFlow(defaultMailOAuthFlow(provider));
    mailForm.setMailOauthDeviceInfo(null);
    mailForm.setMailOauthStatus(null);
    const preset = MAIL_PROVIDER_PRESETS[provider];
    if (!preset) return;

    setHost(preset.imapHost);
    setPort(preset.imapPort);
    mailForm.setMailImapSecurity(preset.imapSecurity);
    mailForm.setMailSmtpHost(preset.smtpHost);
    mailForm.setMailSmtpPort(preset.smtpPort);
    mailForm.setMailSmtpSecurity(preset.smtpSecurity);
    mailForm.setMailSmtpUseImapAuth(preset.smtpUseImapAuth);
  };

  /* Keep authMethod in sync with the radio group */
  const handleAuthRadio = (v: string) => {
    setAuthRadio(v);
    if (v === "password") {
      setAuthMethod("Password");
      setUsePrivKey(false);
    } else if (v === "privatekey") {
      setAuthMethod("PrivateKey");
      setUsePrivKey(true);
    } else if (v === "agent") {
      setAuthMethod("Agent");
      setUsePrivKey(false);
    } else {
      setAuthMethod("None");
      setUsePrivKey(false);
    }
  };
  const { validate, buildConfig, buildOptionsJson } = createSessionSerialization({
    passwordRef,
    networkSettings,
    mailForm,
    session,
    supportsTerminalAppearance,
    isMail,
    proto,
    shellForm,
    serialDevice,
    serialBaud,
    rdpOptions,
    vncSecurityPolicy,
    vncViewOnly,
    vncClipboardPolicy,
    vncViewer,
    isDb,
    databaseForm,
    isProxy,
    proxyKind,
    proxyTestUrl,
    oss,
    isHBase,
    terminalProfile,
    x11,
    x11Trusted,
    compression,
    startupCmd,
    description,
    tags,
    doNotExit,
    disableAiWrite,
    remoteEnv,
    sshBrowser,
    usePrivKey,
    fileEmbedInTab,
    fileExtraArgs,
    pathMappings,
    authMethod,
    keyPath,
    name,
    t,
    username,
    host,
    port,
    groupPath,
    needsHost,
    saveInVault,
    password,
    isSSH,
    specifyUser,
  });

  const handleSave = createHandleSave({
    validate,
    setSaveError,
    passwordRef,
    isSSH,
    isDb,
    isHBase,
    proto,
    isProxy,
    isMail,
    authMethod,
    mailAuthMode: mailForm.mailAuthMode,
    saveInVault,
    password,
    t,
    username,
    host,
    port,
    setPasswordRef,
    setPassword,
    networkSettings,
    setNetworkSettings,
    mailSmtpPasswordRef: mailForm.mailSmtpPasswordRef,
    mailSmtpUseImapAuth: mailForm.mailSmtpUseImapAuth,
    mailSmtpSaveInVault: mailForm.mailSmtpSaveInVault,
    mailSmtpPassword: mailForm.mailSmtpPassword,
    mailSmtpUsername: mailForm.mailSmtpUsername,
    mailSmtpHost: mailForm.mailSmtpHost,
    mailSmtpPort: mailForm.mailSmtpPort,
    setMailSmtpPasswordRef: mailForm.setMailSmtpPasswordRef,
    setMailSmtpPassword: mailForm.setMailSmtpPassword,
    mailOauthClientSecretRef: mailForm.mailOauthClientSecretRef,
    mailProvider: mailForm.mailProvider,
    mailOauthFlow: mailForm.mailOauthFlow,
    setMailOauthClientSecretRef: mailForm.setMailOauthClientSecretRef,
    setMailOauthClientSecret: mailForm.setMailOauthClientSecret,
    mailOauthClientSecretSaveInVault: mailForm.mailOauthClientSecretSaveInVault,
    mailOauthClientSecret: mailForm.mailOauthClientSecret,
    oss,
    setOss,
    buildConfig,
    buildOptionsJson,
    mailOauthTokenRef: mailForm.mailOauthTokenRef,
    mailOauthExpiresAt: mailForm.mailOauthExpiresAt,
    mailOauthScope: mailForm.mailOauthScope,
    isEdit,
    updateSession,
    addSession,
    onClose,
  });

  const handleSaveTemplate = createHandleSaveTemplate({
    validate,
    setSaveError,
    buildConfig,
    t,
    name,
    host,
    proto,
    addSession,
    setTestResult,
  });
  const { handleReset } = createSessionReset({
    session,
    setProto,
    setSection,
    setName,
    setHost,
    setPort,
    setUsername,
    setSpecifyUser,
    setGroupPath,
    defaultGroupPath,
    setAuthMethod,
    setAuthRadio,
    setKeyPath,
    setPassword,
    setPasswordRef,
    setSaveInVault,
    setX11,
    setX11Trusted,
    setCompression,
    setStartupCmd,
    setDoNotExit,
    setDisableAiWrite,
    setRemoteEnv,
    setSshBrowser,
    setUsePrivKey,
    setDescription,
    setTags,
    setFileEmbedInTab,
    setFileExtraArgs,
    databaseForm,
    setTerminalProfile,
    setNetworkSettings,
    setSerialDevice,
    setSerialBaud,
    shellForm,
    setRdpOptions,
    setVncSecurityPolicy,
    setVncViewOnly,
    setVncViewer,
    setVncClipboardPolicy,
    setPathMappings,
    mailForm,
    setOss,
    setSaveError,
    setTestResult,
  });

  const applySshCommandText = (value: string): boolean => {
    const parsed = parseSshConnectionCommand(value);
    if (!parsed) return false;

    setProto("SSH");
    setSection("advanced");
    setHost(parsed.host);
    setPort(String(parsed.port || DEFAULT_PORTS.SSH));
    setUsername(parsed.username ?? "");
    setSpecifyUser(!!parsed.username);
    setName((current) => current || `ssh://${parsed.username ? `${parsed.username}@` : ""}${parsed.host}:${parsed.port || DEFAULT_PORTS.SSH}`);
    setPassword("");
    setPasswordRef("");
    setSaveInVault(false);
    setX11(parsed.options.x11);
    setX11Trusted(parsed.options.x11Trusted);
    setCompression(parsed.options.compression ?? false);
    setStartupCmd(parsed.options.startupCmd ?? "");
    setDoNotExit(parsed.options.doNotExit ?? true);
    setRemoteEnv("Interactive shell");
    if (parsed.keyPath) {
      setAuthMethod("PrivateKey");
      setAuthRadio("privatekey");
      setUsePrivKey(true);
      setKeyPath(parsed.keyPath);
    } else {
      setAuthMethod("Password");
      setAuthRadio("password");
      setUsePrivKey(false);
      setKeyPath("");
    }
    setNetworkSettings(cloneNetworkSettings(parsed.options.networkSettings ?? DEFAULT_NETWORK_SETTINGS));
    setSaveError(null);
    setTestResult({ ok: true, msg: t("sessionEditor2.sshCommandImported") });
    return true;
  };

  const handleHostLookup = () => {
    if (applySshCommandText(host)) return;

    let parsed: ReturnType<typeof parseUserHostPort> = null;
    try {
      parsed = parseUserHostPort(host);
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    setHost(parsed.host);
    if (parsed.username) {
      setUsername(parsed.username);
      setSpecifyUser(true);
    }
    if (parsed.port) setPort(String(parsed.port));
  };

  const handleHostPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text || !applySshCommandText(text)) return;
    event.preventDefault();
  };

  const handleBrowseKey = async () => {
    setSaveError(null);
    try {
      const selected = await selectPrivateKeyFile(keyPath || "~/.ssh/id_ed25519");
      if (!selected) return;
      setKeyPath(selected.trim());
      setUsePrivKey(true);
      handleAuthRadio("privatekey");
    } catch (err) {
      setSaveError(t("sessionEditor2.errKeyChooser", { error: String(err) }));
    }
  };

  const handleBrowseFileTarget = async () => {
    setSaveError(null);
    try {
      const selected = await selectFilePath(host || undefined);
      if (selected) setHost(selected.trim());
    } catch (err) {
      setSaveError(t("sessionEditor2.errFileChooser", { error: String(err) }));
    }
  };

  const handleBrowseFolderTarget = async () => {
    setSaveError(null);
    try {
      const selected = await selectFolderPath(host || undefined);
      if (selected) setHost(selected.trim());
    } catch (err) {
      setSaveError(t("sessionEditor2.errFolderChooser", { error: String(err) }));
    }
  };

  const handleBrowseMailSaveDirectory = async () => {
    setSaveError(null);
    try {
      const selected = await selectFolderPath(mailForm.mailSaveDirectory || undefined);
      if (selected) mailForm.setMailSaveDirectory(selected.trim());
    } catch (err) {
      setSaveError(`Failed to choose mail save directory: ${String(err)}`);
    }
  };

  const handleMailOAuthConnect = createHandleMailOAuthConnect({
    setMailOauthStatus: mailForm.setMailOauthStatus,
    mailProvider: mailForm.mailProvider,
    mailOauthFlow: mailForm.mailOauthFlow,
    username,
    mailOauthClientId: mailForm.mailOauthClientId,
    mailOauthClientSecret: mailForm.mailOauthClientSecret,
    mailOauthClientSecretRef: mailForm.mailOauthClientSecretRef,
    t,
    setMailOauthConnecting: mailForm.setMailOauthConnecting,
    setMailOauthDeviceInfo: mailForm.setMailOauthDeviceInfo,
    session,
    networkSettings,
    setMailAuthMode: mailForm.setMailAuthMode,
    setMailOauthTokenRef: mailForm.setMailOauthTokenRef,
    setMailOauthExpiresAt: mailForm.setMailOauthExpiresAt,
    setMailOauthScope: mailForm.setMailOauthScope,
  });

  const handleNewFolder = createHandleNewFolder({
    t,
    groupPath,
    setGroupPath,
    createFolderPath,
  });

  const handleDelete = createHandleDelete({
    session,
    t,
    removeSession,
    onClose,
  });

  const handleTestConnection = createHandleTestConnection({
    host,
    username,
    presentTestOutcome,
    t,
    password,
    passwordRef,
    authMethod,
    setTesting,
    setTestResult,
    keyPath,
    port,
    networkSettings,
  });

  /** Build a one-shot `DbConnectInfo` from the current editor state. The
   *  password prefers the freshly-typed plaintext, falling back to a saved
   *  vault reference (resolved server-side). */
  const buildDbConnectInfo = createBuildDbConnectInfo({
    session,
    proto,
    host,
    port,
    username,
    password,
    passwordRef,
    dbCatalog: databaseForm.dbCatalog,
    dbDatabase: databaseForm.dbDatabase,
    dbSsl: databaseForm.dbSsl,
    dbTimeout: databaseForm.dbTimeout,
    dbHttpPort: databaseForm.dbHttpPort,
    dbChProtocol: databaseForm.dbChProtocol,
    dbPrestoDialect: databaseForm.dbPrestoDialect,
    dbRedisIndex: databaseForm.dbRedisIndex,
    networkSettings,
  });

  const buildHBaseConnectInfo = createBuildHBaseConnectInfo({
    session,
    host,
    port,
    username,
    password,
    passwordRef,
    dbSsl: databaseForm.dbSsl,
    dbTimeout: databaseForm.dbTimeout,
    hbaseRestPath: databaseForm.hbaseRestPath,
    hbaseNamespace: databaseForm.hbaseNamespace,
    hbaseConnectionMode: databaseForm.hbaseConnectionMode,
    hbaseZkQuorum: databaseForm.hbaseZkQuorum,
    hbaseZkRoot: databaseForm.hbaseZkRoot,
    hbaseEffectiveUser: databaseForm.hbaseEffectiveUser,
    hbaseAuthMethod: databaseForm.hbaseAuthMethod,
    hbaseServicePrincipal: databaseForm.hbaseServicePrincipal,
    hbasePrincipal: databaseForm.hbasePrincipal,
    hbaseKeytabPath: databaseForm.hbaseKeytabPath,
    hbaseKrb5ConfPath: databaseForm.hbaseKrb5ConfPath,
    hbaseSitePath: databaseForm.hbaseSitePath,
  });

  const handleTestDbConnection = createHandleTestDbConnection({
    host,
    presentTestOutcome,
    t,
    proto,
    dbCatalog: databaseForm.dbCatalog,
    setTesting,
    setTestResult,
    buildDbConnectInfo,
  });

  const handleTestHBaseConnection = createHandleTestHBaseConnection({
    hbaseConnectionMode: databaseForm.hbaseConnectionMode,
    host,
    presentTestOutcome,
    hbaseSitePath: databaseForm.hbaseSitePath,
    hbaseZkQuorum: databaseForm.hbaseZkQuorum,
    setTesting,
    setTestResult,
    buildHBaseConnectInfo,
  });

  const handleTestProxyConnection = createHandleTestProxyConnection({
    host,
    presentTestOutcome,
    t,
    setTesting,
    setTestResult,
    proxyTestUrl,
    proxyKind,
    port,
    username,
    password,
    passwordRef,
  });

  const handleSaveAsProxySession = createHandleSaveAsProxySession({
    networkSettings,
    setTestResult,
    t,
    addSession,
  });

  const sectionTabs: { id: SectionTab; label: string; icon: React.ReactNode }[] = proto === "File"
    ? [
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isProxy
    ? [
        { id: "proxy", label: t("sessionEditor2.proxyKindLabel"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isDb || isHBase
    ? [
        { id: "database", label: isHBase ? "HBase settings" : t("sessionEditor2.sectionDatabase"), icon: <Database className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        // DB engines can tunnel through a proxy / SSH jump host; HBase does not
        // (yet) route through the loopback forwarder, so no Network tab for it.
        ...(isDb
          ? [{ id: "network" as SectionTab, label: t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isObjectStorage
    ? [
        { id: "objectstorage", label: "Object storage", icon: <Cloud className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        // Object storage (HTTPS) can route through an HTTP/SOCKS5 proxy or an
        // SSH jump host, just like the DB engines.
        { id: "network", label: t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : isMail
    ? [
        { id: "mail", label: "Mail account", icon: <Mail className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "network", label: t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "appearance", label: "Appearance", icon: <Palette className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
    : [
        ...(isSSH
          ? [{ id: "advanced" as SectionTab, label: t("sessionEditor2.sectionAdvancedSsh"), icon: <Shield className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        // SFTP gets a dedicated path mappings tab
        ...(proto === "SFTP"
          ? [{ id: "mappings" as SectionTab, label: t("pathMappings.sectionTitle"), icon: <Folder className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : []),
        // RDP gets a dedicated options tab in place of the Terminal tab
        // (terminal appearance is meaningless for a graphical RDP session).
        ...(isRdp
          ? [{ id: "rdp" as SectionTab, label: t("rdp.options.title"), icon: <Monitor className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : proto === "VNC"
            ? [{ id: "vnc" as SectionTab, label: "VNC policies", icon: <Monitor className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
          : supportsTerminalAppearance
            ? [{ id: "terminal" as SectionTab, label: t("sessionEditor2.sectionTerminal"), icon: <TerminalIcon className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
            : []),
        { id: "network",  label: t("sessionEditor2.sectionNetwork"),  icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: t("sessionEditor2.sectionBookmark"),  icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ];

  const fallbackSection: SectionTab = isRdp
    ? "rdp"
    : proto === "VNC"
      ? "vnc"
    : supportsTerminalAppearance
      ? "terminal"
      : isSSH
        ? "advanced"
        : "network";

  /* If we switched away from SSH and were on the advanced tab, fall back.
   * Likewise default RDP to its own options tab and bounce non-RDP protos
   * off the rdp tab, and DB protos onto the database tab. */
  const activeSection =
    proto === "File"
      ? "bookmark"
      : isProxy
        ? (section === "proxy" || section === "bookmark" ? section : "proxy")
        : isObjectStorage
        ? (section === "objectstorage" || section === "bookmark" || section === "network" ? section : "objectstorage")
        : isMail
        ? (section === "mail" || section === "network" || section === "bookmark" || section === "appearance" ? section : "mail")
        : isDb || isHBase
        ? (section === "database" || section === "bookmark" || (isDb && section === "network") ? section : "database")
        : section === "advanced" && !isSSH
          ? fallbackSection
          : section === "rdp" && !isRdp
            ? fallbackSection
            : section === "vnc" && proto !== "VNC"
              ? fallbackSection
            : section === "mappings" && proto !== "SFTP"
              ? fallbackSection
              : section === "terminal" && !supportsTerminalAppearance
              ? fallbackSection
              : section === "database"
                ? fallbackSection
                : section === "appearance"
                  ? fallbackSection
                  : section;

  const { containerRef, handleRef } = useModalDraggableAndResizable({ minWidth: 600, minHeight: 400 });

  const handleShortcutTest = () => {
    if (testing) return;
    if (isSSH && needsHost) {
      handleTestConnection();
    } else if (isDb) {
      void handleTestDbConnection();
    } else if (isHBase) {
      void handleTestHBaseConnection();
    } else if (isProxy) {
      void handleTestProxyConnection();
    }
  };

  useModalShortcuts({
    onCancel: onClose,
    onSave: () => {
      void handleSave();
    },
    onTest: handleShortcutTest,
  });

  const shortcuts = getShortcutSuffixes();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <div
        ref={containerRef}
        data-testid="session-editor"
        className="w-[1020px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-[6px] shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        {/* Modal title bar */}
        <div
          ref={handleRef}
          className="h-7 flex items-center px-2 rounded-t-[5px] shrink-0 select-none"
          style={{
            background: "linear-gradient(to bottom,#5895c8,#2b5d8b)",
            color: "white",
          }}
        >
          <Bookmark className="w-3.5 h-3.5 mr-1.5" />
          <div className="text-[12px] font-semibold">
            {isEdit ? t("sessionEditor2.titleEdit") : t("sessionEditor2.titleNew")}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] opacity-95">
            <button
              data-testid="session-help"
              title={t("sessionEditor2.helpTitle")}
              className="hover:bg-white/15 rounded p-0.5"
              onClick={() => setTestResult({ ok: true, msg: t("sessionEditor2.helpMessage") })}
              type="button"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
            <button
              data-testid="session-close"
              title={t("sessionEditor2.closeTitle")}
              className="hover:bg-red-500 rounded p-0.5"
              onClick={onClose}
              type="button"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Protocol picker */}
        <div
          className="max-h-[min(210px,32vh)] overflow-y-auto overscroll-contain px-3 pt-3 pb-2 border-b shrink-0 taomni-scroll-y"
          style={{ borderColor: "var(--taomni-divider)" }}
        >
          <div className="flex flex-wrap gap-1">
            {PROTOS.map((p) => (
              <button
                key={p.id}
                data-testid={`session-proto-${p.id.toLowerCase()}`}
                className="taomni-proto-btn"
                data-active={proto === p.id}
                data-client-status={PLANNED_CLIENT_PROTOS.has(p.id) ? "planned" : "active"}
                title={PLANNED_CLIENT_PROTOS.has(p.id) ? t("sessionEditor2.plannedClientTitle", { proto: p.id }) : p.id}
                onClick={() => handleProtoChange(p.id)}
                type="button"
              >
                <span
                  style={{
                    color: proto === p.id ? "var(--taomni-accent)" : p.color,
                  }}
                >
                  {p.icon}
                </span>
                <span>{p.id}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Basic settings (blue header) */}
        {needsHost && !isMail && (
          <SessionConnectionFields
  t={t}
  proto={proto}
  host={host}
  setHost={setHost}
  handleHostPaste={handleHostPaste}
  handleHostLookup={handleHostLookup}
  specifyUser={specifyUser}
  setSpecifyUser={setSpecifyUser}
  username={username}
  setUsername={setUsername}
  port={port}
  setPort={setPort}
  isProxy={isProxy}
  isMail={isMail}
  password={password}
  passwordRef={passwordRef}
  setPassword={setPassword}
  setPasswordRef={setPasswordRef}
  vaultState={vaultState}
  saveInVault={saveInVault}
  setSaveInVault={setSaveInVault}
/>
        )}

        {isPlannedClient && (
          <div
            data-testid="session-planned-client-note"
            className="mx-4 mt-3 px-3 py-2 rounded border text-[12px]"
            style={{
              borderColor: "var(--taomni-input-border)",
              background: "var(--taomni-panel-bg)",
              color: "var(--taomni-text-muted)",
            }}
          >
            {t("sessionEditor2.plannedClientNote", { proto })}
          </div>
        )}

        {/* Basic Serial settings — appears for the Serial protocol only */}
        {proto === "Serial" && (
          <div
            data-testid="session-serial-section"
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <Wifi className="w-3.5 h-3.5" />
              {t("sessionEditor2.basicSerialTitle")}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right" htmlFor="session-serial-device">
                {t("sessionEditor2.serialDeviceLabel")}
              </label>
              <input
                id="session-serial-device"
                data-testid="session-serial-device"
                className="taomni-input col-span-5"
                value={serialDevice}
                onChange={(e) => setSerialDevice(e.target.value)}
                aria-label={t("sessionEditor2.serialDeviceLabel")}
                placeholder={t("sessionEditor2.serialDevicePlaceholder")}
              />
              <label className="col-span-2 text-[12px] text-right" htmlFor="session-serial-baud">
                {t("sessionEditor2.serialBaudLabel")}
              </label>
              <input
                id="session-serial-baud"
                data-testid="session-serial-baud"
                className="taomni-input col-span-3"
                value={serialBaud}
                inputMode="numeric"
                onChange={(e) => setSerialBaud(e.target.value)}
                aria-label={t("sessionEditor2.serialBaudLabel")}
                placeholder="115200"
              />
              <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)]">
                {t("sessionEditor2.serialHint")}
              </div>
            </div>
          </div>
        )}

        {/* Basic File settings — appears for the File protocol only */}
        {proto === "File" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <FileText className="w-3.5 h-3.5" />
              {t("sessionEditor2.basicFileTitle")}
            </div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <label className="col-span-2 text-[12px] text-right">
                {t("sessionEditor2.fileTargetLabel")}
              </label>
              <div className="col-span-10 flex items-center gap-1">
                <input
                  data-testid="session-file-target"
                  className="taomni-input flex-1"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  aria-label={t("sessionEditor2.fileTargetAria")}
                  placeholder={t("sessionEditor2.fileTargetPlaceholder")}
                />
                <button
                  title={t("sessionEditor2.browseFolder")}
                  className="taomni-btn px-2"
                  onClick={() => void handleBrowseFolderTarget()}
                  type="button"
                >
                  <Folder className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
                <button
                  title={t("sessionEditor2.browseFile")}
                  className="taomni-btn px-2"
                  onClick={() => void handleBrowseFileTarget()}
                  type="button"
                >
                  <FileText className="w-3.5 h-3.5 inline -mt-0.5" />
                </button>
              </div>
              <div className="col-span-12 text-[11px] text-[var(--taomni-text-muted)]">
                {t("sessionEditor2.fileTargetHint")}
              </div>
            </div>
          </div>
        )}

        {/* Basic Shell settings - appears for the local Shell protocol only */}
        {proto === "Shell" && (
          <div
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {t("sessionEditor2.localShellTitle")}
            </div>
            <LocalShellOptionsForm
              options={shellForm.localShellOptions}
              shells={shellForm.localShells}
              status={shellForm.localShellStatus}
              onChange={shellForm.setLocalShellOptions}
            />
          </div>
        )}

        {/* Basic WSL settings — appears for the WSL protocol only */}
        {proto === "WSL" && (
          <div
            data-testid="session-wsl-section"
            className="px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          >
            <div
              className="text-[12px] font-semibold mb-2 flex items-center gap-2"
              style={{ color: "var(--taomni-accent)" }}
            >
              <TerminalIcon className="w-3.5 h-3.5" />
              {t("wsl.options.title")}
            </div>
            <WslOptionsForm
              options={shellForm.wslOptions}
              distros={shellForm.wslDistros}
              status={shellForm.wslStatus}
              onChange={shellForm.setWslOptions}
            />
          </div>
        )}

        {/* Section tabs */}
        <div className="px-3 pt-2 flex shrink-0" style={{ background: "transparent" }}>
          {sectionTabs.map((t) => (
            <button
              key={t.id}
              data-testid={`session-section-${t.id}`}
              className="taomni-section-tab"
              data-active={activeSection === t.id}
              onClick={() => setSection(t.id)}
              type="button"
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <div className="flex-1 border-b" style={{ borderColor: "var(--taomni-input-border)" }} />
        </div>

        {/* Section body */}
        <div
          className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x border-b"
          style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}
        >
          {activeSection === "mappings" && proto === "SFTP" && (
            <div data-testid="session-sftp-mappings-section" className="flex flex-col gap-3">
              <div className="text-[12px] text-[var(--taomni-text-muted)]">
                {t("pathMappings.sectionDescription")}
              </div>
              <PathMappingsEditor
                mappings={pathMappings}
                onChange={setPathMappings}
                canBrowseLocal
                onBrowseLocal={async (_index, current) => {
                  const { selectFolderPath } = await import("../../lib/ipc");
                  try {
                    const result = await selectFolderPath(current || undefined);
                    return result ?? null;
                  } catch {
                    return null;
                  }
                }}
              />
            </div>
          )}

          {activeSection === "advanced" && isSSH && (
            <AdvancedSshSettings
              t={t}
              x11={x11} setX11={setX11}
              x11Trusted={x11Trusted} setX11Trusted={setX11Trusted}
              compression={compression} setCompression={setCompression}
              startupCmd={startupCmd} setStartupCmd={setStartupCmd}
              doNotExit={doNotExit} setDoNotExit={setDoNotExit}
              remoteEnv={remoteEnv} setRemoteEnv={setRemoteEnv}
              sshBrowser={sshBrowser} setSshBrowser={setSshBrowser}
              authRadio={authRadio} setAuthRadio={handleAuthRadio}
              password={password} setPassword={setPassword}
              passwordRef={passwordRef}
              clearPasswordRef={() => setPasswordRef("")}
              saveInVault={saveInVault} setSaveInVault={setSaveInVault}
              vaultState={vaultState}
              usePrivKey={usePrivKey} setUsePrivKey={(value) => {
                if (value) {
                  handleAuthRadio("privatekey");
                } else {
                  handleAuthRadio("password");
                }
              }}
              keyPath={keyPath} setKeyPath={setKeyPath}
              onBrowseKey={handleBrowseKey}
            />
          )}

          {activeSection === "terminal" && !isMail && (
            <TerminalSettings
              profile={terminalProfile}
              onProfileChange={setTerminalProfile}
            />
          )}
          {activeSection === "appearance" && isMail && (
            <MailAppearanceSettings
              profile={terminalProfile}
              onProfileChange={setTerminalProfile}
            />
          )}
          {activeSection === "rdp" && (
            <div data-testid="session-rdp-section">
              <RdpOptionsForm options={rdpOptions} onChange={setRdpOptions} />
            </div>
          )}
          {activeSection === "vnc" && proto === "VNC" && (
            <div data-testid="session-vnc-policies" className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px]">
              <Field label={t("sessionEditor2.vncSecurityPolicy")}>
                <select data-testid="session-vnc-security-policy" className="taomni-input w-64" value={vncSecurityPolicy} onChange={(event) => setVncSecurityPolicy(event.target.value as typeof vncSecurityPolicy)}>
                  <option value="prefer-encryption">{t("sessionEditor2.vncSecurityPrefer")}</option>
                  <option value="require-encryption">{t("sessionEditor2.vncSecurityRequire")}</option>
                  <option value="legacy-compatible">{t("sessionEditor2.vncSecurityLegacy")}</option>
                  <option value="prefer-off">{t("sessionEditor2.vncSecurityPreferOff")}</option>
                  <option value="allow-none">{t("sessionEditor2.vncSecurityAllowNone")}</option>
                </select>
              </Field>
              <Field label={t("vnc.pictureQuality")}>
                <select data-testid="session-vnc-quality" className="taomni-input w-64" value={vncViewer.pictureQuality} onChange={(event) => setVncViewer((current) => ({ ...current, pictureQuality: event.target.value as VncViewerOptions["pictureQuality"] }))}>
                  <option value="automatic">{t("vnc.qualityAutomatic")}</option>
                  <option value="high">{t("vnc.qualityHigh")}</option>
                  <option value="medium">{t("vnc.qualityMedium")}</option>
                  <option value="low">{t("vnc.qualityLow")}</option>
                </select>
              </Field>
              <Field label={t("vnc.scaling")}>
                <div className="flex items-center gap-3">
                  <select data-testid="session-vnc-scaling" className="taomni-input w-40" value={String(vncViewer.scaling)} onChange={(event) => setVncViewer((current) => ({ ...current, scaling: normalizeVncScaling(event.target.value) }))}>
                    <option value="auto">{t("vnc.scaleAutomatically")}</option>
                    <option value="fit">{t("vnc.scaleFitWindow")}</option>
                    <option value="fit-width">{t("vnc.scaleFitWidth")}</option>
                    <option value="fit-height">{t("vnc.scaleFitHeight")}</option>
                    {VNC_SCALE_PERCENTAGES.map((percent) => (
                      <option key={percent} value={String(percent)}>{percent}%</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-preserve-aspect" type="checkbox" className="taomni-checkbox" checked={vncViewer.preserveAspect} onChange={(event) => setVncViewer((current) => ({ ...current, preserveAspect: event.target.checked }))} />
                    {t("vnc.preserveAspect")}
                  </label>
                </div>
              </Field>
              <Field label={t("vnc.propertiesKeys")}>
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-special-keys" type="checkbox" className="taomni-checkbox" checked={vncViewer.passSpecialKeys} onChange={(event) => setVncViewer((current) => ({ ...current, passSpecialKeys: event.target.checked }))} />
                    {t("vnc.propertiesPassSpecialKeys")}
                  </label>
                  <label className="flex items-center gap-2">
                    {t("vnc.propertiesMenuKey")}
                    <select data-testid="session-vnc-menu-key" className="taomni-input w-24" value={vncViewer.menuKey} onChange={(event) => setVncViewer((current) => ({ ...current, menuKey: event.target.value as VncViewerOptions["menuKey"] }))}>
                      {(["F8", "F9", "F10", "F11", "F12", "none"] as const).map((key) => (
                        <option key={key} value={key}>{key === "none" ? t("vnc.propertiesMenuKeyNone") : key}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </Field>
              <Field label={t("vnc.propertiesClipboard")}>
                <select data-testid="session-vnc-clipboard-policy" className="taomni-input w-64" value={vncClipboardPolicy} onChange={(event) => setVncClipboardPolicy(event.target.value as typeof vncClipboardPolicy)}>
                  <option value="bidirectional">{t("vnc.clipboardBidirectional")}</option>
                  <option value="client-to-server">{t("vnc.clipboardClientToServer")}</option>
                  <option value="server-to-client">{t("vnc.clipboardServerToClient")}</option>
                  <option value="disabled">{t("vnc.clipboardDisabled")}</option>
                </select>
              </Field>
              <Field label={t("sessionEditor2.vncInput")}>
                <label className="flex items-center gap-2">
                  <input data-testid="session-vnc-view-only" type="checkbox" className="taomni-checkbox" checked={vncViewOnly} onChange={(event) => setVncViewOnly(event.target.checked)} />
                  {t("sessionEditor2.vncViewOnlyHint")}
                </label>
              </Field>
              <Field label={t("sessionEditor2.vncClipboardOnConnect")}>
                <label className="flex items-center gap-2">
                  <input data-testid="session-vnc-initial-clipboard" type="checkbox" className="taomni-checkbox" checked={vncViewer.sendInitialClipboard} onChange={(event) => setVncViewer((current) => ({ ...current, sendInitialClipboard: event.target.checked }))} />
                  {t("vnc.propertiesSendInitialClipboard")}
                </label>
              </Field>
              <Field label={t("vnc.propertiesConnection")}>
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-shared" type="checkbox" className="taomni-checkbox" checked={vncViewer.shared} onChange={(event) => setVncViewer((current) => ({ ...current, shared: event.target.checked }))} />
                    {t("vnc.propertiesShared")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-warn-unencrypted" type="checkbox" className="taomni-checkbox" checked={vncViewer.warnUnencrypted} onChange={(event) => setVncViewer((current) => ({ ...current, warnUnencrypted: event.target.checked }))} />
                    {t("vnc.propertiesWarnUnencrypted")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-auto-reconnect" type="checkbox" className="taomni-checkbox" checked={vncViewer.autoReconnect} onChange={(event) => setVncViewer((current) => ({ ...current, autoReconnect: event.target.checked }))} />
                    {t("vnc.propertiesAutoReconnect")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input data-testid="session-vnc-bell" type="checkbox" className="taomni-checkbox" checked={vncViewer.acceptBell} onChange={(event) => setVncViewer((current) => ({ ...current, acceptBell: event.target.checked }))} />
                    {t("vnc.propertiesAcceptBell")}
                  </label>
                </div>
              </Field>
              <div className="col-span-12 rounded border px-3 py-2 text-[11px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                {t("sessionEditor2.vncSecurityNote")}
              </div>
            </div>
          )}
          {activeSection === "mail" && isMail && (
            <div data-testid="session-mail-section">
              <MailSettings
                provider={mailForm.mailProvider} setProvider={handleMailProviderChange}
                authMode={mailForm.mailAuthMode} setAuthMode={mailForm.setMailAuthMode}
                imapHost={host} setImapHost={setHost}
                imapPort={port} setImapPort={setPort}
                username={username} setUsername={(value) => { setUsername(value); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                displayName={mailForm.mailDisplayName} setDisplayName={mailForm.setMailDisplayName}
                replyTo={mailForm.mailReplyTo} setReplyTo={mailForm.setMailReplyTo}
                signature={mailForm.mailSignature} setSignature={mailForm.setMailSignature}
                imapSecurity={mailForm.mailImapSecurity} setImapSecurity={mailForm.setMailImapSecurity}
                smtpHost={mailForm.mailSmtpHost} setSmtpHost={mailForm.setMailSmtpHost}
                smtpPort={mailForm.mailSmtpPort} setSmtpPort={mailForm.setMailSmtpPort}
                smtpSecurity={mailForm.mailSmtpSecurity} setSmtpSecurity={mailForm.setMailSmtpSecurity}
                smtpUsername={mailForm.mailSmtpUsername} setSmtpUsername={mailForm.setMailSmtpUsername}
                smtpUseImapAuth={mailForm.mailSmtpUseImapAuth} setSmtpUseImapAuth={mailForm.setMailSmtpUseImapAuth}
                smtpPassword={mailForm.mailSmtpPassword} setSmtpPassword={mailForm.setMailSmtpPassword}
                smtpPasswordRef={mailForm.mailSmtpPasswordRef} clearSmtpPasswordRef={() => mailForm.setMailSmtpPasswordRef("")}
                smtpSaveInVault={mailForm.mailSmtpSaveInVault} setSmtpSaveInVault={mailForm.setMailSmtpSaveInVault}
                oauthClientId={mailForm.mailOauthClientId} setOauthClientId={mailForm.setMailOauthClientId}
                oauthClientSecret={mailForm.mailOauthClientSecret} setOauthClientSecret={mailForm.setMailOauthClientSecret}
                oauthClientSecretRef={mailForm.mailOauthClientSecretRef} clearOauthClientSecretRef={() => mailForm.setMailOauthClientSecretRef("")}
                oauthClientSecretSaveInVault={mailForm.mailOauthClientSecretSaveInVault} setOauthClientSecretSaveInVault={mailForm.setMailOauthClientSecretSaveInVault}
                oauthFlow={mailForm.mailOauthFlow} setOauthFlow={(value) => {
                  mailForm.setMailOauthFlow(value);
                  mailForm.setMailOauthDeviceInfo(null);
                  mailForm.setMailOauthStatus(null);
                }}
                oauthDeviceInfo={mailForm.mailOauthDeviceInfo}
                oauthTokenRef={mailForm.mailOauthTokenRef}
                oauthExpiresAt={mailForm.mailOauthExpiresAt}
                oauthScope={mailForm.mailOauthScope}
                oauthConnecting={mailForm.mailOauthConnecting}
                oauthStatus={mailForm.mailOauthStatus}
                onOAuthConnect={() => void handleMailOAuthConnect()}
                cacheEnabled={mailForm.mailCacheEnabled} setCacheEnabled={mailForm.setMailCacheEnabled}
                storage={mailForm.mailStorage} setStorage={mailForm.setMailStorage} accountId={session?.id}
                saveDirectory={mailForm.mailSaveDirectory} setSaveDirectory={mailForm.setMailSaveDirectory}
                onBrowseSaveDirectory={() => void handleBrowseMailSaveDirectory()}
                headerRetentionDays={mailForm.mailHeaderRetentionDays} setHeaderRetentionDays={mailForm.setMailHeaderRetentionDays}
                headerLimitPerFolder={mailForm.mailHeaderLimitPerFolder} setHeaderLimitPerFolder={mailForm.setMailHeaderLimitPerFolder}
                bodyRecentLimit={mailForm.mailBodyRecentLimit} setBodyRecentLimit={mailForm.setMailBodyRecentLimit}
                bodyMaxBytes={mailForm.mailBodyMaxBytes} setBodyMaxBytes={mailForm.setMailBodyMaxBytes}
                attachmentCache={mailForm.mailAttachmentCache} setAttachmentCache={mailForm.setMailAttachmentCache}
                syncOnOpen={mailForm.mailSyncOnOpen} setSyncOnOpen={mailForm.setMailSyncOnOpen}
                idlePush={mailForm.mailIdlePush} setIdlePush={mailForm.setMailIdlePush}
                subscribedOnly={mailForm.mailSubscribedOnly} setSubscribedOnly={mailForm.setMailSubscribedOnly}
                incoming={mailForm.mailIncoming} setIncoming={mailForm.setMailIncoming}
                pop3LeaveDays={mailForm.mailPop3LeaveDays} setPop3LeaveDays={mailForm.setMailPop3LeaveDays}
                undoSendSeconds={mailForm.mailUndoSendSeconds} setUndoSendSeconds={mailForm.setMailUndoSendSeconds}
                cardDavUrl={mailForm.mailCardDavUrl} setCardDavUrl={mailForm.setMailCardDavUrl}
                cardDavUsername={mailForm.mailCardDavUsername} setCardDavUsername={mailForm.setMailCardDavUsername}
                calDavUrl={mailForm.mailCalDavUrl} setCalDavUrl={mailForm.setMailCalDavUrl}
                calDavUsername={mailForm.mailCalDavUsername} setCalDavUsername={mailForm.setMailCalDavUsername}
                receiptPolicy={mailForm.mailReceiptPolicy} setReceiptPolicy={mailForm.setMailReceiptPolicy}
                specialFolders={mailForm.mailSpecialFolders} setSpecialFolders={mailForm.setMailSpecialFolders}
                desktopNotify={mailForm.mailDesktopNotify} setDesktopNotify={mailForm.setMailDesktopNotify}
                syncIntervalMinutes={mailForm.mailSyncIntervalMinutes} setSyncIntervalMinutes={mailForm.setMailSyncIntervalMinutes}
                maxFetchPerSync={mailForm.mailMaxFetchPerSync} setMaxFetchPerSync={mailForm.setMailMaxFetchPerSync}
                saveSentCopy={mailForm.mailSaveSentCopy} setSaveSentCopy={mailForm.setMailSaveSentCopy}
                identities={mailForm.mailIdentityList} setIdentities={mailForm.setMailIdentityList}
                aiEnabled={mailForm.mailAiEnabled} setAiEnabled={mailForm.setMailAiEnabled}
                aiSkipBodyConfirm={mailForm.mailAiSkipBodyConfirm} setAiSkipBodyConfirm={mailForm.setMailAiSkipBodyConfirm}
                vaultState={vaultState}
              />
            </div>
          )}
          {activeSection === "database" && isDb && (
            <div data-testid="session-database-section">
              <DatabaseSettings
                proto={proto}
                username={username} setUsername={(v) => { setUsername(v); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                vaultState={vaultState}
                catalog={databaseForm.dbCatalog} setCatalog={databaseForm.setDbCatalog}
                database={databaseForm.dbDatabase} setDatabase={databaseForm.setDbDatabase}
                ssl={databaseForm.dbSsl} setSsl={databaseForm.setDbSsl}
                timeoutSecs={databaseForm.dbTimeout} setTimeoutSecs={databaseForm.setDbTimeout}
                httpPort={databaseForm.dbHttpPort} setHttpPort={databaseForm.setDbHttpPort}
                chProtocol={databaseForm.dbChProtocol} setChProtocol={databaseForm.setDbChProtocol}
                prestoDialect={databaseForm.dbPrestoDialect} setPrestoDialect={databaseForm.setDbPrestoDialect}
                redisDbIndex={databaseForm.dbRedisIndex} setRedisDbIndex={databaseForm.setDbRedisIndex}
              />
            </div>
          )}
          {activeSection === "database" && isHBase && (
            <div data-testid="session-hbase-section">
              <HBaseSettings
                host={host} setHost={setHost}
                port={port} setPort={setPort}
                username={username} setUsername={(v) => { setUsername(v); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                vaultState={vaultState}
                namespace={databaseForm.hbaseNamespace} setNamespace={databaseForm.setHBaseNamespace}
                restPath={databaseForm.hbaseRestPath} setRestPath={databaseForm.setHBaseRestPath}
                connectionMode={databaseForm.hbaseConnectionMode} setConnectionMode={databaseForm.setHBaseConnectionMode}
                zkQuorum={databaseForm.hbaseZkQuorum} setZkQuorum={databaseForm.setHBaseZkQuorum}
                zkRoot={databaseForm.hbaseZkRoot} setZkRoot={databaseForm.setHBaseZkRoot}
                effectiveUser={databaseForm.hbaseEffectiveUser} setEffectiveUser={databaseForm.setHBaseEffectiveUser}
                ssl={databaseForm.dbSsl} setSsl={databaseForm.setDbSsl}
                timeoutSecs={databaseForm.dbTimeout} setTimeoutSecs={databaseForm.setDbTimeout}
                authMethod={databaseForm.hbaseAuthMethod} setAuthMethod={databaseForm.setHBaseAuthMethod}
                servicePrincipal={databaseForm.hbaseServicePrincipal} setServicePrincipal={databaseForm.setHBaseServicePrincipal}
                principal={databaseForm.hbasePrincipal} setPrincipal={databaseForm.setHBasePrincipal}
                keytabPath={databaseForm.hbaseKeytabPath} setKeytabPath={databaseForm.setHBaseKeytabPath}
                krb5ConfPath={databaseForm.hbaseKrb5ConfPath} setKrb5ConfPath={databaseForm.setHBaseKrb5ConfPath}
                hbaseSitePath={databaseForm.hbaseSitePath} setHBaseSitePath={databaseForm.setHBaseSitePath}
              />
            </div>
          )}
          {activeSection === "objectstorage" && isObjectStorage && (
            <div data-testid="session-objectstorage-wrap">
              <ObjectStorageSettings
                value={oss}
                onChange={setOss}
                saveInVault={saveInVault}
                setSaveInVault={setSaveInVault}
              />
            </div>
          )}
          {activeSection === "proxy" && isProxy && (
            <div data-testid="session-proxy-section" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
              <Field label={t("sessionEditor2.proxyKindLabel")}>
                <Select
                  value={proxyKind === "http" ? t("sessionEditor2.proxyHttp") : t("sessionEditor2.proxySocks5")}
                  options={[t("sessionEditor2.proxyHttp"), t("sessionEditor2.proxySocks5")]}
                  onChange={(label) => setProxyKind(label === t("sessionEditor2.proxyHttp") ? "http" : "socks5")}
                />
              </Field>
              <Field label={t("sessionEditor2.proxyTestUrl")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.proxyTestUrlPlaceholder")}
                  value={proxyTestUrl}
                  onChange={(e) => setProxyTestUrl(e.target.value)}
                />
              </Field>
            </div>
          )}
          {activeSection === "network" && !isDb && !isObjectStorage && (
            <NetworkSettings
              t={t}
              value={networkSettings}
              onChange={setNetworkSettings}
              sessionConfigId={session?.id}
              sshSessions={sessions
                .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              proxySessions={sessions
                .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              onSaveAsProxySession={() => void handleSaveAsProxySession()}
            />
          )}
          {activeSection === "network" && (isDb || isObjectStorage) && (
            <DbNetworkSettings
              t={t}
              value={networkSettings}
              onChange={setNetworkSettings}
              sshSessions={sessions
                .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              proxySessions={sessions
                .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
                .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
              onSaveAsProxySession={() => void handleSaveAsProxySession()}
            />
          )}
          {activeSection === "bookmark" && (
            <BookmarkSettings
              t={t}
              name={name} setName={setName}
              groupPath={groupPath} setGroupPath={setGroupPath}
              folderOptions={folderOptions}
              description={description} setDescription={setDescription}
              tags={tags} setTags={setTags}
              proto={proto}
              onNewFolder={handleNewFolder}
              fileEmbedInTab={fileEmbedInTab} setFileEmbedInTab={setFileEmbedInTab}
              fileExtraArgs={fileExtraArgs} setFileExtraArgs={setFileExtraArgs}
              disableAiWrite={disableAiWrite} setDisableAiWrite={setDisableAiWrite}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="min-h-12 flex flex-wrap items-center gap-2 px-3 py-2 border-t shrink-0"
          style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {isSSH && needsHost && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="session-test-connection"
                onClick={handleTestConnection}
                disabled={testing}
                type="button"
                aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {isDb && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="db-test-connection"
                onClick={() => void handleTestDbConnection()}
                disabled={testing}
                type="button"
                aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {isHBase && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="hbase-test-connection"
                onClick={() => void handleTestHBaseConnection()}
                disabled={testing}
                type="button"
                aria-label={testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {testing ? t("sessionEditor2.testing") : t("sessionEditor2.testConnection")}{shortcuts.test}
              </button>
            )}
            {isProxy && (
              <button
                className="taomni-btn shrink-0 flex items-center gap-1.5"
                data-testid="proxy-test-connection"
                onClick={() => void handleTestProxyConnection()}
                disabled={testing}
                type="button"
                aria-label={testing ? t("sessionEditor2.proxyTestTesting") : t("sessionEditor2.proxyTestBtn")}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {testing ? t("sessionEditor2.proxyTestTesting") : t("sessionEditor2.proxyTestBtn")}{shortcuts.test}
              </button>
            )}
            <button data-testid="session-save-template" className="taomni-btn shrink-0 flex items-center gap-1.5" type="button" onClick={() => void handleSaveTemplate()}>
              <Save className="w-3.5 h-3.5" /> {t("sessionEditor2.saveTemplate")}
            </button>
            <button data-testid="session-reset" className="taomni-btn shrink-0 flex items-center gap-1.5" type="button" onClick={handleReset}>
              <RotateCcw className="w-3.5 h-3.5" /> {t("sessionEditor2.reset")}
            </button>

            {(testResult || saveError) && (
              <span
                className="text-[11px] min-w-0 max-w-[280px] truncate"
                title={saveError ?? testResult?.msg}
                style={{ color: testResult?.ok && !saveError ? "#2f8a3e" : "#b22222" }}
                data-testid="session-test-result-summary"
              >
                {saveError ?? testResult?.msg}
              </span>
            )}

            <span
              className="min-w-0 basis-40 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]"
              title={`${t("sessionEditor2.willBeSavedTo")} ${groupPath ? folderOptionLabel(groupPath) : SESSION_ROOT_LABEL} / ${name || host || "..."}`}
            >
              {t("sessionEditor2.willBeSavedTo")}{" "}
              <span className="taomni-mono">
                {groupPath ? folderOptionLabel(groupPath) : SESSION_ROOT_LABEL} / {name || host || "..."}
              </span>
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {isEdit && (
              <button
                data-testid="session-delete-editor"
                className="taomni-btn"
                onClick={handleDelete}
                type="button"
                style={{ color: "#b22222" }}
              >
                {t("sessionEditor2.delete")}
              </button>
            )}
            <button
              data-testid="session-cancel"
              className="taomni-btn"
              onClick={onClose}
              type="button"
              aria-label={t("sessionEditor2.cancel")}
            >
              {t("sessionEditor2.cancel")}{shortcuts.cancel}
            </button>
            <button
              className="taomni-btn"
              data-testid="session-save"
              data-primary="true"
              onClick={handleSave}
              type="button"
              aria-label={t("sessionEditor2.ok")}
            >
              {t("sessionEditor2.ok")}{shortcuts.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
