import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { useT, getLocale, type TranslateFn } from "../../lib/i18n";
import { AppProxyPanel } from "./AppProxyPanel";
import { newFeishuTarget, remoteBackup, type AuthorizationSession, type FeishuApplication, type BackupJob, type BackupTarget, type RemoteBackup, type RemoteConfiguration } from "../../lib/remoteBackup";

const input = "w-full rounded border border-theme-border bg-theme-bg p-2 text-xs text-theme-text";
const button = "rounded border border-theme-border px-3 py-1.5 text-xs text-theme-text hover:border-accent disabled:opacity-50";
const finished = new Set(["completed", "failed", "cancelled", "interrupted", "discarded", "retry_wait"]);
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const authFinished = new Set(["connected", "failed", "cancelled", "expired", "interrupted"]);
type BatchResult = Awaited<ReturnType<typeof remoteBackup.runSelected>>;
type Notice = { key: string } | { results: BatchResult } | null;

function BackupError({ error, t }: { error: string; t: TranslateFn }) {
  let key = "failed";
  if (error.includes("BACKUP_BROWSER_OPEN_FAILED")) key = "browser";
  else if (error.startsWith("BACKUP_AUTHORIZATION")) key = "authorization";
  else if (error.startsWith("BACKUP_PERMISSION")) key = "permissions";
  else if (error.startsWith("BACKUP_STORAGE")) key = "storage";
  else if (error.startsWith("BACKUP_OTHER_INSTANCE")) key = "otherInstance";
  else if (error.startsWith("BACKUP_TRANSIENT")) key = "network";
  else if (error.startsWith("BACKUP_REGISTRATION_RECOVERY")) key = "registration";
  else if (error.includes("BACKUP_CONFIG_NOT_LOADED")) key = "config";
  else if (/credential store|credentials in the system/i.test(error)) key = "credentialStore";
  else if (/CLI.*(configuration|application|file|credential)|existing CLI/i.test(error)) key = "cli";
  else if (/application credentials are invalid/i.test(error)) key = "appCredentials";
  else if (/authorization.*(expired|interrupted|uncertain)|token refresh.*(interrupted|uncertain)/i.test(error)) key = "authorization";
  else if (/permissions|scope|offline_access/i.test(error)) key = "permissions";
  else if (/declined/i.test(error)) key = "declined";
  else if (/connect Feishu/i.test(error)) key = "connect";
  else if (/password/i.test(error)) key = "password";
  else if (/proxy|network|Cannot connect to backup service/i.test(error)) key = "network";
  else if (/NATIVE_VERSION_UNSUPPORTED|native versioning is unavailable/i.test(error)) key = "version";
  else if (/registration may have completed|registration completed/i.test(error)) key = "registration";
  else if (/active.*tasks|Another Feishu connection|being authorized/i.test(error)) key = "busy";
  return <div role="alert" className="break-all text-xs text-red-500">
    <p>{t(`remoteBackup.errors.${key}`)}</p>
    {(!error.startsWith("BACKUP_") || error.includes(":")) && <details><summary>{t("remoteBackup.errorDetails")}</summary><p>{error}</p></details>}
  </div>;
}
function mergeSessions(old: AuthorizationSession[], values: AuthorizationSession[]) {
  const next = new Map(old.map((s) => [s.id, s]));
  for (const s of values) if (!next.has(s.id) || next.get(s.id)!.revision <= s.revision) next.set(s.id, s);
  return [...next.values()];
}

export function RemoteBackupPanel({ onRestore }: { onRestore: (path: string) => void }) {
  const t = useT();
  const [data, setData] = useState<RemoteConfiguration | null>(null);
  const [batchIncludeMail, setBatchIncludeMail] = useState(false);
  const [target, setTarget] = useState<BackupTarget | null>(null);
  const [applications, setApplications] = useState<FeishuApplication[]>([]);
  const [applicationSelection, setApplicationSelection] = useState("");
  const [sessions, setSessions] = useState<AuthorizationSession[]>([]);
  const [password, setPassword] = useState("");
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [files, setFiles] = useState<RemoteBackup[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [batchScope, setBatchScope] = useState("core");
  const [restartConfirmed, setRestartConfirmed] = useState(false);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const generation = useRef(0);
  const activeId = useRef("");
  const requestedAuth = useRef("");
  const openedAuthUrls = useRef(new Set<string>());

  const refreshConfig = async () => {
    const value = await remoteBackup.config();
    if (!value?.config) return; // Browser fixtures may not implement native configuration.
    setData(value);
    setTarget((old) => value.config.targets.find((item) => item.id === old?.id) ?? value.config.targets[0] ?? null);
  };
  const refreshJobs = async () => {
    const values = await remoteBackup.jobs();
    if (Array.isArray(values)) setJobs((old) => values.map((v) => old.find((o) => o.id === v.id && o.revision > v.revision) ?? v));
  };
  const refreshAuthorizations = async () => {
    const values = await remoteBackup.authorizations();
    if (Array.isArray(values)) setSessions((old) => mergeSessions(old, values));
  };
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    void Promise.all([
      listen<BackupJob>("backup-job-progress", ({ payload }) => {
        if (!disposed) setJobs((old) => [payload, ...old.filter((j) => j.id !== payload.id)].map((j) => old.find((o) => o.id === j.id && o.revision > j.revision) ?? j));
      }),
      listen<AuthorizationSession>("backup-authorization", ({ payload }) => {
        if (disposed) return;
        setSessions((old) => mergeSessions(old, [payload]));
        if (authFinished.has(payload.phase)) void refreshConfig().catch((e) => setError(String(e)));
      }),
      listen("backup-connection-changed", () => { if (!disposed) void refreshConfig().catch((e) => setError(String(e))); }),
    ]).then((unlisten) => {
      if (disposed) unlisten.forEach((stop) => stop());
      else {
        stops.push(...unlisten);
        void Promise.all([refreshConfig(), refreshJobs(), refreshAuthorizations()]).catch((e) => setError(String(e)));
        void remoteBackup.applications().then((values) => { if (!disposed && Array.isArray(values)) setApplications(values); }).catch((e) => { if (!disposed) setError(String(e)); });
      }
    }).catch((e) => { if (!disposed) setError(String(e)); });
    const timer = window.setInterval(() => void Promise.all([refreshJobs(), refreshAuthorizations()]).catch((e) => { if (!disposed) setError(String(e)); }), 5000);
    return () => { disposed = true; stops.forEach((stop) => stop()); window.clearInterval(timer); generation.current++; };
  }, []);
  useEffect(() => {
    const session = sessions.find((s) => s.id === requestedAuth.current);
    if (!session?.verificationUrl || openedAuthUrls.current.has(session.verificationUrl)) return;
    openedAuthUrls.current.add(session.verificationUrl);
    void open(session.verificationUrl).catch(() => setError("BACKUP_BROWSER_OPEN_FAILED"));
  }, [sessions]);

  const action = async (fn: () => Promise<unknown>) => {
    setError(""); setMessage(null); setBusy(true);
    try { await fn(); await refreshJobs(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const save = async (next: BackupTarget = target!) => {
    if (!data || !next) throw new Error("BACKUP_CONFIG_NOT_LOADED");
    const config = { ...data.config, targets: [...data.config.targets.filter((t) => t.id !== next.id), next] };
    await remoteBackup.save(config, next.id, password);
    setPassword(""); await refreshConfig(); setEditing(false); setMessage({ key: "saved" });
  };
  const browse = async () => {
    if (!target) return;
    const id = target.id; activeId.current = id;
    const version = ++generation.current;
    const result = await remoteBackup.list(id);
    if (version === generation.current && id === activeId.current) setFiles(result);
  };
  const patch = (value: Partial<BackupTarget>) => setTarget((t) => t ? { ...t, ...value } : null);
  const selectDestination = async (id: string, selected: boolean) => {
    if (!data) return;
    const config = { ...data.config, selectedTargetIds: selected ? [...data.config.selectedTargetIds, id] : data.config.selectedTargetIds.filter((item) => item !== id) };
    await remoteBackup.save(config); await refreshConfig();
  };
  const status = data?.statuses.find((s) => s.targetId === target?.id);
  const connection = data?.config.connections.find((c) => c.id === target?.connectionId);
  const session = sessions.filter((s) => s.targetId === target?.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const authorizing = session != null && !authFinished.has(session.phase);
  const visible = files.filter((f) => !filter || f.deviceId === filter);

  return <section data-testid="backup-cloud-panel" className="space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4">
    <div className="flex items-center justify-between"><h4 className="text-sm font-medium text-theme-text">{t("remoteBackup.title")}</h4><button data-testid="backup-feishu-add" className={button} disabled={busy || !data} onClick={() => { setTarget(newFeishuTarget()); setEditing(true); setFiles([]); setApplicationSelection(""); setPassword(""); }}>{t("remoteBackup.addFeishu")}</button></div>
    <p className="text-xs text-theme-muted">{t("remoteBackup.sourceHint")}</p>
    {data && <fieldset className="space-y-2 rounded border border-theme-border p-3 text-xs text-theme-text"><legend>{t("remoteBackup.destinations")}</legend>
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.config.selectedTargetIds.includes("local")} disabled={busy} onChange={(e) => void action(() => selectDestination("local", e.target.checked))} />{t("remoteBackup.localDestination")}</label>
      {data.config.targets.map((destination) => <label key={destination.id} className="flex items-center gap-2"><input data-testid="backup-destination-select" type="checkbox" checked={data.config.selectedTargetIds.includes(destination.id)} disabled={busy || !destination.enabled} onChange={(e) => void action(() => selectDestination(destination.id, e.target.checked))} />{destination.name} · {destination.proxy.mode === "app" ? t("remoteBackup.proxyApp") : destination.proxy.mode === "none" ? t("remoteBackup.proxyNone") : t("remoteBackup.proxyCustom")}{!destination.enabled && t("remoteBackup.notEnabledSuffix")}</label>)}
      <div className="flex flex-wrap gap-2"><select aria-label={t("remoteBackup.localScopeLabel")} className={button} value={batchScope} onChange={(e) => { setBatchScope(e.target.value); setBatchIncludeMail(e.target.value === "full"); }}><option value="core">{t("remoteBackup.localCore")}</option><option value="full">{t("remoteBackup.localFull")}</option></select><button data-testid="backup-selected-start" className={button} disabled={busy || editing || data.config.selectedTargetIds.length === 0} onClick={() => void action(async () => { const results = await remoteBackup.runSelected(batchScope, batchIncludeMail); setMessage({ results }); })}>{t("remoteBackup.startSelected")}</button></div>
      <label className="flex items-center gap-2 text-xs text-theme-text"><input id="backup-selected-include-mail" data-testid="backup-selected-include-mail" type="checkbox" checked={batchIncludeMail} onChange={(e) => setBatchIncludeMail(e.target.checked)} />{t("backupSettings.localIncludeMail")}</label>
      <p className="text-theme-muted">{t("remoteBackup.destinationsHint")}</p>
    </fieldset>}
    {data && <div className="space-y-1 text-xs text-theme-muted"><label>{t("remoteBackup.deviceName")}<input data-testid="backup-device-name" aria-label={t("remoteBackup.deviceName")} className={input} value={data.config.device.name} onChange={(e) => setData({ ...data, config: { ...data.config, device: { ...data.config.device, name: e.target.value } } })} onBlur={() => void action(async () => { await remoteBackup.save(data.config); })} /></label><p>{t("remoteBackup.deviceIdentity", { id: data.config.device.id })}</p><p>{t("remoteBackup.deviceNameHint")}</p></div>}
    {data && data.config.targets.length > 0 && <select data-testid="backup-cloud-target" aria-label={t("remoteBackup.targetLabel")} className={input} value={target?.id ?? ""} onChange={(e) => { generation.current++; activeId.current = e.target.value; setTarget(data.config.targets.find((t) => t.id === e.target.value) ?? null); setFiles([]); setEditing(false); setPassword(""); setApplicationSelection(""); }}>
      {data.config.targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      {target && !data.config.targets.some((t) => t.id === target.id) && <option value={target.id}>{t("remoteBackup.newTarget")}</option>}
    </select>}
    {target && <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-theme-muted"><span>{t(status?.connected ? "remoteBackup.authorized" : "remoteBackup.notAuthorized")} · {t(target.writesPaused ? "remoteBackup.writesPaused" : target.enabled ? "common.enabled" : "common.disabled")}</span><button data-testid="backup-cloud-edit" className={button} onClick={() => setEditing((v) => !v)}>{t("remoteBackup.connectionSettings")}</button></div>
      {connection && <p className="text-xs text-theme-muted">{t("remoteBackup.account", { name: connection.accountName || t("remoteBackup.awaitingAccount"), application: connection.label, origin: t(connection.origin === "cli_existing" ? "remoteBackup.originExisting" : "remoteBackup.originRegistered") })}</p>}
      {editing && <div className="space-y-3 border-t border-theme-border pt-3">
        <label className="block text-xs text-theme-muted">{t("remoteBackup.targetName")}<input data-testid="backup-cloud-name" className={input} value={target.name} onChange={(e) => patch({ name: e.target.value })} /></label>
        <label className="block text-xs text-theme-muted">{t("remoteBackup.folder")}<input data-testid="backup-feishu-folder" className={input} value={target.rootToken} placeholder={t("remoteBackup.folderPlaceholder")} onChange={(e) => { const raw = e.target.value.trim(); patch({ rootToken: raw.includes("/folder/") ? raw.split("/folder/")[1].split(/[?#/]/)[0] : raw }); }} /></label>
        <label className="block text-xs text-theme-muted">{t("remoteBackup.password")}<input data-testid="backup-cloud-password" type="password" autoComplete="new-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <p className="text-xs text-theme-muted">{t("remoteBackup.passwordHint")}</p>
        <label className="block text-xs text-theme-muted">{t("remoteBackup.scope")}<select className={input} value={target.source.scope} onChange={(e) => patch({ source: { ...target.source, scope: e.target.value } })}><option value="core">{t("remoteBackup.core")}</option><option value="full">{t("remoteBackup.full")}</option></select></label>
        <label className="flex items-center gap-2 text-xs text-theme-text"><input id="backup-cloud-include-mail" data-testid="backup-cloud-include-mail" type="checkbox" checked={target.source.customOptions?.includeMail ?? target.source.scope === "full"} onChange={(e) => patch({ source: { ...target.source, customOptions: { ...target.source.customOptions, includeMail: e.target.checked } } })} />{t("backupSettings.includeMail")}</label>
        <label className="block text-xs text-theme-muted">{t("remoteBackup.proxyLabel")}<select data-testid="backup-cloud-proxy" aria-label={t("remoteBackup.proxyAria")} className={input} value={target.proxy.mode} onChange={(e) => patch({ proxy: { ...target.proxy, mode: e.target.value as BackupTarget["proxy"]["mode"] } })}><option value="app">{t("remoteBackup.useAppProxy")}</option><option value="custom">{t("remoteBackup.proxyCustom")}</option><option value="none">{t("remoteBackup.noProxy")}</option></select></label>
        {target.proxy.mode === "custom" && <AppProxyPanel value={target.proxy.custom} testHost="open.feishu.cn" onSave={async (custom) => { patch({ proxy: { ...target.proxy, custom } }); }} />}
        <label className="flex gap-2 text-xs text-theme-text"><input type="checkbox" checked={target.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />{t("remoteBackup.enableTarget")}</label>
        <button data-testid="backup-cloud-save" className={button} disabled={busy} onClick={() => void action(() => save())}>{t("common.save")}</button>
      </div>}
      <p className="text-xs text-theme-muted">{t("remoteBackup.connectHint")}</p>
      {(connection?.registrationPending || session && ["failed", "expired", "interrupted"].includes(session.phase)) && <div data-testid="backup-connection-recovery" className="space-y-2 rounded border border-theme-border p-3 text-xs text-theme-muted">
        <p>{t("remoteBackup.recoveryHint")}</p>
        <label className="flex items-center gap-2"><input data-testid="backup-restart-confirm" type="checkbox" checked={restartConfirmed} onChange={(e) => setRestartConfirmed(e.target.checked)} />{t("remoteBackup.restartWarning")}</label>
        <button data-testid="backup-restart-application" className={button} disabled={busy || authorizing || !restartConfirmed} onClick={() => void action(async () => { const value = await remoteBackup.authorize(target.id, undefined, true); requestedAuth.current = value.id; setSessions((old) => mergeSessions(old, [value])); setRestartConfirmed(false); })}>{t("remoteBackup.restartApplication")}</button>
      </div>}
      {(applications.length > 1 || (data?.config.connections.length ?? 0) > 1 || applications.length > 0 && (data?.config.connections.length ?? 0) > 0) && <label className="block text-xs text-theme-muted">{t("remoteBackup.applicationLabel")}<select aria-label={t("remoteBackup.applicationAria")} className={input} value={applicationSelection} disabled={authorizing} onChange={(e) => setApplicationSelection(e.target.value)}><option value="">{t("remoteBackup.automaticApp")}</option>{data?.config.connections.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.accountName || t("remoteBackup.savedConnection")}</option>)}{applications.map((a) => <option key={a.appId} value={a.appId}>{a.label} · {t("remoteBackup.localCli")}{a.isDefault ? t("remoteBackup.defaultSuffix") : ""}</option>)}</select></label>}
      {session && <div data-testid="backup-feishu-session" className="space-y-2 rounded border border-theme-border p-3 text-xs text-theme-muted">
        <p role="status">{t(`remoteBackup.auth.${session.phase}`)}{session.userCode && ` · ${t("remoteBackup.verificationCode", { code: session.userCode })}`}</p>
        {session.error && <BackupError error={session.error} t={t} />}
        {session.verificationUrl && <button className={button} onClick={() => void action(() => open(session.verificationUrl!))}>{t("remoteBackup.openAuthorization")}</button>}
        {authorizing && <button className={button} onClick={() => void action(() => remoteBackup.cancelAuthorization(session.id))}>{t("remoteBackup.cancelConnection")}</button>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <button data-testid="backup-feishu-authorize" className={button} disabled={busy || editing || authorizing} onClick={() => void action(async () => { const value = await remoteBackup.authorize(target.id, applicationSelection); requestedAuth.current = value.id; setSessions((old) => mergeSessions(old, [value])); if (value.phase === "connected") await refreshConfig(); setMessage({ key: "confirmAuthorization" }); })}>{t("remoteBackup.authorize")}</button>
        <button data-testid="backup-cloud-start" className={button} disabled={busy || editing || !target.enabled || target.writesPaused || !status?.connected} onClick={() => void action(async () => { await remoteBackup.start(target.id); setMessage({ key: "started" }); })}>{t("remoteBackup.startFeishu")}</button>
        <button data-testid="backup-cloud-refresh" className={button} disabled={busy || editing || !status?.connected} onClick={() => void action(browse)}>{t("remoteBackup.refresh")}</button>
        {target.writesPaused && <button className={button} disabled={busy} onClick={() => void action(() => save({ ...target, writesPaused: false }))}>{t("remoteBackup.resumeWrites")}</button>}
      </div>
      <select data-testid="backup-source-device" aria-label={t("remoteBackup.sourceDevice")} className={input} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">{t("remoteBackup.allDevices")}</option>{Array.from(new Set(files.map((f) => f.deviceId))).map((id) => <option key={id} value={id}>{id === data?.config.device.id ? t("remoteBackup.thisDevice", { name: data.config.device.name }) : `${files.find((file) => file.deviceId === id)?.deviceName ?? id} · ${id.slice(0, 8)}`}</option>)}</select>
      {visible.length === 0 && <p className="text-xs text-theme-muted">{t("remoteBackup.empty")}</p>}
      {visible.map((file) => <div key={file.fileToken} data-testid="backup-cloud-row" className="space-y-2 rounded border border-theme-border p-3 text-xs">
        <p className="break-all text-theme-text">{file.deviceId === data?.config.device.id ? t("remoteBackup.thisDevice", { name: data.config.device.name }) : `${file.deviceName} · ${file.deviceId.slice(0, 8)}`} · {file.sourceKind}</p>
        <p className="text-theme-muted">{file.name}</p>
        <p className="text-theme-muted">{t("remoteBackup.cloudUpdated", { time: file.modifiedAt ? new Date(Number(file.modifiedAt) * 1000).toLocaleString(getLocale()) : t("remoteBackup.unknownTime") })}</p>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void action(async () => { await remoteBackup.download(file); setMessage({ key: "downloadingNotice" }); })}>{t(target.writesPaused ? "remoteBackup.downloadAfterHistory" : "remoteBackup.downloadCurrent")}</button><button className={button} disabled={busy} onClick={() => void action(async () => { const url = await remoteBackup.history(file); await open(url); await refreshConfig(); setMessage({ key: "historyNotice" }); })}>{t("remoteBackup.history")}</button></div>
      </div>)}
    </>}
    {message && ("key" in message ? <p role="status" className="text-xs text-green-600">{t(`remoteBackup.${message.key}`)}</p> : <div role="status" className="space-y-1 text-xs text-green-600">{message.results.map((result) => <div key={result.targetId}><p>{result.targetId === "local" ? t("remoteBackup.local") : data?.config.targets.find((item) => item.id === result.targetId)?.name ?? result.targetId}: {result.error ? t("remoteBackup.phases.failed") : t(result.jobId ? "remoteBackup.taskCreated" : "remoteBackup.completed")}</p>{result.error && <BackupError error={result.error} t={t} />}</div>)}</div>)}
    {error && <BackupError error={error} t={t} />}
    {data?.cache && <div data-testid="backup-cache" className="space-y-2 text-xs text-theme-muted"><p>{t("remoteBackup.cacheUsage", { used: bytes(data.cache.usedBytes), limit: bytes(data.cache.limitBytes), days: data.cache.retentionDays })}</p><button data-testid="backup-cache-clean" className={button} disabled={busy} onClick={() => void action(async () => { await remoteBackup.cleanCache(); await refreshConfig(); setMessage({ key: "cacheCleaned" }); })}>{t("remoteBackup.cleanCache")}</button></div>}
    {jobs.length > 0 && <div className="space-y-2 border-t border-theme-border pt-3"><h5 className="text-xs font-medium text-theme-text">{t("remoteBackup.jobs")}</h5>{jobs.slice(0, 20).map((job) => <div key={job.id} data-testid="backup-cloud-job" data-job-id={job.id} data-phase={job.phase} data-operation={job.operation} className="space-y-2 rounded border border-theme-border p-2 text-xs text-theme-muted">
      <p>{t(job.operation === "upload" ? "remoteBackup.upload" : "remoteBackup.download")} · {t(`remoteBackup.phases.${job.phase}`)} · {new Date(job.createdAt).toLocaleString(getLocale())}</p>
      <p>{bytes(job.bytes)}{job.total != null && ` / ${bytes(job.total)} (${job.total ? Math.min(100, Math.round(job.bytes / job.total * 100)) : 0}%)`}</p>
      {!finished.has(job.phase) && <progress className="w-full" max={job.total ?? undefined} value={job.total != null ? job.bytes : undefined} />}
      {job.error && <BackupError error={job.error} t={t} />}
      {job.nextRetryAt && job.phase === "retry_wait" && <p data-testid="backup-retry-notice">{t("remoteBackup.retryAt", { time: new Date(job.nextRetryAt).toLocaleString(getLocale()), attempts: job.attempts ?? 0 })}</p>}
      {job.phase === "failed" && <p>{t("remoteBackup.actionRequired")}</p>}
      {(!finished.has(job.phase) || job.phase === "retry_wait") && <button data-testid="backup-job-cancel" className={button} onClick={() => void action(() => remoteBackup.cancel(job.id))}>{t("common.cancel")}</button>}
      {["failed", "cancelled", "interrupted", "retry_wait"].includes(job.phase) && <><button data-testid="backup-job-retry" className={button} disabled={busy} onClick={() => void action(() => remoteBackup.retry(job.id))}>{t("remoteBackup.retry")}</button><button data-testid="backup-job-discard" className={button} disabled={busy} onClick={() => setDiscardId(job.id)}>{t("remoteBackup.discard")}</button></>}
      {discardId === job.id && <div role="alertdialog"><p>{t("remoteBackup.discardWarning")}</p><button data-testid="backup-discard-confirm" className={button} disabled={busy} onClick={() => void action(async () => { await remoteBackup.discard(job.id); setDiscardId(null); await refreshConfig(); })}>{t("remoteBackup.discardConfirm")}</button><button className={button} onClick={() => setDiscardId(null)}>{t("common.cancel")}</button></div>}
      {job.phase === "completed" && job.operation === "download" && job.artifact && <button data-testid="backup-cloud-restore" className={button} onClick={() => onRestore(job.artifact!.path)}>{t("remoteBackup.restore")}</button>}
    </div>)}</div>}
  </section>;
}
