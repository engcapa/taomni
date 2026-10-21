import { mailStorageOptions } from "../mail/MailStorageSettings";
import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useModalShortcuts, getShortcutSuffixes } from "../../hooks/useModalShortcuts";
import { X, Terminal as TerminalIcon, Monitor, Folder, Wifi, Bookmark, Shield, FlaskConical, FileText, Cloud, Save, RotateCcw, Network, HelpCircle, Database, Mail, Palette } from "lucide-react";
import { useSessionStore } from "../../stores/sessionStore";
import { useVaultStore } from "../../stores/vaultStore";
import { ensureVaultReady } from "../../lib/vaultGate";
import { MAIL_HEADER_LIMITS_EXPLICIT_KEY, mailHeaderLimitOption } from "../../lib/mailSync";
import { parseSpecialFolders } from "../../lib/mailFolders";
import { parseMailIdentities } from "../../lib/mailIdentities";
import { selectFilePath, selectFolderPath, selectPrivateKeyFile, testSshConnection, testProxyConnection, dbTestConnection, hbaseTestConnection, vaultPut, isVaultReference, isVaultLockedError, listWslDistros, listLocalShells, type WslDistro, type LocalShellOption } from "../../lib/ipc";
import type { DbConnectInfo, HBaseConnectInfo, MailIdentity } from "../../types";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { DEFAULT_NETWORK_SETTINGS, getSessionNetworkSettings, toNetworkSettingsPayload, type NetworkSettings as NetworkSettingsValue } from "../../lib/networkSettings";
import { parseSshConnectionCommand, parseUserHostPort } from "../../lib/quickConnect";
import { SESSION_ROOT_LABEL, collectFolderPaths, folderOptionLabel, normalizeGroupPath, toStoredGroupPath } from "../../lib/sessionPaths";
import { alertAppDialog, confirmAppDialog, formatUnknownError, promptAppDialog } from "../../lib/appDialogs";
import type { SessionConfig, AuthMethod } from "../../lib/ipc";
import { SYSTEM_TERMINAL_THEME, parseSessionOptions, type TerminalProfile } from "../../lib/terminalProfile";
import { supportsTerminalAppearanceSessionType } from "../../lib/sessionTerminalTheme";
import { buildWslLaunchArgs, parseWslOptions, serializeWslOptions, type WslOptions } from "../../types/wsl";
import { parseRdpOptions, serializeRdpOptions, type RdpOptions } from "../../types/rdp";
import { parseLocalShellOptions, serializeLocalShellOptions, type LocalShellOptions } from "../../types/localShell";
import { RdpOptionsForm } from "./forms/RdpOptionsForm";
import { ObjectStorageSettings, ossFormFromOptions, ossFormToConfig, type OssFormState } from "./ObjectStorageSettings";
import { engineForProvider } from "../../types/objectStorage";
import { WslOptionsForm } from "./forms/WslOptionsForm";
import { LocalShellOptionsForm } from "./forms/LocalShellOptionsForm";
import { MailAppearanceSettings } from "../mail/MailAppearanceSettings";
import { mailOAuthAuthorize, mailOAuthDeviceComplete, mailOAuthDeviceStart } from "../../lib/mail";
import { useT } from "../../lib/i18n";
import { normalizeVncScaling, VNC_SCALE_PERCENTAGES } from "../../lib/vnc";
import { parseVncViewerOptions, writeVncViewerOptions, type VncViewerOptions } from "../../lib/vncOptions";
import { PathMappingsEditor, parsePathMappings as parsePathMappingsFromOptions } from "../filebrowser/PathMappingsEditor";
import type { SftpPathMapping } from "../../types";
import { sessionTypeToProto, type Proto, type SectionTab, DEFAULT_PORTS, optionString, extractAuthType, extractKeyPath, optionBoolean, optionStringOrNumber, initialTerminalProfileForProto, DB_PROTOS, PLANNED_CLIENT_PROTOS, protoToSessionType, defaultTerminalProfileForProto, stripSerialOptions, stripLocalShellLaunchOptions, stripDeprecatedCwdOptions, stripTerminalProfileOption, cloneNetworkSettings, PROTOS } from "./editor/sessionPolicy";
import { type MailProvider, initialMailProvider, type MailAuthMode, normalizeMailAuthMode, type MailSecurityMode, type MailOAuthFlow, initialMailOAuthFlow, type MailOAuthDeviceInfo, defaultMailOAuthFlow, MAIL_PROVIDER_PRESETS, stripMailIdentityOptions, effectiveMailOAuthFlow, mailOAuthClientSecretVisible, mailOAuthClientSecretRequired, supportsMailOAuthProvider } from "./editor/mailPolicy";
import { Field, Select } from "./editor/Fields";
import { AdvancedSshSettings } from "./editor/SshSettings";
import { TerminalSettings } from "./editor/TerminalSettings";
import { MailSettings } from "./editor/MailSettings";
import { DatabaseSettings } from "./editor/DatabaseSettings";
import { HBaseSettings } from "./editor/HBaseSettings";
import { NetworkSettings, DbNetworkSettings } from "./editor/NetworkSettings";
import { BookmarkSettings } from "./editor/BookmarkSettings";
import { SessionConnectionFields } from "./editor/SessionConnectionFields";



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

  /* --- database session options (MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto/Redis) --- */
  const [dbCatalog, setDbCatalog] = useState(() => optionString(initialOptions, "dbCatalog", ""));
  const [dbDatabase, setDbDatabase] = useState(() => optionString(initialOptions, "dbDatabase", ""));
  const [dbSsl, setDbSsl] = useState(() => optionBoolean(initialOptions, "dbSsl", false));
  const [dbTimeout, setDbTimeout] = useState(() => optionString(initialOptions, "dbTimeout", "15"));
  const [dbHttpPort, setDbHttpPort] = useState(() => optionString(initialOptions, "dbHttpPort", "8123"));
  const [dbChProtocol, setDbChProtocol] = useState(() => optionString(initialOptions, "dbChProtocol", "HTTP"));
  // New sessions default to Trino (modern default); saved sessions without the
  // key hydrate as "Presto" so legacy options_json keeps X-Presto-* behavior.
  const [dbPrestoDialect, setDbPrestoDialect] = useState(() => {
    const stored = optionString(initialOptions, "dbPrestoDialect", "");
    if (stored.toLowerCase() === "trino") return "Trino";
    if (stored.toLowerCase() === "presto") return "Presto";
    return session ? "Presto" : "Trino";
  });
  const [dbRedisIndex, setDbRedisIndex] = useState(() => optionString(initialOptions, "dbRedisIndex", "0"));
  const [hbaseNamespace, setHBaseNamespace] = useState(() => optionString(initialOptions, "hbaseNamespace", ""));
  const [hbaseRestPath, setHBaseRestPath] = useState(() => optionString(initialOptions, "hbaseRestPath", ""));
  const [hbaseConnectionMode, setHBaseConnectionMode] = useState(() => optionString(initialOptions, "hbaseConnectionMode", "native"));
  const [hbaseZkQuorum, setHBaseZkQuorum] = useState(() => optionString(initialOptions, "hbaseZkQuorum", ""));
  const [hbaseZkRoot, setHBaseZkRoot] = useState(() => optionString(initialOptions, "hbaseZkRoot", ""));
  const [hbaseEffectiveUser, setHBaseEffectiveUser] = useState(() => optionString(initialOptions, "hbaseEffectiveUser", ""));
  const [hbaseAuthMethod, setHBaseAuthMethod] = useState(() => optionString(initialOptions, "hbaseAuthMethod", "simple"));
  const [hbaseServicePrincipal, setHBaseServicePrincipal] = useState(() => optionString(initialOptions, "hbaseServicePrincipal", ""));
  const [hbasePrincipal, setHBasePrincipal] = useState(() => optionString(initialOptions, "hbasePrincipal", ""));
  const [hbaseKeytabPath, setHBaseKeytabPath] = useState(() => optionString(initialOptions, "hbaseKeytabPath", ""));
  const [hbaseKrb5ConfPath, setHBaseKrb5ConfPath] = useState(() => optionString(initialOptions, "hbaseKrb5ConfPath", ""));
  const [hbaseSitePath, setHBaseSitePath] = useState(() => optionString(initialOptions, "hbaseSitePath", ""));

  /* --- proxy session options --- */
  const [proxyKind, setProxyKind] = useState<"http" | "socks5">(() => {
    const v = optionString(initialOptions, "proxyKind", "http");
    return v === "socks5" ? "socks5" : "http";
  });
  const [proxyTestUrl, setProxyTestUrl] = useState(() => optionString(initialOptions, "testUrl", "www.google.com:443"));

  /* --- mail session options (generic IMAP + SMTP) --- */
  const [mailProvider, setMailProvider] = useState<MailProvider>(() => initialMailProvider(initialOptions, session?.host));
  const [mailAuthMode, setMailAuthMode] = useState<MailAuthMode>(() => normalizeMailAuthMode(initialOptions.mailAuthMode));
  const [mailDisplayName, setMailDisplayName] = useState(() => optionString(initialOptions, "mailDisplayName", ""));
  const [mailReplyTo, setMailReplyTo] = useState(() => optionString(initialOptions, "mailReplyTo", ""));
  const [mailSignature, setMailSignature] = useState(() => optionString(initialOptions, "mailSignature", ""));
  const [mailImapSecurity, setMailImapSecurity] = useState<MailSecurityMode>(() => {
    const value = optionString(initialOptions, "mailImapSecurity", "TLS");
    return value === "STARTTLS" || value === "None" ? value : "TLS";
  });
  const [mailSmtpHost, setMailSmtpHost] = useState(() => optionString(initialOptions, "mailSmtpHost", ""));
  const [mailSmtpPort, setMailSmtpPort] = useState(() => optionString(initialOptions, "mailSmtpPort", "465"));
  const [mailSmtpSecurity, setMailSmtpSecurity] = useState<MailSecurityMode>(() => {
    const value = optionString(initialOptions, "mailSmtpSecurity", "TLS");
    return value === "STARTTLS" || value === "None" ? value : "TLS";
  });
  const [mailSmtpUsername, setMailSmtpUsername] = useState(() => optionString(initialOptions, "mailSmtpUsername", ""));
  const [mailSmtpUseImapAuth, setMailSmtpUseImapAuth] = useState(() => optionBoolean(initialOptions, "mailSmtpUseImapAuth", true));
  const [mailSmtpPassword, setMailSmtpPassword] = useState("");
  const [mailSmtpPasswordRef, setMailSmtpPasswordRef] = useState(() => optionString(initialOptions, "mailSmtpPasswordRef", ""));
  const [mailSmtpSaveInVault, setMailSmtpSaveInVault] = useState(() =>
    !!optionString(initialOptions, "mailSmtpPasswordRef", "") || initialProtoValue === "Mail",
  );
  const [mailOauthClientId, setMailOauthClientId] = useState(() => optionString(initialOptions, "mailOauthClientId", ""));
  const [mailOauthClientSecret, setMailOauthClientSecret] = useState("");
  const [mailOauthClientSecretRef, setMailOauthClientSecretRef] = useState(() => optionString(initialOptions, "mailOauthClientSecretRef", ""));
  const [mailOauthClientSecretSaveInVault, setMailOauthClientSecretSaveInVault] = useState(() =>
    !!optionString(initialOptions, "mailOauthClientSecretRef", "") || initialProtoValue === "Mail",
  );
  const [mailOauthFlow, setMailOauthFlow] = useState<MailOAuthFlow>(() =>
    initialMailOAuthFlow(initialOptions, initialMailProvider(initialOptions, session?.host)),
  );
  const [mailOauthDeviceInfo, setMailOauthDeviceInfo] = useState<MailOAuthDeviceInfo | null>(null);
  const [mailOauthTokenRef, setMailOauthTokenRef] = useState(() => optionString(initialOptions, "mailOauthTokenRef", ""));
  const [mailOauthExpiresAt, setMailOauthExpiresAt] = useState(() => optionStringOrNumber(initialOptions, "mailOauthExpiresAt", ""));
  const [mailOauthScope, setMailOauthScope] = useState(() => optionString(initialOptions, "mailOauthScope", ""));
  const [mailOauthConnecting, setMailOauthConnecting] = useState(false);
  const [mailOauthStatus, setMailOauthStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [mailCacheEnabled, setMailCacheEnabled] = useState(() => optionBoolean(initialOptions, "mailCacheEnabled", true));
  const [mailStorage, setMailStorage] = useState(() => mailStorageOptions(initialOptions));
  const [mailSaveDirectory, setMailSaveDirectory] = useState(() => optionString(initialOptions, "mailSaveDirectory", ""));
  const [mailHeaderRetentionDays, setMailHeaderRetentionDays] = useState(() => String(mailHeaderLimitOption(initialOptions, "mailHeaderRetentionDays", 30)));
  const [mailHeaderLimitPerFolder, setMailHeaderLimitPerFolder] = useState(() => String(mailHeaderLimitOption(initialOptions, "mailHeaderLimitPerFolder", 2000)));
  const [mailBodyRecentLimit, setMailBodyRecentLimit] = useState(() => optionString(initialOptions, "mailBodyRecentLimit", "200"));
  const [mailBodyMaxBytes, setMailBodyMaxBytes] = useState(() => optionString(initialOptions, "mailBodyMaxBytes", "262144"));
  const [mailAttachmentCache, setMailAttachmentCache] = useState(() => optionBoolean(initialOptions, "mailAttachmentCache", false));
  const [mailSyncOnOpen, setMailSyncOnOpen] = useState(() => optionBoolean(initialOptions, "mailSyncOnOpen", true));
  const [mailIdlePush, setMailIdlePush] = useState(() => optionBoolean(initialOptions, "mailIdlePush", true));
  const [mailSubscribedOnly, setMailSubscribedOnly] = useState(() => optionBoolean(initialOptions, "mailSubscribedOnly", false));
  const [mailIncoming, setMailIncoming] = useState<"imap" | "pop3">(() => (optionString(initialOptions, "mailIncoming", "imap") === "pop3" ? "pop3" : "imap"));
  const [mailPop3LeaveDays, setMailPop3LeaveDays] = useState(() => optionString(initialOptions, "mailPop3LeaveDays", ""));
  const [mailUndoSendSeconds, setMailUndoSendSeconds] = useState(() => optionString(initialOptions, "mailUndoSendSeconds", "0"));
  const [mailCardDavUrl, setMailCardDavUrl] = useState(() => optionString(initialOptions, "mailCardDavUrl", ""));
  const [mailCardDavUsername, setMailCardDavUsername] = useState(() => optionString(initialOptions, "mailCardDavUsername", ""));
  const [mailCalDavUrl, setMailCalDavUrl] = useState(() => optionString(initialOptions, "mailCalDavUrl", ""));
  const [mailCalDavUsername, setMailCalDavUsername] = useState(() => optionString(initialOptions, "mailCalDavUsername", ""));
  const [mailReceiptPolicy, setMailReceiptPolicy] = useState(() => optionString(initialOptions, "mailReceiptPolicy", "ask"));
  const [mailSpecialFolders, setMailSpecialFolders] = useState(() => parseSpecialFolders(initialOptions.mailSpecialFolders));
  const [mailDesktopNotify, setMailDesktopNotify] = useState(() => optionBoolean(initialOptions, "mailDesktopNotify", false));
  const [mailSyncIntervalMinutes, setMailSyncIntervalMinutes] = useState(() => optionString(initialOptions, "mailSyncIntervalMinutes", "5"));
  const [mailMaxFetchPerSync, setMailMaxFetchPerSync] = useState(() => optionString(initialOptions, "mailMaxFetchPerSync", "200"));
  const [mailSaveSentCopy, setMailSaveSentCopy] = useState(() => optionString(initialOptions, "mailSaveSentCopy", "auto"));
  const [mailIdentityList, setMailIdentityList] = useState<MailIdentity[]>(() => parseMailIdentities(initialOptions.mailIdentities));
  const [mailAiEnabled, setMailAiEnabled] = useState(() => optionBoolean(initialOptions, "mailAiEnabled", true));
  const [mailAiSkipBodyConfirm, setMailAiSkipBodyConfirm] = useState(() => optionBoolean(initialOptions, "mailAiSkipBodyConfirm", false));

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

  /* --- local shell options --- */
  const [localShellOptions, setLocalShellOptions] = useState<LocalShellOptions>(() =>
    parseLocalShellOptions(session?.options_json),
  );
  const [localShells, setLocalShells] = useState<LocalShellOption[]>([]);
  const [localShellStatus, setLocalShellStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (proto !== "Shell") return;
    let cancelled = false;
    setLocalShellStatus("loading");
    listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        setLocalShells(shells);
        setLocalShellStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLocalShellStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [proto]);

  /* --- WSL options --- */
  const [wslOptions, setWslOptions] = useState<WslOptions>(() =>
    parseWslOptions(session?.options_json),
  );
  const [wslDistros, setWslDistros] = useState<WslDistro[]>([]);
  const [wslStatus, setWslStatus] = useState<"loading" | "ready" | "error" | "unsupported">(
    // WSL sessions need the desktop backend; the browser preview (even on a
    // Windows host) cannot launch them, so report unsupported there.
    () => (getAppPlatform() === "windows" && isTauriRuntime() ? "loading" : "unsupported"),
  );

  useEffect(() => {
    if (proto !== "WSL") return;
    if (getAppPlatform() !== "windows" || !isTauriRuntime()) {
      setWslStatus("unsupported");
      return;
    }
    let cancelled = false;
    setWslStatus("loading");
    listWslDistros()
      .then((distros) => {
        if (cancelled) return;
        const list = distros ?? [];
        setWslDistros(list);
        setWslStatus("ready");
        // If editing a brand-new session, default to the system's default distro.
        if (!wslOptions.distro && list.length > 0) {
          const def = list.find((d) => d.isDefault) ?? list[0];
          setWslOptions((prev) => ({ ...prev, distro: def.name }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setWslStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proto]);

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
      setMailSmtpSaveInVault(true);
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
    setMailProvider(provider);
    setMailAuthMode(provider === "custom" ? "password" : "oauth2");
    setMailOauthFlow(defaultMailOAuthFlow(provider));
    setMailOauthDeviceInfo(null);
    setMailOauthStatus(null);
    const preset = MAIL_PROVIDER_PRESETS[provider];
    if (!preset) return;

    setHost(preset.imapHost);
    setPort(preset.imapPort);
    setMailImapSecurity(preset.imapSecurity);
    setMailSmtpHost(preset.smtpHost);
    setMailSmtpPort(preset.smtpPort);
    setMailSmtpSecurity(preset.smtpSecurity);
    setMailSmtpUseImapAuth(preset.smtpUseImapAuth);
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

  const buildOptionsJson = ({
    passwordRefValue = passwordRef,
    networkSettingsValue = networkSettings,
    proxyPassValue = networkSettings.proxyPass,
    jumpPasswordValue = networkSettings.jumpPassword,
    mailSmtpPasswordRefValue = mailSmtpPasswordRef,
    mailOauthClientSecretRefValue = mailOauthClientSecretRef,
    mailOauthTokenRefValue = mailOauthTokenRef,
    mailOauthExpiresAtValue = mailOauthExpiresAt,
    mailOauthScopeValue = mailOauthScope,
    ossConfigValue,
  }: {
    passwordRefValue?: string;
    networkSettingsValue?: NetworkSettingsValue;
    proxyPassValue?: string;
    jumpPasswordValue?: string;
    mailSmtpPasswordRefValue?: string;
    mailOauthClientSecretRefValue?: string;
    mailOauthTokenRefValue?: string;
    mailOauthExpiresAtValue?: string;
    mailOauthScopeValue?: string;
    /** Resolved object-storage option map (secrets already swapped for vault
     *  refs by handleSave). Falls back to current form state when omitted. */
    ossConfigValue?: Record<string, unknown>;
  } = {}): string => {
    const rawPreviousOptions = stripSerialOptions(
      stripLocalShellLaunchOptions(
        stripDeprecatedCwdOptions(parseSessionOptions(session?.options_json)),
      ),
    );
    const previousOptionsBase = supportsTerminalAppearance || isMail
      ? rawPreviousOptions
      : stripTerminalProfileOption(rawPreviousOptions);
    const previousOptions = proto === "Mail"
      ? stripMailIdentityOptions(previousOptionsBase)
      : previousOptionsBase;
    const localShellOverrides: Record<string, unknown> =
      proto === "Shell" ? serializeLocalShellOptions(localShellOptions) : {};
    const serialOverrides: Record<string, unknown> =
      proto === "Serial"
        ? {
            serialDevice: serialDevice.trim(),
            serialBaud: serialBaud.trim() || "115200",
          }
        : {};
    const wslOverrides: Record<string, unknown> =
      proto === "WSL"
        ? {
            ...serializeWslOptions(wslOptions),
            localShellPath: "wsl.exe",
            localShellArgs: buildWslLaunchArgs(wslOptions),
          }
        : {};
    const rdpOverrides: Record<string, unknown> =
      proto === "RDP"
        ? (JSON.parse(serializeRdpOptions(rdpOptions)) as Record<string, unknown>)
        : {};
    const vncOverrides: Record<string, unknown> =
      proto === "VNC"
        ? writeVncViewerOptions({ vncSecurityPolicy, vncViewOnly, vncClipboardPolicy }, vncViewer)
        : {};
    const dbOverrides: Record<string, unknown> = isDb
      ? {
          dbDatabase,
          dbCatalog,
          dbSsl,
          dbTimeout,
          dbHttpPort,
          dbChProtocol,
          dbPrestoDialect: dbPrestoDialect.toLowerCase(),
          dbRedisIndex,
        }
      : {};
    const proxyOverrides: Record<string, unknown> = isProxy
      ? { proxyKind, testUrl: proxyTestUrl }
      : {};
    const mailOauthExpiresAtNumber = Number.parseInt(mailOauthExpiresAtValue, 10);
    const effectiveMailOauthFlow = effectiveMailOAuthFlow(mailProvider, mailOauthFlow);
    const persistMailOauthClientSecret = mailOAuthClientSecretVisible(mailProvider, effectiveMailOauthFlow);
    const mailOverrides: Record<string, unknown> = isMail
      ? {
          mailProvider,
          mailAuthMode,
          mailOauthFlow: mailAuthMode === "oauth2" ? effectiveMailOauthFlow : "browser",
          mailOauthClientId: mailAuthMode === "oauth2" ? mailOauthClientId : "",
          mailOauthClientSecretRef:
            mailAuthMode === "oauth2" && persistMailOauthClientSecret
              ? mailOauthClientSecretRefValue
              : "",
          mailOauthTokenRef: mailAuthMode === "oauth2" ? mailOauthTokenRefValue : "",
          mailOauthExpiresAt: mailAuthMode === "oauth2" && Number.isFinite(mailOauthExpiresAtNumber) ? mailOauthExpiresAtNumber : 0,
          mailOauthScope: mailAuthMode === "oauth2" ? mailOauthScopeValue : "",
          mailDisplayName,
          mailReplyTo,
          mailSignature,
          mailImapSecurity,
          mailSmtpHost,
          mailSmtpPort,
          mailSmtpSecurity,
          mailSmtpUsername,
          mailSmtpUseImapAuth,
          mailSmtpPasswordRef: mailSmtpUseImapAuth ? "" : mailSmtpPasswordRefValue,
          mailCacheEnabled,
          mailSaveDirectory,
          mailStorageDirectory: mailStorage.directory.trim(),
          mailFullMessageMode: mailStorage.mode,
          mailFullMessageFolders: Array.from(new Set(mailStorage.folders.map((v) => v.trim()).filter(Boolean))),
          mailHeaderRetentionDays,
          mailHeaderLimitPerFolder,
          [MAIL_HEADER_LIMITS_EXPLICIT_KEY]: true,
          mailBodyRecentLimit,
          mailBodyMaxBytes,
          mailAttachmentCache,
          mailSyncOnOpen,
          mailIdlePush,
          mailSubscribedOnly,
          mailIncoming,
          mailPop3LeaveDays,
          mailUndoSendSeconds,
          mailCardDavUrl: mailCardDavUrl.trim(),
          mailCardDavUsername: mailCardDavUsername.trim(),
          mailCalDavUrl: mailCalDavUrl.trim(),
          mailCalDavUsername: mailCalDavUsername.trim(),
          mailReceiptPolicy,
          mailSpecialFolders: JSON.stringify(parseSpecialFolders(mailSpecialFolders)),
          mailDesktopNotify,
          mailSyncIntervalMinutes,
          mailMaxFetchPerSync,
          mailSaveSentCopy,
          mailIdentities: JSON.stringify(parseMailIdentities(mailIdentityList)),
          mailAiEnabled,
          mailAiSkipBodyConfirm,
        }
      : {};
    const ossOverrides: Record<string, unknown> =
      proto === "S3"
        ? (ossConfigValue ?? { ...ossFormToConfig(oss) })
        : {};
    const hbaseOverrides: Record<string, unknown> = isHBase
      ? {
          hbaseNamespace,
          hbaseRestPath,
          hbaseConnectionMode,
          hbaseZkQuorum,
          hbaseZkRoot,
          hbaseEffectiveUser,
          hbaseAuthMethod,
          hbaseServicePrincipal,
          hbasePrincipal,
          hbaseKeytabPath,
          hbaseKrb5ConfPath,
          hbaseSitePath,
          dbSsl,
          dbTimeout,
        }
      : {};

    const terminalProfileOverrides = supportsTerminalAppearance || isMail ? { terminalProfile } : {};

    return JSON.stringify({
      ...previousOptions,
      x11, x11Trusted, compression, startupCmd,
      description, tags, doNotExit, disableAiWrite,
      remoteEnv, sshBrowser, usePrivKey,
      fileEmbedInTab, fileExtraArgs,
      ...terminalProfileOverrides,
      // SSH password vault reference (vault:<id>). Empty string means no
      // saved password; the user types it on connect.
      passwordRef: isMail && mailAuthMode === "oauth2" ? "" : passwordRefValue || "",
      // Strip the proxy password unless the user explicitly opted into
      // "Save in vault". `options_json` lands in the SQLite session row
      // in plaintext, so this is the gate keeping secrets out at rest.
      // When proxySaveAuth is on AND the value is already a vault: ref,
      // we keep it (the resolution happens server-side). The jump-host
      // password is gated the same way via jumpSaveAuth.
      networkSettings: {
        ...networkSettingsValue,
        proxyPass: networkSettingsValue.proxySaveAuth ? proxyPassValue : "",
        jumpPassword: networkSettingsValue.jumpSaveAuth ? jumpPasswordValue : "",
      },
      // SFTP deployment path mappings (only stored for SFTP sessions).
      ...(proto === "SFTP" ? { pathMappings } : {}),
      ...wslOverrides,
      ...rdpOverrides,
      ...vncOverrides,
      ...dbOverrides,
      ...proxyOverrides,
      ...mailOverrides,
      ...hbaseOverrides,
      ...ossOverrides,
      ...localShellOverrides,
      ...serialOverrides,
    });
  };

  const buildConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => {
    const now = Math.floor(Date.now() / 1000);
    let auth: AuthMethod =
      proto === "Shell" ||
      proto === "WSL" ||
      proto === "File" ||
      proto === "Browser" ||
      proto === "FTP" ||
      proto === "Telnet" ||
      proto === "Rlogin" ||
      proto === "Serial" ||
      proto === "Mosh"
        ? "None"
        : "Password";
    if (authMethod === "PrivateKey")
      auth = { PrivateKey: { key_path: keyPath || "~/.ssh/id_ed25519" } };
    else if (authMethod === "Agent") auth = "Agent";
    else if (authMethod === "None") auth = "None";

    const displayName = name
      || (proto === "WSL"
        ? t("sessionEditor2.wslDefaultName", { distro: wslOptions.distro || "Linux" })
        : proto === "S3"
          ? (oss.defaultBucket || oss.defaultContainer || oss.accountName || oss.endpoint || "Object Storage")
          : proto === "Mail"
            ? (username || host || "Mail account")
          : proto === "Serial"
            ? (serialDevice ? `Serial ${serialDevice}` : "Serial terminal")
          : (proto === "File" && host
            ? (host.split(/[\\/]/).filter(Boolean).pop() || host)
            : (host ? `${username ? username + "@" : ""}${host}` : "Local terminal")));
    const storedHost = proto === "Serial" ? serialDevice.trim() : host;
    const storedPort = proto === "Serial" ? 0 : (parseInt(port) || DEFAULT_PORTS[proto] || 0);
    return {
      id: session?.id ?? crypto.randomUUID(),
      name: displayName,
      session_type:
        proto === "S3"
          ? (engineForProvider(oss.provider) === "azure" ? "AzureBlob" : "S3")
          : protoToSessionType(proto),
      group_path: toStoredGroupPath(groupPath),
      host: storedHost,
      port: storedPort,
      username: username || null,
      auth_method: auth,
      options_json: buildOptionsJson(),
      created_at: session?.created_at ?? now,
      updated_at: now,
      last_connected_at: session?.last_connected_at ?? null,
      sort_order: session?.sort_order ?? 0,
      ...overrides,
    };
  };

  const validate = () => {
    if (needsHost && !host.trim()) return t("sessionEditor2.errHostRequired");
    if (proto === "Serial" && !serialDevice.trim()) return t("sessionEditor2.errSerialDeviceRequired");
    if (proto === "File" && !host.trim()) return t("sessionEditor2.errFilePathRequired");
    if (proto === "WSL" && !wslOptions.distro.trim()) return t("sessionEditor2.errWslDistroRequired");
    if (proto === "Presto" && !dbCatalog.trim()) return "Presto catalog is required.";
    if (proto === "Mail") {
      if (!username.trim()) return "Mail email or username is required.";
      if (!host.trim()) return "IMAP host is required.";
      if (!mailSmtpHost.trim()) return "SMTP host is required.";
      if (mailAuthMode === "oauth2") {
        if (mailProvider === "custom") return "OAuth2 mail auth requires Gmail or Outlook provider.";
        if (!mailOauthClientId.trim()) return "OAuth2 client ID is required.";
        if (mailOAuthClientSecretRequired(mailProvider, mailOauthFlow)) {
          if (!mailOauthClientSecretRef.trim() && !mailOauthClientSecret.trim()) {
            return "Gmail device code requires an OAuth2 client secret.";
          }
          if (!mailOauthClientSecretRef.trim() && mailOauthClientSecret.trim() && !mailOauthClientSecretSaveInVault) {
            return "Gmail device code client secret must be saved in the vault.";
          }
        }
        if (!mailOauthTokenRef.trim()) return "OAuth2 token is required. Use Connect OAuth2 first.";
      } else {
        if (!saveInVault) return "Mail credentials must be saved in the vault.";
        if (!passwordRef && !password) return "Mail password or app password token is required.";
        if (!mailSmtpUseImapAuth && !mailSmtpSaveInVault) return "SMTP credentials must be saved in the vault.";
        if (!mailSmtpUseImapAuth && !mailSmtpPasswordRef && !mailSmtpPassword) {
          return "SMTP password or app password token is required.";
        }
      }
    }
    if (isSSH && specifyUser && !username.trim()) return t("sessionEditor2.errUsernameEmpty");
    if (authMethod === "PrivateKey" && !keyPath.trim()) return t("sessionEditor2.errKeyPathRequired");
    if (proto === "HBaseShell") {
      if ((hbaseConnectionMode === "rest" || hbaseConnectionMode === "thrift") && !host.trim()) {
        return hbaseConnectionMode === "thrift"
          ? "HBase Thrift host is required."
          : "HBase REST host is required.";
      }
      if (hbaseConnectionMode === "native" && !hbaseSitePath.trim() && !hbaseZkQuorum.trim() && !host.trim()) {
        return "HBase ZooKeeper quorum, HBase-site.xml, or Remote host is required.";
      }
    }
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError(null);

    // If the user wants to remember the SSH/database password and typed a
    // fresh plaintext into the password field, push it into the vault first
    // and capture the resulting `vault:<id>` reference. We do this *before*
    // building the config so the reference lands in options_json.
    let nextPasswordRef = passwordRef;
    if (
      (isSSH || isDb || isHBase || proto === "RDP" || proto === "VNC" || isProxy || isMail) &&
      (isDb || isHBase || proto === "RDP" || proto === "VNC" || isProxy || isMail || authMethod === "Password") &&
      (!isMail || mailAuthMode === "password") &&
      saveInVault &&
      password.length > 0
    ) {
      // The vault must be unlocked to encrypt the password. If it is empty or
      // locked, pop the on-demand gate (set master password / unlock) instead
      // of failing with a text hint. Bail out of the save if the user cancels.
      const ready = await ensureVaultReady(t("vault.gateReasonSession"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedSave"));
        return;
      }
      try {
        const kind =
          proto === "RDP"
            ? "rdp-password"
            : proto === "VNC"
              ? "vnc-password"
            : isProxy
              ? "proxy-password"
              : isMail
                ? "mail-imap-password"
              : isHBase
                  ? "hbase-password"
                  : isDb
                    ? "db-password"
                    : "ssh-password";
        const label = `${username || "user"}@${host || "?"}:${port}`;
        const result = await vaultPut(kind, label, password);
        nextPasswordRef = result.reference;
        setPasswordRef(result.reference);
        setPassword("");
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    } else if (!saveInVault) {
      // User unchecked Save in vault: forget any previous reference.
      nextPasswordRef = "";
    }
    if (isMail && mailAuthMode === "oauth2") {
      nextPasswordRef = "";
      setPasswordRef("");
      setPassword("");
    }

    // Same dance for the proxy password when proxySaveAuth is enabled and
    // the user typed a fresh plaintext (i.e. the value isn't already a
    // vault: reference).
    let nextProxyPass = networkSettings.proxyPass;
    if (
      networkSettings.proxySaveAuth &&
      networkSettings.proxyPass.length > 0 &&
      !isVaultReference(networkSettings.proxyPass)
    ) {
      const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `proxy://${networkSettings.proxyHost}:${networkSettings.proxyPort}`;
        const result = await vaultPut("proxy-password", label, networkSettings.proxyPass);
        nextProxyPass = result.reference;
        setNetworkSettings({ ...networkSettings, proxyPass: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // And once more for the SSH jump-host password (manual mode only — when a
    // jump session is selected, its own saved credential is resolved
    // server-side and there is no separate jump password to persist).
    let nextJumpPass = networkSettings.jumpPassword;
    if (
      networkSettings.jumpSaveAuth &&
      networkSettings.jumpSessionId.trim() === "" &&
      networkSettings.jumpPassword.length > 0 &&
      !isVaultReference(networkSettings.jumpPassword)
    ) {
      const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
      if (!ready) {
        setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        return;
      }
      try {
        const label = `jump://${networkSettings.jumpUser}@${networkSettings.jumpHost}:${networkSettings.jumpPort}`;
        const result = await vaultPut("jump-password", label, networkSettings.jumpPassword);
        nextJumpPass = result.reference;
        setNetworkSettings({ ...networkSettings, jumpPassword: result.reference });
      } catch (err) {
        if (isVaultLockedError(err)) {
          setSaveError(t("sessionEditor2.errVaultLockedProxy"));
        } else {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    setPasswordRef(nextPasswordRef);

    let nextMailSmtpPasswordRef = mailSmtpPasswordRef;
    if (isMail && mailAuthMode === "password" && !mailSmtpUseImapAuth) {
      if (mailSmtpSaveInVault && mailSmtpPassword.length > 0) {
        const ready = await ensureVaultReady(t("vault.gateReasonSession"));
        if (!ready) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const label = `${mailSmtpUsername || username || "mail"}@${mailSmtpHost || "smtp"}:${mailSmtpPort || "465"}`;
          const result = await vaultPut("mail-smtp-password", label, mailSmtpPassword);
          nextMailSmtpPasswordRef = result.reference;
          setMailSmtpPasswordRef(result.reference);
          setMailSmtpPassword("");
        } catch (err) {
          if (isVaultLockedError(err)) {
            setSaveError(t("sessionEditor2.errVaultLockedSave"));
          } else {
            setSaveError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else if (!mailSmtpSaveInVault) {
        nextMailSmtpPasswordRef = "";
      }
    } else if (isMail && (mailAuthMode === "oauth2" || mailSmtpUseImapAuth)) {
      nextMailSmtpPasswordRef = "";
      setMailSmtpPasswordRef("");
      setMailSmtpPassword("");
    }

    let nextMailOauthClientSecretRef = mailOauthClientSecretRef;
    const effectiveMailOauthFlowForSave = effectiveMailOAuthFlow(mailProvider, mailOauthFlow);
    if (isMail && mailAuthMode === "oauth2" && !mailOAuthClientSecretVisible(mailProvider, effectiveMailOauthFlowForSave)) {
      nextMailOauthClientSecretRef = "";
      setMailOauthClientSecretRef("");
      setMailOauthClientSecret("");
    } else if (isMail && mailAuthMode === "oauth2") {
      if (mailOauthClientSecretSaveInVault && mailOauthClientSecret.length > 0) {
        const ready = await ensureVaultReady(t("vault.gateReasonSession"));
        if (!ready) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const label = `${username || "mail"} OAuth client secret`;
          const result = await vaultPut("mail-oauth-client-secret", label, mailOauthClientSecret);
          nextMailOauthClientSecretRef = result.reference;
          setMailOauthClientSecretRef(result.reference);
          setMailOauthClientSecret("");
        } catch (err) {
          if (isVaultLockedError(err)) {
            setSaveError(t("sessionEditor2.errVaultLockedSave"));
          } else {
            setSaveError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      } else if (!mailOauthClientSecretSaveInVault) {
        nextMailOauthClientSecretRef = "";
      }
    } else if (isMail) {
      nextMailOauthClientSecretRef = "";
      setMailOauthClientSecret("");
    }

    // Object-storage secrets: swap freshly-typed plaintext for vault refs when
    // "Save secrets in vault" is on. When off, secrets are stored as plaintext
    // in options_json (the backend resolve() accepts either form).
    let ossConfigValue: Record<string, unknown> | undefined;
    if (proto === "S3") {
      const isAzure = engineForProvider(oss.provider) === "azure";
      const label = oss.defaultBucket || oss.defaultContainer || oss.accountName || oss.endpoint || oss.provider;
      const secretFields: Array<{ key: keyof OssFormState; kind: string }> = isAzure
        ? [
            { key: "accountKey", kind: "azure-account-key" },
            { key: "sasToken", kind: "azure-sas" },
            { key: "connectionString", kind: "azure-connstr" },
            { key: "azureBearerToken", kind: "azure-bearer" },
          ]
        : [
            { key: "secretAccessKey", kind: "s3-secret-key" },
            { key: "sessionToken", kind: "s3-session-token" },
          ];
      const resolved: Record<string, string> = {};
      for (const { key, kind } of secretFields) {
        const value = oss[key] as string;
        if (!value || isVaultReference(value) || !saveInVault) {
          resolved[key] = value;
          continue;
        }
        const ready = await ensureVaultReady(t("vault.gateReasonSession"));
        if (!ready) {
          setSaveError(t("sessionEditor2.errVaultLockedSave"));
          return;
        }
        try {
          const r = await vaultPut(kind, `${kind} ${label}`, value);
          resolved[key] = r.reference;
        } catch (err) {
          if (isVaultLockedError(err)) setSaveError(t("sessionEditor2.errVaultLockedSave"));
          else setSaveError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      const next: OssFormState = { ...oss, ...(resolved as Partial<OssFormState>) };
      setOss(next);
      ossConfigValue = { ...ossFormToConfig(next) };
    }

    const config = buildConfig({
      options_json: buildOptionsJson({
        passwordRefValue: nextPasswordRef,
        proxyPassValue: nextProxyPass,
        jumpPasswordValue: nextJumpPass,
        mailSmtpPasswordRefValue: nextMailSmtpPasswordRef,
        mailOauthClientSecretRefValue: nextMailOauthClientSecretRef,
        mailOauthTokenRefValue: mailAuthMode === "oauth2" ? mailOauthTokenRef : "",
        mailOauthExpiresAtValue: mailAuthMode === "oauth2" ? mailOauthExpiresAt : "",
        mailOauthScopeValue: mailAuthMode === "oauth2" ? mailOauthScope : "",
        ossConfigValue,
      }),
    });

    try {
      if (isEdit) {
        await updateSession(config);
      } else {
        await addSession(config);
      }
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveTemplate = async () => {
    const error = validate();
    if (error) {
      setSaveError(error);
      return;
    }
    const config = buildConfig({
      id: crypto.randomUUID(),
      name: t("sessionEditor2.templateName", { base: name || host || proto }),
      group_path: "Templates",
      last_connected_at: null,
    });
    await addSession(config);
    setTestResult({ ok: true, msg: t("sessionEditor2.templateSaved") });
  };

  const handleReset = () => {
    const nextOptions = parseSessionOptions(session?.options_json);
    const nextProto = sessionTypeToProto(session?.session_type, session?.options_json);
    setProto(nextProto);
    setSection("advanced");
    setName(session?.name ?? "");
    setHost(session?.host ?? "");
    setPort(String(session?.port ?? DEFAULT_PORTS[nextProto] ?? 22));
    const nextUsername = nextProto === "Mail"
      ? session?.username ?? optionString(nextOptions, "mailEmailAddress", "")
      : session?.username ?? "";
    setUsername(nextUsername);
    setSpecifyUser(!!nextUsername || nextProto === "Mail");
    setGroupPath(toStoredGroupPath(session?.group_path ?? defaultGroupPath) ?? "");
    const nextAuth = extractAuthType(session?.auth_method);
    setAuthMethod(nextAuth);
    setAuthRadio(nextAuth === "PrivateKey" ? "privatekey" : nextAuth === "Agent" ? "agent" : nextAuth === "None" ? "gssapi" : "password");
    setKeyPath(extractKeyPath(session?.auth_method));
    setPassword("");
    const restoredRef = optionString(nextOptions, "passwordRef", "");
    setPasswordRef(restoredRef);
    setSaveInVault(!!restoredRef || nextProto === "Mail");
    setX11(optionBoolean(nextOptions, "x11", true));
    setX11Trusted(optionBoolean(nextOptions, "x11Trusted", true));
    setCompression(optionBoolean(nextOptions, "compression", false));
    setStartupCmd(optionString(nextOptions, "startupCmd", ""));
    setDoNotExit(optionBoolean(nextOptions, "doNotExit", true));
    setDisableAiWrite(optionBoolean(nextOptions, "disableAiWrite", false));
    setRemoteEnv(optionString(nextOptions, "remoteEnv", "Interactive shell"));
    setSshBrowser(optionString(nextOptions, "sshBrowser", "SFTP protocol (recommended)"));
    setUsePrivKey(nextAuth === "PrivateKey");
    setDescription(optionString(nextOptions, "description", ""));
    setTags(optionString(nextOptions, "tags", ""));
    setFileEmbedInTab(optionBoolean(nextOptions, "fileEmbedInTab", true));
    setFileExtraArgs(optionString(nextOptions, "fileExtraArgs", ""));
    setDbCatalog(optionString(nextOptions, "dbCatalog", ""));
    setDbDatabase(optionString(nextOptions, "dbDatabase", ""));
    setDbSsl(optionBoolean(nextOptions, "dbSsl", false));
    setDbTimeout(optionString(nextOptions, "dbTimeout", "15"));
    setDbHttpPort(optionString(nextOptions, "dbHttpPort", "8123"));
    setDbChProtocol(optionString(nextOptions, "dbChProtocol", "HTTP"));
    {
      const dialect = optionString(nextOptions, "dbPrestoDialect", "presto").toLowerCase();
      setDbPrestoDialect(dialect === "trino" ? "Trino" : "Presto");
    }
    setDbRedisIndex(optionString(nextOptions, "dbRedisIndex", "0"));
    setHBaseNamespace(optionString(nextOptions, "hbaseNamespace", ""));
    setHBaseRestPath(optionString(nextOptions, "hbaseRestPath", ""));
    setHBaseConnectionMode(optionString(nextOptions, "hbaseConnectionMode", "native"));
    setHBaseZkQuorum(optionString(nextOptions, "hbaseZkQuorum", ""));
    setHBaseZkRoot(optionString(nextOptions, "hbaseZkRoot", ""));
    setHBaseEffectiveUser(optionString(nextOptions, "hbaseEffectiveUser", ""));
    setHBaseAuthMethod(optionString(nextOptions, "hbaseAuthMethod", "simple"));
    setHBaseServicePrincipal(optionString(nextOptions, "hbaseServicePrincipal", ""));
    setHBasePrincipal(optionString(nextOptions, "hbasePrincipal", ""));
    setHBaseKeytabPath(optionString(nextOptions, "hbaseKeytabPath", ""));
    setHBaseKrb5ConfPath(optionString(nextOptions, "hbaseKrb5ConfPath", ""));
    setHBaseSitePath(optionString(nextOptions, "hbaseSitePath", ""));
    setTerminalProfile(initialTerminalProfileForProto(session?.options_json, nextProto));
    setNetworkSettings(getSessionNetworkSettings(session?.options_json));
    setSerialDevice(session?.session_type === "Serial" ? session.host : optionString(nextOptions, "serialDevice", ""));
    setSerialBaud(optionString(nextOptions, "serialBaud", "115200"));
    setLocalShellOptions(parseLocalShellOptions(session?.options_json));
    setWslOptions(parseWslOptions(session?.options_json));
    setRdpOptions(parseRdpOptions(session?.options_json));
    {
      const policy = optionString(nextOptions, "vncSecurityPolicy", "prefer-encryption");
      setVncSecurityPolicy(
        policy === "require-encryption" || policy === "legacy-compatible" || policy === "allow-none"
          || policy === "prefer-off"
          ? policy
          : "prefer-encryption",
      );
    }
    setVncViewOnly(optionBoolean(nextOptions, "vncViewOnly", false));
    setVncViewer(parseVncViewerOptions(nextOptions));
    {
      const policy = optionString(nextOptions, "vncClipboardPolicy", "bidirectional");
      setVncClipboardPolicy(
        policy === "disabled" || policy === "client-to-server" || policy === "server-to-client"
          ? policy
          : "bidirectional",
      );
    }
    setPathMappings(parsePathMappingsFromOptions(session?.options_json));
    const restoredMailProvider = initialMailProvider(nextOptions, session?.host);
    setMailProvider(restoredMailProvider);
    setMailAuthMode(normalizeMailAuthMode(nextOptions.mailAuthMode));
    setMailDisplayName(optionString(nextOptions, "mailDisplayName", ""));
    setMailReplyTo(optionString(nextOptions, "mailReplyTo", ""));
    setMailSignature(optionString(nextOptions, "mailSignature", ""));
    setMailImapSecurity((() => {
      const value = optionString(nextOptions, "mailImapSecurity", "TLS");
      return value === "STARTTLS" || value === "None" ? value : "TLS";
    })());
    setMailSmtpHost(optionString(nextOptions, "mailSmtpHost", ""));
    setMailSmtpPort(optionString(nextOptions, "mailSmtpPort", "465"));
    setMailSmtpSecurity((() => {
      const value = optionString(nextOptions, "mailSmtpSecurity", "TLS");
      return value === "STARTTLS" || value === "None" ? value : "TLS";
    })());
    setMailSmtpUsername(optionString(nextOptions, "mailSmtpUsername", ""));
    setMailSmtpUseImapAuth(optionBoolean(nextOptions, "mailSmtpUseImapAuth", true));
    setMailSmtpPassword("");
    const restoredSmtpRef = optionString(nextOptions, "mailSmtpPasswordRef", "");
    setMailSmtpPasswordRef(restoredSmtpRef);
    setMailSmtpSaveInVault(!!restoredSmtpRef || nextProto === "Mail");
    setMailOauthClientId(optionString(nextOptions, "mailOauthClientId", ""));
    setMailOauthClientSecret("");
    const restoredOauthSecretRef = optionString(nextOptions, "mailOauthClientSecretRef", "");
    setMailOauthClientSecretRef(restoredOauthSecretRef);
    setMailOauthClientSecretSaveInVault(!!restoredOauthSecretRef || nextProto === "Mail");
    setMailOauthFlow(initialMailOAuthFlow(nextOptions, restoredMailProvider));
    setMailOauthDeviceInfo(null);
    setMailOauthTokenRef(optionString(nextOptions, "mailOauthTokenRef", ""));
    setMailOauthExpiresAt(optionStringOrNumber(nextOptions, "mailOauthExpiresAt", ""));
    setMailOauthScope(optionString(nextOptions, "mailOauthScope", ""));
    setMailOauthStatus(null);
    setMailCacheEnabled(optionBoolean(nextOptions, "mailCacheEnabled", true));
    setMailSaveDirectory(optionString(nextOptions, "mailSaveDirectory", ""));
    setMailStorage(mailStorageOptions(nextOptions));
    setMailHeaderRetentionDays(String(mailHeaderLimitOption(nextOptions, "mailHeaderRetentionDays", 30)));
    setMailHeaderLimitPerFolder(String(mailHeaderLimitOption(nextOptions, "mailHeaderLimitPerFolder", 2000)));
    setMailBodyRecentLimit(optionString(nextOptions, "mailBodyRecentLimit", "200"));
    setMailBodyMaxBytes(optionString(nextOptions, "mailBodyMaxBytes", "262144"));
    setMailAttachmentCache(optionBoolean(nextOptions, "mailAttachmentCache", false));
    setMailSyncOnOpen(optionBoolean(nextOptions, "mailSyncOnOpen", true));
    setMailIdlePush(optionBoolean(nextOptions, "mailIdlePush", true));
    setMailSubscribedOnly(optionBoolean(nextOptions, "mailSubscribedOnly", false));
    setMailIncoming(optionString(nextOptions, "mailIncoming", "imap") === "pop3" ? "pop3" : "imap");
    setMailPop3LeaveDays(optionString(nextOptions, "mailPop3LeaveDays", ""));
    setMailUndoSendSeconds(optionString(nextOptions, "mailUndoSendSeconds", "0"));
    setMailCardDavUrl(optionString(nextOptions, "mailCardDavUrl", ""));
    setMailCardDavUsername(optionString(nextOptions, "mailCardDavUsername", ""));
    setMailCalDavUrl(optionString(nextOptions, "mailCalDavUrl", ""));
    setMailCalDavUsername(optionString(nextOptions, "mailCalDavUsername", ""));
    setMailReceiptPolicy(optionString(nextOptions, "mailReceiptPolicy", "ask"));
    setMailSpecialFolders(parseSpecialFolders(nextOptions.mailSpecialFolders));
    setMailDesktopNotify(optionBoolean(nextOptions, "mailDesktopNotify", false));
    setMailSyncIntervalMinutes(optionString(nextOptions, "mailSyncIntervalMinutes", "5"));
    setMailMaxFetchPerSync(optionString(nextOptions, "mailMaxFetchPerSync", "200"));
    setMailSaveSentCopy(optionString(nextOptions, "mailSaveSentCopy", "auto"));
    setMailIdentityList(parseMailIdentities(nextOptions.mailIdentities));
    setMailAiEnabled(optionBoolean(nextOptions, "mailAiEnabled", true));
    setMailAiSkipBodyConfirm(optionBoolean(nextOptions, "mailAiSkipBodyConfirm", false));
    setOss(ossFormFromOptions(session?.options_json));
    setSaveError(null);
    setTestResult(null);
  };

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
      const selected = await selectFolderPath(mailSaveDirectory || undefined);
      if (selected) setMailSaveDirectory(selected.trim());
    } catch (err) {
      setSaveError(`Failed to choose mail save directory: ${String(err)}`);
    }
  };

  const handleMailOAuthConnect = async () => {
    setMailOauthStatus(null);
    if (!supportsMailOAuthProvider(mailProvider)) {
      setMailOauthStatus({ ok: false, msg: "Select Gmail or Outlook first." });
      return;
    }
    const oauthProvider = mailProvider;
    const oauthProviderLabel = oauthProvider === "gmail" ? "Gmail" : "Outlook";
    const selectedMailOauthFlow = effectiveMailOAuthFlow(oauthProvider, mailOauthFlow);
    if (!username.trim()) {
      setMailOauthStatus({ ok: false, msg: "Enter the mail email address first." });
      return;
    }
    if (!mailOauthClientId.trim()) {
      setMailOauthStatus({ ok: false, msg: "Enter the OAuth2 client ID first." });
      return;
    }
    const oauthClientSecretValue = mailOauthClientSecret || mailOauthClientSecretRef || null;
    if (mailOAuthClientSecretRequired(oauthProvider, selectedMailOauthFlow) && !oauthClientSecretValue) {
      setMailOauthStatus({ ok: false, msg: "Enter the OAuth2 client secret first." });
      return;
    }
    const ready = await ensureVaultReady(t("vault.gateReasonSession"));
    if (!ready) {
      setMailOauthStatus({ ok: false, msg: t("sessionEditor2.errVaultLockedSave") });
      return;
    }

    setMailOauthConnecting(true);
    setMailOauthDeviceInfo(null);
    try {
      const sessionId = session?.id ?? (username.trim() || "mail-editor");
      const networkPayload =
        networkSettings.proxyKind !== "none"
          ? toNetworkSettingsPayload(networkSettings)
          : null;
      const result = selectedMailOauthFlow === "device"
        ? await (async () => {
            const device = await mailOAuthDeviceStart({
              sessionId,
              provider: oauthProvider,
              emailAddress: username.trim(),
              clientId: mailOauthClientId.trim(),
              networkSettings: networkPayload,
            });
            setMailOauthDeviceInfo({
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              message: device.message,
              expiresIn: device.expiresIn,
            });
            setMailOauthStatus({
              ok: true,
              msg: `Enter code ${device.userCode} to approve ${oauthProviderLabel} access.`,
            });
            return mailOAuthDeviceComplete({
              sessionId,
              provider: oauthProvider,
              emailAddress: username.trim(),
              clientId: mailOauthClientId.trim(),
              clientSecret: oauthProvider === "gmail" ? oauthClientSecretValue : null,
              deviceCode: device.deviceCode,
              interval: device.interval,
              expiresIn: device.expiresIn,
              networkSettings: networkPayload,
            });
        })()
        : await mailOAuthAuthorize({
            sessionId,
            provider: oauthProvider,
            emailAddress: username.trim(),
            clientId: mailOauthClientId.trim(),
            clientSecret: oauthClientSecretValue,
            networkSettings: networkPayload,
          });
      setMailAuthMode("oauth2");
      setMailOauthTokenRef(result.tokenRef);
      setMailOauthExpiresAt(result.expiresAt ? String(result.expiresAt) : "");
      setMailOauthScope(result.scope ?? "");
      setMailOauthDeviceInfo(null);
      setMailOauthStatus({ ok: true, msg: "OAuth2 connected." });
    } catch (err) {
      setMailOauthStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setMailOauthConnecting(false);
    }
  };

  const handleNewFolder = async () => {
    const next = await promptAppDialog({
      title: t("sessionEditor2.promptNewFolder"),
      initialValue: groupPath || t("sessionEditor2.promptNewFolderDefault"),
      allowEmpty: true,
    });
    const normalized = normalizeGroupPath(next);
    if (!normalized) return;
    setGroupPath(toStoredGroupPath(normalized) ?? "");
    void createFolderPath(normalized);
  };

  const handleDelete = async () => {
    if (!session) return;
    const confirmed = await confirmAppDialog({
      title: t("sessionEditor2.confirmDeleteTitle"),
      message: t("sessionEditor2.confirmDeleteMessage", { name: session.name }),
      confirmLabel: t("sessionEditor2.delete"),
      danger: true,
    });
    if (!confirmed) return;
    await removeSession(session.id);
    onClose();
  };

  const handleTestConnection = async () => {
    if (!host || !username) {
      presentTestOutcome(false, t("sessionEditor2.testHostUserRequired"));
      return;
    }
    const passwordAuthData = password || passwordRef;
    if (authMethod === "Password" && !passwordAuthData) {
      presentTestOutcome(false, t("sessionEditor2.testEnterPassword"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      let authData: string | null = null;
      if (authMethod === "Password") authData = passwordAuthData;
      else if (authMethod === "PrivateKey")
        authData = keyPath || "~/.ssh/id_ed25519";
      const msg = await testSshConnection(
        host,
        parseInt(port) || 22,
        username,
        authMethod,
        authData,
        JSON.stringify(toNetworkSettingsPayload(networkSettings)),
      );
      presentTestOutcome(true, msg);
    } catch (err) {
      presentTestOutcome(false, formatUnknownError(err));
    } finally {
      setTesting(false);
    }
  };

  /** Build a one-shot `DbConnectInfo` from the current editor state. The
   *  password prefers the freshly-typed plaintext, falling back to a saved
   *  vault reference (resolved server-side). */
  const buildDbConnectInfo = (): DbConnectInfo => ({
    sessionId: session?.id ?? "db-editor-test",
    engine: proto as DbConnectInfo["engine"],
    host,
    port: parseInt(port) || DEFAULT_PORTS[proto] || 0,
    username: username || null,
    password: password || passwordRef || undefined,
    catalog: proto === "Presto" ? dbCatalog || null : null,
    database: dbDatabase || null,
    ssl: dbSsl,
    timeoutSecs: parseInt(dbTimeout) || null,
    httpPort: proto === "ClickHouse" ? parseInt(dbHttpPort) || 8123 : null,
    protocol: proto === "ClickHouse" ? dbChProtocol.toLowerCase() : null,
    prestoDialect:
      proto === "Presto"
        ? (dbPrestoDialect.toLowerCase() === "trino" ? "trino" : "presto")
        : null,
    dbIndex: proto === "Redis" ? parseInt(dbRedisIndex) || 0 : null,
    // Route the test probe through the same proxy / SSH jump host the saved
    // connection uses. Only attach when a proxy/jump is actually selected so a
    // direct connection skips the backend loopback forwarder entirely (mirrors
    // sessionToDbConnectInfo in MainLayout).
    networkSettings:
      networkSettings.proxyKind !== "none"
        ? toNetworkSettingsPayload(networkSettings)
        : null,
  });

  const buildHBaseConnectInfo = (): HBaseConnectInfo => ({
    sessionId: session?.id ?? "hbase-editor-test",
    host,
    port: parseInt(port) || DEFAULT_PORTS.HBaseShell,
    username: username || null,
    password: password || passwordRef || undefined,
    ssl: dbSsl,
    timeoutSecs: parseInt(dbTimeout) || null,
    restPath: hbaseRestPath || null,
    namespace: hbaseNamespace || null,
    connectionMode:
      hbaseConnectionMode === "rest"
        ? "rest"
        : hbaseConnectionMode === "thrift"
          ? "thrift"
          : "native",
    zkQuorum: hbaseZkQuorum || null,
    zkRoot: hbaseZkRoot || null,
    effectiveUser: hbaseEffectiveUser || null,
    authMethod: hbaseAuthMethod === "kerberos" ? "kerberos" : "simple",
    servicePrincipal: hbaseServicePrincipal || null,
    principal: hbasePrincipal || null,
    keytabPath: hbaseKeytabPath || null,
    krb5ConfPath: hbaseKrb5ConfPath || null,
    hbaseSitePath: hbaseSitePath || null,
  });

  const handleTestDbConnection = async () => {
    if (!host) {
      presentTestOutcome(false, t("sessionEditor2.errHostRequired"));
      return;
    }
    if (proto === "Presto" && !dbCatalog.trim()) {
      presentTestOutcome(false, "Presto catalog is required.");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await dbTestConnection(buildDbConnectInfo());
      presentTestOutcome(true, msg);
    } catch (err) {
      presentTestOutcome(false, formatUnknownError(err));
    } finally {
      setTesting(false);
    }
  };

  const handleTestHBaseConnection = async () => {
    // Mirror the save-path validation: REST/Thrift need a host; native needs a
    // ZK quorum, an hbase-site.xml, or a host (host/port hidden in native mode).
    if ((hbaseConnectionMode === "rest" || hbaseConnectionMode === "thrift") && !host.trim()) {
      presentTestOutcome(
        false,
        hbaseConnectionMode === "thrift"
          ? "HBase Thrift host is required."
          : "HBase REST host is required.",
      );
      return;
    }
    if (
      hbaseConnectionMode === "native" &&
      !hbaseSitePath.trim() &&
      !hbaseZkQuorum.trim() &&
      !host.trim()
    ) {
      presentTestOutcome(
        false,
        "HBase ZooKeeper quorum, HBase-site.xml, or Remote host is required.",
      );
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await hbaseTestConnection(buildHBaseConnectInfo());
      presentTestOutcome(true, msg);
    } catch (err) {
      presentTestOutcome(false, formatUnknownError(err));
    } finally {
      setTesting(false);
    }
  };

  const handleTestProxyConnection = async () => {
    if (!host) {
      presentTestOutcome(false, t("sessionEditor2.proxyHostRequired"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const [testHost, testPortStr] = (proxyTestUrl || "www.google.com:443").split(":");
      const testPort = parseInt(testPortStr) || 443;
      const msg = await testProxyConnection(
        proxyKind,
        host,
        parseInt(port) || 3128,
        username || "",
        password || passwordRef || "",
        testHost,
        testPort,
      );
      presentTestOutcome(true, msg);
    } catch (err) {
      presentTestOutcome(false, formatUnknownError(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSaveAsProxySession = async () => {
    const ns = networkSettings;
    if (!ns.proxyHost.trim()) {
      setTestResult({ ok: false, msg: t("sessionEditor2.proxyHostRequired") });
      return;
    }
    const proxyPort = parseInt(ns.proxyPort) || 3128;
    const now = Math.floor(Date.now() / 1000);
    const proxyName = `${ns.proxyKind === "http" ? "HTTP" : "SOCKS5"} ${ns.proxyHost}:${proxyPort}`;

    // Carry the proxy password into the new Proxy session as a vault reference,
    // mirroring how SSH passwords live in options_json.passwordRef. An existing
    // vault: ref is reused as-is; fresh plaintext is encrypted first (which may
    // require unlocking / creating the vault). Bail out if the gate is cancelled
    // so we never drop the secret on the floor or store it in plaintext at rest.
    let proxyPasswordRef = "";
    if (ns.proxyPass.length > 0) {
      if (isVaultReference(ns.proxyPass)) {
        proxyPasswordRef = ns.proxyPass;
      } else {
        const ready = await ensureVaultReady(t("vault.gateReasonProxy"));
        if (!ready) {
          setTestResult({ ok: false, msg: t("sessionEditor2.errVaultLockedProxy") });
          return;
        }
        try {
          const label = `proxy://${ns.proxyHost}:${proxyPort}`;
          const result = await vaultPut("proxy-password", label, ns.proxyPass);
          proxyPasswordRef = result.reference;
        } catch (err) {
          setTestResult({
            ok: false,
            msg: isVaultLockedError(err)
              ? t("sessionEditor2.errVaultLockedProxy")
              : err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    }

    const config: SessionConfig = {
      id: crypto.randomUUID(),
      name: proxyName,
      session_type: "Proxy",
      group_path: null,
      host: ns.proxyHost.trim(),
      port: proxyPort,
      username: ns.proxyUser || null,
      auth_method: ns.proxyUser ? "Password" : "None",
      options_json: JSON.stringify({
        proxyKind: ns.proxyKind === "http" ? "http" : "socks5",
        testUrl: "www.google.com:443",
        ...(proxyPasswordRef ? { passwordRef: proxyPasswordRef } : {}),
      }),
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      sort_order: 0,
    };
    try {
      await addSession(config);
      setTestResult({ ok: true, msg: t("sessionEditor2.proxySessionSaved") });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    }
  };

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
              options={localShellOptions}
              shells={localShells}
              status={localShellStatus}
              onChange={setLocalShellOptions}
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
              options={wslOptions}
              distros={wslDistros}
              status={wslStatus}
              onChange={setWslOptions}
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
                provider={mailProvider} setProvider={handleMailProviderChange}
                authMode={mailAuthMode} setAuthMode={setMailAuthMode}
                imapHost={host} setImapHost={setHost}
                imapPort={port} setImapPort={setPort}
                username={username} setUsername={(value) => { setUsername(value); setSpecifyUser(true); }}
                password={password} setPassword={setPassword}
                passwordRef={passwordRef} clearPasswordRef={() => setPasswordRef("")}
                saveInVault={saveInVault} setSaveInVault={setSaveInVault}
                displayName={mailDisplayName} setDisplayName={setMailDisplayName}
                replyTo={mailReplyTo} setReplyTo={setMailReplyTo}
                signature={mailSignature} setSignature={setMailSignature}
                imapSecurity={mailImapSecurity} setImapSecurity={setMailImapSecurity}
                smtpHost={mailSmtpHost} setSmtpHost={setMailSmtpHost}
                smtpPort={mailSmtpPort} setSmtpPort={setMailSmtpPort}
                smtpSecurity={mailSmtpSecurity} setSmtpSecurity={setMailSmtpSecurity}
                smtpUsername={mailSmtpUsername} setSmtpUsername={setMailSmtpUsername}
                smtpUseImapAuth={mailSmtpUseImapAuth} setSmtpUseImapAuth={setMailSmtpUseImapAuth}
                smtpPassword={mailSmtpPassword} setSmtpPassword={setMailSmtpPassword}
                smtpPasswordRef={mailSmtpPasswordRef} clearSmtpPasswordRef={() => setMailSmtpPasswordRef("")}
                smtpSaveInVault={mailSmtpSaveInVault} setSmtpSaveInVault={setMailSmtpSaveInVault}
                oauthClientId={mailOauthClientId} setOauthClientId={setMailOauthClientId}
                oauthClientSecret={mailOauthClientSecret} setOauthClientSecret={setMailOauthClientSecret}
                oauthClientSecretRef={mailOauthClientSecretRef} clearOauthClientSecretRef={() => setMailOauthClientSecretRef("")}
                oauthClientSecretSaveInVault={mailOauthClientSecretSaveInVault} setOauthClientSecretSaveInVault={setMailOauthClientSecretSaveInVault}
                oauthFlow={mailOauthFlow} setOauthFlow={(value) => {
                  setMailOauthFlow(value);
                  setMailOauthDeviceInfo(null);
                  setMailOauthStatus(null);
                }}
                oauthDeviceInfo={mailOauthDeviceInfo}
                oauthTokenRef={mailOauthTokenRef}
                oauthExpiresAt={mailOauthExpiresAt}
                oauthScope={mailOauthScope}
                oauthConnecting={mailOauthConnecting}
                oauthStatus={mailOauthStatus}
                onOAuthConnect={() => void handleMailOAuthConnect()}
                cacheEnabled={mailCacheEnabled} setCacheEnabled={setMailCacheEnabled}
                storage={mailStorage} setStorage={setMailStorage} accountId={session?.id}
                saveDirectory={mailSaveDirectory} setSaveDirectory={setMailSaveDirectory}
                onBrowseSaveDirectory={() => void handleBrowseMailSaveDirectory()}
                headerRetentionDays={mailHeaderRetentionDays} setHeaderRetentionDays={setMailHeaderRetentionDays}
                headerLimitPerFolder={mailHeaderLimitPerFolder} setHeaderLimitPerFolder={setMailHeaderLimitPerFolder}
                bodyRecentLimit={mailBodyRecentLimit} setBodyRecentLimit={setMailBodyRecentLimit}
                bodyMaxBytes={mailBodyMaxBytes} setBodyMaxBytes={setMailBodyMaxBytes}
                attachmentCache={mailAttachmentCache} setAttachmentCache={setMailAttachmentCache}
                syncOnOpen={mailSyncOnOpen} setSyncOnOpen={setMailSyncOnOpen}
                idlePush={mailIdlePush} setIdlePush={setMailIdlePush}
                subscribedOnly={mailSubscribedOnly} setSubscribedOnly={setMailSubscribedOnly}
                incoming={mailIncoming} setIncoming={setMailIncoming}
                pop3LeaveDays={mailPop3LeaveDays} setPop3LeaveDays={setMailPop3LeaveDays}
                undoSendSeconds={mailUndoSendSeconds} setUndoSendSeconds={setMailUndoSendSeconds}
                cardDavUrl={mailCardDavUrl} setCardDavUrl={setMailCardDavUrl}
                cardDavUsername={mailCardDavUsername} setCardDavUsername={setMailCardDavUsername}
                calDavUrl={mailCalDavUrl} setCalDavUrl={setMailCalDavUrl}
                calDavUsername={mailCalDavUsername} setCalDavUsername={setMailCalDavUsername}
                receiptPolicy={mailReceiptPolicy} setReceiptPolicy={setMailReceiptPolicy}
                specialFolders={mailSpecialFolders} setSpecialFolders={setMailSpecialFolders}
                desktopNotify={mailDesktopNotify} setDesktopNotify={setMailDesktopNotify}
                syncIntervalMinutes={mailSyncIntervalMinutes} setSyncIntervalMinutes={setMailSyncIntervalMinutes}
                maxFetchPerSync={mailMaxFetchPerSync} setMaxFetchPerSync={setMailMaxFetchPerSync}
                saveSentCopy={mailSaveSentCopy} setSaveSentCopy={setMailSaveSentCopy}
                identities={mailIdentityList} setIdentities={setMailIdentityList}
                aiEnabled={mailAiEnabled} setAiEnabled={setMailAiEnabled}
                aiSkipBodyConfirm={mailAiSkipBodyConfirm} setAiSkipBodyConfirm={setMailAiSkipBodyConfirm}
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
                catalog={dbCatalog} setCatalog={setDbCatalog}
                database={dbDatabase} setDatabase={setDbDatabase}
                ssl={dbSsl} setSsl={setDbSsl}
                timeoutSecs={dbTimeout} setTimeoutSecs={setDbTimeout}
                httpPort={dbHttpPort} setHttpPort={setDbHttpPort}
                chProtocol={dbChProtocol} setChProtocol={setDbChProtocol}
                prestoDialect={dbPrestoDialect} setPrestoDialect={setDbPrestoDialect}
                redisDbIndex={dbRedisIndex} setRedisDbIndex={setDbRedisIndex}
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
                namespace={hbaseNamespace} setNamespace={setHBaseNamespace}
                restPath={hbaseRestPath} setRestPath={setHBaseRestPath}
                connectionMode={hbaseConnectionMode} setConnectionMode={setHBaseConnectionMode}
                zkQuorum={hbaseZkQuorum} setZkQuorum={setHBaseZkQuorum}
                zkRoot={hbaseZkRoot} setZkRoot={setHBaseZkRoot}
                effectiveUser={hbaseEffectiveUser} setEffectiveUser={setHBaseEffectiveUser}
                ssl={dbSsl} setSsl={setDbSsl}
                timeoutSecs={dbTimeout} setTimeoutSecs={setDbTimeout}
                authMethod={hbaseAuthMethod} setAuthMethod={setHBaseAuthMethod}
                servicePrincipal={hbaseServicePrincipal} setServicePrincipal={setHBaseServicePrincipal}
                principal={hbasePrincipal} setPrincipal={setHBasePrincipal}
                keytabPath={hbaseKeytabPath} setKeytabPath={setHBaseKeytabPath}
                krb5ConfPath={hbaseKrb5ConfPath} setKrb5ConfPath={setHBaseKrb5ConfPath}
                hbaseSitePath={hbaseSitePath} setHBaseSitePath={setHBaseSitePath}
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
