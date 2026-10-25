import { RefreshCw, Lock, Unlock } from "lucide-react";
import { getLocale } from "../../../lib/i18n";
import type { BackupSettingsViewProps } from "./BackupSettingsTypes";
export function BackupLocalHistory(inputs: Pick<BackupSettingsViewProps, "t" | "history" | "refreshHistory" | "openRestoreModal" | "handleDeleteItem">) {
  const { t, history, refreshHistory, openRestoreModal, handleDeleteItem } = inputs;
  return <>
      {(() => {
        const safeHistory = history ?? [];
        return (
          <div className="p-4 rounded-lg bg-theme-surface border border-theme-border space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-theme-text">
                {t("backupSettings.historyTitle")} ({safeHistory.length})
              </h4>
              <button
                type="button"
                data-testid="backup-history-refresh"
                onClick={() => void refreshHistory()}
                className="p-1 rounded text-theme-muted hover:text-theme-text"
                title={t("common.refresh")}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {safeHistory.length === 0 ? (
              <p className="text-xs text-theme-muted py-2">
                {t("backupSettings.noHistory")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-theme-border text-theme-muted">
                      <th className="py-2 px-2">{t("backupSettings.fileName")}</th>
                      <th className="py-2 px-2">{t("backupSettings.size")}</th>
                      <th className="py-2 px-2">{t("backupSettings.date")}</th>
                      <th className="py-2 px-2">{t("backupSettings.status")}</th>
                      <th className="py-2 px-2 text-right">{t("backupSettings.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/40">
                    {safeHistory.map((item) => (
                      <tr key={item.filePath} data-testid="backup-history-row" data-file-name={item.fileName} className="hover:bg-theme-bg/40">
                        <td className="py-2 px-2 font-mono text-theme-text max-w-xs truncate" title={item.fileName}>
                          {item.fileName}
                        </td>
                        <td className="py-2 px-2 text-theme-muted">
                          {(item.sizeBytes / 1024 / 1024).toFixed(2)} MB
                        </td>
                        <td className="py-2 px-2 text-theme-muted">
                          {new Date(item.modifiedAt).toLocaleString(getLocale())}
                        </td>
                        <td className="py-2 px-2">
                          {item.isEncrypted ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
                              <Lock className="w-3 h-3" />
                              {t("backupSettings.encrypted")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-theme-muted">
                              <Unlock className="w-3 h-3" />
                              {t("backupSettings.unencrypted")}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right space-x-2">
                          <button
                            type="button"
                            data-testid="backup-history-restore"
                            onClick={() => openRestoreModal(item.filePath)}
                            className="text-xs text-accent hover:underline font-medium"
                          >
                            {t("backupSettings.restoreAction")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(item.fileName)}
                            className="text-xs text-red-500 hover:underline"
                          >
                            {t("backupSettings.deleteAction")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}


  </>;
}
