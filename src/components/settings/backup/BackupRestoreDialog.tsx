import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { getLocale } from "../../../lib/i18n";
import type { BackupSettingsViewProps } from "./BackupSettingsTypes";

type RestoreProps = Pick<BackupSettingsViewProps,
  "t" | "archiveName" | "dismissRestore" | "inspecting" | "manifest" | "vaultState" |
  "restoreVaultPassword" | "setRestoreVaultPassword" | "setInspectError" | "inspectError" |
  "restorePassword" | "setRestorePassword" | "handleRetryInspectWithPassword" |
  "restoreStaged" | "relaunchError" | "restartAfterRestore" | "restoring" | "handleConfirmRestore">;

export function BackupRestoreDialog({
  t, archiveName, dismissRestore, inspecting, manifest, vaultState, restoreVaultPassword,
  setRestoreVaultPassword, inspectError, setInspectError, restorePassword, setRestorePassword,
  handleRetryInspectWithPassword, restoreStaged, relaunchError, restartAfterRestore, restoring, handleConfirmRestore,
}: RestoreProps) {
  const [confirmation, setConfirmation] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const hintId = useId();
  const locked = restoring || restoreStaged;
  const vaultPasswordError = inspectError === "backupSettings.vaultBadPassword" || inspectError === "backupSettings.vaultPasswordRequired";
  const archivePasswordError = inspectError === "backupSettings.badArchivePassword";
  useEffect(() => {
    if (vaultPasswordError || archivePasswordError) password.current?.focus();
  }, [vaultPasswordError, archivePasswordError]);

  return <Modal title={t("backupSettings.restoreModalTitle")} testId="backup-restore-dialog"
    initialFocus='[data-testid="backup-restore-cancel"]' onCancel={dismissRestore}
    footer={<>
      <Button data-testid="backup-restore-cancel" disabled={locked && relaunchError === null} onClick={dismissRestore}>{t("common.cancel")}</Button>
      {relaunchError !== null && <Button onClick={() => void restartAfterRestore()}>{t("update.restartNow")}</Button>}
      {manifest && <Button variant="danger" data-testid="backup-restore-confirm" busy={restoring}
        disabled={restoreStaged || !archiveName || confirmation !== archiveName}
        aria-describedby={hintId} onClick={() => void handleConfirmRestore(confirmation)}>
        {t(restoring ? "backupSettings.restoring" : "backupSettings.confirmRestoreAndRestart")}
      </Button>}
    </>}>
    <div className="space-y-3">
      <p className="rounded border border-ui-warning-border bg-ui-warning-surface p-3 text-ui-warning">
        {t("backupSettings.restoreModalWarning")}
      </p>
      {inspectError && inspectError !== "backupSettings.inputPasswordForDecrypt" &&
        <p id={errorId} role="alert" data-testid="backup-restore-error" className="rounded border border-ui-danger-border bg-ui-danger-surface p-2 text-ui-danger">
          {inspectError.startsWith("backupSettings.") ? t(inspectError) : inspectError}
        </p>}
      {inspecting ? <p role="status">{t("backupSettings.inspecting")}</p> : manifest ? <>
        <p className="text-theme-muted">{t("backupSettings.provenance", {
          source: manifest.provenance ? `${manifest.provenance.deviceName} · ${manifest.provenance.deviceId}` : t("backupSettings.unknownSource"),
        })}{t("backupSettings.restoreIdentityHint")}</p>
        <dl className="grid grid-cols-2 gap-2 rounded border border-theme-border bg-theme-surface p-3">
          <div><dt className="text-theme-muted">{t("backupSettings.archiveVersion")}</dt><dd>{manifest.appVersion}</dd></div>
          <div><dt className="text-theme-muted">{t("backupSettings.scopeLabel")}</dt><dd>{manifest.backupScope}</dd></div>
          <div><dt className="text-theme-muted">{t("backupSettings.archiveDate")}</dt><dd>{new Date(manifest.createdAt).toLocaleString(getLocale())}</dd></div>
          <div><dt className="text-theme-muted">{t("backupSettings.archiveFilesCount")}</dt><dd>{t("backupSettings.filesCount", { count: manifest.files.length })}</dd></div>
        </dl>
        <ul data-testid="backup-restore-files" className="max-h-36 overflow-y-auto rounded border border-theme-border p-2 font-mono text-ui-small">
          {manifest.files.map((file) => <li key={file.path} className="flex justify-between gap-2">
            <span className="break-all">{file.path}</span><span className="shrink-0">{(file.sizeBytes / 1024).toFixed(1)} KB</span>
          </li>)}
        </ul>
        <label className="block"><span id={hintId}>{t("backupSettings.typeArchiveName", { name: archiveName })}</span>
          <input className="taomni-input mt-1 w-full" value={confirmation} disabled={locked}
            data-testid="backup-restore-name" autoComplete="off" spellCheck={false}
            onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        {vaultState !== "empty" ? <>
          <label className="block">{t("backupSettings.restoreVaultPasswordLabel")}
            <input ref={password} type="password" className="taomni-input mt-1 w-full" disabled={locked}
              autoComplete="current-password" required aria-invalid={vaultPasswordError || undefined}
              aria-describedby={vaultPasswordError ? errorId : undefined}
              data-testid="backup-restore-vault-password" value={restoreVaultPassword}
              onChange={(event) => { setRestoreVaultPassword(event.target.value); setInspectError(null); }}
              placeholder={t("backupSettings.restoreVaultPasswordPh")} />
          </label>
          <p className="text-ui-small text-theme-muted">{t("backupSettings.restoreVaultPasswordHint")}</p>
        </> : <p className="text-ui-small text-theme-muted">{t("backupSettings.vaultEmptyNotice")}</p>}
      </> : <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        if (restorePassword) void handleRetryInspectWithPassword();
      }}>
        <label className="block">{t("backupSettings.inputPasswordForDecrypt")}
          <input ref={password} type="password" data-testid="backup-restore-password" value={restorePassword}
            required aria-invalid={archivePasswordError || undefined} aria-describedby={archivePasswordError ? errorId : undefined}
            className="taomni-input mt-1 w-full" onChange={(event) => { setRestorePassword(event.target.value); setInspectError(null); }}
            placeholder={t("backupSettings.archivePasswordPh")} />
        </label>
        <Button type="submit" data-testid="backup-restore-unlock" disabled={!restorePassword}>{t("backupSettings.unlockAndVerify")}</Button>
      </form>}
      {relaunchError !== null && <p role="alert" className="text-ui-danger">{t("backupSettings.restartError", { reason: relaunchError })}</p>}
      {restoreStaged && relaunchError === null && <p role="status" data-testid="backup-restore-staged" className="rounded border border-ui-success-border bg-ui-success-surface p-2 text-ui-success">
        {t("backupSettings.restoreStagedSuccess")}
      </p>}
    </div>
  </Modal>;
}
