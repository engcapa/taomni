import { useEffect, useState } from "react";
import { Network, Loader2 } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  type AppProxyConfig,
  getAppProxyConfig,
  saveAppProxyConfig,
  getSession,
  listSessions,
  saveSession,
  testProxyConnection,
  vaultStatus,
  vaultPut,
  VAULT_LOCKED_EVENT,
} from "../../lib/ipc";

const DEFAULT_CFG: AppProxyConfig = {
  enabled: false,
  mode: "manual",
  session_id: "",
  kind: "http",
  host: "",
  port: 3128,
  username: "",
  password_ref: "",
};

const KIND_OPTIONS = [
  { value: "http", label: "HTTP CONNECT" },
  { value: "socks5", label: "SOCKS 5" },
] as const;

interface ProxySessionOption {
  id: string;
  name: string;
  host: string;
  port: number;
}

/**
 * Application-level outbound proxy settings. A single global proxy the app
 * routes its own traffic through (currently: update checks/downloads). Either
 * references a saved Proxy session or carries manual fields. The manual
 * password is stored in the vault — only a `vault:<id>` ref is persisted.
 */
export function AppProxyPanel() {
  const t = useT();
  const [cfg, setCfg] = useState<AppProxyConfig | null>(null);
  const [proxySessions, setProxySessions] = useState<ProxySessionOption[]>([]);
  const [password, setPassword] = useState("");
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    getAppProxyConfig()
      .then((c) => setCfg(c))
      .catch(() => setCfg(DEFAULT_CFG));
    listSessions()
      .then((all) =>
        setProxySessions(
          all
            .filter((s) => s.session_type === "Proxy")
            .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port })),
        ),
      )
      .catch(() => {});
  }, []);

  if (!cfg) {
    return <div className="text-[12px] text-[var(--taomni-text-muted)]">{t("aiSettings.loading")}</div>;
  }

  // Persist a change. Every field except the password is non-secret, so we
  // auto-save it (consistent with the other settings panels).
  const persist = async (patch: Partial<AppProxyConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    try {
      await saveAppProxyConfig(next);
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    }
  };

  // Store the manual password in the vault and keep only the ref. The vault
  // must be unlocked — we never write the secret to proxy.json in the clear.
  const storePassword = async () => {
    if (!password) return;
    setBusy(true);
    setMsg(null);
    try {
      const status = await vaultStatus().catch(() => null);
      if (!status || status.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, { detail: { reason: t("settings.appProxyVaultLocked") } }),
        );
        setMsg({ ok: false, text: t("settings.appProxyVaultLocked") });
        return;
      }
      const res = await vaultPut("app_proxy_password", "Application Proxy Password", password);
      await persist({ password_ref: res.reference });
      setPassword("");
      setMsg({ ok: true, text: t("settings.appProxySaved") });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const clearPassword = async () => {
    setPassword("");
    await persist({ password_ref: "" });
  };

  // Resolve the proxy params to test, for the active mode. The backend
  // `test_proxy_connection` command resolves any `vault:<id>` password ref.
  const resolveTestParams = async (): Promise<{
    kind: string;
    host: string;
    port: number;
    user: string;
    pass: string;
  } | null> => {
    if (cfg.mode === "session") {
      if (!cfg.session_id) return null;
      const s = await getSession(cfg.session_id);
      let opts: Record<string, unknown> = {};
      try {
        opts = JSON.parse(s.options_json) as Record<string, unknown>;
      } catch {
        opts = {};
      }
      return {
        kind: typeof opts.proxyKind === "string" ? opts.proxyKind : "http",
        host: s.host,
        port: s.port,
        user: s.username ?? "",
        pass: typeof opts.passwordRef === "string" ? opts.passwordRef : "",
      };
    }
    return {
      kind: cfg.kind,
      host: cfg.host.trim(),
      port: cfg.port || 3128,
      user: cfg.username.trim(),
      pass: password || cfg.password_ref,
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg(null);
    try {
      const p = await resolveTestParams();
      if (!p || !p.host) {
        setMsg({ ok: false, text: t("settings.appProxyHostRequired") });
        return;
      }
      const text = await testProxyConnection(p.kind, p.host, p.port, p.user, p.pass, "www.google.com", 443);
      setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };
  // Persist the manual entry as a reusable Proxy session. The password (if
  // any) is stored in the vault and referenced from the session options.
  const handleSaveAsSession = async () => {
    if (!cfg.host.trim()) {
      setMsg({ ok: false, text: t("settings.appProxyHostRequired") });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      let passwordRef = cfg.password_ref;
      if (password) {
        const status = await vaultStatus().catch(() => null);
        if (!status || status.state !== "unlocked") {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, { detail: { reason: t("settings.appProxyVaultLocked") } }),
          );
          setMsg({ ok: false, text: t("settings.appProxyVaultLocked") });
          return;
        }
        const res = await vaultPut("app_proxy_password", "Application Proxy Password", password);
        passwordRef = res.reference;
        await persist({ password_ref: passwordRef });
        setPassword("");
      }
      const now = Math.floor(Date.now() / 1000);
      const kind = cfg.kind === "socks5" ? "socks5" : "http";
      const port = cfg.port || 3128;
      const id = crypto.randomUUID();
      await saveSession({
        id,
        name: `${kind === "http" ? "HTTP" : "SOCKS5"} ${cfg.host.trim()}:${port}`,
        session_type: "Proxy",
        group_path: null,
        host: cfg.host.trim(),
        port,
        username: cfg.username.trim() || null,
        auth_method: cfg.username.trim() ? "Password" : "None",
        options_json: JSON.stringify({ proxyKind: kind, testUrl: "www.google.com:443", passwordRef }),
        created_at: now,
        updated_at: now,
        last_connected_at: null,
        sort_order: 0,
      });
      const all = await listSessions();
      setProxySessions(
        all
          .filter((s) => s.session_type === "Proxy")
          .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port })),
      );
      // Switch the app proxy to reference the freshly saved session.
      await persist({ mode: "session", session_id: id });
      setMsg({ ok: true, text: t("settings.appProxySessionSaved") });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold flex items-center gap-2">
          <Network className="w-4 h-4 text-[var(--taomni-accent)]" />
          {t("settings.appProxyTitle")}
        </div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("settings.appProxySubtitle")}</div>
      </div>

      {/* Enable toggle */}
      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          cfg.enabled
            ? "border-[var(--taomni-accent)]/40 bg-[var(--taomni-accent)]/5"
            : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
        }`}
        onClick={() => persist({ enabled: !cfg.enabled })}
      >
        <div className="flex-1">
          <div className="text-[13px] font-semibold">{t("settings.appProxyEnable")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("settings.appProxyEnableDesc")}</div>
        </div>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${cfg.enabled ? "bg-[var(--taomni-accent)]" : "bg-[var(--taomni-divider)]"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${cfg.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </div>
      </div>

      {cfg.enabled && (
        <>
          {/* Source mode */}
          <div className="flex gap-4">
            {(["session", "manual"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="app-proxy-mode"
                  checked={cfg.mode === m}
                  onChange={() => persist({ mode: m })}
                  className="accent-[var(--taomni-accent)]"
                />
                <span className="text-[12px]">
                  {m === "session" ? t("settings.appProxyModeSession") : t("settings.appProxyModeManual")}
                </span>
              </label>
            ))}
          </div>
          {/* Session mode: pick a saved Proxy session */}
          {cfg.mode === "session" &&
            (proxySessions.length > 0 ? (
              <div>
                <div className="text-[11px] text-[var(--taomni-text-muted)] mb-1">{t("settings.appProxySessionSelect")}</div>
                <select
                  className="taomni-input h-8 w-full text-[12px]"
                  value={cfg.session_id}
                  onChange={(e) => persist({ session_id: e.target.value })}
                >
                  <option value="">{t("settings.appProxySessionPlaceholder")}</option>
                  {proxySessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.host}:{s.port})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("settings.appProxySessionNone")}</div>
            ))}

          {/* Manual mode: enter fields directly */}
          {cfg.mode === "manual" && (
            <div className="space-y-2">
              <div className="flex gap-4">
                {KIND_OPTIONS.map(({ value, label }) => (
                  <label key={value} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="app-proxy-kind"
                      checked={cfg.kind === value}
                      onChange={() => persist({ kind: value })}
                      className="accent-[var(--taomni-accent)]"
                    />
                    <span className="text-[12px]">{label}</span>
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="taomni-input h-7 flex-1 text-[12px]"
                  placeholder={t("settings.appProxyHost")}
                  value={cfg.host}
                  onChange={(e) => persist({ host: e.target.value })}
                />
                <input
                  type="number"
                  className="taomni-input h-7 w-24 text-[12px]"
                  placeholder={t("settings.appProxyPort")}
                  value={cfg.port || ""}
                  onChange={(e) => persist({ port: parseInt(e.target.value, 10) || 0 })}
                />
              </div>
              <input
                type="text"
                className="taomni-input h-7 w-full text-[12px]"
                placeholder={t("settings.appProxyUsername")}
                value={cfg.username}
                onChange={(e) => persist({ username: e.target.value })}
              />
              {/* Password (vault-backed). Only a vault ref is persisted. */}
              <div className="flex gap-2">
                <input
                  type="password"
                  className="taomni-input h-7 flex-1 text-[12px]"
                  placeholder={cfg.password_ref ? t("settings.appProxyPasswordStored") : t("settings.appProxyPassword")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="taomni-btn h-7 px-2 text-[11px] shrink-0"
                  onClick={storePassword}
                  disabled={busy || !password}
                >
                  {t("settings.appProxyPasswordStore")}
                </button>
                {cfg.password_ref && (
                  <button
                    type="button"
                    className="taomni-btn h-7 px-2 text-[11px] shrink-0"
                    onClick={clearPassword}
                    disabled={busy}
                  >
                    {t("settings.appProxyPasswordClear")}
                  </button>
                )}
              </div>
              <button
                type="button"
                className="taomni-btn h-7 px-2.5 text-[11px] inline-flex items-center gap-1"
                onClick={handleSaveAsSession}
                disabled={busy}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t("settings.appProxySaveAsSession")}
              </button>
            </div>
          )}
          <div className="flex items-center flex-wrap gap-2 gap-y-1">
            <button
              type="button"
              className="taomni-btn h-7 px-2.5 text-[11px] inline-flex items-center gap-1"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {testing ? t("sessionEditor2.proxyTestTesting") : t("settings.appProxyTest")}
            </button>
            {msg && (
              <span className={`text-[11px] break-all max-w-full ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</span>
            )}
          </div>
          <div className="text-[10px] text-[var(--taomni-text-muted)]">{t("settings.appProxyUpdaterNote")}</div>
        </>
      )}
    </div>
  );
}
