import { MailStorageSettings, type MailStorageOptions } from "../../mail/MailStorageSettings";
import { useState } from "react";
import { Shield } from "lucide-react";
import { MAIL_SPECIAL_FOLDER_KEYS, type MailSpecialFolderKey } from "../../../lib/mailFolders";
import { MailIdentitiesEditor } from "../MailIdentitiesEditor";
import type { MailIdentity } from "../../../types";
import { mailAutoconfig } from "../../../lib/mail";
import { type MailProvider, type MailAuthMode, type MailSecurityMode, type MailOAuthFlow, type MailOAuthDeviceInfo, supportsMailOAuthProvider, effectiveMailOAuthFlow, mailOAuthClientSecretVisible, mailOAuthClientSecretRequired, MAIL_PROVIDER_OPTIONS, normalizeMailProvider, MAIL_AUTH_MODE_OPTIONS, normalizeMailAuthMode, MAIL_OAUTH_FLOW_OPTIONS, normalizeMailOAuthFlow, defaultMailOAuthFlow } from "./mailPolicy";
import { Field, Select, Checkbox } from "./Fields";


export function MailSettings({
  provider, setProvider,
  authMode, setAuthMode,
  imapHost, setImapHost,
  imapPort, setImapPort,
  username, setUsername,
  password, setPassword,
  passwordRef, clearPasswordRef,
  saveInVault, setSaveInVault,
  displayName, setDisplayName,
  replyTo, setReplyTo,
  signature, setSignature,
  imapSecurity, setImapSecurity,
  smtpHost, setSmtpHost,
  smtpPort, setSmtpPort,
  smtpSecurity, setSmtpSecurity,
  smtpUsername, setSmtpUsername,
  smtpUseImapAuth, setSmtpUseImapAuth,
  smtpPassword, setSmtpPassword,
  smtpPasswordRef, clearSmtpPasswordRef,
  smtpSaveInVault, setSmtpSaveInVault,
  oauthClientId, setOauthClientId,
  oauthClientSecret, setOauthClientSecret,
  oauthClientSecretRef, clearOauthClientSecretRef,
  oauthClientSecretSaveInVault, setOauthClientSecretSaveInVault,
  oauthFlow, setOauthFlow,
  oauthDeviceInfo,
  oauthTokenRef,
  oauthExpiresAt,
  oauthScope,
  oauthConnecting,
  oauthStatus,
  onOAuthConnect,
  storage, setStorage, accountId,
  cacheEnabled, setCacheEnabled,
  saveDirectory, setSaveDirectory,
  onBrowseSaveDirectory,
  headerRetentionDays, setHeaderRetentionDays,
  headerLimitPerFolder, setHeaderLimitPerFolder,
  bodyRecentLimit, setBodyRecentLimit,
  bodyMaxBytes, setBodyMaxBytes,
  attachmentCache, setAttachmentCache,
  syncOnOpen, setSyncOnOpen,
  idlePush, setIdlePush,
  subscribedOnly, setSubscribedOnly,
  incoming, setIncoming,
  pop3LeaveDays, setPop3LeaveDays,
  undoSendSeconds, setUndoSendSeconds,
  cardDavUrl, setCardDavUrl,
  cardDavUsername, setCardDavUsername,
  calDavUrl, setCalDavUrl,
  calDavUsername, setCalDavUsername,
  receiptPolicy, setReceiptPolicy,
  specialFolders, setSpecialFolders,
  desktopNotify, setDesktopNotify,
  syncIntervalMinutes, setSyncIntervalMinutes,
  maxFetchPerSync, setMaxFetchPerSync,
  saveSentCopy, setSaveSentCopy,
  identities, setIdentities,
  aiEnabled, setAiEnabled,
  aiSkipBodyConfirm, setAiSkipBodyConfirm,
  vaultState,
}: {
  provider: MailProvider; setProvider: (v: MailProvider) => void;
  authMode: MailAuthMode; setAuthMode: (v: MailAuthMode) => void;
  imapHost: string; setImapHost: (v: string) => void;
  imapPort: string; setImapPort: (v: string) => void;
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  passwordRef: string; clearPasswordRef: () => void;
  saveInVault: boolean; setSaveInVault: (v: boolean) => void;
  displayName: string; setDisplayName: (v: string) => void;
  replyTo: string; setReplyTo: (v: string) => void;
  signature: string; setSignature: (v: string) => void;
  imapSecurity: MailSecurityMode; setImapSecurity: (v: MailSecurityMode) => void;
  smtpHost: string; setSmtpHost: (v: string) => void;
  smtpPort: string; setSmtpPort: (v: string) => void;
  smtpSecurity: MailSecurityMode; setSmtpSecurity: (v: MailSecurityMode) => void;
  smtpUsername: string; setSmtpUsername: (v: string) => void;
  smtpUseImapAuth: boolean; setSmtpUseImapAuth: (v: boolean) => void;
  smtpPassword: string; setSmtpPassword: (v: string) => void;
  smtpPasswordRef: string; clearSmtpPasswordRef: () => void;
  smtpSaveInVault: boolean; setSmtpSaveInVault: (v: boolean) => void;
  oauthClientId: string; setOauthClientId: (v: string) => void;
  oauthClientSecret: string; setOauthClientSecret: (v: string) => void;
  oauthClientSecretRef: string; clearOauthClientSecretRef: () => void;
  oauthClientSecretSaveInVault: boolean; setOauthClientSecretSaveInVault: (v: boolean) => void;
  oauthFlow: MailOAuthFlow; setOauthFlow: (v: MailOAuthFlow) => void;
  oauthDeviceInfo: MailOAuthDeviceInfo | null;
  oauthTokenRef: string;
  oauthExpiresAt: string;
  oauthScope: string;
  oauthConnecting: boolean;
  oauthStatus: { ok: boolean; msg: string } | null;
  onOAuthConnect: () => void;
  storage: MailStorageOptions; setStorage: (v: MailStorageOptions) => void; accountId?: string;
  cacheEnabled: boolean; setCacheEnabled: (v: boolean) => void;
  saveDirectory: string; setSaveDirectory: (v: string) => void;
  onBrowseSaveDirectory: () => void;
  headerRetentionDays: string; setHeaderRetentionDays: (v: string) => void;
  headerLimitPerFolder: string; setHeaderLimitPerFolder: (v: string) => void;
  bodyRecentLimit: string; setBodyRecentLimit: (v: string) => void;
  bodyMaxBytes: string; setBodyMaxBytes: (v: string) => void;
  attachmentCache: boolean; setAttachmentCache: (v: boolean) => void;
  syncOnOpen: boolean; setSyncOnOpen: (v: boolean) => void;
  idlePush: boolean; setIdlePush: (v: boolean) => void;
  subscribedOnly: boolean; setSubscribedOnly: (v: boolean) => void;
  incoming: "imap" | "pop3"; setIncoming: (v: "imap" | "pop3") => void;
  pop3LeaveDays: string; setPop3LeaveDays: (v: string) => void;
  undoSendSeconds: string; setUndoSendSeconds: (v: string) => void;
  cardDavUrl: string; setCardDavUrl: (v: string) => void;
  cardDavUsername: string; setCardDavUsername: (v: string) => void;
  calDavUrl: string; setCalDavUrl: (v: string) => void;
  calDavUsername: string; setCalDavUsername: (v: string) => void;
  receiptPolicy: string; setReceiptPolicy: (v: string) => void;
  specialFolders: Partial<Record<MailSpecialFolderKey, string>>;
  setSpecialFolders: (v: Partial<Record<MailSpecialFolderKey, string>>) => void;
  desktopNotify: boolean; setDesktopNotify: (v: boolean) => void;
  syncIntervalMinutes: string; setSyncIntervalMinutes: (v: string) => void;
  maxFetchPerSync: string; setMaxFetchPerSync: (v: string) => void;
  saveSentCopy: string; setSaveSentCopy: (v: string) => void;
  identities: MailIdentity[]; setIdentities: (v: MailIdentity[]) => void;
  aiEnabled: boolean; setAiEnabled: (v: boolean) => void;
  aiSkipBodyConfirm: boolean; setAiSkipBodyConfirm: (v: boolean) => void;
  vaultState: "empty" | "locked" | "unlocked";
}) {
  const isOAuth = authMode === "oauth2";
  // TASK-14: fill servers from the address (built-in table, then ISPDB).
  const [autoconfigOnline, setAutoconfigOnline] = useState(true);
  const [autoconfigBusy, setAutoconfigBusy] = useState(false);
  const [autoconfigResult, setAutoconfigResult] = useState<string | null>(null);
  const detectMailSettings = async () => {
    setAutoconfigBusy(true);
    setAutoconfigResult(null);
    try {
      const found = await mailAutoconfig(username, autoconfigOnline);
      if (!found) {
        setAutoconfigResult("No settings found; enter the servers manually.");
        return;
      }
      if (found.provider !== "custom" && found.provider !== provider) {
        setProvider(found.provider);
      } else {
        setImapHost(found.imap.host);
        setImapPort(String(found.imap.port));
        setImapSecurity(found.imap.security);
        setSmtpHost(found.smtp.host);
        setSmtpPort(String(found.smtp.port));
        setSmtpSecurity(found.smtp.security);
        setSmtpUseImapAuth(true);
      }
      const label = found.source === "builtin" ? "built-in" : found.source === "guess" ? "guessed" : found.source;
      setAutoconfigResult(
        `Found (${label}): ${found.imap.host}:${found.imap.port} / ${found.smtp.host}:${found.smtp.port}`,
      );
    } catch (e) {
      setAutoconfigResult(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoconfigBusy(false);
    }
  };
  const oauthSupported = supportsMailOAuthProvider(provider);
  const effectiveOauthFlow = effectiveMailOAuthFlow(provider, oauthFlow);
  const usesDeviceCode = oauthSupported && effectiveOauthFlow === "device";
  const showClientSecret = mailOAuthClientSecretVisible(provider, effectiveOauthFlow);
  const oauthConnectLabel = usesDeviceCode
    ? (oauthConnecting ? "Waiting for approval..." : oauthTokenRef ? "Reconnect device code" : "Start device code")
    : (oauthConnecting ? "Connecting..." : oauthTokenRef ? "Reconnect OAuth2" : "Connect OAuth2");
  const oauthClientSecretPlaceholder = (() => {
    if (oauthClientSecretRef) return "Saved in vault";
    if (mailOAuthClientSecretRequired(provider, effectiveOauthFlow)) return "Google device client secret";
    return "Optional for public clients";
  })();
  const oauthExpiresLabel = (() => {
    const seconds = Number.parseInt(oauthExpiresAt, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    return new Date(seconds * 1000).toLocaleString();
  })();

  return (
    <div data-testid="mail-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <Field label="Provider">
        <Select
          value={provider}
          className="w-44"
          ariaLabel="Mail provider"
          options={MAIL_PROVIDER_OPTIONS}
          onChange={(value) => setProvider((normalizeMailProvider(value) ?? "custom"))}
        />
      </Field>

      <Field label="Auth mode">
        <Select
          value={authMode}
          className="w-52"
          ariaLabel="Mail auth mode"
          options={MAIL_AUTH_MODE_OPTIONS}
          onChange={(value) => setAuthMode(normalizeMailAuthMode(value))}
        />
        {isOAuth && !oauthSupported && (
          <span className="ml-2 text-[var(--taomni-text-muted)]">
            OAuth2 is available for Gmail and Outlook presets.
          </span>
        )}
      </Field>

      <Field label="Incoming">
        <select
          className="taomni-input w-40"
          value={incoming}
          aria-label="Mail incoming protocol"
          data-testid="mail-incoming-protocol"
          onChange={(e) => {
            const next = e.target.value === "pop3" ? "pop3" : "imap";
            setIncoming(next);
            // Keep the port on the new protocol's default for the chosen security.
            const tls = imapSecurity === "TLS";
            setImapPort(String(next === "pop3" ? (tls ? 995 : 110) : tls ? 993 : 143));
          }}
        >
          <option value="imap">IMAP (server folders)</option>
          <option value="pop3">POP3 (local folders)</option>
        </select>
        {incoming === "pop3" && (
          <>
            <span className="ml-3 text-[var(--taomni-text-muted)]">Delete from server after</span>
            <input
              className="taomni-input w-14 ml-1"
              value={pop3LeaveDays}
              placeholder="never"
              aria-label="POP3 leave on server days"
              data-testid="mail-pop3-leave-days"
              onChange={(e) => setPop3LeaveDays(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <span className="ml-1 text-[var(--taomni-text-muted)]">days (blank = keep, 0 = at once)</span>
          </>
        )}
      </Field>

      <Field label={incoming === "pop3" ? "POP3 server" : "IMAP server"}>
        <input
          className="taomni-input w-72"
          value={imapHost}
          aria-label="IMAP server"
          placeholder="imap.example.com"
          onChange={(e) => setImapHost(e.target.value)}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">Port</span>
        <input
          className="taomni-input w-20 ml-1"
          value={imapPort}
          aria-label="IMAP port"
          onChange={(e) => setImapPort(e.target.value)}
        />
      </Field>
      <Field label="Email / username">
        <input
          className="taomni-input w-72"
          value={username}
          aria-label="Mail email or username"
          placeholder="name@example.com"
          onChange={(e) => setUsername(e.target.value)}
        />
        <button
          type="button"
          className="taomni-btn h-7 px-2 ml-2"
          data-testid="mail-autoconfig"
          disabled={autoconfigBusy || !username.includes("@")}
          onClick={() => void detectMailSettings()}
        >
          {autoconfigBusy ? "Detecting…" : "Detect settings"}
        </button>
        <label
          className="ml-2 inline-flex items-center gap-1 text-[var(--taomni-text-muted)]"
          title="Also asks autoconfig.thunderbird.net and the provider's autoconfig host, which reveals the address's domain"
        >
          <Checkbox checked={autoconfigOnline} onChange={setAutoconfigOnline} dataTestId="mail-autoconfig-online" />
          Online lookup
        </label>
        {autoconfigResult && (
          <span className="ml-2 text-[11px] text-[var(--taomni-text-muted)]" data-testid="mail-autoconfig-result">
            {autoconfigResult}
          </span>
        )}
      </Field>

      {isOAuth && (
        <>
          {oauthSupported && (
            <Field label="OAuth flow">
              <Select
                value={oauthFlow}
                className="w-44"
                ariaLabel="OAuth flow"
                options={MAIL_OAUTH_FLOW_OPTIONS}
                onChange={(value) => setOauthFlow(normalizeMailOAuthFlow(value) ?? defaultMailOAuthFlow(provider))}
              />
            </Field>
          )}
          <Field label="OAuth client ID">
            <input
              className="taomni-input w-[420px]"
              value={oauthClientId}
              aria-label="OAuth client ID"
              placeholder={provider === "outlook" ? "Azure app client ID" : "Google OAuth client ID"}
              onChange={(e) => setOauthClientId(e.target.value)}
            />
          </Field>
          {showClientSecret && (
            <Field label="OAuth client secret">
              <input
                className="taomni-input w-64"
                type="password"
                value={oauthClientSecret}
                aria-label="OAuth client secret"
                placeholder={oauthClientSecretPlaceholder}
                onChange={(e) => {
                  setOauthClientSecret(e.target.value);
                  if (oauthClientSecretRef) clearOauthClientSecretRef();
                }}
              />
              <label
                className="ml-2 inline-flex items-center gap-1 text-[11px] cursor-pointer"
                title={vaultState === "empty" ? "Set up the vault to save this secret" : "Save this secret in the encrypted vault"}
              >
                <input
                  type="checkbox"
                  className="taomni-checkbox"
                  data-testid="mail-oauth-client-secret-save-in-vault"
                  checked={oauthClientSecretSaveInVault}
                  onChange={(e) => setOauthClientSecretSaveInVault(e.target.checked)}
                />
                Save in vault
              </label>
            </Field>
          )}
          <Field label="OAuth token">
            <button
              type="button"
              className="taomni-btn flex items-center gap-1.5"
              data-testid="mail-oauth-connect"
              disabled={!oauthSupported || oauthConnecting}
              onClick={onOAuthConnect}
              aria-label="Connect OAuth2"
            >
              <Shield className="w-3.5 h-3.5" />
              {oauthConnectLabel}
            </button>
            {usesDeviceCode && oauthDeviceInfo && (
              <span className="ml-2 taomni-pill" data-testid="mail-oauth-device-code">
                Code {oauthDeviceInfo.userCode}
              </span>
            )}
            {usesDeviceCode && oauthDeviceInfo && (
              <span className="ml-2 text-[var(--taomni-text-muted)]">
                {oauthDeviceInfo.verificationUri}
              </span>
            )}
            {oauthTokenRef && (
              <span className="ml-2 taomni-pill">
                <Shield className="w-3 h-3" /> Token saved
              </span>
            )}
            {oauthExpiresLabel && (
              <span className="ml-2 text-[var(--taomni-text-muted)]">
                Expires {oauthExpiresLabel}
              </span>
            )}
            {oauthScope && (
              <span className="ml-2 text-[var(--taomni-text-muted)]">
                Scope saved
              </span>
            )}
            {oauthStatus && (
              <span
                className="ml-2"
                style={{ color: oauthStatus.ok ? "#2f8a3e" : "#b22222" }}
              >
                {oauthStatus.msg}
              </span>
            )}
            {usesDeviceCode && oauthDeviceInfo && (
              <span className="ml-2 text-[var(--taomni-text-muted)]">
                {oauthDeviceInfo.message}
              </span>
            )}
          </Field>
        </>
      )}

      <Field label="Sender name">
        <input
          className="taomni-input w-72"
          value={displayName}
          aria-label="Mail sender display name"
          placeholder="Shown on outgoing messages"
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>
      <Field label="Reply-To">
        <input
          className="taomni-input w-72"
          value={replyTo}
          aria-label="Mail reply-to address"
          placeholder="Optional reply address"
          onChange={(e) => setReplyTo(e.target.value)}
        />
      </Field>
      <Field label="Signature">
        <textarea
          className="taomni-input w-[420px] min-h-[76px] resize-y font-sans leading-5"
          value={signature}
          aria-label="Mail default signature"
          placeholder="Default text appended to new messages and replies"
          onChange={(e) => setSignature(e.target.value)}
        />
      </Field>
      <Field label="Identities">
        <MailIdentitiesEditor identities={identities} onChange={setIdentities} />
      </Field>

      <Field label="IMAP security">
        <Select
          value={imapSecurity}
          dataTestId="mail-imap-security"
          className="w-32"
          options={["TLS", "STARTTLS", "None"]}
          onChange={(value) => setImapSecurity(value as MailSecurityMode)}
        />
      </Field>
      {!isOAuth && (
        <Field label="IMAP password">
          <input
            className="taomni-input w-64"
            type="password"
            value={password}
            aria-label="Mail password or app password token"
            placeholder={passwordRef ? "Saved in vault" : "Password / app password token"}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordRef) clearPasswordRef();
            }}
          />
          <label
            className="ml-2 inline-flex items-center gap-1 text-[11px] cursor-pointer"
            title={vaultState === "empty" ? "Set up the vault to save this secret" : "Save this secret in the encrypted vault"}
          >
            <input
              type="checkbox"
              className="taomni-checkbox"
              data-testid="session-save-in-vault"
              checked={saveInVault}
              onChange={(e) => setSaveInVault(e.target.checked)}
            />
            Save in vault
          </label>
        </Field>
      )}

      <Field label="SMTP server">
        <input
          className="taomni-input w-72"
          value={smtpHost}
          aria-label="SMTP server"
          placeholder="smtp.example.com"
          onChange={(e) => setSmtpHost(e.target.value)}
        />
        <span className="ml-2 text-[var(--taomni-text-muted)]">Port</span>
        <input
          className="taomni-input w-20 ml-1"
          value={smtpPort}
          aria-label="SMTP port"
          onChange={(e) => setSmtpPort(e.target.value)}
        />
      </Field>

      <Field label="SMTP security">
        <Select
          value={smtpSecurity}
          dataTestId="mail-smtp-security"
          className="w-32"
          options={["TLS", "STARTTLS", "None"]}
          onChange={(value) => setSmtpSecurity(value as MailSecurityMode)}
        />
      </Field>

      <Field label="SMTP auth">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={smtpUseImapAuth} onChange={setSmtpUseImapAuth} />
          {isOAuth ? "Reuse IMAP username and OAuth2 token" : "Reuse IMAP username and app password token"}
        </label>
      </Field>

      {!smtpUseImapAuth && (
        <>
          <Field label="SMTP username">
            <input
              className="taomni-input w-72"
              value={smtpUsername}
              aria-label="SMTP username"
              placeholder="Defaults to the email address"
              onChange={(e) => setSmtpUsername(e.target.value)}
            />
          </Field>
          {!isOAuth && (
            <Field label="SMTP password">
              <input
                className="taomni-input w-64"
                type="password"
                value={smtpPassword}
                aria-label="SMTP password or app password token"
                placeholder={smtpPasswordRef ? "saved in vault" : "Password / app password token"}
                onChange={(e) => {
                  setSmtpPassword(e.target.value);
                  if (smtpPasswordRef) clearSmtpPasswordRef();
                }}
              />
              <label
                className="flex items-center gap-1 text-[11px] cursor-pointer ml-2"
                title={vaultState === "empty" ? "Set up the vault on save to store this token" : "Encrypt and store this token in the vault"}
              >
                <input
                  type="checkbox"
                  className="taomni-checkbox"
                  data-testid="mail-smtp-save-in-vault"
                  checked={smtpSaveInVault}
                  onChange={(e) => setSmtpSaveInVault(e.target.checked)}
                />
                Save in vault
              </label>
              <span className="taomni-pill">
                <Shield className="w-3 h-3" /> Encrypted
              </span>
            </Field>
          )}
        </>
      )}

      <Field label="Sync">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={syncOnOpen} onChange={setSyncOnOpen} />
          Sync when tab opens
        </label>
        <span className="ml-3 text-[var(--taomni-text-muted)]">Interval</span>
        <input
          className="taomni-input w-16 ml-1"
          value={syncIntervalMinutes}
          aria-label="Mail sync interval minutes"
          onChange={(e) => setSyncIntervalMinutes(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">min</span>
        <span className="ml-3 text-[var(--taomni-text-muted)]">Fetch</span>
        <input
          className="taomni-input w-20 ml-1"
          value={maxFetchPerSync}
          aria-label="Mail max fetch per sync"
          onChange={(e) => setMaxFetchPerSync(e.target.value)}
        />
      </Field>

      <Field label="New mail">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={idlePush} onChange={setIdlePush} dataTestId="mail-idle-push" />
          Instant push (IMAP IDLE) while the tab is open
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={desktopNotify} onChange={setDesktopNotify} dataTestId="mail-desktop-notify" />
          Desktop notification
        </label>
      </Field>

      <Field label="Folders">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={subscribedOnly} onChange={setSubscribedOnly} dataTestId="mail-subscribed-only-setting" />
          Show and sync only subscribed folders
        </label>
      </Field>

      <Field label="Special folders">
        <div className="flex flex-wrap items-center gap-2" data-testid="mail-special-folders">
          {MAIL_SPECIAL_FOLDER_KEYS.map((key) => (
            <label key={key} className="inline-flex items-center gap-1">
              <span className="text-[var(--taomni-text-muted)] capitalize">{key}</span>
              <input
                className="taomni-input w-28"
                value={specialFolders[key] ?? ""}
                placeholder="auto"
                aria-label={`Mail ${key} folder`}
                data-testid={`mail-special-folder-${key}`}
                onChange={(e) => setSpecialFolders({ ...specialFolders, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </Field>

      <Field label="Sent copy">
        <select
          className="taomni-input w-72"
          value={saveSentCopy}
          aria-label="Mail save sent copy"
          data-testid="mail-save-sent-copy"
          onChange={(e) => setSaveSentCopy(e.target.value)}
        >
          <option value="auto">Automatic (Gmail/Outlook file it themselves)</option>
          <option value="on">Always save a copy to Sent</option>
          <option value="off">Never save a copy</option>
        </select>
      </Field>

      <Field label="Undo send">
        <input
          className="taomni-input w-16"
          value={undoSendSeconds}
          aria-label="Mail undo send seconds"
          data-testid="mail-undo-send-seconds"
          onChange={(e) => setUndoSendSeconds(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">seconds to cancel after Send (0 = off)</span>
      </Field>

      <Field label="Read receipts">
        <select
          className="taomni-input w-56"
          value={receiptPolicy}
          aria-label="Answer read receipt requests"
          data-testid="mail-receipt-policy"
          onChange={(e) => setReceiptPolicy(e.target.value)}
        >
          <option value="ask">Ask me when a sender requests one</option>
          <option value="always">Always send</option>
          <option value="never">Never send</option>
        </select>
      </Field>

      <Field label="CardDAV">
        <input
          className="taomni-input w-72"
          value={cardDavUrl}
          placeholder="https://carddav.example.com/ (blank = local address book)"
          aria-label="CardDAV address book URL"
          data-testid="mail-carddav-url"
          onChange={(e) => setCardDavUrl(e.target.value)}
        />
        <input
          className="taomni-input w-40 ml-2"
          value={cardDavUsername}
          placeholder="username (default: IMAP)"
          aria-label="CardDAV username"
          data-testid="mail-carddav-username"
          onChange={(e) => setCardDavUsername(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">uses the mail password</span>
      </Field>

      <Field label="CalDAV">
        <input
          className="taomni-input w-72"
          value={calDavUrl}
          placeholder="https://caldav.example.com/ (blank = no agenda)"
          aria-label="CalDAV calendar URL"
          data-testid="mail-caldav-url"
          onChange={(e) => setCalDavUrl(e.target.value)}
        />
        <input
          className="taomni-input w-40 ml-2"
          value={calDavUsername}
          placeholder="username (default: IMAP)"
          aria-label="CalDAV username"
          data-testid="mail-caldav-username"
          onChange={(e) => setCalDavUsername(e.target.value)}
        />
        <span className="ml-1 text-[var(--taomni-text-muted)]">agenda, accepted invitations and reminders</span>
      </Field>

      <MailStorageSettings accountId={accountId} value={storage} onChange={setStorage} pop3={incoming === "pop3"} />

      <Field label="Cache">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={cacheEnabled} onChange={setCacheEnabled} />
          Cache headers and recent bodies
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={attachmentCache} onChange={setAttachmentCache} />
          Cache attachments
        </label>
      </Field>

      <Field label="Extra .eml copies">
        <input
          className="taomni-input w-[420px]"
          value={saveDirectory}
          aria-label="Mail save directory"
          placeholder="Optional directory for extra .eml copies"
          onChange={(e) => setSaveDirectory(e.target.value)}
        />
        <button
          type="button"
          className="taomni-btn ml-1"
          onClick={onBrowseSaveDirectory}
        >
          Browse
        </button>
      </Field>

      <div className="col-span-12 text-xs text-[var(--taomni-text-muted)]">
        Saves extra .eml files during IMAP body fetching; these may be partial due to body size limits. This does not change the cache location. Leave blank if you only need Complete mail storage above.
      </div>

      <Field label="Cache limits">
        <span className="text-[var(--taomni-text-muted)]">Headers</span>
        <input
          className="taomni-input w-20 ml-1"
          value={headerLimitPerFolder}
          aria-label="Mail header limit per folder"
          placeholder="0"
          title="0 keeps every header (full local index)"
          onChange={(e) => setHeaderLimitPerFolder(e.target.value)}
        />
        <span className="ml-3 text-[var(--taomni-text-muted)]">Days</span>
        <input
          className="taomni-input w-16 ml-1"
          value={headerRetentionDays}
          aria-label="Mail header retention days"
          placeholder="0"
          title="0 keeps headers of any age; otherwise by server arrival time"
          onChange={(e) => setHeaderRetentionDays(e.target.value)}
        />
        <span className="ml-1 text-[11px] text-[var(--taomni-text-muted)]">0 = all</span>
        <span className="ml-3 text-[var(--taomni-text-muted)]">Bodies</span>
        <input
          className="taomni-input w-16 ml-1"
          value={bodyRecentLimit}
          aria-label="Mail recent body limit"
          onChange={(e) => setBodyRecentLimit(e.target.value)}
        />
        <span className="ml-3 text-[var(--taomni-text-muted)]">Max bytes</span>
        <input
          className="taomni-input w-24 ml-1"
          value={bodyMaxBytes}
          aria-label="Mail body max bytes"
          onChange={(e) => setBodyMaxBytes(e.target.value)}
        />
      </Field>

      <Field label="AI">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={aiEnabled} onChange={setAiEnabled} />
          Enable AI actions for this account
        </label>
        <label className="ml-3 flex items-center gap-1.5">
          <Checkbox checked={aiSkipBodyConfirm} onChange={setAiSkipBodyConfirm} />
          Do not ask before sending mail body text to AI
        </label>
      </Field>
    </div>
  );
}
