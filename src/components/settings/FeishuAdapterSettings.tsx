import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { isVaultLockedError, type AppProxyConfig } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useVaultStore } from "../../stores/vaultStore";
import { AppProxyPanel } from "./AppProxyPanel";
import { FeishuSetupGuide } from "./FeishuSetupGuide";
import { mobileSettingsError } from "./mobileSettingsError";

interface Config {
  app_id: string; secret_ref: string; mobile_endpoint: string; allow_file_content?: boolean;
  bindings: { open_id: string; chat_id: string }[];
  proxy_mode: "app" | "custom" | "none"; custom_proxy: AppProxyConfig;
}
interface Status {
  state: string; error: string | null; reconnects: number; delivered: number;
  failed_deliveries: number; rejected: number; duplicates: number;
}
interface View { config: Config; status: Status; secret_configured: boolean }
const stateKeys: Record<string, string> = {
  stopped: "feishuSettings.states.stopped",
  connecting: "feishuSettings.states.connecting",
  connected: "feishuSettings.states.connected",
  reconnecting: "feishuSettings.states.reconnecting",
};
export function FeishuAdapterSettings({ mobileEnabled }: { mobileEnabled: boolean }) {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [bindings, setBindings] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let disposed = false;
    let initialized = false;
    const refresh = async () => {
      try {
        const next = await invoke<View>("mobile_feishu_get");
        if (!disposed) {
          setView(next);
          if (!initialized) {
            initialized = true;
            setDraft(next.config);
            setBindings(next.config.bindings.map(b => `${b.open_id} ${b.chat_id}`).join("\n"));
          }
        }
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!draft || !view) return <p data-testid="feishu-loading">{t("feishuSettings.loading")}{error && mobileSettingsError(error, t)}</p>;
  const running = view.status.state !== "stopped";
  const parsedBindings = bindings.split("\n").filter(v => v.trim()).map(line => {
    const [open_id = "", chat_id = "", ...extra] = line.trim().split(/\s+/);
    return { open_id, chat_id: extra.length ? "" : chat_id };
  });
  const config = { ...draft, bindings: parsedBindings };
  const dirty = !!secret || JSON.stringify(config) !== JSON.stringify(view.config);
  const act = async (run: () => Promise<void>) => {
    setBusy(true); setError(""); setSaved(false);
    try {
      try { await run(); } catch (e) {
        if (!isVaultLockedError(e)) throw e;
        await useVaultStore.getState().refresh();
        if (!(await ensureVaultReady(t("feishuSettings.vaultReason")))) {
          throw new Error("vault_cancelled");
        }
        await run();
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const patch = (value: Partial<Config>) => { setDraft({ ...draft, ...value }); setSaved(false); };
  return <section data-testid="feishu-settings" className="mt-5 border-t pt-4 space-y-3">
    <h4 className="font-semibold">{t("feishuSettings.title")}</h4>
    <p>{t("feishuSettings.description")}</p>
    <p className="text-[var(--taomni-text-muted)]">{t("feishuSettings.setupHint")}</p>
    <FeishuSetupGuide />
    <fieldset disabled={busy || running} className="space-y-3">
      <label className="block">{t("feishuSettings.appId")}<input data-testid="feishu-app-id" className="taomni-input w-full" value={draft.app_id} onChange={e => patch({ app_id: e.target.value.trim() })} placeholder="cli_…" autoComplete="off" /></label>
      <label className="block">{t("feishuSettings.appSecret", { hint: t(view.secret_configured ? "feishuSettings.secretSaved" : "feishuSettings.secretVault") })}<input data-testid="feishu-app-secret" className="taomni-input w-full" type="password" value={secret} onChange={e => { setSecret(e.target.value); setSaved(false); }} autoComplete="new-password" /></label>
      <label className="block">{t("feishuSettings.mobileEndpoint")}<input data-testid="feishu-mobile-endpoint" className="taomni-input w-full" value={draft.mobile_endpoint} onChange={e => patch({ mobile_endpoint: e.target.value })} placeholder="https://pc.example.com" /></label>
      <label className="block">{t("feishuSettings.bindings")}<textarea data-testid="feishu-bindings" className="taomni-input w-full" rows={3} value={bindings} onChange={e => { setBindings(e.target.value); setSaved(false); }} placeholder="ou_… oc_…" /></label>
      <p>{t("feishuSettings.bindingsHint")}</p>
      <p>{t("feishuSettings.privacyHint")}</p>
      <label className="block"><input id="feishu-allow-files" data-testid="feishu-allow-files" type="checkbox" checked={draft.allow_file_content ?? false} onChange={e => patch({ allow_file_content: e.target.checked })} />{t("feishuSettings.allowFiles")}</label>
      <label className="block">{t("feishuSettings.proxy")}<select data-testid="feishu-proxy-mode" className="taomni-input w-full" value={draft.proxy_mode} onChange={e => patch({ proxy_mode: e.target.value as Config["proxy_mode"] })}>
        <option value="app">{t("feishuSettings.proxyApp")}</option><option value="custom">{t("feishuSettings.proxyCustom")}</option><option value="none">{t("feishuSettings.proxyNone")}</option>
      </select></label>
      {draft.proxy_mode === "custom" && <div data-testid="feishu-custom-proxy"><AppProxyPanel value={draft.custom_proxy} onSave={async custom_proxy => patch({ custom_proxy })} testHost="open.feishu.cn" /></div>}
    </fieldset>
    <div className="flex gap-2 flex-wrap">
      <button data-testid="feishu-save" className="border rounded px-3 py-1.5" disabled={busy || running || !dirty} onClick={() => void act(async () => {
        const next = await invoke<View>("mobile_feishu_save", { config, secret: secret || null });
        setView(next); setDraft(next.config); setSecret(""); setBindings(next.config.bindings.map(b => `${b.open_id} ${b.chat_id}`).join("\n")); setSaved(true);
      })}>{t("feishuSettings.save")}</button>
      <button data-testid="feishu-toggle" className="border rounded px-3 py-1.5" disabled={busy || (!running && (!mobileEnabled || dirty || !view.secret_configured || !draft.app_id || !config.bindings.length))} onClick={() => void act(async () => {
        const status = await invoke<Status>(running ? "mobile_feishu_stop" : "mobile_feishu_start");
        setView({ ...view, status });
      })}>{t(running ? "feishuSettings.stop" : "feishuSettings.start")}</button>
    </div>
    {saved && <p role="status" data-testid="feishu-saved">{t("feishuSettings.saved")}</p>}
    <p data-testid="feishu-status">{t("feishuSettings.status", {
      state: stateKeys[view.status.state] ? t(stateKeys[view.status.state]) : view.status.state,
      delivered: view.status.delivered,
      failed: view.status.failed_deliveries,
      rejected: view.status.rejected,
      duplicates: view.status.duplicates,
      reconnects: view.status.reconnects,
    })}</p>
    {(error || view.status.error) && <p role="alert" data-testid="feishu-error">{mobileSettingsError(error || view.status.error || "", t)}</p>}
    <p>{t("feishuSettings.commands")}</p>
  </section>;
}
