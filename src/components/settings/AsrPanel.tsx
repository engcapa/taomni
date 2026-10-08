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
  streaming?: boolean;
  replacement?: string;
  available_version?: string; installed_version?: string | null;
  update_available?: boolean; integrity?: "missing" | "unverified" | "verified" | "corrupt";
}
interface Installation {
  revision: number; job_id: string; model_id: string; bytes: number; total: number;
  phase: "connecting" | "downloading" | "importing" | "verifying" | "complete" | "failed" | "cancelled";
  error?: string | null;
}
interface SherpaStatus { model_id: string; revision: string; download_url?: string; available_version?: string; installed_version?: string | null; update_available?: boolean; integrity?: "missing" | "verified" | "corrupt"; files: { filename: string; bytes: number; downloaded: number; installed: boolean }[]; total_bytes: number; downloaded_bytes: number; installed: boolean }
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
  const [sherpaCancelling, setSherpaCancelling] = useState("");
  const [sherpaStatusReady, setSherpaStatusReady] = useState(false);
  const savedProxy = config?.asr.download_proxy;
  const [providerDraft, setProviderDraft] = useState<Record<string, AsrConfig["providers"][string]>>({});
  useEffect(() => { if (config?.asr.providers) setProviderDraft(config.asr.providers); }, [config?.asr.providers]);
  const [hotwords, setHotwords] = useState(config?.asr.hotwords?.join("\n") ?? "");
  useEffect(() => { setHotwords(config?.asr.hotwords?.join("\n") ?? ""); }, [config?.asr.hotwords]);
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
    let sherpaRevision = 0;
    let sherpaRequest = 0;
    const fail = (e: unknown) => { if (!disposed) setError(String(e)); };
    const accept = (job: Installation | null) => {
      if (disposed) return;
      setStatusReady(true);
      if (!job || job.revision <= revision) return;
      revision = job.revision;
      setInstallation(job);
      if (!isRunning(job)) void refresh().catch(fail);
    };
    const refreshSherpa = () => {
      const request = ++sherpaRequest;
      void invoke<SherpaStatus>("voice_sherpa_model_status").then((value) => {
        if (!disposed && request === sherpaRequest) setSherpa(value);
      }).catch(fail);
    };
    const acceptSherpa = (job: SherpaProgress | null) => {
      if (disposed) return;
      setSherpaStatusReady(true);
      if (!job || job.revision <= sherpaRevision) return;
      sherpaRevision = job.revision;
      setSherpaProgress(job);
      if (["complete", "failed", "cancelled"].includes(job.phase)) {
        setSherpaCancelling("");
        refreshSherpa();
      }
    };
    void refresh().catch(fail);
    refreshSherpa();
    const sherpaSnapshot = () => { void invoke<SherpaProgress | null>("voice_sherpa_model_installation").then(acceptSherpa).catch(fail); };
    void invoke<boolean>("voice_capture_supported").then((value) => { if (!disposed) setSupported(value); }).catch(fail);
    const snapshot = () => { void invoke<Installation | null>("voice_model_installation").then(accept).catch(fail); };
    // Subscribe before the initial snapshot; revisions discard stale responses.
    const unlisten = listen<Installation>("voice-model-progress", ({ payload }) => accept(payload));
    const sherpaUnlisten = listen<SherpaProgress>("voice-sherpa-model-progress", ({ payload }) => acceptSherpa(payload));
    void sherpaUnlisten.then(sherpaSnapshot).catch(fail);
    sherpaSnapshot();
    void unlisten.then(snapshot).catch(fail);
    snapshot();
    // Also recovers missed events and observes jobs started in another window.
    const poll = setInterval(() => { snapshot(); sherpaSnapshot(); }, 1000);
    return () => { disposed = true; clearInterval(poll); void unlisten.then((fn) => fn()).catch(() => undefined); void sherpaUnlisten.then((fn) => fn()).catch(() => undefined); };
  }, [refresh]);
  const downloading = isRunning(installation);
  const sherpaDownloading = !!sherpaProgress && !["complete", "failed", "cancelled"].includes(sherpaProgress.phase);
  const blocked = !!busy || downloading || sherpaDownloading || !statusReady || !sherpaStatusReady;
  const install = async (model: Model, offline: boolean, replaceModelId?: string) => {
    if (submitting.current || blocked) return;
    submitting.current = true;
    setBusy(model.id); setError("");
    try {
      const sourcePath = offline ? await open({ multiple: false, filters: [{ name: "Whisper", extensions: ["bin", "onnx"] }] }) : null;
      if (offline && !sourcePath) return;
      await invoke("voice_install_model", { modelId: model.id, sourcePath, replaceModelId });
      if (replaceModelId) await loadConfig();
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
    try {
      const [whisperModels, sherpaStatus] = await Promise.all([
        invoke<Model[]>("voice_check_models"),
        invoke<SherpaStatus>("voice_sherpa_model_status"),
      ]);
      setModels(whisperModels);
      setSherpa(sherpaStatus);
      setChecked(true);
    }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  const installSherpa = async () => {
    if (submitting.current || blocked || proxyDirty || !config) return;
    submitting.current = true;
    setBusy("sherpa"); setError("");
    try { await invoke("voice_install_sherpa_model"); setSherpa(await invoke<SherpaStatus>("voice_sherpa_model_status")); }
    catch (e) { if (String(e) !== "CANCELLED") setError(String(e)); }
    finally { submitting.current = false; setBusy(""); }
  };
  const cancelSherpa = async () => {
    if (!sherpaProgress || !sherpaDownloading || sherpaProgress.phase === "verifying" || sherpaCancelling === sherpaProgress.job_id) return;
    setSherpaCancelling(sherpaProgress.job_id); setError("");
    try { await invoke("voice_cancel_sherpa_model_installation", { jobId: sherpaProgress.job_id }); }
    catch (e) { setSherpaCancelling(""); setError(String(e)); }
  };
  const select = async (patch: Partial<AsrConfig>) => {
    if (!config) return;
    setError(""); setBusy("config");
    try { await saveConfig({ ...config, asr: { ...config.asr, ...patch, language_prior: patch.language && patch.language !== "auto" ? patch.language : config.asr.language_prior, warm_on_startup: false, vad: "none" } }); }
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
  const localModels: Model[] = [...models.filter((m) => !["whisper-medium", "whisper-medium-q8"].includes(m.id) || m.installed || config?.asr.active === m.id), ...(sherpa ? [{
    id: sherpa.model_id, filename: "", bytes: sherpa.total_bytes, installed: sherpa.installed,
    license: "", streaming: true, download_url: sherpa.download_url,
    resumable_bytes: !sherpa.installed ? sherpa.downloaded_bytes : 0,
    available_version: sherpa.available_version, installed_version: sherpa.installed_version,
    update_available: sherpa.update_available, integrity: sherpa.integrity,
  }] : [])];
  const modelTitle = (id: string) => id === "sensevoice-small" ? "SenseVoice Small int8" : id === "sherpa-zipformer-zh-en" ? "Zipformer" : id.replace("whisper-", "Whisper ");
  const jobs = [installation, sherpaProgress].filter((job): job is Installation => !!job);
  return <div className="space-y-4 text-xs" data-testid="asr-settings">
    <header className="pr-10 space-y-2">
      <div className="flex items-center gap-2 text-base font-semibold"><Mic className="h-5 w-5 text-[var(--taomni-accent)]" />{t("aiSettings.asrTitle")}</div>
      <p className="flex items-start gap-2 text-[var(--taomni-text-muted)]"><ShieldCheck className="h-4 w-4 shrink-0" />{t(config?.asr.mode === "online" ? "voice.privacyOnline" : "voice.privacy")}</p>
    </header>
    {!supported && <p role="alert">{t("voice.unsupported")}</p>}
    <section className="rounded-lg border border-[var(--taomni-divider)] p-3 space-y-3" data-testid="asr-realtime-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{t("voice.realtimeTitle")}</strong>
        <select className="taomni-input" data-testid="asr-realtime-provider" value={config?.asr.active ?? "local-auto"} disabled={blocked}
          onChange={(e) => { const id = e.target.value; void select({ active: id, mode: ["aliyun", "volcengine", "soniox", "deepgram", "gemini"].includes(id) ? "online" : "local" }); }}>
          <option value="local-auto">Auto local · SenseVoice + Whisper Small q8</option>
          <option value="sensevoice-small">SenseVoice Small int8 · 中 / 粵 / EN / 日本語 / 한국어</option>
          {["whisper-small-q8", "whisper-base-q8", "whisper-turbo-q5", ...models.filter((m) => ["whisper-base", "whisper-small", "whisper-medium", "whisper-medium-q8"].includes(m.id) && (m.installed || config?.asr.active === m.id)).map((m) => m.id)].map((id) => <option key={id} value={id}>{modelTitle(id)} · {t("voice.batchRecognition")}</option>)}
          <option value="sherpa-zipformer-zh-en">Zipformer · {t("voice.streamingRecognition")}</option>
          <option value="aliyun">Aliyun Paraformer Realtime</option>
          <option value="volcengine">Volcengine Seed-ASR 2.0</option>
          <option value="soniox">Soniox Realtime</option>
          <option value="deepgram">Deepgram Nova-3</option>
          {(config?.asr.experimental || config?.asr.active === "gemini") && <option value="gemini">Google Gemini Live · Experimental</option>}
        </select>
      </div>
      <p className="text-[var(--taomni-text-muted)] leading-relaxed">Auto local uses SenseVoice for Chinese, Cantonese, English, Japanese and Korean; Whisper for Spanish, French and Italian. Optional Zipformer adds Chinese/English partials. Audio stays on this device.</p>
      <p>Recommended: SenseVoice + Small q8, 504 MB. Single model: Small q8, 264 MB. Small/Base use the zh token for Cantonese; use SenseVoice or Turbo for distinct yue recognition.</p>
      <button type="button" className="taomni-btn px-2 py-1" data-testid="asr-download-recommended" disabled={blocked || proxyDirty} onClick={() => void (async () => {
        if (submitting.current) return;
        submitting.current = true;
        try {
          setBusy("recommended");
          for (const id of ["sensevoice-small", "whisper-small-q8"]) {
            if (!models.find((m) => m.id === id)?.installed) await invoke("voice_install_model", { modelId: id });
          }
          await refresh();
        } catch (e) { if (String(e) !== "CANCELLED") setError(String(e)); }
        finally { submitting.current = false; setBusy(""); }
      })()}>Download recommended models</button>
      <label className="flex gap-2 items-center"><input type="checkbox" data-testid="asr-experimental" checked={!!config?.asr.experimental} onChange={(e) => void select({ experimental: e.target.checked })} />Show experimental providers</label>
      <label className="block space-y-1">Hotwords · one term per line (up to 2000)<textarea data-testid="asr-hotwords" className="taomni-input w-full" rows={3} value={hotwords} onChange={(e) => setHotwords(e.target.value)} /></label>
      <p className="text-[var(--taomni-text-muted)]">Terms are sent only to the selected online provider. Aliyun requires its workspace vocabulary endpoint; Volcengine requires an App ID to create a table. Local hotword biasing is not enabled.</p>
      <button type="button" data-testid="asr-hotwords-save" className="taomni-btn px-2 py-1" disabled={blocked} onClick={() => {
        const words = [...new Set(hotwords.split("\n").map((s) => s.trim()).filter(Boolean))];
        if (words.length > 2000 || words.some((w) => w.length > 100)) { setError("Use at most 2000 terms of at most 100 characters each."); return; }
        void select({ hotwords: words });
      }}>Save hotwords</button>
      {config?.asr.mode === "online" && config.asr.providers[config.asr.active] && (() => {
        const id = config.asr.active;
        const provider = providerDraft[id] ?? config.asr.providers[id];
        const updateProvider = (patch: Partial<typeof provider>) => setProviderDraft((current) => ({ ...current, [id]: { ...provider, ...patch } }));
        return <div className="grid gap-2 md:grid-cols-2">
          <label className="space-y-1">Model<input className="taomni-input w-full" value={provider.model} onChange={(e) => updateProvider({ model: e.target.value })} /></label>
          <label className="space-y-1">API key<input className="taomni-input w-full" type="password" placeholder={provider.api_key?.startsWith("vault:") ? "Stored in credential vault" : "Required"} value={provider.api_key?.startsWith("vault:") ? "" : provider.api_key ?? ""} onChange={(e) => updateProvider({ api_key: e.target.value })} /></label>
          <label className="space-y-1">Proxy<select className="taomni-input w-full" value={provider.proxy_mode ?? "app"} onChange={(e) => updateProvider({ proxy_mode: e.target.value })}><option value="app">Application proxy</option><option value="custom">Feature proxy</option><option value="none">No proxy</option></select></label>
          <label className="space-y-1">Endpoint<input data-testid="asr-provider-endpoint" className="taomni-input w-full" value={provider.endpoint ?? ""} onChange={(e) => updateProvider({ endpoint: e.target.value })} /></label>
          {id === "volcengine" && <>
            <label>App ID (hotword tables)<input className="taomni-input w-full" value={provider.app_id ?? ""} onChange={(e) => updateProvider({ app_id: e.target.value })} /></label>
            <label>Resource ID<input className="taomni-input w-full" value={provider.resource_id ?? ""} onChange={(e) => updateProvider({ resource_id: e.target.value })} /></label>
          </>}
          {id === "aliyun" && <label className="md:col-span-2">Vocabulary HTTPS endpoint<input className="taomni-input w-full" value={provider.vocabulary_endpoint ?? ""} placeholder="https://WORKSPACE.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/customization" onChange={(e) => updateProvider({ vocabulary_endpoint: e.target.value })} /></label>}
          {provider.proxy_mode === "custom" && <div className="md:col-span-2">
            <AppProxyPanel value={provider.custom_proxy ?? { enabled: true, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" }}
              onSave={async (custom_proxy) => updateProvider({ custom_proxy, proxy_url: "" })} testHost="example.com" />
            {!provider.custom_proxy && <label className="space-y-1">Legacy proxy URL<input className="taomni-input w-full" value={provider.proxy_url ?? ""} onChange={(e) => updateProvider({ proxy_url: e.target.value })} /></label>}
          </div>}
          <button type="button" className="taomni-btn px-2 py-1 justify-self-start" disabled={blocked} onClick={() => void select({ providers: providerDraft })}>Save provider</button>
          <p className="md:col-span-2 text-[var(--taomni-text-muted)]">Keys are encrypted in the credential vault when saved. A configured proxy failure is surfaced; the provider never silently falls back to a direct connection.</p>
        </div>;
      })()}
    </section>
    {jobs.map((job) => {
      const streaming = job.model_id === "sherpa-zipformer-zh-en";
      const running = isRunning(job);
      const isCancelling = (streaming ? sherpaCancelling : cancelling) === job.job_id;
      const percentage = job.total > 0 ? Math.min(100, Math.floor(job.bytes * 100 / job.total)) : undefined;
      return <section key={job.job_id} data-testid={streaming ? "asr-sherpa-installation-progress" : "asr-installation-progress"} role="status" className={`rounded-lg border p-3 space-y-2 ${job.phase === "failed" ? "border-red-400/40" : "border-[var(--taomni-accent)]/30 bg-[var(--taomni-accent)]/5"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{modelTitle(job.model_id)} · {phaseLabel(job.phase)}</strong>
          {running && <button type="button" className="taomni-btn px-2 py-1" data-testid={streaming ? "asr-cancel-sherpa-download" : "asr-cancel-download"} disabled={isCancelling || job.phase === "verifying"} onClick={() => void (streaming ? cancelSherpa() : cancelInstallation())}>{isCancelling ? t("voice.cancellingDownload") : t("voice.cancelDownload")}</button>}
        </div>
        <div className="flex justify-between text-[var(--taomni-text-muted)] tabular-nums"><span>{megabytes(job.bytes)}{job.total > 0 ? ` / ${megabytes(job.total)}` : ""} MB</span>{percentage !== undefined && <span>{percentage}%</span>}</div>
        <progress aria-label={t("voice.downloadProgress")} className="block h-2 w-full accent-[var(--taomni-accent)]" max={100} value={percentage} />
        {running && <p className="text-[var(--taomni-text-muted)]">{t("voice.backgroundDownload")}</p>}
        {job.error && <p className="text-red-400 break-words">{job.error}</p>}
      </section>;
    })}
    <label className="flex gap-3 items-center">Text cleanup
      <select data-testid="asr-cleanup" className="taomni-input" disabled={blocked} value={config?.asr.cleanup ?? "off"} onChange={(e) => void select({ cleanup: e.target.value as AsrConfig["cleanup"] })}>
        <option value="off">Off · keep original</option><option value="light">Light · fillers and punctuation</option><option value="full">Full · repair disfluencies</option>
      </select>
      <span className="text-[var(--taomni-text-muted)]">Uses the configured text model. Original is retained; code, paths and numbers are protected.</span>
    </label>
    <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))]">
      <section className="space-y-3 rounded-lg bg-[var(--taomni-bg)] p-3">
        <label className="flex items-center justify-between gap-3 font-medium">{t("voice.language")}
          <select className="taomni-input" data-testid="asr-language" value={config?.asr.language ?? "auto"} disabled={blocked} onChange={(e) => void select({ language: e.target.value })}>
            {["auto", "zh", "yue", "en", "ja", "ko", "fr", "de", "es", "it"].map((language) => <option key={language} value={language}>{language === "auto" ? t("voice.autoLanguage") : ({ yue: "粵語", it: "Italiano", zh: "中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" } as Record<string, string>)[language]}</option>)}
          </select>
        </label>
        <p className="leading-relaxed text-[var(--taomni-text-muted)]">Auto local language prior: {config?.asr.language_prior ?? "zh"}. Choosing a language updates this prior; automatic detection stays within the selected engine’s languages.</p>
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
    <p className="text-[var(--taomni-text-muted)] leading-relaxed">{t("voice.zipformerDownloadHelp")}</p>
    {checked && <p role="status">{t("voice.checkComplete")}</p>}
    <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]">
      {localModels.map((m) => {
        const job = m.streaming ? sherpaProgress : installation;
        return <section key={m.id} className={`min-w-0 flex flex-col gap-3 rounded-lg border p-4 ${config?.asr.active === m.id ? "border-[var(--taomni-accent)]/50 bg-[var(--taomni-accent)]/5" : "border-[var(--taomni-divider)]"}`} data-testid={`asr-model-${m.id}`}>
        <div className="flex items-center justify-between gap-2"><strong className="text-sm capitalize">{modelTitle(m.id)}</strong>{config?.asr.active === m.id && <span className="rounded-full px-2 py-0.5 text-[10px] bg-[var(--taomni-accent)]/10 text-[var(--taomni-accent)]">{t("voice.selected")}</span>}</div>
        <p className="text-[var(--taomni-text-muted)]">{Math.round(m.bytes / 1e6)} MB{m.license ? ` · ${m.license}` : ""} · {t(m.streaming ? "voice.streamingRecognition" : "voice.batchRecognition")}</p>
        <p>{m.update_available ? t("voice.updateAvailable") : m.integrity === "corrupt" ? t("voice.corrupt") : m.integrity === "verified" ? t("voice.verified") : m.installed ? t("voice.installed") : t("voice.notInstalled")}</p>
        {!!m.resumable_bytes && <p className="text-[var(--taomni-text-muted)]">{t("voice.partialDownload")} {megabytes(m.resumable_bytes)} MB</p>}
        {m.available_version && <p className="text-[10px] text-[var(--taomni-text-muted)]">{t("voice.version")} {m.available_version}{m.installed_version && m.installed_version !== m.available_version ? ` ← ${m.installed_version}` : ""}</p>}
        {m.id === "sensevoice-small" && <p>Supports zh/yue/en/ja/ko only. Downloading accepts FunASR Model License v1.1; weights are not bundled with the application.</p>}
        {m.replacement && m.installed && <button type="button" className="taomni-btn p-2" data-testid={`asr-replace-${m.id}`} disabled={blocked || proxyDirty} onClick={() => {
          const replacement = models.find((candidate) => candidate.id === m.replacement);
          if (replacement) void install(replacement, false, m.id);
        }}>Replace f16 with q8 · remove old weights after verification</button>}
        <div className="mt-auto grid grid-cols-2 gap-2">
          <button type="button" className="taomni-btn px-2 py-1.5" disabled={blocked || !supported || proxyDirty || !config} data-testid={`asr-download-${m.id}`} onClick={() => void (m.streaming ? installSherpa() : install(m, false))}>{isRunning(job) && job?.model_id === m.id ? phaseLabel(job.phase) : m.resumable_bytes ? t("voice.resumeDownload") : m.update_available ? t("voice.updateModel") : m.installed || m.integrity === "corrupt" ? t("voice.reinstall") : t("voice.download")}</button>
          {!m.streaming && <button type="button" className="taomni-btn px-2 py-1.5" disabled={blocked || !supported} onClick={() => void install(m, true)}>{t("voice.import")}</button>}
          <button type="button" className="taomni-btn px-2 py-1.5 col-span-2 row-start-2 justify-self-start" disabled={blocked || !m.installed || config?.asr.active === m.id} data-testid={`asr-select-${m.id}`} onClick={() => void select({ active: m.id, mode: "local" })}>{t("voice.useModel")}</button>
        </div>
        {m.download_url && <div className="border-t border-[var(--taomni-divider)] pt-3 space-y-2">
          <a className="block break-all text-[10px] leading-relaxed text-[var(--taomni-text-muted)] hover:underline" href={m.download_url} title={t("voice.openDownloadLink")} data-testid={`asr-download-url-${m.id}`} onClick={(e) => { e.preventDefault(); void openExternalUrl(m.download_url!).catch((e) => setError(String(e))); }}>{m.download_url}</a>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="inline-flex items-center gap-1 hover:underline" data-testid={`asr-copy-url-${m.id}`} onClick={() => void copyLink(m)}><Copy className="h-3 w-3" />{copied === m.id ? t("voice.linkCopied") : t("voice.copyDownloadLink")}</button>
            <button type="button" className="inline-flex items-center gap-1 hover:underline" data-testid={`asr-open-url-${m.id}`} onClick={() => void openExternalUrl(m.download_url!).catch((e) => setError(String(e)))}><ExternalLink className="h-3 w-3" />{t("voice.openDownloadLink")}</button>
          </div>
        </div>}
      </section>; })}
    </div>
    <footer className="space-y-2 text-[11px] leading-relaxed text-[var(--taomni-text-muted)]"><p>{t("voice.browserDownloadHelp")}</p><p>{t("voice.updateHelp")}</p></footer>
    {error && <p role="alert" className="text-red-400 break-words">{error}</p>}
  </div>;
}
