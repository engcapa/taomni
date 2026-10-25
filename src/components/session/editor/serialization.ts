import { remoteEnvironment } from "../../../lib/sshSessionOptions";
import type { SessionBookmark } from "../../../lib/sessionBookmark";
import { cleanSessionOptions, sessionCapabilities } from "../../../lib/sessionCapabilities";
import { MAIL_HEADER_LIMITS_EXPLICIT_KEY } from "../../../lib/mailSync";
import { parseSpecialFolders } from "../../../lib/mailFolders";
import { parseMailIdentities } from "../../../lib/mailIdentities";
import { type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import { toStoredGroupPath } from "../../../lib/sessionPaths";
import type { SessionConfig, AuthMethod } from "../../../lib/ipc";
import { parseSessionOptions, type TerminalProfile } from "../../../lib/terminalProfile";
import { buildWslLaunchArgs, serializeWslOptions } from "../../../types/wsl";
import { serializeRdpOptions, type RdpOptions } from "../../../types/rdp";
import { serializeLocalShellOptions } from "../../../types/localShell";
import { ossFormToConfig, type OssFormState } from "../ObjectStorageSettings";
import { engineForProvider } from "../../../types/objectStorage";
import { writeVncViewerOptions, type VncViewerOptions } from "../../../lib/vncOptions";
import type { SftpPathMapping } from "../../../types";
import {
  type Proto,
  DEFAULT_PORTS,
  protoToSessionType,
  stripSerialOptions,
  stripLocalShellLaunchOptions,
  stripDeprecatedCwdOptions,
  stripTerminalProfileOption,
} from "./sessionPolicy";
import { type MailProvider, stripMailIdentityOptions, effectiveMailOAuthFlow, mailOAuthClientSecretVisible, mailOAuthClientSecretRequired } from "./mailPolicy";


export interface CreateSessionSerializationContext {
  bookmark: SessionBookmark;
  passwordRef: string;
  networkSettings: NetworkSettingsValue;
  mailForm: { setMailSmtpSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailProvider: import("react").Dispatch<import("react").SetStateAction<MailProvider>>; setMailAuthMode: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailAuthMode>>; setMailOauthFlow: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailOAuthFlow>>; setMailOauthDeviceInfo: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailOAuthDeviceInfo | null>>; setMailOauthStatus: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>; setMailImapSecurity: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailSecurityMode>>; setMailSmtpHost: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpPort: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpSecurity: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailSecurityMode>>; setMailSmtpUseImapAuth: import("react").Dispatch<import("react").SetStateAction<boolean>>; mailSmtpPasswordRef: string; mailOauthClientSecretRef: string; mailOauthTokenRef: string; mailOauthExpiresAt: string; mailOauthScope: string; mailProvider: MailProvider; mailOauthFlow: import("./mailPolicy").MailOAuthFlow; mailAuthMode: import("./mailPolicy").MailAuthMode; mailOauthClientId: string; mailDisplayName: string; mailReplyTo: string; mailSignature: string; mailImapSecurity: import("./mailPolicy").MailSecurityMode; mailSmtpHost: string; mailSmtpPort: string; mailSmtpSecurity: import("./mailPolicy").MailSecurityMode; mailSmtpUsername: string; mailSmtpUseImapAuth: boolean; mailCacheEnabled: boolean; mailSaveDirectory: string; mailStorage: import("../../mail/MailStorageSettings").MailStorageOptions; mailHeaderRetentionDays: string; mailHeaderLimitPerFolder: string; mailBodyRecentLimit: string; mailBodyMaxBytes: string; mailAttachmentCache: boolean; mailSyncOnOpen: boolean; mailIdlePush: boolean; mailSubscribedOnly: boolean; mailIncoming: "imap" | "pop3"; mailPop3LeaveDays: string; mailUndoSendSeconds: string; mailCardDavUrl: string; mailCardDavUsername: string; mailCalDavUrl: string; mailCalDavUsername: string; mailReceiptPolicy: string; mailSpecialFolders: Partial<Record<import("../../../lib/mailFolders").MailSpecialFolderKey, string>>; mailDesktopNotify: boolean; mailSyncIntervalMinutes: string; mailMaxFetchPerSync: string; mailSaveSentCopy: string; mailIdentityList: import("../../../types").MailIdentity[]; mailAiEnabled: boolean; mailAiSkipBodyConfirm: boolean; mailOauthClientSecret: string; mailOauthClientSecretSaveInVault: boolean; mailSmtpSaveInVault: boolean; mailSmtpPassword: string; setMailSmtpPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpPassword: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecretRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecret: import("react").Dispatch<import("react").SetStateAction<string>>; setMailDisplayName: import("react").Dispatch<import("react").SetStateAction<string>>; setMailReplyTo: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSignature: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientId: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecretSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailOauthTokenRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthExpiresAt: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthScope: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCacheEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSaveDirectory: import("react").Dispatch<import("react").SetStateAction<string>>; setMailStorage: import("react").Dispatch<import("react").SetStateAction<import("../../mail/MailStorageSettings").MailStorageOptions>>; setMailHeaderRetentionDays: import("react").Dispatch<import("react").SetStateAction<string>>; setMailHeaderLimitPerFolder: import("react").Dispatch<import("react").SetStateAction<string>>; setMailBodyRecentLimit: import("react").Dispatch<import("react").SetStateAction<string>>; setMailBodyMaxBytes: import("react").Dispatch<import("react").SetStateAction<string>>; setMailAttachmentCache: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSyncOnOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailIdlePush: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSubscribedOnly: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailIncoming: import("react").Dispatch<import("react").SetStateAction<"imap" | "pop3">>; setMailPop3LeaveDays: import("react").Dispatch<import("react").SetStateAction<string>>; setMailUndoSendSeconds: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCardDavUrl: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCardDavUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCalDavUrl: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCalDavUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailReceiptPolicy: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSpecialFolders: import("react").Dispatch<import("react").SetStateAction<Partial<Record<import("../../../lib/mailFolders").MailSpecialFolderKey, string>>>>; setMailDesktopNotify: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSyncIntervalMinutes: import("react").Dispatch<import("react").SetStateAction<string>>; setMailMaxFetchPerSync: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSaveSentCopy: import("react").Dispatch<import("react").SetStateAction<string>>; setMailIdentityList: import("react").Dispatch<import("react").SetStateAction<import("../../../types").MailIdentity[]>>; setMailAiEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailAiSkipBodyConfirm: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailOauthConnecting: import("react").Dispatch<import("react").SetStateAction<boolean>>; mailOauthDeviceInfo: import("./mailPolicy").MailOAuthDeviceInfo | null; mailOauthConnecting: boolean; mailOauthStatus: { ok: boolean; msg: string; } | null; };
  session: SessionConfig | undefined;
  supportsTerminalAppearance: boolean;
  isMail: boolean;
  proto: Proto;
  shellForm: { localShellOptions: import("../../../types/localShell").LocalShellOptions; wslOptions: import("../../../types/wsl").WslOptions; setLocalShellOptions: import("react").Dispatch<import("react").SetStateAction<import("../../../types/localShell").LocalShellOptions>>; setWslOptions: import("react").Dispatch<import("react").SetStateAction<import("../../../types/wsl").WslOptions>>; localShells: import("../../../lib/ipc").LocalShellOption[]; localShellStatus: "loading" | "ready" | "error"; wslDistros: import("../../../lib/ipc").WslDistro[]; wslStatus: "loading" | "ready" | "error" | "unsupported"; };
  serialDevice: string;
  serialBaud: string;
  rdpOptions: RdpOptions;
  vncSecurityPolicy: "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" | "prefer-off";
  vncViewOnly: boolean;
  vncClipboardPolicy: "disabled" | "client-to-server" | "server-to-client" | "bidirectional";
  vncViewer: VncViewerOptions;
  isDb: boolean;
  databaseForm: { dbDatabase: string; dbCatalog: string; dbSsl: boolean; dbTimeout: string; dbHttpPort: string; dbChProtocol: string; dbPrestoDialect: string; dbRedisIndex: string; hbaseNamespace: string; hbaseRestPath: string; hbaseConnectionMode: string; hbaseZkQuorum: string; hbaseZkRoot: string; hbaseEffectiveUser: string; hbaseAuthMethod: string; hbaseServicePrincipal: string; hbasePrincipal: string; hbaseKeytabPath: string; hbaseKrb5ConfPath: string; hbaseSitePath: string; setDbCatalog: import("react").Dispatch<import("react").SetStateAction<string>>; setDbDatabase: import("react").Dispatch<import("react").SetStateAction<string>>; setDbSsl: import("react").Dispatch<import("react").SetStateAction<boolean>>; setDbTimeout: import("react").Dispatch<import("react").SetStateAction<string>>; setDbHttpPort: import("react").Dispatch<import("react").SetStateAction<string>>; setDbChProtocol: import("react").Dispatch<import("react").SetStateAction<string>>; setDbPrestoDialect: import("react").Dispatch<import("react").SetStateAction<string>>; setDbRedisIndex: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseNamespace: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseRestPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseConnectionMode: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseZkQuorum: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseZkRoot: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseEffectiveUser: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseAuthMethod: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseServicePrincipal: import("react").Dispatch<import("react").SetStateAction<string>>; setHBasePrincipal: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseKeytabPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseKrb5ConfPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseSitePath: import("react").Dispatch<import("react").SetStateAction<string>>; };
  isProxy: boolean;
  proxyKind: "http" | "socks5";
  proxyTestUrl: string;
  oss: OssFormState;
  isHBase: boolean;
  terminalProfile: TerminalProfile;
  x11: boolean;
  x11Trusted: boolean;
  compression: boolean;
  startupCmd: string;
  description: string;
  tags: string;
  doNotExit: boolean;
  disableAiWrite: boolean;
  remoteEnv: string;
  usePrivKey: boolean;
  fileEmbedInTab: boolean;
  fileExtraArgs: string;
  pathMappings: SftpPathMapping[];
  authMethod: "Password" | "Agent" | "Gssapi" | "None" | "PrivateKey";
  keyPath: string;
  name: string;
  t: import("../../../lib/i18n").TranslateFn;
  username: string;
  host: string;
  port: string;
  groupPath: string;
  needsHost: boolean;
  saveInVault: boolean;
  password: string;
  isSSH: boolean;
  specifyUser: boolean;
}

export function createSessionSerialization(context: CreateSessionSerializationContext) {
  const {
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
  } = context;

  const buildOptionsJson = ({
    passwordRefValue = passwordRef,
    networkSettingsValue = networkSettings,
    proxyPassValue = networkSettings.proxyPass,
    jumpPasswordValue = networkSettings.jumpPassword,
    mailSmtpPasswordRefValue = mailForm.mailSmtpPasswordRef,
    mailOauthClientSecretRefValue = mailForm.mailOauthClientSecretRef,
    mailOauthTokenRefValue = mailForm.mailOauthTokenRef,
    mailOauthExpiresAtValue = mailForm.mailOauthExpiresAt,
    mailOauthScopeValue = mailForm.mailOauthScope,
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
      proto === "Shell" ? serializeLocalShellOptions(shellForm.localShellOptions) : {};
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
          ...serializeWslOptions(shellForm.wslOptions),
          localShellPath: "wsl.exe",
          localShellArgs: buildWslLaunchArgs(shellForm.wslOptions),
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
        dbDatabase: databaseForm.dbDatabase,
        dbCatalog: databaseForm.dbCatalog,
        dbSsl: databaseForm.dbSsl,
        dbTimeout: databaseForm.dbTimeout,
        dbHttpPort: databaseForm.dbHttpPort,
        dbChProtocol: databaseForm.dbChProtocol,
        dbPrestoDialect: databaseForm.dbPrestoDialect.toLowerCase(),
        dbRedisIndex: databaseForm.dbRedisIndex,
      }
      : {};
    const proxyOverrides: Record<string, unknown> = isProxy
      ? { proxyKind, testUrl: proxyTestUrl }
      : {};
    const mailOauthExpiresAtNumber = Number.parseInt(mailOauthExpiresAtValue, 10);
    const effectiveMailOauthFlow = effectiveMailOAuthFlow(mailForm.mailProvider, mailForm.mailOauthFlow);
    const persistMailOauthClientSecret = mailOAuthClientSecretVisible(mailForm.mailProvider, effectiveMailOauthFlow);
    const mailOverrides: Record<string, unknown> = isMail
      ? {
        mailProvider: mailForm.mailProvider,
        mailAuthMode: mailForm.mailAuthMode,
        mailOauthFlow: mailForm.mailAuthMode === "oauth2" ? effectiveMailOauthFlow : "browser",
        mailOauthClientId: mailForm.mailAuthMode === "oauth2" ? mailForm.mailOauthClientId : "",
        mailOauthClientSecretRef:
          mailForm.mailAuthMode === "oauth2" && persistMailOauthClientSecret
            ? mailOauthClientSecretRefValue
            : "",
        mailOauthTokenRef: mailForm.mailAuthMode === "oauth2" ? mailOauthTokenRefValue : "",
        mailOauthExpiresAt: mailForm.mailAuthMode === "oauth2" && Number.isFinite(mailOauthExpiresAtNumber) ? mailOauthExpiresAtNumber : 0,
        mailOauthScope: mailForm.mailAuthMode === "oauth2" ? mailOauthScopeValue : "",
        mailDisplayName: mailForm.mailDisplayName,
        mailReplyTo: mailForm.mailReplyTo,
        mailSignature: mailForm.mailSignature,
        mailImapSecurity: mailForm.mailImapSecurity,
        mailSmtpHost: mailForm.mailSmtpHost,
        mailSmtpPort: mailForm.mailSmtpPort,
        mailSmtpSecurity: mailForm.mailSmtpSecurity,
        mailSmtpUsername: mailForm.mailSmtpUsername,
        mailSmtpUseImapAuth: mailForm.mailSmtpUseImapAuth,
        mailSmtpPasswordRef: mailForm.mailSmtpUseImapAuth ? "" : mailSmtpPasswordRefValue,
        mailCacheEnabled: mailForm.mailCacheEnabled,
        mailSaveDirectory: mailForm.mailSaveDirectory,
        mailStorageDirectory: mailForm.mailStorage.directory.trim(),
        mailFullMessageMode: mailForm.mailStorage.mode,
        mailFullMessageFolders: Array.from(new Set(mailForm.mailStorage.folders.map((v) => v.trim()).filter(Boolean))),
        mailHeaderRetentionDays: mailForm.mailHeaderRetentionDays,
        mailHeaderLimitPerFolder: mailForm.mailHeaderLimitPerFolder,
        [MAIL_HEADER_LIMITS_EXPLICIT_KEY]: true,
        mailBodyRecentLimit: mailForm.mailBodyRecentLimit,
        mailBodyMaxBytes: mailForm.mailBodyMaxBytes,
        mailAttachmentCache: mailForm.mailAttachmentCache,
        mailSyncOnOpen: mailForm.mailSyncOnOpen,
        mailIdlePush: mailForm.mailIdlePush,
        mailSubscribedOnly: mailForm.mailSubscribedOnly,
        mailIncoming: mailForm.mailIncoming,
        mailPop3LeaveDays: mailForm.mailPop3LeaveDays,
        mailUndoSendSeconds: mailForm.mailUndoSendSeconds,
        mailCardDavUrl: mailForm.mailCardDavUrl.trim(),
        mailCardDavUsername: mailForm.mailCardDavUsername.trim(),
        mailCalDavUrl: mailForm.mailCalDavUrl.trim(),
        mailCalDavUsername: mailForm.mailCalDavUsername.trim(),
        mailReceiptPolicy: mailForm.mailReceiptPolicy,
        mailSpecialFolders: JSON.stringify(parseSpecialFolders(mailForm.mailSpecialFolders)),
        mailDesktopNotify: mailForm.mailDesktopNotify,
        mailSyncIntervalMinutes: mailForm.mailSyncIntervalMinutes,
        mailMaxFetchPerSync: mailForm.mailMaxFetchPerSync,
        mailSaveSentCopy: mailForm.mailSaveSentCopy,
        mailIdentities: JSON.stringify(parseMailIdentities(mailForm.mailIdentityList)),
        mailAiEnabled: mailForm.mailAiEnabled,
        mailAiSkipBodyConfirm: mailForm.mailAiSkipBodyConfirm,
      }
      : {};
    const ossOverrides: Record<string, unknown> =
      proto === "S3"
        ? (ossConfigValue ?? { ...ossFormToConfig(oss) })
        : {};
    const hbaseOverrides: Record<string, unknown> = isHBase
      ? {
        hbaseNamespace: databaseForm.hbaseNamespace,
        hbaseRestPath: databaseForm.hbaseRestPath,
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
        dbSsl: databaseForm.dbSsl,
        dbTimeout: databaseForm.dbTimeout,
      }
      : {};

    const terminalProfileOverrides = supportsTerminalAppearance || isMail ? { terminalProfile } : {};

    return JSON.stringify(cleanSessionOptions(proto, {
      ...previousOptions,
      ...context.bookmark,
      x11, x11Trusted, compression, startupCmd,
      description, tags, doNotExit, disableAiWrite,
      remoteEnv, sshBrowser: "sftp", usePrivKey,
      fileEmbedInTab, fileExtraArgs,
      ...terminalProfileOverrides,
      // SSH password vault reference (vault:<id>). Empty string means no
      // saved password; the user types it on connect.
      passwordRef: isMail && mailForm.mailAuthMode === "oauth2" ? "" : passwordRefValue || "",
      // Strip the proxy password unless the user explicitly opted into
      // "Save in vault". `options_json` lands in the SQLite session row
      // in plaintext, so this is the gate keeping secrets out at rest.
      // When proxySaveAuth is on AND the value is already a vault: ref,
      // we keep it (the resolution happens server-side). The jump-host
      // password is gated the same way via jumpSaveAuth.
      networkSettings: {
        ...networkSettingsValue,
        sshBrowser: "sftp",
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
    }));
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
    if (isSSH && authMethod === "PrivateKey")
      auth = { PrivateKey: { key_path: keyPath || "~/.ssh/id_ed25519" } };
    else if (isSSH && authMethod === "Agent") auth = "Agent";
    else if (isSSH && (authMethod === "Gssapi" || authMethod === "None")) auth = "Gssapi";

    const displayName = name
      || (proto === "WSL"
        ? t("sessionEditor2.wslDefaultName", { distro: shellForm.wslOptions.distro || "Linux" })
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
      username: sessionCapabilities(proto).username && specifyUser ? username || null : null,
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
    if (proto === "SSH" && remoteEnvironment(remoteEnv) === "custom" && !startupCmd.trim()) return t("sessionEditor2.errCustomCommandRequired");
    if (needsHost && !host.trim()) return t("sessionEditor2.errHostRequired");
    if (proto === "Serial" && !serialDevice.trim()) return t("sessionEditor2.errSerialDeviceRequired");
    if (proto === "File" && !host.trim()) return t("sessionEditor2.errFilePathRequired");
    if (proto === "WSL" && !shellForm.wslOptions.distro.trim()) return t("sessionEditor2.errWslDistroRequired");
    if (proto === "Presto" && !databaseForm.dbCatalog.trim()) return "Presto catalog is required.";
    if (proto === "Mail") {
      if (!username.trim()) return "Mail email or username is required.";
      if (!host.trim()) return "IMAP host is required.";
      if (!mailForm.mailSmtpHost.trim()) return "SMTP host is required.";
      if (mailForm.mailAuthMode === "oauth2") {
        if (mailForm.mailProvider === "custom") return "OAuth2 mail auth requires Gmail or Outlook provider.";
        if (!mailForm.mailOauthClientId.trim()) return "OAuth2 client ID is required.";
        if (mailOAuthClientSecretRequired(mailForm.mailProvider, mailForm.mailOauthFlow)) {
          if (!mailForm.mailOauthClientSecretRef.trim() && !mailForm.mailOauthClientSecret.trim()) {
            return "Gmail device code requires an OAuth2 client secret.";
          }
          if (!mailForm.mailOauthClientSecretRef.trim() && mailForm.mailOauthClientSecret.trim() && !mailForm.mailOauthClientSecretSaveInVault) {
            return "Gmail device code client secret must be saved in the vault.";
          }
        }
        if (!mailForm.mailOauthTokenRef.trim()) return "OAuth2 token is required. Use Connect OAuth2 first.";
      } else {
        if (!saveInVault) return "Mail credentials must be saved in the vault.";
        if (!passwordRef && !password) return "Mail password or app password token is required.";
        if (!mailForm.mailSmtpUseImapAuth && !mailForm.mailSmtpSaveInVault) return "SMTP credentials must be saved in the vault.";
        if (!mailForm.mailSmtpUseImapAuth && !mailForm.mailSmtpPasswordRef && !mailForm.mailSmtpPassword) {
          return "SMTP password or app password token is required.";
        }
      }
    }
    if (isSSH && specifyUser && !username.trim()) return t("sessionEditor2.errUsernameEmpty");
    if (isSSH && authMethod === "PrivateKey" && !keyPath.trim()) return t("sessionEditor2.errKeyPathRequired");
    if (proto === "HBaseShell") {
      if ((databaseForm.hbaseConnectionMode === "rest" || databaseForm.hbaseConnectionMode === "thrift") && !host.trim()) {
        return databaseForm.hbaseConnectionMode === "thrift"
          ? "HBase Thrift host is required."
          : "HBase REST host is required.";
      }
      if (databaseForm.hbaseConnectionMode === "native" && !databaseForm.hbaseSitePath.trim() && !databaseForm.hbaseZkQuorum.trim() && !host.trim()) {
        return "HBase ZooKeeper quorum, HBase-site.xml, or Remote host is required.";
      }
    }
    return null;
  };
  return { validate, buildConfig, buildOptionsJson };
}
