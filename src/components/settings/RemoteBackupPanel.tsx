import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { newFeishuTarget, remoteBackup, type FeishuApplication } from "../../lib/remoteBackup";
import { useBackupSettingsStore } from "../../stores/backupSettingsStore";
import { BackupDestination, BackupTextSetting } from "./backup/BackupDestination";
import { backupButton } from "./backup/BackupRangeEditor";
import { BackupError } from "./backup/BackupError";

export function RemoteBackupPanel() {
  const t = useT();
  const { draft, editControl } = useBackupSettingsStore();
  const [applications, setApplications] = useState<FeishuApplication[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState("");
  useEffect(() => {
    let disposed = false;
    void remoteBackup.applications().then((values) => { if (!disposed) setApplications(values); }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, []);
  if (!draft) return null;
  const config = draft.remote.config;
  return <div data-testid="backup-cloud-panel" className="space-y-3">
    {config.targets.map((target) => <BackupDestination key={target.id} target={target} applications={applications} initiallyOpen={added === target.id} />)}
    <button data-testid="backup-feishu-add" className={backupButton} onClick={() => { const target = newFeishuTarget(); editControl({ op: "addTarget", target }); setAdded(target.id); }}>{t("remoteBackup.addFeishu")}</button>
    <details data-testid="backup-device-settings" className="rounded-lg border border-theme-border p-3"><summary className="cursor-pointer text-xs text-theme-muted">{t("remoteBackup.deviceName")}</summary>
      <div className="mt-3 space-y-2"><BackupTextSetting value={config.device.name} label={t("remoteBackup.deviceName")} testId="backup-device-name" onCommit={(name) => editControl({ op: "setDeviceName", name })} />
        <p className="text-xs text-theme-muted">{t("remoteBackup.deviceIdentity", { id: config.device.id })}</p><p className="text-xs text-theme-muted">{t("remoteBackup.deviceNameHint")}</p></div>
    </details>
    {error && <BackupError error={error} t={t} />}
  </div>;
}
