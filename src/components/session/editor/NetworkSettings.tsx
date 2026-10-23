import { sessionCapabilities } from "../../../lib/sessionCapabilities";
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { type IpVersion, type NetworkSettings as NetworkSettingsValue, type ProxyKind } from "../../../lib/networkSettings";
import { type TranslateFn } from "../../../lib/i18n";
import { Field, Select, Checkbox } from "./Fields";


/** Proxy selector + (HTTP/SOCKS5) proxy fields or the SSH jump-host section.
 *  Shared by the SSH Network tab and the database Network tab so both speak
 *  the same `NetworkSettings` shape and persistence path. */
export function ProxyJumpFields({
  t,
  value,
  onChange,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const isJump = value.proxyKind === "ssh-tunnel";
  const isHttpOrSocks = value.proxyKind === "http" || value.proxyKind === "socks5";
  const proxyManual = value.proxySessionId?.trim() === "";
  const jumpManual = value.jumpSessionId.trim() === "";
  return (
    <>
      <Field label={t("sessionEditor2.fieldProxy")}>
        <Select
          dataTestId="session-proxy-kind"
          value={value.proxyKind}
          options={[
            { value: "none", label: t("sessionEditor2.proxyNone") },
            { value: "http", label: t("sessionEditor2.proxyHttp") },
            { value: "socks5", label: t("sessionEditor2.proxySocks5") },
            { value: "ssh-tunnel", label: t("sessionEditor2.proxyLocalSshTunnel") },
            { value: "system", label: t("sessionEditor2.proxySystem") },
          ]}
          onChange={(kind) => patch({ proxyKind: kind as ProxyKind })}
        />
      </Field>

      {isJump && (
        <>
          <Field label={t("sessionEditor2.fieldJumpVia")}>
            <select
              data-testid="session-jump-source"
              className="taomni-input w-72"
              value={value.jumpSessionId}
              aria-label={t("sessionEditor2.jumpViaAria")}
              onChange={(e) => patch({ jumpSessionId: e.target.value })}
            >
              <option value="">{t("sessionEditor2.jumpManualOption")}</option>
              {sshSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.host}:{s.port})
                </option>
              ))}
            </select>
          </Field>

          {jumpManual && (
            <>
              <Field label={t("sessionEditor2.fieldJumpHost")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.jumpHostPlaceholder")}
                  value={value.jumpHost}
                  aria-label={t("sessionEditor2.jumpHostAria")}
                  onChange={(e) => patch({ jumpHost: e.target.value })}
                />
                <span className="text-[var(--taomni-text-muted)] ml-2">{t("sessionEditor2.portLabel")}</span>
                <input
                  className="taomni-input w-16 ml-1"
                  placeholder="22"
                  value={value.jumpPort}
                  aria-label={t("sessionEditor2.jumpPortAria")}
                  onChange={(e) => patch({ jumpPort: e.target.value })}
                />
              </Field>

              <Field label={t("sessionEditor2.fieldJumpUser")}>
                <input
                  className="taomni-input w-32"
                  placeholder={t("sessionEditor2.jumpUserPlaceholder")}
                  value={value.jumpUser}
                  aria-label={t("sessionEditor2.jumpUserAria")}
                  onChange={(e) => patch({ jumpUser: e.target.value })}
                />
                <select
                  data-testid="session-jump-auth"
                  className="taomni-input w-28 ml-2"
                  value={value.jumpAuthKind}
                  aria-label={t("sessionEditor2.jumpAuthAria")}
                  onChange={(e) => patch({ jumpAuthKind: e.target.value === "PrivateKey" ? "PrivateKey" : "Password" })}
                >
                  <option value="Password">{t("sessionEditor2.jumpAuthPassword")}</option>
                  <option value="PrivateKey">{t("sessionEditor2.jumpAuthKey")}</option>
                </select>
              </Field>

              {value.jumpAuthKind === "Password" ? (
                <Field label={t("sessionEditor2.fieldJumpPassword")}>
                  <input
                    className="taomni-input w-64"
                    type="password"
                    data-testid="session-jump-password"
                    placeholder={t("sessionEditor2.jumpPasswordPlaceholder")}
                    value={value.jumpPassword}
                    aria-label={t("sessionEditor2.jumpPasswordAria")}
                    onChange={(e) => patch({ jumpPassword: e.target.value })}
                  />
                  <label className="ml-2 flex items-center gap-1.5">
                    <Checkbox dataTestId="session-proxy-save-auth" checked={value.jumpSaveAuth} onChange={(v) => patch({ jumpSaveAuth: v })} /> {t("sessionEditor2.proxySaveInVault")}
                  </label>
                </Field>
              ) : (
                <Field label={t("sessionEditor2.fieldJumpKey")}>
                  <input
                    className="taomni-input w-72"
                    data-testid="session-jump-key"
                    placeholder={t("sessionEditor2.jumpKeyPlaceholder")}
                    value={value.jumpKeyPath}
                    aria-label={t("sessionEditor2.jumpKeyAria")}
                    onChange={(e) => patch({ jumpKeyPath: e.target.value })}
                  />
                </Field>
              )}
            </>
          )}
        </>
      )}

      {isHttpOrSocks && (
        <>
          {proxySessions.length > 0 && (
            <Field label={t("sessionEditor2.proxyViaSession")}>
              <select
                data-testid="session-proxy-source"
                className="taomni-input w-72"
                value={value.proxySessionId || ""}
                onChange={(e) => patch({ proxySessionId: e.target.value })}
              >
                <option value="">{t("sessionEditor2.proxyManualOption")}</option>
                {proxySessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host}:{s.port})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {proxyManual && (
            <>
              <Field label={t("sessionEditor2.fieldProxyHost")}>
                <input
                  className="taomni-input w-64"
                  placeholder={t("sessionEditor2.proxyHostPlaceholder")}
                  value={value.proxyHost}
                  aria-label={t("sessionEditor2.proxyHostAria")}
                  onChange={(e) => patch({ proxyHost: e.target.value })}
                />
                <span className="text-[var(--taomni-text-muted)] ml-2">{t("sessionEditor2.portLabel")}</span>
                <input
                  className="taomni-input w-16 ml-1"
                  placeholder={t("sessionEditor2.proxyPortPlaceholder")}
                  value={value.proxyPort}
                  aria-label={t("sessionEditor2.proxyPortAria")}
                  onChange={(e) => patch({ proxyPort: e.target.value })}
                />
              </Field>

              <Field label={t("sessionEditor2.fieldProxyAuth")}>
                <input
                  className="taomni-input w-32"
                  placeholder={t("sessionEditor2.proxyUserPlaceholder")}
                  value={value.proxyUser}
                  aria-label={t("sessionEditor2.proxyUserAria")}
                  onChange={(e) => patch({ proxyUser: e.target.value })}
                />
                <input
                  className="taomni-input w-40 ml-1"
                  type="password"
                  placeholder={t("sessionEditor2.proxyPassPlaceholder")}
                  value={value.proxyPass}
                  aria-label={t("sessionEditor2.proxyPassAria")}
                  onChange={(e) => patch({ proxyPass: e.target.value })}
                />
                <label className="ml-2 flex items-center gap-1.5">
                  <Checkbox dataTestId="session-proxy-save-auth" checked={value.proxySaveAuth} onChange={(v) => patch({ proxySaveAuth: v })} /> {t("sessionEditor2.proxySaveInVault")}
                </label>
              </Field>
              {onSaveAsProxySession && (
                <Field label="">
                  <button
                    data-testid="session-save-as-proxy-session"
                    className="taomni-btn flex items-center gap-1.5"
                    type="button"
                    onClick={onSaveAsProxySession}
                    title={t("sessionEditor2.saveAsProxySessionTitle")}
                  >
                    <Save className="w-3.5 h-3.5" />
                    {t("sessionEditor2.saveAsProxySession")}
                  </button>
                </Field>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}


/** Network tab for database sessions: proxy + SSH jump host only (no
 *  keep-alive / TCP / local-forward rows, which are SSH-terminal specific). */
export function DbNetworkSettings({
  t,
  value,
  onChange,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  return (
    <div data-testid="db-network-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <ProxyJumpFields t={t} value={value} onChange={onChange} sshSessions={sshSessions} proxySessions={proxySessions} onSaveAsProxySession={onSaveAsProxySession} />
    </div>
  );
}


export function NetworkSettings({
  t,
  sessionType = "SSH",
  value,
  onChange,
  sessionConfigId,
  sshSessions = [],
  proxySessions = [],
  onSaveAsProxySession,
}: {
  t: TranslateFn;
  sessionType?: string;
  value: NetworkSettingsValue;
  onChange: (next: NetworkSettingsValue) => void;
  /** When set, the Network tab subscribes to runtime forward errors
   *  for this saved session and renders the latest failure inline next
   *  to the offending row. */
  sessionConfigId?: string;
  /** Saved SSH sessions selectable as a jump host (current session excluded). */
  sshSessions?: { id: string; name: string; host: string; port: number }[];
  proxySessions?: { id: string; name: string; host: string; port: number }[];
  onSaveAsProxySession?: () => void;
}) {
  const capabilities = sessionCapabilities(sessionType);
  const [newFwdLocal, setNewFwdLocal] = useState("");
  const [newFwdRemote, setNewFwdRemote] = useState("");
  const [newFwdDesc, setNewFwdDesc] = useState("");
  // Per-row latest forward error, keyed by `${local}->${remote}`.
  const [forwardErrors, setForwardErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sessionConfigId) return;
    const onErr = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        sessionConfigId: string;
        local: string;
        remote: string;
        message: string;
      }>).detail;
      if (!detail || detail.sessionConfigId !== sessionConfigId) return;
      setForwardErrors((m) => ({
        ...m,
        [`${detail.local}->${detail.remote}`]: detail.message,
      }));
    };
    window.addEventListener("taomni:forward-error", onErr as EventListener);
    return () => window.removeEventListener("taomni:forward-error", onErr as EventListener);
  }, [sessionConfigId]);

  const patch = (delta: Partial<NetworkSettingsValue>) => onChange({ ...value, ...delta });
  const keepAlive = value.keepAlive;
  const keepAliveInterval = value.keepAliveIntervalSecs;
  const tcpNodelay = value.tcpNodelay;
  const forwards = value.localForwards;

  const setKeepAlive = (v: boolean) => patch({ keepAlive: v });
  const setKeepAliveInterval = (v: string) => patch({ keepAliveIntervalSecs: v });
  const setIpVersion = (kind: string) => patch({ ipVersion: kind as IpVersion });
  const setForwards = (
    updater: (items: NetworkSettingsValue["localForwards"]) => NetworkSettingsValue["localForwards"],
  ) => patch({ localForwards: updater(value.localForwards) });

  const addForward = () => {
    if (!newFwdLocal.trim() || !newFwdRemote.trim()) return;
    setForwards((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        local: newFwdLocal.trim(),
        remote: newFwdRemote.trim(),
        desc: newFwdDesc.trim(),
      },
    ]);
    setNewFwdLocal("");
    setNewFwdRemote("");
    setNewFwdDesc("");
  };

  return (
    <div data-testid="network-settings" className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px]">
      <ProxyJumpFields t={t} value={value} onChange={onChange} sshSessions={sshSessions} proxySessions={proxySessions} onSaveAsProxySession={onSaveAsProxySession} />

      {capabilities.keepAlive && <Field label={t("sessionEditor2.fieldKeepAlive")}>
        <label className="flex items-center gap-1.5">
          <Checkbox dataTestId="session-keepalive-toggle" checked={sessionType === "SFTP" || keepAlive} disabled={sessionType === "SFTP"} onChange={setKeepAlive} />
          {t("sessionEditor2.keepAliveSend")}
        </label>
        <input
          className="taomni-input w-16 ml-1"
          value={keepAliveInterval}
          aria-label={t("sessionEditor2.keepAliveAria")}
          onChange={(e) => setKeepAliveInterval(e.target.value)}
        />
        <span className="ml-1">{t("sessionEditor2.keepAliveSuffix")}</span>
      </Field>}

      {capabilities.transportOptions && <Field label={t("sessionEditor2.fieldTcpOptions")}>
        <label className="flex items-center gap-1.5">
          <Checkbox
            dataTestId="session-tcp-nodelay-toggle"
            checked={tcpNodelay}
            onChange={(v) => patch({ tcpNodelay: v, disableNagle: v })}
          /> {t("sessionEditor2.tcpNodelay")}
        </label>
      </Field>}

      {capabilities.transportOptions && <Field label={t("sessionEditor2.fieldIpVersion")}>
        <Select
          dataTestId="session-ip-version"
          value={value.ipVersion}
          options={[
            { value: "auto", label: t("sessionEditor2.ipAuto") },
            { value: "ipv4", label: t("sessionEditor2.ipForceIpv4") },
            { value: "ipv6", label: t("sessionEditor2.ipForceIpv6") },
          ]}
          onChange={setIpVersion}
        />
      </Field>}

      {capabilities.localForwards && <Field label={t("sessionEditor2.fieldLocalForwarding")}>
        <div className="flex flex-col gap-1 w-full">
          <div className="flex items-center gap-1.5 text-[var(--taomni-text-muted)]">
            <span className="w-32">{t("sessionEditor2.forwardLocalHeader")}</span>
            <span className="w-32">{t("sessionEditor2.forwardRemoteHeader")}</span>
            <span>{t("sessionEditor2.forwardDescHeader")}</span>
          </div>
          {forwards.map((forward) => {
            const errKey = `${forward.local.trim()}->${forward.remote.trim()}`;
            const rowError = forwardErrors[errKey];
            return (
              <div key={forward.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <input
                    className="taomni-input w-32"
                    value={forward.local}
                    aria-label={t("sessionEditor2.forwardLocalAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, local: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="taomni-input w-40"
                    value={forward.remote}
                    aria-label={t("sessionEditor2.forwardRemoteAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, remote: e.target.value } : item),
                      )
                    }
                  />
                  <input
                    className="taomni-input flex-1"
                    value={forward.desc}
                    aria-label={t("sessionEditor2.forwardDescAria")}
                    onChange={(e) =>
                      setForwards((items) =>
                        items.map((item) => item.id === forward.id ? { ...item, desc: e.target.value } : item),
                      )
                    }
                  />
                  <button data-testid={`session-forward-remove-${forward.id}`} className="taomni-btn" type="button" onClick={() => setForwards((items) => items.filter((item) => item.id !== forward.id))}>
                    {t("sessionEditor2.forwardRemove")}
                  </button>
                </div>
                {rowError && (
                  <div
                    className="text-[11px] text-red-400 ml-[2px]"
                    role="status"
                    data-testid={`forward-row-error-${forward.id}`}
                  >
                    {rowError}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <input className="taomni-input w-32" placeholder={t("sessionEditor2.forwardLocalPlaceholder")} value={newFwdLocal} aria-label={t("sessionEditor2.forwardLocalNewAria")} onChange={(e) => setNewFwdLocal(e.target.value)} />
            <input className="taomni-input w-40" placeholder={t("sessionEditor2.forwardRemotePlaceholder")} value={newFwdRemote} aria-label={t("sessionEditor2.forwardRemoteNewAria")} onChange={(e) => setNewFwdRemote(e.target.value)} />
            <input className="taomni-input flex-1" placeholder={t("sessionEditor2.forwardDescPlaceholder")} value={newFwdDesc} aria-label={t("sessionEditor2.forwardDescNewAria")} onChange={(e) => setNewFwdDesc(e.target.value)} />
            <button data-testid="session-forward-add" className="taomni-btn" type="button" onClick={addForward} disabled={!newFwdLocal.trim() || !newFwdRemote.trim()}>{t("sessionEditor2.forwardAdd")}</button>
          </div>
        </div>
      </Field>}
    </div>
  );
}
