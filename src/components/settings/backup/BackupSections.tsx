import { useT, getLocale } from "../../../lib/i18n";
import { globalRange } from "../../../lib/backupSettings";
import { useBackupSettingsStore } from "../../../stores/backupSettingsStore";
import { authBlocking, useBackupControlStore } from "../../../stores/backupControlStore";
import { BackupRangeEditor, BackupRangeSummary, backupInput, backupButton } from "./BackupRangeEditor";
import { BackupError } from "./BackupError";
import type { BackupSettingsViewProps } from "./BackupSettingsTypes";

export function BackupGlobalDefaults() {
  const t = useT();
  const { draft, status, error, editPolicy, retry } = useBackupSettingsStore();
  const policy = draft?.policy;
  return <section className="space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4" data-testid="backup-global-defaults">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-theme-text">{t("backupUnified.globalDefaults")}</h4>
      <span data-testid="backup-settings-save-status" role="status" className="text-xs text-theme-muted">{t(`backupUnified.${status}`)}</span>
    </div>
    <p className="text-xs text-theme-muted">{t("backupUnified.globalHint")}</p>
    {error && <div className="space-y-2"><BackupError error={error} t={t} /><button className={backupButton} data-testid="backup-settings-retry" onClick={() => void retry()}>{t("backupUnified.retrySave")}</button></div>}
    {policy && <>
      <BackupRangeEditor value={globalRange(policy)} onChange={(range) => editPolicy({ defaultScope: range.scope, includeMail: range.customOptions?.includeMail ?? null, defaultCustomOptions: range.scope === "custom" ? range.customOptions : null })} />
      <label className="flex items-center gap-2 text-xs text-theme-text"><input data-testid="backup-auto-enabled" aria-checked={policy.autoBackupEnabled} type="checkbox" checked={policy.autoBackupEnabled} onChange={(e) => editPolicy({ autoBackupEnabled: e.target.checked })} />{t("backupSettings.enableAutoBackup")}</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-theme-muted">{t("backupSettings.frequencyLabel")}<select data-testid="backup-auto-frequency" className={backupInput} value={policy.frequency} onChange={(e) => editPolicy({ frequency: e.target.value as typeof policy.frequency })}>
          <option value="daily">{t("backupSettings.freqDaily")}</option><option value="weekly">{t("backupSettings.freqWeekly")}</option><option value="on_exit">{t("backupSettings.freqOnExit")}</option>
        </select></label>
        <label className="space-y-1 text-xs text-theme-muted">{t("backupSettings.maxCopiesLabel")}<input data-testid="backup-auto-retention" className={backupInput} type="number" min={1} max={10000} value={policy.maxRetainedCopies} onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 10000) editPolicy({ maxRetainedCopies: n }); }} /></label>
      </div>
      <p className="text-xs text-theme-muted">{t("backupUnified.retentionHint")}</p>
      <p data-testid="backup-last-success" className="text-xs text-theme-muted">{t("backupSettings.lastBackupLabel")}: {policy.lastBackupAt ? new Date(policy.lastBackupAt).toLocaleString(getLocale()) : t("backupSettings.neverBackedUp")}</p>
    </>}
  </section>;
}

export function BackupLocalDestination(props: BackupSettingsViewProps) {
  const t = useT();
  const { draft, editPolicy } = useBackupSettingsStore();
  const policy = draft?.policy;
  if (!policy) return null;
  const range = policy.localRangeOverride;
  return <details className="rounded-lg border border-theme-border bg-theme-surface p-4" data-testid="backup-local-destination">
    <summary className="cursor-pointer text-sm text-theme-text">{t("remoteBackup.localDestination")} · {t(range ? "backupUnified.customRange" : "backupUnified.inherit")}</summary>
    <div className="mt-3 space-y-3">
      <label className="flex items-center gap-2 text-xs text-theme-text"><input data-testid="backup-local-enabled" type="checkbox" checked={policy.localChannelEnabled !== false} onChange={(e) => editPolicy({ localChannelEnabled: e.target.checked })} />{t("backupUnified.enableDestination")}</label>
      <p className="text-xs text-theme-muted">{t("backupSettings.targetDirDesc")}</p>
      <code className="block break-all text-xs text-theme-text" data-testid="backup-effective-directory">{props.effectiveBackupDir}</code>
      <div className="flex gap-2"><button data-testid="backup-change-directory" className={backupButton} onClick={props.handleChangeDirectory}>{t("backupSettings.changeDir")}</button>
        {props.isCustomDir && <button className={backupButton} onClick={props.handleResetDefaultDirectory}>{t("backupSettings.resetDefaultDir")}</button>}</div>
      <label className="block space-y-1 text-xs text-theme-muted">{t("backupUnified.automaticRange")}<select data-testid="backup-local-range-mode" className={backupInput} value={range ? "custom" : "inherit"} onChange={(e) => editPolicy({ localRangeOverride: e.target.value === "inherit" ? null : globalRange(policy) })}>
        <option value="inherit">{t("backupUnified.inherit")}</option><option value="custom">{t("backupUnified.customRange")}</option>
      </select></label>
      {range ? <BackupRangeEditor id="backup-local" value={range} onChange={(value) => editPolicy({ localRangeOverride: value })} /> : <BackupRangeSummary value={globalRange(policy)} />}
    </div>
  </details>;
}

export function BackupManual(props: BackupSettingsViewProps) {
  const t = useT();
  const { draft, status, editControl } = useBackupSettingsStore();
  const blocked = useBackupControlStore((s) => s.sessions.some(authBlocking));
  if (!draft) return null;
  const { config, statuses } = draft.remote;
  const selected = config.selectedTargetIds;
  const toggle = (id: string, checked: boolean) => editControl({ op: "setSelectedTargets", ids: checked ? [...new Set([...selected, id])] : selected.filter((s) => s !== id) });
  const invalid = selected.some((id) => id === "local" ? draft.policy.localChannelEnabled === false : !config.targets.some((target) => target.id === id && target.enabled && !target.writesPaused && statuses.some((s) => s.targetId === id && s.connected && s.passwordConfigured)));
  return <section className="space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4" data-testid="backup-manual">
    <h4 className="text-sm font-medium text-theme-text">{t("backupSettings.createBackupTitle")}</h4>
    <p className="text-xs text-theme-muted">{t("backupUnified.manualGlobal")}</p>
    <BackupRangeSummary value={globalRange(draft.policy)} />
    <fieldset className="space-y-2 text-xs text-theme-text"><legend className="mb-2">{t("remoteBackup.destinations")}</legend>
      <label className="flex items-center gap-2"><input data-testid="backup-local-select" type="checkbox" disabled={draft.policy.localChannelEnabled === false && !selected.includes("local")} checked={selected.includes("local")} onChange={(e) => toggle("local", e.target.checked)} />{t("remoteBackup.localDestination")}</label>
      {config.targets.map((target) => <label key={target.id} className="flex items-center gap-2"><input data-testid="backup-destination-select" data-target-id={target.id} type="checkbox" disabled={!target.enabled && !selected.includes(target.id)} checked={selected.includes(target.id)} onChange={(e) => toggle(target.id, e.target.checked)} />{target.name}{!target.enabled && t("remoteBackup.notEnabledSuffix")}</label>)}
    </fieldset>
    <label className="flex items-center gap-2 text-xs text-theme-text"><input data-testid="backup-local-encryption" type="checkbox" checked={props.usePassword} onChange={(e) => props.setUsePassword(e.target.checked)} />{t("backupUnified.localEncryption")}</label>
    {props.usePassword && <input type="password" autoComplete="new-password" data-testid="backup-local-password" aria-label={t("backupSettings.passwordPlaceholder")} className={backupInput} placeholder={t("backupSettings.passwordPlaceholder")} value={props.password} onChange={(e) => props.setPassword(e.target.value)} />}
    <p className="text-xs text-theme-muted">{t("backupUnified.cloudEncryption")}</p>
    <div className="flex flex-wrap gap-2">
      <button data-testid="backup-selected-start" className={backupButton} disabled={props.creating || status === "error" || blocked && selected.some((id) => id !== "local") || !selected.length || invalid || props.usePassword && !props.password.trim()} onClick={props.handleBackupNow}>{t(props.creating ? "backupSettings.creating" : "remoteBackup.startSelected")}</button>
      <button data-testid="backup-export" className={backupButton} disabled={props.creating || status === "error" || props.usePassword && !props.password.trim()} onClick={props.handleExportBackup}>{t("backupSettings.exportTo")}</button>
    </div>
    {props.manualResults.map((result) => <div key={result.targetId} role="status" className="space-y-1 text-xs text-theme-muted">
      <p>{result.targetId === "local" ? t("remoteBackup.localDestination") : config.targets.find((target) => target.id === result.targetId)?.name}: {t(result.error ? "remoteBackup.phases.failed" : result.jobId ? "remoteBackup.taskCreated" : "remoteBackup.completed")}</p>
      {result.error && <BackupError error={result.error} t={t} />}
    </div>)}
  </section>;
}
