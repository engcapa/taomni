import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { useT } from "../../../lib/i18n";
import { authBlocking, authClean, authTerminal, useBackupControlStore } from "../../../stores/backupControlStore";
import { useBackupSettingsStore } from "../../../stores/backupSettingsStore";
import { BackupError } from "./BackupError";
import { backupButton } from "./BackupRangeEditor";

export function BackupAuthorizationBanner() {
  const t = useT();
  const { sessions, cancelAuthorization, forget, error } = useBackupControlStore();
  const targets = useBackupSettingsStore((s) => s.draft?.remote.config.targets);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setError] = useState<string | null>(null);
  const visible = sessions.filter((s) => !s.dismissedAt).sort((a, b) => Number(authBlocking(b)) - Number(authBlocking(a)) || b.createdAt - a.createdAt);
  const action = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };
  if (!visible.length && !error) return null;
  return <aside data-testid="backup-authorization-banner" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
    <h4 className="text-sm font-medium text-theme-text">{t("backupUnified.authorization")}</h4>
    {visible.slice(0, 5).map((session) => <div key={session.id} data-testid="backup-feishu-session" data-session-id={session.id} data-phase={session.phase} data-cleanup-complete={authClean(session)} className="space-y-2 text-xs text-theme-muted">
      <p className="font-medium text-theme-text">{targets?.find((item) => item.id === session.targetId)?.name ?? t("backupUnified.removedDestination")}</p>
      <p role="status">{t(session.cancelRequested && !authClean(session) ? "backupUnified.cancelling" : `remoteBackup.auth.${session.phase}`)}{session.userCode && !session.cancelRequested && ` · ${t("remoteBackup.verificationCode", { code: session.userCode })}`}</p>
      {session.error && <BackupError t={t} error={session.error} />}
      <div className="flex flex-wrap gap-2">
        {session.verificationUrl && !session.cancelRequested && !authTerminal(session) && <button className={backupButton} onClick={() => void action(session.id, () => open(session.verificationUrl!))}>{t("remoteBackup.openAuthorization")}</button>}
        {authBlocking(session) && <button data-testid="backup-authorization-cancel" className={backupButton} disabled={busy === session.id || session.cancelRequested || authTerminal(session)} onClick={() => void action(session.id, () => cancelAuthorization(session.id))}>{t("remoteBackup.cancelConnection")}</button>}
        {authTerminal(session) && authClean(session) && <button data-testid="backup-authorization-forget" className={backupButton} disabled={busy === session.id} onClick={() => void action(session.id, () => forget(session.id))}>{t("backupUnified.dismissAuthorization")}</button>}
      </div>
    </div>)}
    {(actionError || error) && <BackupError error={actionError || error!} t={t} />}
  </aside>;
}
