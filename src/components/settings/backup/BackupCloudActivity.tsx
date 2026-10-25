import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { getLocale, useT } from "../../../lib/i18n";
import { remoteBackup, type RemoteBackup } from "../../../lib/remoteBackup";
import { useBackupControlStore } from "../../../stores/backupControlStore";
import { useBackupSettingsStore } from "../../../stores/backupSettingsStore";
import { BackupError } from "./BackupError";
import { backupButton as button, backupInput as input } from "./BackupRangeEditor";
const finished = new Set(["completed", "failed", "cancelled", "interrupted", "discarded", "retry_wait"]);
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
export function BackupCloudActivity({ onRestore }: { onRestore: (path: string) => void }) {
  const t = useT();
  const data = useBackupSettingsStore((s) => s.draft?.remote);
  const refreshConfig = useBackupSettingsStore((s) => s.refresh);
  const { jobs, refresh: refreshJobs } = useBackupControlStore();
  const [targetId, setTargetId] = useState("");
  const [files, setFiles] = useState<RemoteBackup[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState<{ key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const generation = useRef(0);
  const target = data?.config.targets.find((t) => t.id === targetId) ?? data?.config.targets[0];
  const id = target?.id;
  useEffect(() => { generation.current++; setFiles([]); setFilter(""); return () => { generation.current++; }; }, [id]);
  const action = async (fn: () => Promise<unknown>) => {
    setError(""); setMessage(null); setBusy(true);
    try { await fn(); await refreshJobs(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const browse = async () => {
    if (!id) return;
    const version = ++generation.current;
    const result = await remoteBackup.list(id);
    if (version === generation.current) setFiles(result);
  };
  const visible = files.filter((f) => !filter || f.deviceId === filter);
  return <section className="space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4" data-testid="backup-cloud-activity">
    <h4 className="text-sm font-medium text-theme-text">{t("backupUnified.tasksHistory")}</h4>
    {data && target && <>
      <select data-testid="backup-cloud-target" aria-label={t("remoteBackup.targetLabel")} className={input} value={target.id} onChange={(e) => setTargetId(e.target.value)}>{data.config.targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <div className="flex flex-wrap gap-2"><button data-testid="backup-cloud-refresh" className={button} disabled={busy || !data.statuses.some((s) => s.targetId === id && s.connected)} onClick={() => void action(browse)}>{t("remoteBackup.refresh")}</button>
      {target.writesPaused && <button className={button} disabled={busy} onClick={() => void action(async () => { await remoteBackup.resumeWrites(target.id); await refreshConfig(); })}>{t("remoteBackup.resumeWrites")}</button>}</div>
      <select data-testid="backup-source-device" aria-label={t("remoteBackup.sourceDevice")} className={input} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">{t("remoteBackup.allDevices")}</option>{Array.from(new Set(files.map((f) => f.deviceId))).map((id) => <option key={id} value={id}>{id === data?.config.device.id ? t("remoteBackup.thisDevice", { name: data.config.device.name }) : `${files.find((file) => file.deviceId === id)?.deviceName ?? id} · ${id.slice(0, 8)}`}</option>)}</select>
      {visible.length === 0 && <p className="text-xs text-theme-muted">{t("remoteBackup.empty")}</p>}
      {visible.map((file) => <div key={file.fileToken} data-testid="backup-cloud-row" className="space-y-2 rounded border border-theme-border p-3 text-xs">
        <p className="break-all text-theme-text">{file.deviceId === data?.config.device.id ? t("remoteBackup.thisDevice", { name: data.config.device.name }) : `${file.deviceName} · ${file.deviceId.slice(0, 8)}`} · {file.sourceKind}</p>
        <p className="text-theme-muted">{file.name}</p>
        <p className="text-theme-muted">{t("remoteBackup.cloudUpdated", { time: file.modifiedAt ? new Date(Number(file.modifiedAt) * 1000).toLocaleString(getLocale()) : t("remoteBackup.unknownTime") })}</p>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void action(async () => { await remoteBackup.download(file); setMessage({ key: "downloadingNotice" }); })}>{t(target!.writesPaused ? "remoteBackup.downloadAfterHistory" : "remoteBackup.downloadCurrent")}</button><button className={button} disabled={busy} onClick={() => void action(async () => { const url = await remoteBackup.history(file); await open(url); await refreshConfig(); setMessage({ key: "historyNotice" }); })}>{t("remoteBackup.history")}</button></div>
      </div>)}

    </>}
    {message && <p role="status" className="text-xs text-green-600">{t(`remoteBackup.${message.key}`)}</p>}
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
