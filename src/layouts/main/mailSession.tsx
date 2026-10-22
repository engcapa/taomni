import { LEGACY_MAIL_HEADER_LIMIT_PER_FOLDER, LEGACY_MAIL_HEADER_RETENTION_DAYS, mailHeaderLimitOption } from "../../lib/mailSync";
import { parseMailIdentities } from "../../lib/mailIdentities";
import { parseSpecialFolders } from "../../lib/mailFolders";
import type { MailConnectionSecurity, MailTabInfo, MailAuthMode, MailProvider } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { DEFAULT_MAIL_TERMINAL_PROFILE, getSessionTerminalProfile } from "../../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";


export function mailSmtpPasswordRefFromOptions(session: SessionConfig): string | null {
  const opts = parseSessionOptions(session.options_json);
  const useImapAuth = opts.mailSmtpUseImapAuth !== false;
  if (useImapAuth) return null;
  const ref = typeof opts.mailSmtpPasswordRef === "string" ? opts.mailSmtpPasswordRef : "";
  return ref && ref.startsWith("vault:") ? ref : null;
}


export function mailSecurityFromOptions(value: unknown, fallback: MailConnectionSecurity): MailConnectionSecurity {
  if (value === "STARTTLS" || value === "starttls") return "starttls";
  if (value === "None" || value === "none") return "none";
  if (value === "TLS" || value === "tls") return "tls";
  return fallback;
}


export function mailProviderFromOptions(value: unknown, imapHost: string): MailProvider {
  if (value === "gmail" || value === "outlook" || value === "custom") return value;
  const host = imapHost.trim().toLowerCase();
  if (host === "imap.gmail.com") return "gmail";
  if (host === "outlook.office365.com") return "outlook";
  return "custom";
}


export function mailAuthModeFromOptions(value: unknown): MailAuthMode {
  return value === "oauth2" ? "oauth2" : "password";
}


export function mailNumberOption(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  min = 0,
): number {
  const raw = options[key];
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}


export function sessionToMailTabInfo(
  session: SessionConfig,
  password?: string,
  smtpPassword?: string,
): MailTabInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const smtpUseImapAuth = opts.mailSmtpUseImapAuth !== false;
  const emailAddress = session.username || str("mailEmailAddress");
  const provider = mailProviderFromOptions(opts.mailProvider, session.host);
  const authMode = mailAuthModeFromOptions(opts.mailAuthMode);
  const ns = getSessionNetworkSettings(session.options_json);
  const networkSettings = ns.proxyKind !== "none" ? toNetworkSettingsPayload(ns) : null;
  return {
    sessionId: session.id,
    emailAddress,
    provider,
    authMode,
    displayName: str("mailDisplayName") || null,
    replyTo: str("mailReplyTo") || null,
    signature: str("mailSignature") || null,
    terminalProfile: getSessionTerminalProfile(session.options_json) ?? DEFAULT_MAIL_TERMINAL_PROFILE,
    imap: {
      host: session.host,
      port: session.port,
      username: session.username || emailAddress || null,
      password,
      security: mailSecurityFromOptions(opts.mailImapSecurity, "tls"),
      trustedCert: str("mailImapTrustedCert") || null,
    },
    smtp: {
      host: str("mailSmtpHost"),
      port: mailNumberOption(opts, "mailSmtpPort", 465, 1),
      username: smtpUseImapAuth ? (session.username || emailAddress || null) : (str("mailSmtpUsername") || emailAddress || null),
      password: smtpUseImapAuth ? password : smtpPassword,
      security: mailSecurityFromOptions(opts.mailSmtpSecurity, "tls"),
      useImapAuth: smtpUseImapAuth,
      trustedCert: str("mailSmtpTrustedCert") || null,
    },
    oauth: {
      clientId: str("mailOauthClientId") || null,
      clientSecret: str("mailOauthClientSecretRef") || undefined,
      tokenRef: str("mailOauthTokenRef") || null,
      refreshTokenRef: str("mailOauthRefreshTokenRef") || null,
      expiresAt: mailNumberOption(opts, "mailOauthExpiresAt", 0, 0) || null,
      scope: str("mailOauthScope") || null,
    },
    networkSettings,
    sync: {
      onOpen: opts.mailSyncOnOpen !== false,
      intervalMinutes: mailNumberOption(opts, "mailSyncIntervalMinutes", 5, 1),
      maxFetchPerSync: mailNumberOption(opts, "mailMaxFetchPerSync", 200, 1),
      idle: opts.mailIdlePush !== false,
      desktopNotify: opts.mailDesktopNotify === true,
      subscribedOnly: opts.mailSubscribedOnly === true,
    },
    specialFolders: parseSpecialFolders(opts.mailSpecialFolders),
    undoSendSeconds: mailNumberOption(opts, "mailUndoSendSeconds", 0, 0),
    carddav: typeof opts.mailCardDavUrl === "string" && opts.mailCardDavUrl.trim()
      ? {
        url: opts.mailCardDavUrl.trim(),
        username: typeof opts.mailCardDavUsername === "string" && opts.mailCardDavUsername.trim()
          ? opts.mailCardDavUsername.trim()
          : null,
      }
      : null,
    caldav: typeof opts.mailCalDavUrl === "string" && opts.mailCalDavUrl.trim()
      ? {
        url: opts.mailCalDavUrl.trim(),
        username: typeof opts.mailCalDavUsername === "string" && opts.mailCalDavUsername.trim()
          ? opts.mailCalDavUsername.trim()
          : null,
      }
      : null,
    receiptPolicy: opts.mailReceiptPolicy === "always" || opts.mailReceiptPolicy === "never" ? opts.mailReceiptPolicy : "ask",
    incoming: opts.mailIncoming === "pop3" ? "pop3" : "imap",
    pop3LeaveDays: opts.mailPop3LeaveDays === undefined || opts.mailPop3LeaveDays === null || String(opts.mailPop3LeaveDays).trim() === ""
      ? null
      : mailNumberOption(opts, "mailPop3LeaveDays", 0, 0),
    cache: {
      // POP3 mail lives only in the local store, so its cache is always on.
      enabled: opts.mailCacheEnabled !== false || opts.mailIncoming === "pop3",
      headerRetentionDays: mailHeaderLimitOption(opts, "mailHeaderRetentionDays", LEGACY_MAIL_HEADER_RETENTION_DAYS),
      headerLimitPerFolder: mailHeaderLimitOption(opts, "mailHeaderLimitPerFolder", LEGACY_MAIL_HEADER_LIMIT_PER_FOLDER),
      bodyRecentLimit: mailNumberOption(opts, "mailBodyRecentLimit", 200, 0),
      bodyMaxBytes: mailNumberOption(opts, "mailBodyMaxBytes", 262144, 1024),
      attachmentCache: opts.mailAttachmentCache === true,
      saveDirectory: str("mailSaveDirectory") || null,
      storageDirectory: str("mailStorageDirectory") || null,
      fullMessageMode: opts.mailFullMessageMode === "include" || opts.mailFullMessageMode === "exclude" ? opts.mailFullMessageMode : "all",
      fullMessageFolders: Array.isArray(opts.mailFullMessageFolders) ? opts.mailFullMessageFolders.filter((v): v is string => typeof v === "string") : [],
    },
    ai: {
      enabled: opts.mailAiEnabled !== false,
      skipBodyConfirm: opts.mailAiSkipBodyConfirm === true,
    },
    saveSentCopy: opts.mailSaveSentCopy === "on" ? true : opts.mailSaveSentCopy === "off" ? false : null,
    identities: parseMailIdentities(opts.mailIdentities),
  };
}
