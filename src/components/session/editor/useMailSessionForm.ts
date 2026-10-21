import { mailStorageOptions } from "../../mail/MailStorageSettings";
import { useState } from "react";
import { mailHeaderLimitOption } from "../../../lib/mailSync";
import { parseSpecialFolders } from "../../../lib/mailFolders";
import { parseMailIdentities } from "../../../lib/mailIdentities";
import type { MailIdentity } from "../../../types";
import type { SessionConfig } from "../../../lib/ipc";
import { type Proto, optionString, optionBoolean, optionStringOrNumber } from "./sessionPolicy";
import {
  type MailProvider,
  initialMailProvider,
  type MailAuthMode,
  normalizeMailAuthMode,
  type MailSecurityMode,
  type MailOAuthFlow,
  initialMailOAuthFlow,
  type MailOAuthDeviceInfo,
} from "./mailPolicy";


export interface UseMailSessionFormContext {
  initialOptions: Record<string, unknown>;
  session: SessionConfig | undefined;
  initialProtoValue: Proto;
}

export function useMailSessionForm(context: UseMailSessionFormContext) {
  const { initialOptions, session, initialProtoValue } = context;

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
  const [mailOauthStatus, setMailOauthStatus] = useState<{ ok: boolean; msg: string; } | null>(null);
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
  return { setMailSmtpSaveInVault, setMailProvider, setMailAuthMode, setMailOauthFlow, setMailOauthDeviceInfo, setMailOauthStatus, setMailImapSecurity, setMailSmtpHost, setMailSmtpPort, setMailSmtpSecurity, setMailSmtpUseImapAuth, mailSmtpPasswordRef, mailOauthClientSecretRef, mailOauthTokenRef, mailOauthExpiresAt, mailOauthScope, mailProvider, mailOauthFlow, mailAuthMode, mailOauthClientId, mailDisplayName, mailReplyTo, mailSignature, mailImapSecurity, mailSmtpHost, mailSmtpPort, mailSmtpSecurity, mailSmtpUsername, mailSmtpUseImapAuth, mailCacheEnabled, mailSaveDirectory, mailStorage, mailHeaderRetentionDays, mailHeaderLimitPerFolder, mailBodyRecentLimit, mailBodyMaxBytes, mailAttachmentCache, mailSyncOnOpen, mailIdlePush, mailSubscribedOnly, mailIncoming, mailPop3LeaveDays, mailUndoSendSeconds, mailCardDavUrl, mailCardDavUsername, mailCalDavUrl, mailCalDavUsername, mailReceiptPolicy, mailSpecialFolders, mailDesktopNotify, mailSyncIntervalMinutes, mailMaxFetchPerSync, mailSaveSentCopy, mailIdentityList, mailAiEnabled, mailAiSkipBodyConfirm, mailOauthClientSecret, mailOauthClientSecretSaveInVault, mailSmtpSaveInVault, mailSmtpPassword, setMailSmtpPasswordRef, setMailSmtpPassword, setMailOauthClientSecretRef, setMailOauthClientSecret, setMailDisplayName, setMailReplyTo, setMailSignature, setMailSmtpUsername, setMailOauthClientId, setMailOauthClientSecretSaveInVault, setMailOauthTokenRef, setMailOauthExpiresAt, setMailOauthScope, setMailCacheEnabled, setMailSaveDirectory, setMailStorage, setMailHeaderRetentionDays, setMailHeaderLimitPerFolder, setMailBodyRecentLimit, setMailBodyMaxBytes, setMailAttachmentCache, setMailSyncOnOpen, setMailIdlePush, setMailSubscribedOnly, setMailIncoming, setMailPop3LeaveDays, setMailUndoSendSeconds, setMailCardDavUrl, setMailCardDavUsername, setMailCalDavUrl, setMailCalDavUsername, setMailReceiptPolicy, setMailSpecialFolders, setMailDesktopNotify, setMailSyncIntervalMinutes, setMailMaxFetchPerSync, setMailSaveSentCopy, setMailIdentityList, setMailAiEnabled, setMailAiSkipBodyConfirm, setMailOauthConnecting, mailOauthDeviceInfo, mailOauthConnecting, mailOauthStatus };
}
