import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import type { MobileListenerConfig } from "../../lib/mobileListener";
import { mobileSettingsError } from "./mobileSettingsError";

/** Owns the persisted Host policy draft independently of the status polling. */
export function MobileHostSettings() {
  const t = useT();
  const [hosts, setHosts] = useState("");
  const [allowAll, setAllowAll] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let disposed = false;
    void invoke<MobileListenerConfig>("mobile_listener_get").then(config => {
      if (disposed) return;
      setHosts(config.allowed_hosts.join("\n"));
      setAllowAll(config.allow_all_hosts);
      setLoaded(true);
      setError("");
    }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [reload]);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const config = await invoke<MobileListenerConfig>("mobile_listener_save", {
        config: {
          allowed_hosts: hosts.split(/\r?\n/).map(host => host.trim()).filter(Boolean),
          allow_all_hosts: allowAll,
        },
      });
      setHosts(config.allowed_hosts.join("\n"));
      setAllowAll(config.allow_all_hosts);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return <section data-testid="mobile-settings-hosts" className="mt-4 border-t border-[var(--taomni-divider)] pt-3 space-y-2">
    <h4 className="font-medium">{t("mobileSettings.hostsTitle")}</h4>
    <p className="text-[var(--taomni-text-muted)]">{t("mobileSettings.hostsHint")}</p>
    {!loaded && !error && <p data-testid="mobile-settings-hosts-loading">{t("mobileSettings.hostsLoading")}</p>}
    <label className="block">
      <input data-testid="mobile-settings-allow-all-hosts" type="checkbox" checked={allowAll} disabled={!loaded || busy} onChange={e => {
        setAllowAll(e.target.checked);
        setSaved(false);
      }} />
      {" "}{t("mobileSettings.allowAllHosts")}
    </label>
    <p data-testid="mobile-settings-hosts-warning" className="text-amber-600 dark:text-amber-400">{t("mobileSettings.allHostsWarning")}</p>
    <label className="block">
      {t("mobileSettings.allowedHosts")}
      <textarea data-testid="mobile-settings-allowed-hosts" className="mt-1 block w-full border rounded px-2 py-1" rows={3} value={hosts} disabled={!loaded || busy || allowAll} placeholder={"pc.example.com\npc.example.com:8443"} onChange={e => {
        setHosts(e.target.value);
        setSaved(false);
      }} />
    </label>
    <p className="text-[var(--taomni-text-muted)]">{t("mobileSettings.hostsApplyHint")}</p>
    <button data-testid="mobile-settings-save-hosts" className="border rounded px-3 py-1.5" disabled={!loaded || busy} onClick={() => void save()}>{t("mobileSettings.saveHosts")}</button>
    {!loaded && error && <button data-testid="mobile-settings-reload-hosts" className="ml-2 border rounded px-3 py-1.5" onClick={() => { setError(""); setReload(value => value + 1); }}>{t("mobileSettings.retryHosts")}</button>}
    {saved && <p role="status" data-testid="mobile-settings-hosts-saved">{t("mobileSettings.hostsSaved")}</p>}
    {error && <p role="alert" data-testid="mobile-settings-hosts-error" className="text-red-400">{mobileSettingsError(error, t)}</p>}
  </section>;
}
