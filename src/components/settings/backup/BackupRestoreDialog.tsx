import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import type { BackupSettingsViewProps } from "./BackupSettingsTypes";
export function BackupRestoreDialog(inputs: Pick<BackupSettingsViewProps, "t" | "restoreModalOpen" | "setRestoreModalOpen" | "inspecting" | "manifest" | "vaultState" | "restoreVaultPassword" | "setRestoreVaultPassword" | "setInspectError" | "inspectError" | "restorePassword" | "setRestorePassword" | "handleRetryInspectWithPassword" | "restoreStaged" | "restoring" | "handleConfirmRestore">) {
  const { t, restoreModalOpen, setRestoreModalOpen, inspecting, manifest, vaultState, restoreVaultPassword, setRestoreVaultPassword, setInspectError, inspectError, restorePassword, setRestorePassword, handleRetryInspectWithPassword, restoreStaged, restoring, handleConfirmRestore } = inputs;
  const displayError = inspectError?.startsWith("backupSettings.") ? t(inspectError) : inspectError;
  return <>
      {restoreModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-restore-dialog-title"
            data-testid="backup-restore-dialog"
            className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border p-5 shadow-2xl space-y-4"
            style={{
              background: "var(--taomni-bg)",
              borderColor: "var(--taomni-card-border)",
              color: "var(--taomni-text)",
            }}
          >
            <div
              className="flex items-center justify-between border-b pb-3"
              style={{ borderColor: "var(--taomni-divider)" }}
            >
              <h3 id="backup-restore-dialog-title" className="font-semibold text-base flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[var(--taomni-accent)]" />
                {t("backupSettings.restoreModalTitle")}
              </h3>
              <button
                type="button"
                onClick={() => setRestoreModalOpen(false)}
                className="text-sm text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
              >
                ✕
              </button>
            </div>

            <div
              className="rounded border p-3 text-xs"
              style={{
                background: "var(--taomni-warning-bg)",
                borderColor: "var(--taomni-warning-border)",
                color: "var(--taomni-warning-text)",
              }}
            >
              {t("backupSettings.restoreModalWarning")}
            </div>

            {inspecting ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-[var(--taomni-text-muted)]">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--taomni-accent)]" />
                {t("backupSettings.inspecting")}
              </div>
            ) : manifest ? (
              <div className="space-y-3 text-xs">
                <p className="text-[var(--taomni-text-muted)]">
                  {t("backupSettings.provenance", { source: manifest.provenance ? `${manifest.provenance.deviceName} · ${manifest.provenance.deviceId}` : t("backupSettings.unknownSource") })}
                  {t("backupSettings.restoreIdentityHint")}
                </p>
                <div
                  className="grid grid-cols-2 gap-2 rounded border p-3"
                  style={{
                    background: "var(--taomni-card-bg)",
                    borderColor: "var(--taomni-card-border)",
                  }}
                >
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveVersion")}:</span>
                    <div className="font-medium font-mono">{manifest.appVersion}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.scopeLabel")}:</span>
                    <div className="font-medium capitalize">{manifest.backupScope}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveDate")}:</span>
                    <div className="font-mono">{new Date(manifest.createdAt).toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-[var(--taomni-text-muted)]">{t("backupSettings.archiveFilesCount")}:</span>
                    <div className="font-mono">{t("backupSettings.filesCount", { count: manifest.files.length })}</div>
                  </div>
                </div>

                <div
                  data-testid="backup-restore-files"
                  className="max-h-36 overflow-y-auto space-y-1 rounded border p-2 font-mono text-[11px] text-[var(--taomni-text-muted)]"
                  style={{
                    background: "var(--taomni-panel-bg)",
                    borderColor: "var(--taomni-divider)",
                  }}
                >
                  {manifest.files.map((f) => (
                    <div key={f.path} className="flex justify-between">
                      <span className="truncate pr-2">{f.path}</span>
                      <span>{(f.sizeBytes / 1024).toFixed(1)} KB</span>
                    </div>
                  ))}
                </div>

                {vaultState !== "empty" ? (
                  <div
                    className="space-y-1.5 border-t pt-2"
                    style={{ borderColor: "var(--taomni-divider)" }}
                  >
                    <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--taomni-text-muted)]">
                      <ShieldCheck className="h-3.5 w-3.5 text-[var(--taomni-accent)]" />
                      <span>{t("backupSettings.restoreVaultPasswordLabel")}</span>
                      <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={restoreVaultPassword}
                      onChange={(e) => {
                        setRestoreVaultPassword(e.target.value);
                        setInspectError(null);
                      }}
                      placeholder={t("backupSettings.restoreVaultPasswordPh")}
                      className="w-full rounded border px-3 py-1.5 text-xs text-[var(--taomni-text)] outline-none focus:border-[var(--taomni-accent)] placeholder:text-[var(--taomni-text-muted)]"
                      style={{
                        background: "var(--taomni-input-bg)",
                        borderColor: "var(--taomni-input-border)",
                      }}
                    />
                    <p className="text-[11px] text-[var(--taomni-text-muted)]">
                      {t("backupSettings.restoreVaultPasswordHint")}
                    </p>
                  </div>
                ) : (
                  <div
                    className="border-t pt-2 text-[11px] italic text-[var(--taomni-text-muted)]"
                    style={{ borderColor: "var(--taomni-divider)" }}
                  >
                    {t("backupSettings.vaultEmptyNotice")}
                  </div>
                )}

                {inspectError && (
                  <div className="text-xs text-red-500 bg-red-500/10 p-2.5 rounded border border-red-500/20 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span>{displayError}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {inspectError && (
                  <div className="text-xs text-red-500 bg-red-500/10 p-2.5 rounded border border-red-500/20">
                    {displayError}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--taomni-text-muted)]">
                    {t("backupSettings.inputPasswordForDecrypt")}
                  </label>
                  <input
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    data-testid="backup-restore-password" placeholder={t("backupSettings.archivePasswordPh")}
                    className="w-full rounded border px-3 py-2 text-xs text-[var(--taomni-text)] outline-none focus:border-[var(--taomni-accent)] placeholder:text-[var(--taomni-text-muted)]"
                    style={{
                      background: "var(--taomni-input-bg)",
                      borderColor: "var(--taomni-input-border)",
                    }}
                  />
                  <button
                    type="button"
                    data-testid="backup-restore-unlock" onClick={handleRetryInspectWithPassword}
                    className="mt-2 w-full rounded border py-1.5 text-xs font-medium text-[var(--taomni-text)] hover:border-[var(--taomni-accent)]"
                    style={{
                      background: "var(--taomni-card-bg)",
                      borderColor: "var(--taomni-input-border)",
                    }}
                  >
                    {t("backupSettings.unlockAndVerify")}
                  </button>
                </div>
              </div>
            )}

            {restoreStaged && (
              <div
                className="flex items-center gap-2 rounded border p-3 text-xs"
                style={{
                  background: "var(--taomni-success-bg)",
                  borderColor: "var(--taomni-success-border)",
                  color: "var(--taomni-success-text)",
                }}
              >
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" style={{ color: "var(--taomni-success-icon)" }} />
                <span>{t("backupSettings.restoreStagedSuccess")}</span>
              </div>
            )}

            <div
              className="flex justify-end gap-2 border-t pt-2"
              style={{ borderColor: "var(--taomni-divider)" }}
            >
              <button
                type="button"
                data-testid="backup-restore-cancel"
                disabled={restoring}
                onClick={() => setRestoreModalOpen(false)}
                className="rounded border px-3 py-1.5 text-xs text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
                style={{
                  background: "var(--taomni-card-bg)",
                  borderColor: "var(--taomni-input-border)",
                }}
              >
                {t("common.cancel")}
              </button>
              {manifest && (
                <button
                  type="button"
                  disabled={restoring || restoreStaged}
                  onClick={handleConfirmRestore}
                  className="flex items-center gap-1.5 rounded bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {restoring ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t("backupSettings.restoring")}
                    </>
                  ) : (
                    t("backupSettings.confirmRestoreAndRestart")
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
  </>;
}
