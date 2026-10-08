import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Copy, ExternalLink, Mic, ShieldCheck } from "lucide-react";
import { writeText } from "../../lib/clipboard";
import { openExternalUrl } from "../../lib/sftp";
import { AppProxyPanel } from "./AppProxyPanel";
import { useAiStore, type AsrConfig } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
interface Model {
  id: string; filename: string; bytes: number; installed: boolean; license: string;
  download_url?: string; resumable_bytes?: number;
  available_version?: string; installed_version?: string | null;
  update_available?: boolean; integrity?: "missing" | "unverified" | "verified" | "corrupt";
}
interface Installation {
  revision: number; job_id: string; model_id: string; bytes: number; total: number;
  phase: "connecting" | "downloading" | "importing" | "verifying" | "complete" | "failed" | "cancelled";
  error?: string | null;
}
interface SherpaStatus { model_id: string; revision: string; files: { filename: string; bytes: number; downloaded: number; installed: boolean }[]; total_bytes: number; downloaded_bytes: number; installed: boolean }
interface SherpaProgress { revision: number; job_id: string; model_id: string; bytes: number; total: number; phase: "connecting" | "downloading" | "verifying" | "complete" | "failed" | "cancelled"; file?: string | null; error?: string | null }
const isRunning = (job: Installation | null) => !!job && !["complete", "failed", "cancelled"].includes(job.phase);
const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);

export function AsrPanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const t = useT();
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState("");
  const submitting = useRef(false);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [statusReady, setStatusReady] = useState(false);
  const [cancelling, setCancelling] = useState("");
  const [copied, setCopied] = useState("");
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const [sherpa, setSherpa] = useState<SherpaStatus | null>(null);
  const [sherpaProgress, setSherpaProgress] = useState<SherpaProgress | null>(null);
  const savedProxy = config?.asr.download_proxy;
  const [providerDraft, setProviderDraft] = useState<Record<string, AsrConfig["providers"][string]>>({});
  useEffect(() => { if (config?.asr.providers) setProviderDraft(config.asr.providers); }, [config?.asr.providers]);
  const [downloadProxy, setDownloadProxy] = useState(savedProxy);
  useEffect(() => { setDownloadProxy(savedProxy); }, [savedProxy]);
  const proxyDirty = JSON.stringify(downloadProxy) !== JSON.stringify(savedProxy);
  const modelsRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++modelsRequest.current;
    const result = await invoke<Model[]>("voice_models");
    if (request === modelsRequest.current) setModels(result);
  }, []);
  useEffect(() => {
    if (!config) void loadConfig();
    let disposed = false;
    let revision = 0;
    const fail = (e: unknown) => { if (!disposed) setError(String(e)); };
    const accept = (job: Installation | null) => {
      if (disposed) return;
      setStatusReady(true);
      if (!job || job.revision <= revision) return;
      revision = job.revision;
      setInstallation(job);
      if (!isRunning(job)) void refresh().catch(fail);
    };
    void refresh().catch(fail);
    void invoke<SherpaStatus>("voice_sherpa_model_status").then((value) => { if (!disposed) setSherpa(value); }).catch(fail);
    void invoke<boolean>("voice_capture_supported").then((value) => { if (!disposed) setSupported(value); }).catch(fail);
    const snapshot = () => { void invoke<Installation | null>("voice_model_installation").then(accept).catch(fail); };
    // Subscribe before the initial snapshot; revisions discard stale responses.
    const unlisten = listen<Installation>("voice-model-progress", ({ payload }) => accept(payload));
    const sherpaUnlisten = listen<SherpaProgress>("voice-sherpa-model-progress", ({ payload }) => { if (!disposed) { setSherpaProgress(payload); void invoke<SherpaStatus>("voice_sherpa_model_status").then(setSherpa).catch(fail); } });
    void unlisten.then(snapshot).catch(fail);
    snapshot();
    // Also recovers missed events and observes jobs started in another window.
    const poll = setInterval(snapshot, 1000);
    return () => { disposed = true; clearInterval(poll); void unlisten.then((fn) => fn()).catch(() => undefined); void sherpaUnlisten.then((fn) => fn()).catch(() => undefined); };
  }, [refresh]);
  const downloading = isRunning(installation);
  const blocked = !!busy || downloading || !statusReady;
  const install = async (model: Model, offline: boolean) => {
    if (submitting.current || blocked) return;
    submitting.current = true;
    setBusy(model.id); setError("");
    try {
      const sourcePath = offline ? await open({ multiple: false, filters: [{ name: "Whisper", extensions: ["bin"] }] }) : null;
      if (offline && !sourcePath) return;
      await invoke("voice_install_model", { modelId: model.id, sourcePath });
      await refresh();
    } catch (e) { if (String(e) !== "CANCELLED") setError(String(e)); }
    finally { submitting.current = false; setBusy(""); }
  };
  const cancelInstallation = async () => {
    if (!installation || !downloading) return;
    setCancelling(installation.job_id); setError("");
    try { await invoke("voice_cancel_model_installation", { jobId: installation.job_id }); }
    catch (e) { setCancelling(""); setError(String(e)); }
  };
  const checkModels = async () => {
    setBusy("check"); setError(""); setChecked(false);
    try { setModels(await invoke<Model[]>("voice_check_models")); setChecked(true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  const installSherpa = async () => {
    if (blocked) return;
    setBusy("sherpa"); setError("");
    try { await invoke("voice_install_sherpa_model"); setSherpa(await invoke<SherpaStatus>("voice_sherpa_model_status")); }
    catch (e) { if (String(e) !== "CANCELLED") setError(String(e)); }
    finally { setBusy(""); }
  };
  const select = async (patch: Partial<AsrConfig>) => {
    if (!config) return;
    setError(""); setBusy("config");
    try { await saveConfig({ ...config, asr: { ...config.asr, ...patch, warm_on_startup: false, vad: "none" } }); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  const copyLink = async (m: Model) => {
    if (!m.download_url) return;
    try { await writeText(m.download_url); setCopied(m.id); }
    catch (e) { setError(String(e)); }
  };
  const phaseLabel = (phase: Installation["phase"]) => ({
    connecting: t("voice.connecting"), downloading: t("voice.downloading"), importing: t("voice.importing"),
    verifying: t("voice.verifying"), complete: t("voice.verified"), failed: t("voice.downloadFailed"), cancelled: t("voice.downloadPaused"),
  })[phase];
  const percentage = installation ? Math.min(100, Math.floor(installation.bytes * 100 / Math.max(1, installation.total))) : 0;
  return <div className="space-y-4 text-xs" data-testid="asr-settings">
    <header className="pr-10 space-y-2">
      <div className="flex items-center gap-2 text-base font-semibold"><Mic className="h-5 w-5 text-[var(--taomni-accent)]" />{t("aiSettings.asrTitle")} <span className="text-xs font-normal text-[var(--taomni-text-muted)]">Whisper</span></div>
      <p className="flex items-start gap-2 text-[var(--taomni-text-muted)]"><ShieldCheck className="h-4 w-4 shrink-0" />{t("voice.privacy")}</p>
    </header>
    {!supported && <p role="alert">{t("voice.unsupported")}</p>}
    <section className="rounded-lg border border-[var(--taomni-divider)] p-3 space-y-3" data-testid="asr-realtime-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{t("voice.realtimeTitle")}</strong>
        <select className="taomni-input" data-testid="asr-realtime-provider" value={config?.asr.active ?? "whisper-base"} disabled={blocked}
          onChange={(e) => { const id = e.target.value; void select({ active: id, mode: ["whisper-base", "whisper-small", "whisper-medium", "sherpa-zipformer-zh-en"].includes(id) ? "local" : "online" }); }}>
          <option value="whisper-base">Whisper Base (batch)</option>
          <option value="sherpa-zipformer-zh-en">Local Zipformer (streaming)</option>
          <option value="aliyun">Aliyun Paraformer Realtime</option>
          <option value="deepgram">Deepgram Nova-3</option>
          <option value="gemini">Google Gemini Transcribe Live</option>
        </select>
      </div>
      {config?.asr.active === "sherpa-zipformer-zh-en" && <div className="space-y-2"><p className="text-[var(--taomni-text-muted)] leading-relaxed">Local streaming uses the verified Zipformer bundle in the application cache. GPU acceleration remains a later task.</p><div className="flex items-center gap-2"><span>{sherpa?.installed ? "Zipformer installed" : `Zipformer ${megabytes(sherpa?.downloaded_bytes ?? 0)} / ${megabytes(sherpa?.total_bytes ?? 0)} MB`}</span><button type="button" className="taomni-btn px-2 py-1" disabled={blocked || (!!sherpaProgress && !["complete", "failed", "cancelled"].includes(sherpaProgress.phase))} onClick={() => void installSherpa()}>{sherpa?.installed ? "Reinstall Zipformer" : "Install Zipformer"}</button>{sherpaProgress && !["complete", "failed", "cancelled"].includes(sherpaProgress.phase) && <button type="button" className="taomni-btn px-2 py-1" onClick={() => void invoke("voice_cancel_sherpa_model_installation", { jobId: sherpaProgress.job_id })}>Cancel</button>}</div>{sherpaProgress && !["complete", "failed", "cancelled"].includes(sherpaProgress.phase) && <progress className="block h-2 w-full accent-[var(--taomni-accent)]" max={100} value={Math.floor((sherpaProgress.bytes * 100) / Math.max(1, sherpaProgress.total))} />}{sherpaProgress?.error && <p className="text-red-400 break-words">{sherpaProgress.error}</p>}</div>}
      {config?.asr.mode === "online" && config.asr.providers[config.asr.active] && (() => {
        const id = config.asr.active;
        const provider = providerDraft[id] ?? config.asr.providers[id];
        const updateProvider = (patch: Partial<typeof provider>) => setProviderDraft((current) => ({ ...current, [id]: { ...provider, ...patch } }));
        return <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-1">Model<input className="taomni-input w-full" value={provider.model} onChange={(e) => updateProvider({ model: e.target.value })} /></label>
          <label className="space-y-1">API key<input className="taomni-input w-full" type="password" placeholder={provider.api_key?.startsWith("vault:") ? "Stored in credential vault" : "Required"} value={provider.api_key?.startsWith("vault:") ? "" : provider.api_key ?? ""} onChange={(e) => updateProvider({ api_key: e.target.value })} /></label>
          <label className="space-y-1">Proxy<select className="taomni-input w-full" value={provider.proxy_mode ?? "app"} onChange={(e) => updateProvider({ proxy_mode: e.target.value })}><option value="app">Application proxy</option><option value="custom">Feature proxy</option><option value="none">No proxy</option></select></label>
          {provider.proxy_mode === "custom" && <label className="space-y-1">Proxy URL<input className="taomni-input w-full" value={provider.proxy_url ?? ""} placeholder="http://10.1.0.80:3228" onChange={(e) => updateProvider({ proxy_url: e.target.value })} /></label>}
          <button type="button" className="taomni-btn px-2 py-1 justify-self-start" disabled={blocked} onClick={() => void select({ providers: providerDraft })}>Save provider</button>
          <p className="md:col-span-2 text-[var(--taomni-text-muted)]">Keys are encrypted in the credential vault when saved. A configured proxy failure is surfaced; the provider never silently falls back to a direct connection.</p>
        </div>;
      })()}
    </section>
    {installation && <section data-testid="asr-installation-progress" role="status" className={`rounded-lg border p-3 space-y-2 ${installation.phase === "failed" ? "border-red-400/40" : "border-[var(--taomni-accent)]/30 bg-[var(--taomni-accent)]/5"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{installation.model_id.replace("whisper-", "Whisper ")} · {phaseLabel(installation.phase)}</strong>
        {downloading && <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-cancel-download" disabled={cancelling === installation.job_id || installation.phase === "verifying"} onClick={() => void cancelInstallation()}>{cancelling === installation.job_id ? t("voice.cancellingDownload") : t("voice.cancelDownload")}</button>}
      </div>
      <div className="flex justify-between text-[var(--taomni-text-muted)] tabular-nums"><span>{megabytes(installation.bytes)} / {megabytes(installation.total)} MB</span><span>{percentage}%</span></div>
      <progress aria-label={t("voice.downloadProgress")} className="block h-2 w-full accent-[var(--taomni-accent)]" max={100} value={percentage} />
      {downloading && <p className="text-[var(--taomni-text-muted)]">{t("voice.backgroundDownload")}</p>}
      {installation.error && <p className="text-red-400 break-words">{installation.error}</p>}
    </section>}
    <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))]">
      <section className="space-y-3 rounded-lg bg-[var(--taomni-bg)] p-3">
        <label className="flex items-center justify-between gap-3 font-medium">{t("voice.language")}
          <select className="taomni-input" data-testid="asr-language" value={config?.asr.language ?? "auto"} disabled={blocked} onChange={(e) => void select({ language: e.target.value })}>
            {["auto", "zh", "en", "ja", "ko", "fr", "de", "es"].map((language) => <option key={language} value={language}>{language === "auto" ? t("voice.autoLanguage") : ({ zh: "中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } as Record<string, string>)[language]}</option>)}
          </select>
        </label>
        <p className="leading-relaxed text-[var(--taomni-text-muted)]">{t("voice.modelHelp")}</p>
      </section>
      {downloadProxy && <fieldset disabled={blocked} className="rounded-lg border border-[var(--taomni-divider)] p-3 space-y-2 min-w-0" data-testid="asr-download-proxy">
        <label className="flex flex-wrap items-center justify-between gap-2 font-medium">{t("voice.downloadProxy")}
          <select className="taomni-input" data-testid="asr-download-proxy-mode" value={downloadProxy.mode} onChange={(e) => setDownloadProxy({ ...downloadProxy, mode: e.target.value as typeof downloadProxy.mode })}>
            <option value="app">{t("voice.proxyApp")}</option><option value="custom">{t("voice.proxyCustom")}</option><option value="none">{t("aiSettings.codexProxyNone")}</option>
          </select>
        </label>
        {downloadProxy.mode === "custom" && <AppProxyPanel value={downloadProxy.custom} onSave={async (custom) => setDownloadProxy((current) => current ? { ...current, custom } : current)} testHost="huggingface.co" />}
        <p className="text-[var(--taomni-text-muted)] leading-relaxed">{t("voice.proxyHelp")}</p>
        <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-download-proxy-save" disabled={!proxyDirty} onClick={() => void select({ download_proxy: downloadProxy })}>{t("voice.proxySave")}</button>
        {proxyDirty && <p role="status">{t("voice.proxyUnsaved")}</p>}
      </fieldset>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t("voice.modelsTitle")}</h3>
      <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-check-models" disabled={blocked} onClick={() => void checkModels()}>{t("voice.checkModels")}</button>
    </div>
    {checked && <p role="status">{t("voice.checkComplete")}</p>}
    <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]">
      {models.map((m) => <section key={m.id} className={`min-w-0 flex flex-col gap-3 rounded-lg border p-4 ${config?.asr.active === m.id ? "border-[var(--taomni-accent)]/50 bg-[var(--taomni-accent)]/5" : "border-[var(--taomni-divider)]"}`} data-testid={`asr-model-${m.id}`}>
        <div className="flex items-center justify-between gap-2"><strong className="text-sm capitalize">{m.id.replace("whisper-", "Whisper ")}</strong>{config?.asr.active === m.id && <span className="rounded-full px-2 py-0.5 text-[10px] bg-[var(--taomni-accent)]/10 text-[var(--taomni-accent)]">{t("voice.selected")}</span>}</div>
        <p className="text-[var(--taomni-text-muted)]">{Math.round(m.bytes / 1e6)} MB · {m.license} · {t("voice.multilingual")}</p>
        <p>{m.update_available ? t("voice.updateAvailable") : m.integrity === "corrupt" ? t("voice.corrupt") : m.integrity === "verified" ? t("voice.verified") : m.installed ? t("voice.installed") : t("voice.notInstalled")}</p>
        {!!m.resumable_bytes && <p className="text-[var(--taomni-text-muted)]">{t("voice.partialDownload")} {megabytes(m.resumable_bytes)} MB</p>}
        {m.available_version && <p className="text-[10px] text-[var(--taomni-text-muted)]">{t("voice.version")} {m.available_version}{m.installed_version && m.installed_version !== m.available_version ? ` ← ${m.installed_version}` : ""}</p>}
        <div className="mt-auto flex flex-wrap gap-2">
          <button type="button" className="taomni-btn px-2 py-1.5" disabled={blocked || !supported || proxyDirty || !config} data-testid={`asr-download-${m.id}`} onClick={() => void install(m, false)}>{downloading && installation?.model_id === m.id ? phaseLabel(installation.phase) : m.resumable_bytes ? t("voice.resumeDownload") : m.update_available ? t("voice.updateModel") : m.installed || m.integrity === "corrupt" ? t("voice.reinstall") : t("voice.download")}</button>
          <button type="button" className="taomni-btn px-2 py-1.5" disabled={blocked || !supported} onClick={() => void install(m, true)}>{t("voice.import")}</button>
          <button type="button" className="taomni-btn px-2 py-1.5" disabled={blocked || !m.installed || config?.asr.active === m.id} data-testid={`asr-select-${m.id}`} onClick={() => void select({ active: m.id })}>{t("voice.useModel")}</button>
        </div>
        {m.download_url && <div className="border-t border-[var(--taomni-divider)] pt-3 space-y-2">
          <a className="block break-all text-[10px] leading-relaxed text-[var(--taomni-text-muted)] hover:underline" href={m.download_url} title={t("voice.openDownloadLink")} data-testid={`asr-download-url-${m.id}`} onClick={(e) => { e.preventDefault(); void openExternalUrl(m.download_url!).catch((e) => setError(String(e))); }}>{m.download_url}</a>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="inline-flex items-center gap-1 hover:underline" data-testid={`asr-copy-url-${m.id}`} onClick={() => void copyLink(m)}><Copy className="h-3 w-3" />{copied === m.id ? t("voice.linkCopied") : t("voice.copyDownloadLink")}</button>
            <button type="button" className="inline-flex items-center gap-1 hover:underline" data-testid={`asr-open-url-${m.id}`} onClick={() => void openExternalUrl(m.download_url!).catch((e) => setError(String(e)))}><ExternalLink className="h-3 w-3" />{t("voice.openDownloadLink")}</button>
          </div>
        </div>}
      </section>)}
    </div>
    <footer className="space-y-2 text-[11px] leading-relaxed text-[var(--taomni-text-muted)]"><p>{t("voice.browserDownloadHelp")}</p><p>{t("voice.updateHelp")}</p></footer>
    {error && <p role="alert" className="text-red-400 break-words">{error}</p>}
  </div>;
}
