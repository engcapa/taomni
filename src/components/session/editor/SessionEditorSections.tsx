import type { SessionConfig } from "../../../lib/ipc";
import { normalizeVncScaling, VNC_SCALE_PERCENTAGES } from "../../../lib/vnc";
import { type VncViewerOptions } from "../../../lib/vncOptions";
import { PathMappingsEditor } from "../../filebrowser/PathMappingsEditor";
import { MailAppearanceSettings } from "../../mail/MailAppearanceSettings";
import { RdpOptionsForm } from "../forms/RdpOptionsForm";
import { ObjectStorageSettings } from "../ObjectStorageSettings";
import { BookmarkSettings } from "./BookmarkSettings";
import { DatabaseSettings } from "./DatabaseSettings";
import { Field, Select } from "./Fields";
import { HBaseSettings } from "./HBaseSettings";
import { MailSettings } from "./MailSettings";
import { DbNetworkSettings, NetworkSettings } from "./NetworkSettings";
import { AdvancedSshSettings } from "./SshSettings";
import { TerminalSettings } from "./TerminalSettings";
import { useSessionEditorActions } from "./useSessionEditorActions";
import { useSessionEditorNavigation } from "./useSessionEditorNavigation";
import { useSessionEditorState } from "./useSessionEditorState";


export interface SessionEditorSectionsProps {
  navigation: ReturnType<typeof useSessionEditorNavigation>;
  form: ReturnType<typeof useSessionEditorState>;
  actions: ReturnType<typeof useSessionEditorActions>;
  session: SessionConfig | undefined;
}

export function SessionEditorSections(props: SessionEditorSectionsProps) {
  const { navigation, form, actions, session } = props;
  return (<div
    className="flex-1 min-h-0 overflow-auto px-4 py-3 border-x border-b"
    style={{ borderColor: "var(--taomni-input-border)", background: "var(--taomni-bg)" }}
  >
    {navigation.activeSection === "mappings" && form.proto === "SFTP" && (
      <div data-testid="session-sftp-mappings-section" className="flex flex-col gap-3">
        <div className="text-[12px] text-[var(--taomni-text-muted)]">
          {form.t("pathMappings.sectionDescription")}
        </div>
        <PathMappingsEditor
          mappings={form.pathMappings}
          onChange={form.setPathMappings}
          canBrowseLocal
          onBrowseLocal={async (_index, current) => {
            const { selectFolderPath } = await import("../../../lib/ipc");
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

    {navigation.activeSection === "advanced" && form.isSSH && (
      <AdvancedSshSettings
        sessionType={form.proto}
        t={form.t}
        x11={form.x11} setX11={form.setX11}
        x11Trusted={form.x11Trusted} setX11Trusted={form.setX11Trusted}
        compression={form.compression} setCompression={form.setCompression}
        startupCmd={form.startupCmd} setStartupCmd={form.setStartupCmd}
        doNotExit={form.doNotExit} setDoNotExit={form.setDoNotExit}
        remoteEnv={form.remoteEnv} setRemoteEnv={form.setRemoteEnv}
        sshBrowser={form.sshBrowser} setSshBrowser={form.setSshBrowser}
        authRadio={form.authRadio} setAuthRadio={actions.handleAuthRadio}
        password={form.password} setPassword={form.setPassword}
        passwordRef={form.passwordRef}
        clearPasswordRef={() => form.setPasswordRef("")}
        saveInVault={form.saveInVault} setSaveInVault={form.setSaveInVault}
        vaultState={form.vaultState}
        usePrivKey={form.usePrivKey} setUsePrivKey={(value) => {
          if (value) {
            actions.handleAuthRadio("privatekey");
          } else {
            actions.handleAuthRadio("password");
          }
        }}
        keyPath={form.keyPath} setKeyPath={form.setKeyPath}
        onBrowseKey={actions.handleBrowseKey}
      />
    )}

    {navigation.activeSection === "terminal" && !form.isMail && (
      <TerminalSettings
        profile={form.terminalProfile}
        onProfileChange={form.setTerminalProfile}
      />
    )}
    {navigation.activeSection === "appearance" && form.isMail && (
      <MailAppearanceSettings
        profile={form.terminalProfile}
        onProfileChange={form.setTerminalProfile}
      />
    )}
    {navigation.activeSection === "rdp" && (
      <div data-testid="session-rdp-section">
        <RdpOptionsForm options={form.rdpOptions} onChange={form.setRdpOptions} />
      </div>
    )}
    {navigation.activeSection === "vnc" && form.proto === "VNC" && (
      <div data-testid="session-vnc-policies" className="grid grid-cols-12 gap-x-3 gap-y-3 text-[12px]">
        <Field label={form.t("sessionEditor2.vncSecurityPolicy")}>
          <select data-testid="session-vnc-security-policy" className="taomni-input w-64" value={form.vncSecurityPolicy} onChange={(event) => form.setVncSecurityPolicy(event.target.value as typeof form.vncSecurityPolicy)}>
            <option value="prefer-encryption">{form.t("sessionEditor2.vncSecurityPrefer")}</option>
            <option value="require-encryption">{form.t("sessionEditor2.vncSecurityRequire")}</option>
            <option value="legacy-compatible">{form.t("sessionEditor2.vncSecurityLegacy")}</option>
            <option value="prefer-off">{form.t("sessionEditor2.vncSecurityPreferOff")}</option>
            <option value="allow-none">{form.t("sessionEditor2.vncSecurityAllowNone")}</option>
          </select>
        </Field>
        <Field label={form.t("vnc.pictureQuality")}>
          <select data-testid="session-vnc-quality" className="taomni-input w-64" value={form.vncViewer.pictureQuality} onChange={(event) => form.setVncViewer((current) => ({ ...current, pictureQuality: event.target.value as VncViewerOptions["pictureQuality"] }))}>
            <option value="automatic">{form.t("vnc.qualityAutomatic")}</option>
            <option value="high">{form.t("vnc.qualityHigh")}</option>
            <option value="medium">{form.t("vnc.qualityMedium")}</option>
            <option value="low">{form.t("vnc.qualityLow")}</option>
          </select>
        </Field>
        <Field label={form.t("vnc.scaling")}>
          <div className="flex items-center gap-3">
            <select data-testid="session-vnc-scaling" className="taomni-input w-40" value={String(form.vncViewer.scaling)} onChange={(event) => form.setVncViewer((current) => ({ ...current, scaling: normalizeVncScaling(event.target.value) }))}>
              <option value="auto">{form.t("vnc.scaleAutomatically")}</option>
              <option value="fit">{form.t("vnc.scaleFitWindow")}</option>
              <option value="fit-width">{form.t("vnc.scaleFitWidth")}</option>
              <option value="fit-height">{form.t("vnc.scaleFitHeight")}</option>
              {VNC_SCALE_PERCENTAGES.map((percent) => (
                <option key={percent} value={String(percent)}>{percent}%</option>
              ))}
            </select>
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-preserve-aspect" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.preserveAspect} onChange={(event) => form.setVncViewer((current) => ({ ...current, preserveAspect: event.target.checked }))} />
              {form.t("vnc.preserveAspect")}
            </label>
          </div>
        </Field>
        <Field label={form.t("vnc.propertiesKeys")}>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-special-keys" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.passSpecialKeys} onChange={(event) => form.setVncViewer((current) => ({ ...current, passSpecialKeys: event.target.checked }))} />
              {form.t("vnc.propertiesPassSpecialKeys")}
            </label>
            <label className="flex items-center gap-2">
              {form.t("vnc.propertiesMenuKey")}
              <select data-testid="session-vnc-menu-key" className="taomni-input w-24" value={form.vncViewer.menuKey} onChange={(event) => form.setVncViewer((current) => ({ ...current, menuKey: event.target.value as VncViewerOptions["menuKey"] }))}>
                {(["F8", "F9", "F10", "F11", "F12", "none"] as const).map((key) => (
                  <option key={key} value={key}>{key === "none" ? form.t("vnc.propertiesMenuKeyNone") : key}</option>
                ))}
              </select>
            </label>
          </div>
        </Field>
        <Field label={form.t("vnc.propertiesClipboard")}>
          <select data-testid="session-vnc-clipboard-policy" className="taomni-input w-64" value={form.vncClipboardPolicy} onChange={(event) => form.setVncClipboardPolicy(event.target.value as typeof form.vncClipboardPolicy)}>
            <option value="bidirectional">{form.t("vnc.clipboardBidirectional")}</option>
            <option value="client-to-server">{form.t("vnc.clipboardClientToServer")}</option>
            <option value="server-to-client">{form.t("vnc.clipboardServerToClient")}</option>
            <option value="disabled">{form.t("vnc.clipboardDisabled")}</option>
          </select>
        </Field>
        <Field label={form.t("sessionEditor2.vncInput")}>
          <label className="flex items-center gap-2">
            <input data-testid="session-vnc-view-only" type="checkbox" className="taomni-checkbox" checked={form.vncViewOnly} onChange={(event) => form.setVncViewOnly(event.target.checked)} />
            {form.t("sessionEditor2.vncViewOnlyHint")}
          </label>
        </Field>
        <Field label={form.t("sessionEditor2.vncClipboardOnConnect")}>
          <label className="flex items-center gap-2">
            <input data-testid="session-vnc-initial-clipboard" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.sendInitialClipboard} onChange={(event) => form.setVncViewer((current) => ({ ...current, sendInitialClipboard: event.target.checked }))} />
            {form.t("vnc.propertiesSendInitialClipboard")}
          </label>
        </Field>
        <Field label={form.t("vnc.propertiesConnection")}>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-shared" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.shared} onChange={(event) => form.setVncViewer((current) => ({ ...current, shared: event.target.checked }))} />
              {form.t("vnc.propertiesShared")}
            </label>
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-warn-unencrypted" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.warnUnencrypted} onChange={(event) => form.setVncViewer((current) => ({ ...current, warnUnencrypted: event.target.checked }))} />
              {form.t("vnc.propertiesWarnUnencrypted")}
            </label>
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-auto-reconnect" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.autoReconnect} onChange={(event) => form.setVncViewer((current) => ({ ...current, autoReconnect: event.target.checked }))} />
              {form.t("vnc.propertiesAutoReconnect")}
            </label>
            <label className="flex items-center gap-2">
              <input data-testid="session-vnc-bell" type="checkbox" className="taomni-checkbox" checked={form.vncViewer.acceptBell} onChange={(event) => form.setVncViewer((current) => ({ ...current, acceptBell: event.target.checked }))} />
              {form.t("vnc.propertiesAcceptBell")}
            </label>
          </div>
        </Field>
        <div className="col-span-12 rounded border px-3 py-2 text-[11px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
          {form.t("sessionEditor2.vncSecurityNote")}
        </div>
      </div>
    )}
    {navigation.activeSection === "mail" && form.isMail && (
      <div data-testid="session-mail-section">
        <MailSettings
          provider={form.mailForm.mailProvider} setProvider={actions.handleMailProviderChange}
          authMode={form.mailForm.mailAuthMode} setAuthMode={form.mailForm.setMailAuthMode}
          imapHost={form.host} setImapHost={form.setHost}
          imapPort={form.port} setImapPort={form.setPort}
          username={form.username} setUsername={(value) => { form.setUsername(value); form.setSpecifyUser(true); }}
          password={form.password} setPassword={form.setPassword}
          passwordRef={form.passwordRef} clearPasswordRef={() => form.setPasswordRef("")}
          saveInVault={form.saveInVault} setSaveInVault={form.setSaveInVault}
          displayName={form.mailForm.mailDisplayName} setDisplayName={form.mailForm.setMailDisplayName}
          replyTo={form.mailForm.mailReplyTo} setReplyTo={form.mailForm.setMailReplyTo}
          signature={form.mailForm.mailSignature} setSignature={form.mailForm.setMailSignature}
          imapSecurity={form.mailForm.mailImapSecurity} setImapSecurity={form.mailForm.setMailImapSecurity}
          smtpHost={form.mailForm.mailSmtpHost} setSmtpHost={form.mailForm.setMailSmtpHost}
          smtpPort={form.mailForm.mailSmtpPort} setSmtpPort={form.mailForm.setMailSmtpPort}
          smtpSecurity={form.mailForm.mailSmtpSecurity} setSmtpSecurity={form.mailForm.setMailSmtpSecurity}
          smtpUsername={form.mailForm.mailSmtpUsername} setSmtpUsername={form.mailForm.setMailSmtpUsername}
          smtpUseImapAuth={form.mailForm.mailSmtpUseImapAuth} setSmtpUseImapAuth={form.mailForm.setMailSmtpUseImapAuth}
          smtpPassword={form.mailForm.mailSmtpPassword} setSmtpPassword={form.mailForm.setMailSmtpPassword}
          smtpPasswordRef={form.mailForm.mailSmtpPasswordRef} clearSmtpPasswordRef={() => form.mailForm.setMailSmtpPasswordRef("")}
          smtpSaveInVault={form.mailForm.mailSmtpSaveInVault} setSmtpSaveInVault={form.mailForm.setMailSmtpSaveInVault}
          oauthClientId={form.mailForm.mailOauthClientId} setOauthClientId={form.mailForm.setMailOauthClientId}
          oauthClientSecret={form.mailForm.mailOauthClientSecret} setOauthClientSecret={form.mailForm.setMailOauthClientSecret}
          oauthClientSecretRef={form.mailForm.mailOauthClientSecretRef} clearOauthClientSecretRef={() => form.mailForm.setMailOauthClientSecretRef("")}
          oauthClientSecretSaveInVault={form.mailForm.mailOauthClientSecretSaveInVault} setOauthClientSecretSaveInVault={form.mailForm.setMailOauthClientSecretSaveInVault}
          oauthFlow={form.mailForm.mailOauthFlow} setOauthFlow={(value) => {
            form.mailForm.setMailOauthFlow(value);
            form.mailForm.setMailOauthDeviceInfo(null);
            form.mailForm.setMailOauthStatus(null);
          }}
          oauthDeviceInfo={form.mailForm.mailOauthDeviceInfo}
          oauthTokenRef={form.mailForm.mailOauthTokenRef}
          oauthExpiresAt={form.mailForm.mailOauthExpiresAt}
          oauthScope={form.mailForm.mailOauthScope}
          oauthConnecting={form.mailForm.mailOauthConnecting}
          oauthStatus={form.mailForm.mailOauthStatus}
          onOAuthConnect={() => void actions.handleMailOAuthConnect()}
          cacheEnabled={form.mailForm.mailCacheEnabled} setCacheEnabled={form.mailForm.setMailCacheEnabled}
          storage={form.mailForm.mailStorage} setStorage={form.mailForm.setMailStorage} accountId={session?.id}
          saveDirectory={form.mailForm.mailSaveDirectory} setSaveDirectory={form.mailForm.setMailSaveDirectory}
          onBrowseSaveDirectory={() => void actions.handleBrowseMailSaveDirectory()}
          headerRetentionDays={form.mailForm.mailHeaderRetentionDays} setHeaderRetentionDays={form.mailForm.setMailHeaderRetentionDays}
          headerLimitPerFolder={form.mailForm.mailHeaderLimitPerFolder} setHeaderLimitPerFolder={form.mailForm.setMailHeaderLimitPerFolder}
          bodyRecentLimit={form.mailForm.mailBodyRecentLimit} setBodyRecentLimit={form.mailForm.setMailBodyRecentLimit}
          bodyMaxBytes={form.mailForm.mailBodyMaxBytes} setBodyMaxBytes={form.mailForm.setMailBodyMaxBytes}
          attachmentCache={form.mailForm.mailAttachmentCache} setAttachmentCache={form.mailForm.setMailAttachmentCache}
          syncOnOpen={form.mailForm.mailSyncOnOpen} setSyncOnOpen={form.mailForm.setMailSyncOnOpen}
          idlePush={form.mailForm.mailIdlePush} setIdlePush={form.mailForm.setMailIdlePush}
          subscribedOnly={form.mailForm.mailSubscribedOnly} setSubscribedOnly={form.mailForm.setMailSubscribedOnly}
          incoming={form.mailForm.mailIncoming} setIncoming={form.mailForm.setMailIncoming}
          pop3LeaveDays={form.mailForm.mailPop3LeaveDays} setPop3LeaveDays={form.mailForm.setMailPop3LeaveDays}
          undoSendSeconds={form.mailForm.mailUndoSendSeconds} setUndoSendSeconds={form.mailForm.setMailUndoSendSeconds}
          cardDavUrl={form.mailForm.mailCardDavUrl} setCardDavUrl={form.mailForm.setMailCardDavUrl}
          cardDavUsername={form.mailForm.mailCardDavUsername} setCardDavUsername={form.mailForm.setMailCardDavUsername}
          calDavUrl={form.mailForm.mailCalDavUrl} setCalDavUrl={form.mailForm.setMailCalDavUrl}
          calDavUsername={form.mailForm.mailCalDavUsername} setCalDavUsername={form.mailForm.setMailCalDavUsername}
          receiptPolicy={form.mailForm.mailReceiptPolicy} setReceiptPolicy={form.mailForm.setMailReceiptPolicy}
          specialFolders={form.mailForm.mailSpecialFolders} setSpecialFolders={form.mailForm.setMailSpecialFolders}
          desktopNotify={form.mailForm.mailDesktopNotify} setDesktopNotify={form.mailForm.setMailDesktopNotify}
          syncIntervalMinutes={form.mailForm.mailSyncIntervalMinutes} setSyncIntervalMinutes={form.mailForm.setMailSyncIntervalMinutes}
          maxFetchPerSync={form.mailForm.mailMaxFetchPerSync} setMaxFetchPerSync={form.mailForm.setMailMaxFetchPerSync}
          saveSentCopy={form.mailForm.mailSaveSentCopy} setSaveSentCopy={form.mailForm.setMailSaveSentCopy}
          identities={form.mailForm.mailIdentityList} setIdentities={form.mailForm.setMailIdentityList}
          aiEnabled={form.mailForm.mailAiEnabled} setAiEnabled={form.mailForm.setMailAiEnabled}
          aiSkipBodyConfirm={form.mailForm.mailAiSkipBodyConfirm} setAiSkipBodyConfirm={form.mailForm.setMailAiSkipBodyConfirm}
          vaultState={form.vaultState}
        />
      </div>
    )}
    {navigation.activeSection === "database" && form.isDb && (
      <div data-testid="session-database-section">
        <DatabaseSettings
          proto={form.proto}
          username={form.username} setUsername={(v) => { form.setUsername(v); form.setSpecifyUser(true); }}
          password={form.password} setPassword={form.setPassword}
          passwordRef={form.passwordRef} clearPasswordRef={() => form.setPasswordRef("")}
          saveInVault={form.saveInVault} setSaveInVault={form.setSaveInVault}
          vaultState={form.vaultState}
          catalog={form.databaseForm.dbCatalog} setCatalog={form.databaseForm.setDbCatalog}
          database={form.databaseForm.dbDatabase} setDatabase={form.databaseForm.setDbDatabase}
          ssl={form.databaseForm.dbSsl} setSsl={form.databaseForm.setDbSsl}
          timeoutSecs={form.databaseForm.dbTimeout} setTimeoutSecs={form.databaseForm.setDbTimeout}
          httpPort={form.databaseForm.dbHttpPort} setHttpPort={form.databaseForm.setDbHttpPort}
          chProtocol={form.databaseForm.dbChProtocol} setChProtocol={form.databaseForm.setDbChProtocol}
          prestoDialect={form.databaseForm.dbPrestoDialect} setPrestoDialect={form.databaseForm.setDbPrestoDialect}
          redisDbIndex={form.databaseForm.dbRedisIndex} setRedisDbIndex={form.databaseForm.setDbRedisIndex}
        />
      </div>
    )}
    {navigation.activeSection === "database" && form.isHBase && (
      <div data-testid="session-hbase-section">
        <HBaseSettings
          host={form.host} setHost={form.setHost}
          port={form.port} setPort={form.setPort}
          username={form.username} setUsername={(v) => { form.setUsername(v); form.setSpecifyUser(true); }}
          password={form.password} setPassword={form.setPassword}
          passwordRef={form.passwordRef} clearPasswordRef={() => form.setPasswordRef("")}
          saveInVault={form.saveInVault} setSaveInVault={form.setSaveInVault}
          vaultState={form.vaultState}
          namespace={form.databaseForm.hbaseNamespace} setNamespace={form.databaseForm.setHBaseNamespace}
          restPath={form.databaseForm.hbaseRestPath} setRestPath={form.databaseForm.setHBaseRestPath}
          connectionMode={form.databaseForm.hbaseConnectionMode} setConnectionMode={form.databaseForm.setHBaseConnectionMode}
          zkQuorum={form.databaseForm.hbaseZkQuorum} setZkQuorum={form.databaseForm.setHBaseZkQuorum}
          zkRoot={form.databaseForm.hbaseZkRoot} setZkRoot={form.databaseForm.setHBaseZkRoot}
          effectiveUser={form.databaseForm.hbaseEffectiveUser} setEffectiveUser={form.databaseForm.setHBaseEffectiveUser}
          ssl={form.databaseForm.dbSsl} setSsl={form.databaseForm.setDbSsl}
          timeoutSecs={form.databaseForm.dbTimeout} setTimeoutSecs={form.databaseForm.setDbTimeout}
          authMethod={form.databaseForm.hbaseAuthMethod} setAuthMethod={form.databaseForm.setHBaseAuthMethod}
          servicePrincipal={form.databaseForm.hbaseServicePrincipal} setServicePrincipal={form.databaseForm.setHBaseServicePrincipal}
          principal={form.databaseForm.hbasePrincipal} setPrincipal={form.databaseForm.setHBasePrincipal}
          keytabPath={form.databaseForm.hbaseKeytabPath} setKeytabPath={form.databaseForm.setHBaseKeytabPath}
          krb5ConfPath={form.databaseForm.hbaseKrb5ConfPath} setKrb5ConfPath={form.databaseForm.setHBaseKrb5ConfPath}
          hbaseSitePath={form.databaseForm.hbaseSitePath} setHBaseSitePath={form.databaseForm.setHBaseSitePath}
        />
      </div>
    )}
    {navigation.activeSection === "objectstorage" && form.isObjectStorage && (
      <div data-testid="session-objectstorage-wrap">
        <ObjectStorageSettings
          value={form.oss}
          onChange={form.setOss}
          saveInVault={form.saveInVault}
          setSaveInVault={form.setSaveInVault}
        />
      </div>
    )}
    {navigation.activeSection === "proxy" && form.isProxy && (
      <div data-testid="session-proxy-section" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
        <Field label={form.t("sessionEditor2.proxyKindLabel")}>
          <Select
            value={form.proxyKind === "http" ? form.t("sessionEditor2.proxyHttp") : form.t("sessionEditor2.proxySocks5")}
            options={[form.t("sessionEditor2.proxyHttp"), form.t("sessionEditor2.proxySocks5")]}
            onChange={(label) => form.setProxyKind(label === form.t("sessionEditor2.proxyHttp") ? "http" : "socks5")}
          />
        </Field>
        <Field label={form.t("sessionEditor2.proxyTestUrl")}>
          <input
            className="taomni-input w-64"
            placeholder={form.t("sessionEditor2.proxyTestUrlPlaceholder")}
            value={form.proxyTestUrl}
            onChange={(e) => form.setProxyTestUrl(e.target.value)}
          />
        </Field>
      </div>
    )}
    {navigation.activeSection === "network" && !form.isDb && !form.isObjectStorage && (
      <NetworkSettings
        sessionType={form.proto}
        t={form.t}
        value={form.networkSettings}
        onChange={form.setNetworkSettings}
        sessionConfigId={session?.id}
        sshSessions={form.sessions
          .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
          .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
        proxySessions={form.sessions
          .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
          .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
        onSaveAsProxySession={() => void actions.handleSaveAsProxySession()}
      />
    )}
    {navigation.activeSection === "network" && (form.isDb || form.isObjectStorage) && (
      <DbNetworkSettings
        t={form.t}
        value={form.networkSettings}
        onChange={form.setNetworkSettings}
        sshSessions={form.sessions
          .filter((s) => s.session_type === "SSH" && s.id !== session?.id)
          .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
        proxySessions={form.sessions
          .filter((s) => s.session_type === "Proxy" && s.id !== session?.id)
          .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port }))}
        onSaveAsProxySession={() => void actions.handleSaveAsProxySession()}
      />
    )}
    {navigation.activeSection === "bookmark" && (
      <BookmarkSettings
        t={form.t}
        name={form.name} setName={form.setName}
        groupPath={form.groupPath} setGroupPath={form.setGroupPath}
        folderOptions={form.folderOptions}
        description={form.description} setDescription={form.setDescription}
        tags={form.tags} setTags={form.setTags}
        proto={form.proto}
        onNewFolder={actions.handleNewFolder}
        fileEmbedInTab={form.fileEmbedInTab} setFileEmbedInTab={form.setFileEmbedInTab}
        fileExtraArgs={form.fileExtraArgs} setFileExtraArgs={form.setFileExtraArgs}
        disableAiWrite={form.disableAiWrite} setDisableAiWrite={form.setDisableAiWrite}
      />
    )}
  </div>);
}
