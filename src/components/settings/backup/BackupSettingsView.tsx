import type { BackupSettingsViewProps } from "./BackupSettingsTypes";
import { BackupGlobalDefaults, BackupLocalDestination, BackupManual } from "./BackupSections";
import { RemoteBackupPanel } from "../RemoteBackupPanel";
import { BackupAuthorizationBanner } from "./BackupAuthorizationBanner";
import { BackupRestoreDialog } from "./BackupRestoreDialog";
import { BackupLocalHistory } from "./BackupLocalHistory";
import { BackupCloudActivity } from "./BackupCloudActivity";
import { BackupError } from "./BackupError";
export function BackupSettingsView(props: BackupSettingsViewProps) {
  const { t } = props;
  return <div className="space-y-5" data-testid="backup-settings-panel">
    <div><h3 className="text-lg font-medium text-theme-text">{t("backupSettings.sectionTitle")}</h3>
      <p className="mt-1 text-xs text-theme-muted">{t("backupUnified.introduction")}</p></div>
    <BackupAuthorizationBanner />
    <BackupGlobalDefaults />
    <section className="space-y-3" aria-label={t("backupUnified.destinations")}>
      <h4 className="text-sm font-medium text-theme-text">{t("backupUnified.destinations")}</h4>
      <BackupLocalDestination {...props} />
      <RemoteBackupPanel />
    </section>
    <BackupManual {...props} />
    {props.actionError && <BackupError error={props.actionError} t={t} />}
    {props.error && <BackupError error={props.error} t={t} />}
    {props.actionSuccess && <p role="status" data-testid="backup-action-success" className="text-xs text-green-600">{t(props.actionSuccess)}</p>}
    <BackupCloudActivity onRestore={(path) => void props.openRestoreModal(path)} />
    <section className="space-y-3 rounded-lg border border-theme-border bg-theme-surface p-4">
      <h4 className="text-sm font-medium text-theme-text">{t("backupSettings.restoreTitle")}</h4>
      <p className="text-xs text-theme-muted">{t("backupSettings.restoreDesc")}</p>
      <button type="button" className="rounded border border-theme-border px-3 py-2 text-xs text-theme-text" onClick={props.handleSelectRestoreFile}>{t("backupSettings.chooseFile")}</button>
    </section>
    <BackupLocalHistory {...props} />
    <BackupRestoreDialog {...props} />
  </div>;
}
