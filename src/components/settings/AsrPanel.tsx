import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AppProxyPanel } from "./AppProxyPanel";
import { useAiStore, type AsrConfig } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
interface Model {
  id: string; filename: string; bytes: number; installed: boolean; license: string;
  available_version?: string; installed_version?: string | null;
  update_available?: boolean; integrity?: "missing" | "unverified" | "verified" | "corrupt";
}
export function AsrPanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const t = useT();
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const savedProxy = config?.asr.download_proxy;
  const [downloadProxy, setDownloadProxy] = useState(savedProxy);
  useEffect(() => { setDownloadProxy(savedProxy); }, [savedProxy]);
  const proxyDirty = JSON.stringify(downloadProxy) !== JSON.stringify(savedProxy);
  const refresh = () => invoke<Model[]>("voice_models").then(setModels);
  useEffect(() => {
    if (!config) void loadConfig();
    void refresh().catch((e) => setError(String(e)));
    void invoke<boolean>("voice_capture_supported").then(setSupported).catch(() => setSupported(false));
    let disposed = false;
    const unlisten = listen<{ model_id: string; bytes: number; total: number }>("voice-model-progress", ({ payload }) => {
      if (!disposed) setProgress(Math.round(payload.bytes / payload.total * 100));
    });
    return () => { disposed = true; void unlisten.then((fn) => fn()).catch(() => undefined); };
  }, []);
  const install = async (model: Model, offline: boolean) => {
    setBusy(model.id); setProgress(0); setError("");
    try {
      const sourcePath = offline ? await open({ multiple: false, filters: [{ name: "Whisper", extensions: ["bin"] }] }) : null;
      if (offline && !sourcePath) return;
      await invoke("voice_install_model", { modelId: model.id, sourcePath });
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  const checkModels = async () => {
    setBusy("check"); setError(""); setChecked(false);
    try { setModels(await invoke<Model[]>("voice_check_models")); setChecked(true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  const select = async (patch: Partial<AsrConfig>) => {
    if (!config) return;
    setError(""); setBusy("config");
    try { await saveConfig({ ...config, asr: { ...config.asr, ...patch, warm_on_startup: false, vad: "none" } }); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  return <div className="space-y-3 text-xs" data-testid="asr-settings">
    <div className="text-[13px] font-semibold">{t("aiSettings.asrTitle")} · Whisper</div>
    <p>{t("voice.privacy")}</p>
    <p className="text-[var(--taomni-text-muted)]">{t("voice.modelHelp")}</p>
    {!supported && <p role="alert">{t("voice.unsupported")}</p>}
    <label className="block">{t("voice.language")}
      <select className="taomni-input ml-2" data-testid="asr-language" value={config?.asr.language ?? "auto"} disabled={!!busy} onChange={(e) => void select({ language: e.target.value })}>
        {["auto", "zh", "en", "ja", "ko", "fr", "de", "es"].map((language) => <option key={language} value={language}>{language === "auto" ? t("voice.autoLanguage") : ({ zh: "中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } as Record<string, string>)[language]}</option>)}
      </select>
    </label>
    {downloadProxy && <fieldset disabled={!!busy} className="rounded border border-[var(--taomni-divider)] p-3 space-y-2" data-testid="asr-download-proxy">
      <label className="block">{t("voice.downloadProxy")}
        <select className="taomni-input ml-2" data-testid="asr-download-proxy-mode" value={downloadProxy.mode} onChange={(e) => setDownloadProxy({ ...downloadProxy, mode: e.target.value as typeof downloadProxy.mode })}>
          <option value="app">{t("voice.proxyApp")}</option>
          <option value="custom">{t("voice.proxyCustom")}</option>
          <option value="none">{t("aiSettings.codexProxyNone")}</option>
        </select>
      </label>
      {downloadProxy.mode === "custom" && <AppProxyPanel value={downloadProxy.custom} onSave={async (custom) => setDownloadProxy((current) => current ? { ...current, custom } : current)} testHost="huggingface.co" />}
      <p className="text-[var(--taomni-text-muted)]">{t("voice.proxyHelp")}</p>
      <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-download-proxy-save" disabled={!proxyDirty} onClick={() => void select({ download_proxy: downloadProxy })}>{t("voice.proxySave")}</button>
      {proxyDirty && <p role="status">{t("voice.proxyUnsaved")}</p>}
    </fieldset>}
    <p className="text-[var(--taomni-text-muted)]">{t("voice.updateHelp")}</p>
    <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-check-models" disabled={!!busy} onClick={() => void checkModels()}>{t("voice.checkModels")}</button>
    {checked && <p role="status">{t("voice.checkComplete")}</p>}
    {models.map((m) => <div key={m.id} className="rounded border border-[var(--taomni-divider)] p-3 space-y-2" data-testid={`asr-model-${m.id}`}>
      <div className="flex justify-between"><strong>{m.id.replace("whisper-", "Whisper ")}</strong><span>{Math.round(m.bytes / 1e6)} MB · {m.license}</span></div>
      <p>{m.update_available ? t("voice.updateAvailable") : m.integrity === "corrupt" ? t("voice.corrupt") : m.integrity === "verified" ? t("voice.verified") : m.installed ? t("voice.installed") : t("voice.notInstalled")}{config?.asr.active === m.id ? ` · ${t("voice.selected")}` : ""}</p>
      {m.available_version && <p className="text-[var(--taomni-text-muted)]">{t("voice.version")} {m.available_version}{m.installed_version && m.installed_version !== m.available_version ? ` ← ${m.installed_version}` : ""}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="taomni-btn px-2 py-1" disabled={!!busy || !supported || proxyDirty || !config} data-testid={`asr-download-${m.id}`} onClick={() => void install(m, false)}>{m.update_available ? t("voice.updateModel") : m.installed || m.integrity === "corrupt" ? t("voice.reinstall") : t("voice.download")}</button>
        <button type="button" className="taomni-btn px-2 py-1" disabled={!!busy || !supported} onClick={() => void install(m, true)}>{t("voice.import")}</button>
        <button type="button" className="taomni-btn px-2 py-1" disabled={!!busy || !m.installed || config?.asr.active === m.id} data-testid={`asr-select-${m.id}`} onClick={() => void select({ active: m.id })}>{t("voice.useModel")}</button>
      </div>
      {busy === m.id && <div role="status">{t("voice.installing")} {progress}%</div>}
    </div>)}
    <p className="text-[var(--taomni-text-muted)]">{t("voice.downloadConsent")}</p>
    {error && <p role="alert" className="text-red-400 break-words">{error}</p>}
  </div>;
}
