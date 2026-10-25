import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import type { BackupTarget, FeishuApplication } from "../../../lib/remoteBackup";
import { globalRange } from "../../../lib/backupSettings";
import { useBackupSettingsStore } from "../../../stores/backupSettingsStore";
import { authBlocking, useBackupControlStore } from "../../../stores/backupControlStore";
import { AppProxyPanel } from "../AppProxyPanel";
import { BackupRangeEditor, BackupRangeSummary, backupButton, backupInput } from "./BackupRangeEditor";
import { BackupError } from "./BackupError";

export function BackupTextSetting({ value, onCommit, label, testId, placeholder }: {
  value: string; onCommit: (value: string) => void; label: string; testId: string; placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="block space-y-1 text-xs text-theme-muted">{label}<input data-testid={testId} className={backupInput} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} /></label>;
}

export function BackupDestination({ target, applications, initiallyOpen = false }: {
  target: BackupTarget; applications: FeishuApplication[]; initiallyOpen?: boolean;
}) {
  const t = useT();
  const { draft, editControl, setPassword, flush } = useBackupSettingsStore();
  const { sessions, connect } = useBackupControlStore();
  const [password, setPasswordDraft] = useState("");
  const [selection, setSelection] = useState("");
  const [restartConfirmed, setRestartConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPassword, setSavedPassword] = useState(false);
  if (!draft) return null;
  const { config, statuses } = draft.remote;
  const status = statuses.find((s) => s.targetId === target.id);
  const connection = config.connections.find((c) => c.id === target.connectionId);
  const blocked = sessions.some(authBlocking);
  const session = sessions.filter((s) => s.targetId === target.id && !s.dismissedAt).sort((a, b) => b.createdAt - a.createdAt)[0];
  const patch = (fields: Partial<BackupTarget>) => editControl({ op: "updateTarget", targetId: target.id, fields });
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const inherited = target.rangeMode === "inherit";
  const range = { scope: target.source.scope as "core" | "full" | "custom", customOptions: target.source.customOptions };
  return <details open={initiallyOpen || undefined} data-testid="backup-cloud-destination" data-target-id={target.id} className="rounded-lg border border-theme-border bg-theme-surface p-4">
    <summary className="cursor-pointer text-sm text-theme-text">{target.name} · {t(status?.connected ? "remoteBackup.authorized" : "remoteBackup.notAuthorized")} · {t(inherited ? "backupUnified.inherit" : "backupUnified.customRange")}</summary>
    <div className="mt-3 space-y-3">
      <BackupTextSetting value={target.name} label={t("remoteBackup.targetName")} testId="backup-cloud-name" onCommit={(name) => patch({ name })} />
      <BackupTextSetting value={target.rootToken} label={t("remoteBackup.folder")} placeholder={t("remoteBackup.folderPlaceholder")} testId="backup-feishu-folder" onCommit={(raw) => patch({ rootToken: raw.includes("/folder/") ? raw.split("/folder/")[1].split(/[?#/]/)[0] : raw.trim() })} />
      <label className="block space-y-1 text-xs text-theme-muted">{t("backupUnified.automaticRange")}<select data-testid="backup-cloud-range-mode" className={backupInput} value={inherited ? "inherit" : "custom"} onChange={(e) => patch({ rangeMode: e.target.value as "inherit" | "custom", ...(e.target.value === "custom" ? { source: { ...target.source, ...globalRange(draft.policy) } } : {}) })}>
        <option value="inherit">{t("backupUnified.inherit")}</option><option value="custom">{t("backupUnified.customRange")}</option>
      </select></label>
      {inherited ? <BackupRangeSummary value={globalRange(draft.policy)} /> : <BackupRangeEditor id="backup-cloud" value={range} onChange={(value) => patch({ source: { ...target.source, ...value } })} />}
      <label className="block space-y-1 text-xs text-theme-muted">{t("remoteBackup.proxyLabel")}<select data-testid="backup-cloud-proxy" className={backupInput} value={target.proxy.mode} onChange={(e) => patch({ proxy: { ...target.proxy, mode: e.target.value as BackupTarget["proxy"]["mode"] } })}>
        <option value="app">{t("remoteBackup.useAppProxy")}</option><option value="custom">{t("remoteBackup.proxyCustom")}</option><option value="none">{t("remoteBackup.noProxy")}</option>
      </select></label>
      {target.proxy.mode === "custom" && <AppProxyPanel value={target.proxy.custom} testHost="open.feishu.cn" onSave={async (custom) => { patch({ proxy: { ...target.proxy, custom } }); await flush(); }} />}
      <label className="block space-y-1 text-xs text-theme-muted">{t("remoteBackup.password")}<input data-testid="backup-cloud-password" type="password" autoComplete="new-password" className={backupInput} value={password} onChange={(e) => { setPasswordDraft(e.target.value); setSavedPassword(false); }} /></label>
      <p className="text-xs text-theme-muted">{t(status?.passwordConfigured ? "backupUnified.passwordConfigured" : "remoteBackup.passwordHint")}</p>
      <button data-testid="backup-cloud-save" className={backupButton} disabled={busy || !password.trim()} onClick={() => void action(async () => { await setPassword(target.id, password); setPasswordDraft(""); setSavedPassword(true); })}>{t("backupUnified.savePassword")}</button>
      {savedPassword && <p role="status" className="text-xs text-green-600">{t("remoteBackup.saved")}</p>}
      <label className="flex items-center gap-2 text-xs text-theme-text"><input data-testid="backup-cloud-enabled" type="checkbox" checked={target.enabled} disabled={busy || !status?.passwordConfigured} onChange={(e) => patch({ enabled: e.target.checked })} />{t("backupUnified.enableDestination")}</label>
      {connection && <p className="text-xs text-theme-muted">{t("remoteBackup.account", { name: connection.accountName || t("remoteBackup.awaitingAccount"), application: connection.label, origin: t(connection.origin === "cli_existing" ? "remoteBackup.originExisting" : "remoteBackup.originRegistered") })}</p>}
      <p className="text-xs text-theme-muted">{t("remoteBackup.connectHint")}</p>
      {(applications.length > 0 || config.connections.length > 0) && <label className="block space-y-1 text-xs text-theme-muted">{t("remoteBackup.applicationLabel")}<select className={backupInput} aria-label={t("remoteBackup.applicationAria")} value={selection} disabled={blocked || busy} onChange={(e) => setSelection(e.target.value)}>
        <option value="">{t("remoteBackup.automaticApp")}</option>
        {config.connections.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.accountName || t("remoteBackup.savedConnection")}</option>)}
        {applications.map((a) => <option key={a.appId} value={a.appId}>{a.label} · {t("remoteBackup.localCli")}</option>)}
      </select></label>}
      <button data-testid="backup-feishu-authorize" className={backupButton} disabled={busy || blocked} onClick={() => void action(() => connect(target.id, selection))}>{t("remoteBackup.authorize")}</button>
      {(connection?.registrationPending || session && ["failed", "expired", "interrupted", "cancelled"].includes(session.phase)) && <div data-testid="backup-connection-recovery" className="space-y-2 rounded border border-theme-border p-3 text-xs text-theme-muted">
        <p>{t("remoteBackup.recoveryHint")}</p>
        <label className="flex items-center gap-2"><input data-testid="backup-restart-confirm" type="checkbox" checked={restartConfirmed} disabled={blocked} onChange={(e) => setRestartConfirmed(e.target.checked)} />{t("remoteBackup.restartWarning")}</label>
        <button data-testid="backup-restart-application" className={backupButton} disabled={busy || blocked || !restartConfirmed} onClick={() => void action(async () => { await connect(target.id, undefined, true); setRestartConfirmed(false); })}>{t("remoteBackup.restartApplication")}</button>
      </div>}
      {status?.error && <BackupError error={status.error} t={t} />}
      {error && <BackupError error={error} t={t} />}
      <button data-testid="backup-cloud-remove" className={backupButton} disabled={busy || sessions.some((s) => s.targetId === target.id && authBlocking(s))} onClick={() => { if (window.confirm(t("backupUnified.removeConfirm"))) editControl({ op: "removeTarget", targetId: target.id }); }}>{t("backupUnified.removeDestination")}</button>
    </div>
  </details>;
}
