import { mailStorageOptions } from "../../mail/MailStorageSettings";
import { mailHeaderLimitOption } from "../../../lib/mailSync";
import { parseSpecialFolders } from "../../../lib/mailFolders";
import { parseMailIdentities } from "../../../lib/mailIdentities";
import { getSessionNetworkSettings, type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import { toStoredGroupPath } from "../../../lib/sessionPaths";
import type { SessionConfig } from "../../../lib/ipc";
import { parseSessionOptions, type TerminalProfile } from "../../../lib/terminalProfile";
import { parseWslOptions } from "../../../types/wsl";
import { parseRdpOptions, type RdpOptions } from "../../../types/rdp";
import { parseLocalShellOptions } from "../../../types/localShell";
import { ossFormFromOptions, type OssFormState } from "../ObjectStorageSettings";
import { parseVncViewerOptions, type VncViewerOptions } from "../../../lib/vncOptions";
import { parsePathMappings as parsePathMappingsFromOptions } from "../../filebrowser/PathMappingsEditor";
import type { SftpPathMapping } from "../../../types";
import {
  sessionTypeToProto,
  type Proto,
  type SectionTab,
  DEFAULT_PORTS,
  optionString,
  extractAuthType,
  extractKeyPath,
  optionBoolean,
  optionStringOrNumber,
  initialTerminalProfileForProto,
} from "./sessionPolicy";
import { type MailProvider, initialMailProvider, normalizeMailAuthMode, initialMailOAuthFlow } from "./mailPolicy";


export interface CreateSessionResetContext {
  session: SessionConfig | undefined;
  setProto: import("react").Dispatch<import("react").SetStateAction<Proto>>;
  setSection: import("react").Dispatch<import("react").SetStateAction<SectionTab>>;
  setName: import("react").Dispatch<import("react").SetStateAction<string>>;
  setHost: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPort: import("react").Dispatch<import("react").SetStateAction<string>>;
  setUsername: import("react").Dispatch<import("react").SetStateAction<string>>;
  setSpecifyUser: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setGroupPath: import("react").Dispatch<import("react").SetStateAction<string>>;
  defaultGroupPath: string | null;
  setAuthMethod: import("react").Dispatch<import("react").SetStateAction<"Password" | "Agent" | "None" | "PrivateKey">>;
  setAuthRadio: import("react").Dispatch<import("react").SetStateAction<string>>;
  setKeyPath: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPassword: import("react").Dispatch<import("react").SetStateAction<string>>;
  setPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>;
  setSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setX11: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setX11Trusted: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setCompression: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStartupCmd: import("react").Dispatch<import("react").SetStateAction<string>>;
  setDoNotExit: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setDisableAiWrite: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setRemoteEnv: import("react").Dispatch<import("react").SetStateAction<string>>;
  setSshBrowser: import("react").Dispatch<import("react").SetStateAction<string>>;
  setUsePrivKey: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setDescription: import("react").Dispatch<import("react").SetStateAction<string>>;
  setTags: import("react").Dispatch<import("react").SetStateAction<string>>;
  setFileEmbedInTab: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setFileExtraArgs: import("react").Dispatch<import("react").SetStateAction<string>>;
  databaseForm: { dbDatabase: string; dbCatalog: string; dbSsl: boolean; dbTimeout: string; dbHttpPort: string; dbChProtocol: string; dbPrestoDialect: string; dbRedisIndex: string; hbaseNamespace: string; hbaseRestPath: string; hbaseConnectionMode: string; hbaseZkQuorum: string; hbaseZkRoot: string; hbaseEffectiveUser: string; hbaseAuthMethod: string; hbaseServicePrincipal: string; hbasePrincipal: string; hbaseKeytabPath: string; hbaseKrb5ConfPath: string; hbaseSitePath: string; setDbCatalog: import("react").Dispatch<import("react").SetStateAction<string>>; setDbDatabase: import("react").Dispatch<import("react").SetStateAction<string>>; setDbSsl: import("react").Dispatch<import("react").SetStateAction<boolean>>; setDbTimeout: import("react").Dispatch<import("react").SetStateAction<string>>; setDbHttpPort: import("react").Dispatch<import("react").SetStateAction<string>>; setDbChProtocol: import("react").Dispatch<import("react").SetStateAction<string>>; setDbPrestoDialect: import("react").Dispatch<import("react").SetStateAction<string>>; setDbRedisIndex: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseNamespace: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseRestPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseConnectionMode: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseZkQuorum: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseZkRoot: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseEffectiveUser: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseAuthMethod: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseServicePrincipal: import("react").Dispatch<import("react").SetStateAction<string>>; setHBasePrincipal: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseKeytabPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseKrb5ConfPath: import("react").Dispatch<import("react").SetStateAction<string>>; setHBaseSitePath: import("react").Dispatch<import("react").SetStateAction<string>>; };
  setTerminalProfile: import("react").Dispatch<import("react").SetStateAction<TerminalProfile>>;
  setNetworkSettings: import("react").Dispatch<import("react").SetStateAction<NetworkSettingsValue>>;
  setSerialDevice: import("react").Dispatch<import("react").SetStateAction<string>>;
  setSerialBaud: import("react").Dispatch<import("react").SetStateAction<string>>;
  shellForm: { localShellOptions: import("../../../types/localShell").LocalShellOptions; wslOptions: import("../../../types/wsl").WslOptions; setLocalShellOptions: import("react").Dispatch<import("react").SetStateAction<import("../../../types/localShell").LocalShellOptions>>; setWslOptions: import("react").Dispatch<import("react").SetStateAction<import("../../../types/wsl").WslOptions>>; localShells: import("../../../lib/ipc").LocalShellOption[]; localShellStatus: "loading" | "ready" | "error"; wslDistros: import("../../../lib/ipc").WslDistro[]; wslStatus: "loading" | "ready" | "error" | "unsupported"; };
  setRdpOptions: import("react").Dispatch<import("react").SetStateAction<RdpOptions>>;
  setVncSecurityPolicy: import("react").Dispatch<import("react").SetStateAction<"require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none" | "prefer-off">>;
  setVncViewOnly: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setVncViewer: import("react").Dispatch<import("react").SetStateAction<VncViewerOptions>>;
  setVncClipboardPolicy: import("react").Dispatch<import("react").SetStateAction<"disabled" | "client-to-server" | "server-to-client" | "bidirectional">>;
  setPathMappings: import("react").Dispatch<import("react").SetStateAction<SftpPathMapping[]>>;
  mailForm: { setMailSmtpSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailProvider: import("react").Dispatch<import("react").SetStateAction<MailProvider>>; setMailAuthMode: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailAuthMode>>; setMailOauthFlow: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailOAuthFlow>>; setMailOauthDeviceInfo: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailOAuthDeviceInfo | null>>; setMailOauthStatus: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>; setMailImapSecurity: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailSecurityMode>>; setMailSmtpHost: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpPort: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpSecurity: import("react").Dispatch<import("react").SetStateAction<import("./mailPolicy").MailSecurityMode>>; setMailSmtpUseImapAuth: import("react").Dispatch<import("react").SetStateAction<boolean>>; mailSmtpPasswordRef: string; mailOauthClientSecretRef: string; mailOauthTokenRef: string; mailOauthExpiresAt: string; mailOauthScope: string; mailProvider: MailProvider; mailOauthFlow: import("./mailPolicy").MailOAuthFlow; mailAuthMode: import("./mailPolicy").MailAuthMode; mailOauthClientId: string; mailDisplayName: string; mailReplyTo: string; mailSignature: string; mailImapSecurity: import("./mailPolicy").MailSecurityMode; mailSmtpHost: string; mailSmtpPort: string; mailSmtpSecurity: import("./mailPolicy").MailSecurityMode; mailSmtpUsername: string; mailSmtpUseImapAuth: boolean; mailCacheEnabled: boolean; mailSaveDirectory: string; mailStorage: import("../../mail/MailStorageSettings").MailStorageOptions; mailHeaderRetentionDays: string; mailHeaderLimitPerFolder: string; mailBodyRecentLimit: string; mailBodyMaxBytes: string; mailAttachmentCache: boolean; mailSyncOnOpen: boolean; mailIdlePush: boolean; mailSubscribedOnly: boolean; mailIncoming: "imap" | "pop3"; mailPop3LeaveDays: string; mailUndoSendSeconds: string; mailCardDavUrl: string; mailCardDavUsername: string; mailCalDavUrl: string; mailCalDavUsername: string; mailReceiptPolicy: string; mailSpecialFolders: Partial<Record<import("../../../lib/mailFolders").MailSpecialFolderKey, string>>; mailDesktopNotify: boolean; mailSyncIntervalMinutes: string; mailMaxFetchPerSync: string; mailSaveSentCopy: string; mailIdentityList: import("../../../types").MailIdentity[]; mailAiEnabled: boolean; mailAiSkipBodyConfirm: boolean; mailOauthClientSecret: string; mailOauthClientSecretSaveInVault: boolean; mailSmtpSaveInVault: boolean; mailSmtpPassword: string; setMailSmtpPasswordRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpPassword: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecretRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecret: import("react").Dispatch<import("react").SetStateAction<string>>; setMailDisplayName: import("react").Dispatch<import("react").SetStateAction<string>>; setMailReplyTo: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSignature: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSmtpUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientId: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthClientSecretSaveInVault: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailOauthTokenRef: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthExpiresAt: import("react").Dispatch<import("react").SetStateAction<string>>; setMailOauthScope: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCacheEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSaveDirectory: import("react").Dispatch<import("react").SetStateAction<string>>; setMailStorage: import("react").Dispatch<import("react").SetStateAction<import("../../mail/MailStorageSettings").MailStorageOptions>>; setMailHeaderRetentionDays: import("react").Dispatch<import("react").SetStateAction<string>>; setMailHeaderLimitPerFolder: import("react").Dispatch<import("react").SetStateAction<string>>; setMailBodyRecentLimit: import("react").Dispatch<import("react").SetStateAction<string>>; setMailBodyMaxBytes: import("react").Dispatch<import("react").SetStateAction<string>>; setMailAttachmentCache: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSyncOnOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailIdlePush: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSubscribedOnly: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailIncoming: import("react").Dispatch<import("react").SetStateAction<"imap" | "pop3">>; setMailPop3LeaveDays: import("react").Dispatch<import("react").SetStateAction<string>>; setMailUndoSendSeconds: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCardDavUrl: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCardDavUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCalDavUrl: import("react").Dispatch<import("react").SetStateAction<string>>; setMailCalDavUsername: import("react").Dispatch<import("react").SetStateAction<string>>; setMailReceiptPolicy: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSpecialFolders: import("react").Dispatch<import("react").SetStateAction<Partial<Record<import("../../../lib/mailFolders").MailSpecialFolderKey, string>>>>; setMailDesktopNotify: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailSyncIntervalMinutes: import("react").Dispatch<import("react").SetStateAction<string>>; setMailMaxFetchPerSync: import("react").Dispatch<import("react").SetStateAction<string>>; setMailSaveSentCopy: import("react").Dispatch<import("react").SetStateAction<string>>; setMailIdentityList: import("react").Dispatch<import("react").SetStateAction<import("../../../types").MailIdentity[]>>; setMailAiEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailAiSkipBodyConfirm: import("react").Dispatch<import("react").SetStateAction<boolean>>; setMailOauthConnecting: import("react").Dispatch<import("react").SetStateAction<boolean>>; mailOauthDeviceInfo: import("./mailPolicy").MailOAuthDeviceInfo | null; mailOauthConnecting: boolean; mailOauthStatus: { ok: boolean; msg: string; } | null; };
  setOss: import("react").Dispatch<import("react").SetStateAction<OssFormState>>;
  setSaveError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
}

export function createSessionReset(context: CreateSessionResetContext) {
  const {
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
  } = context;

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
    databaseForm.setDbCatalog(optionString(nextOptions, "dbCatalog", ""));
    databaseForm.setDbDatabase(optionString(nextOptions, "dbDatabase", ""));
    databaseForm.setDbSsl(optionBoolean(nextOptions, "dbSsl", false));
    databaseForm.setDbTimeout(optionString(nextOptions, "dbTimeout", "15"));
    databaseForm.setDbHttpPort(optionString(nextOptions, "dbHttpPort", "8123"));
    databaseForm.setDbChProtocol(optionString(nextOptions, "dbChProtocol", "HTTP"));
    {
      const dialect = optionString(nextOptions, "dbPrestoDialect", "presto").toLowerCase();
      databaseForm.setDbPrestoDialect(dialect === "trino" ? "Trino" : "Presto");
    }
    databaseForm.setDbRedisIndex(optionString(nextOptions, "dbRedisIndex", "0"));
    databaseForm.setHBaseNamespace(optionString(nextOptions, "hbaseNamespace", ""));
    databaseForm.setHBaseRestPath(optionString(nextOptions, "hbaseRestPath", ""));
    databaseForm.setHBaseConnectionMode(optionString(nextOptions, "hbaseConnectionMode", "native"));
    databaseForm.setHBaseZkQuorum(optionString(nextOptions, "hbaseZkQuorum", ""));
    databaseForm.setHBaseZkRoot(optionString(nextOptions, "hbaseZkRoot", ""));
    databaseForm.setHBaseEffectiveUser(optionString(nextOptions, "hbaseEffectiveUser", ""));
    databaseForm.setHBaseAuthMethod(optionString(nextOptions, "hbaseAuthMethod", "simple"));
    databaseForm.setHBaseServicePrincipal(optionString(nextOptions, "hbaseServicePrincipal", ""));
    databaseForm.setHBasePrincipal(optionString(nextOptions, "hbasePrincipal", ""));
    databaseForm.setHBaseKeytabPath(optionString(nextOptions, "hbaseKeytabPath", ""));
    databaseForm.setHBaseKrb5ConfPath(optionString(nextOptions, "hbaseKrb5ConfPath", ""));
    databaseForm.setHBaseSitePath(optionString(nextOptions, "hbaseSitePath", ""));
    setTerminalProfile(initialTerminalProfileForProto(session?.options_json, nextProto));
    setNetworkSettings(session ? getSessionNetworkSettings(session.options_json) : { ...getSessionNetworkSettings(null), proxyKind: "app" });
    setSerialDevice(session?.session_type === "Serial" ? session.host : optionString(nextOptions, "serialDevice", ""));
    setSerialBaud(optionString(nextOptions, "serialBaud", "115200"));
    shellForm.setLocalShellOptions(parseLocalShellOptions(session?.options_json));
    shellForm.setWslOptions(parseWslOptions(session?.options_json));
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
    mailForm.setMailProvider(restoredMailProvider);
    mailForm.setMailAuthMode(normalizeMailAuthMode(nextOptions.mailAuthMode));
    mailForm.setMailDisplayName(optionString(nextOptions, "mailDisplayName", ""));
    mailForm.setMailReplyTo(optionString(nextOptions, "mailReplyTo", ""));
    mailForm.setMailSignature(optionString(nextOptions, "mailSignature", ""));
    mailForm.setMailImapSecurity((() => {
      const value = optionString(nextOptions, "mailImapSecurity", "TLS");
      return value === "STARTTLS" || value === "None" ? value : "TLS";
    })());
    mailForm.setMailSmtpHost(optionString(nextOptions, "mailSmtpHost", ""));
    mailForm.setMailSmtpPort(optionString(nextOptions, "mailSmtpPort", "465"));
    mailForm.setMailSmtpSecurity((() => {
      const value = optionString(nextOptions, "mailSmtpSecurity", "TLS");
      return value === "STARTTLS" || value === "None" ? value : "TLS";
    })());
    mailForm.setMailSmtpUsername(optionString(nextOptions, "mailSmtpUsername", ""));
    mailForm.setMailSmtpUseImapAuth(optionBoolean(nextOptions, "mailSmtpUseImapAuth", true));
    mailForm.setMailSmtpPassword("");
    const restoredSmtpRef = optionString(nextOptions, "mailSmtpPasswordRef", "");
    mailForm.setMailSmtpPasswordRef(restoredSmtpRef);
    mailForm.setMailSmtpSaveInVault(!!restoredSmtpRef || nextProto === "Mail");
    mailForm.setMailOauthClientId(optionString(nextOptions, "mailOauthClientId", ""));
    mailForm.setMailOauthClientSecret("");
    const restoredOauthSecretRef = optionString(nextOptions, "mailOauthClientSecretRef", "");
    mailForm.setMailOauthClientSecretRef(restoredOauthSecretRef);
    mailForm.setMailOauthClientSecretSaveInVault(!!restoredOauthSecretRef || nextProto === "Mail");
    mailForm.setMailOauthFlow(initialMailOAuthFlow(nextOptions, restoredMailProvider));
    mailForm.setMailOauthDeviceInfo(null);
    mailForm.setMailOauthTokenRef(optionString(nextOptions, "mailOauthTokenRef", ""));
    mailForm.setMailOauthExpiresAt(optionStringOrNumber(nextOptions, "mailOauthExpiresAt", ""));
    mailForm.setMailOauthScope(optionString(nextOptions, "mailOauthScope", ""));
    mailForm.setMailOauthStatus(null);
    mailForm.setMailCacheEnabled(optionBoolean(nextOptions, "mailCacheEnabled", true));
    mailForm.setMailSaveDirectory(optionString(nextOptions, "mailSaveDirectory", ""));
    mailForm.setMailStorage(mailStorageOptions(nextOptions));
    mailForm.setMailHeaderRetentionDays(String(mailHeaderLimitOption(nextOptions, "mailHeaderRetentionDays", 30)));
    mailForm.setMailHeaderLimitPerFolder(String(mailHeaderLimitOption(nextOptions, "mailHeaderLimitPerFolder", 2000)));
    mailForm.setMailBodyRecentLimit(optionString(nextOptions, "mailBodyRecentLimit", "200"));
    mailForm.setMailBodyMaxBytes(optionString(nextOptions, "mailBodyMaxBytes", "262144"));
    mailForm.setMailAttachmentCache(optionBoolean(nextOptions, "mailAttachmentCache", false));
    mailForm.setMailSyncOnOpen(optionBoolean(nextOptions, "mailSyncOnOpen", true));
    mailForm.setMailIdlePush(optionBoolean(nextOptions, "mailIdlePush", true));
    mailForm.setMailSubscribedOnly(optionBoolean(nextOptions, "mailSubscribedOnly", false));
    mailForm.setMailIncoming(optionString(nextOptions, "mailIncoming", "imap") === "pop3" ? "pop3" : "imap");
    mailForm.setMailPop3LeaveDays(optionString(nextOptions, "mailPop3LeaveDays", ""));
    mailForm.setMailUndoSendSeconds(optionString(nextOptions, "mailUndoSendSeconds", "0"));
    mailForm.setMailCardDavUrl(optionString(nextOptions, "mailCardDavUrl", ""));
    mailForm.setMailCardDavUsername(optionString(nextOptions, "mailCardDavUsername", ""));
    mailForm.setMailCalDavUrl(optionString(nextOptions, "mailCalDavUrl", ""));
    mailForm.setMailCalDavUsername(optionString(nextOptions, "mailCalDavUsername", ""));
    mailForm.setMailReceiptPolicy(optionString(nextOptions, "mailReceiptPolicy", "ask"));
    mailForm.setMailSpecialFolders(parseSpecialFolders(nextOptions.mailSpecialFolders));
    mailForm.setMailDesktopNotify(optionBoolean(nextOptions, "mailDesktopNotify", false));
    mailForm.setMailSyncIntervalMinutes(optionString(nextOptions, "mailSyncIntervalMinutes", "5"));
    mailForm.setMailMaxFetchPerSync(optionString(nextOptions, "mailMaxFetchPerSync", "200"));
    mailForm.setMailSaveSentCopy(optionString(nextOptions, "mailSaveSentCopy", "auto"));
    mailForm.setMailIdentityList(parseMailIdentities(nextOptions.mailIdentities));
    mailForm.setMailAiEnabled(optionBoolean(nextOptions, "mailAiEnabled", true));
    mailForm.setMailAiSkipBodyConfirm(optionBoolean(nextOptions, "mailAiSkipBodyConfirm", false));
    setOss(ossFormFromOptions(session?.options_json));
    setSaveError(null);
    setTestResult(null);
  };
  return { handleReset };
}
