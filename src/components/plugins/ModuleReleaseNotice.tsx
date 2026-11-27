import { useEffect, useState } from "react";
import { isMfaMigrationRequired } from "../../lib/ipc/plugin";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { relaunchApp } from "../../lib/updateService";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";

export function ModuleReleaseNotice({ openSettings }: { openSettings(): void }) {
  const t = useT();
  const snapshot = useModuleMarketplaceStore((state) => state.catalog);
  const refresh = useModuleMarketplaceStore((state) => state.refresh);
  const dismiss = useModuleMarketplaceStore((state) => state.dismissNew);
  const dismissError = useModuleMarketplaceStore((state) => state.dismissError);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const initial = window.setTimeout(() => void refresh(), 4000);
    const periodic = window.setInterval(() => void refresh(), 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(periodic);
    };
  }, [refresh]);

  const mfa = usePluginFrontendStore((state) => state.records.mfa);
  const installedMfa = !!mfa?.manifest && !mfa.reason && (mfa.lifecycle === "installed" || mfa.lifecycle === "enabled");
  const [mfaNotice, setMfaNotice] = useState<"required" | Error | null>(null);
  useEffect(() => {
    if (!installedMfa) {
      setMfaNotice(null);
      return;
    }
    let active = true;
    void isMfaMigrationRequired().then((required) => {
      if (active) setMfaNotice(required ? "required" : null);
    }).catch((reason: unknown) => {
      if (active) setMfaNotice(new Error(String(reason)));
    });
    return () => { active = false; };
  }, [installedMfa]);

  const showMfaNotice = installedMfa && mfaNotice !== null;
  const plan = snapshot?.release;
  const newModules = (plan?.newModules ?? []).flatMap((id) => {
    const entry = snapshot?.catalog.plugins[id];
    return entry ? [entry] : [];
  });
  const waitingForRestart = plan?.legacyRestartRequired?.length ?? 0;
  const importFailed = plan?.legacyImportFailed?.length ?? 0;
  const legacyPending = (plan?.legacyPending.length ?? 0) - waitingForRestart - importFailed;
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  if (!showMfaNotice && !newModules.length && !legacyPending && !waitingForRestart && !importFailed && !plan?.legacyWaiting) return null;

  return <aside data-testid="module-release-notice" className="max-h-40 space-y-1.5 overflow-y-auto border-t border-[var(--taomni-divider)] px-3 py-2 text-ui-body">
    {showMfaNotice && <p data-testid="module-release-mfa" role={mfaNotice instanceof Error ? "alert" : "status"}>
      {mfaNotice instanceof Error ? mfaNotice.message : t("plugins.marketMfaMigrationRequired")}
    </p>}
    {!!legacyPending && <p data-testid="module-release-legacy">{t("plugins.marketLegacyPending", { count: legacyPending })}</p>}
    {!!waitingForRestart && <p data-testid="module-release-legacy">{t("plugins.marketMailRestartRequired")}</p>}
    {!!importFailed && <p data-testid="module-release-legacy">{t("plugins.marketMailImportFailed")}</p>}
    {plan?.legacyWaiting && <p data-testid="module-release-legacy">{t("plugins.marketLegacyWaiting")}</p>}
    {!!newModules.length && <div data-testid="module-release-new">
      <p className="font-semibold">{t("plugins.marketNewTitle")}</p>
      <ul className="space-y-1">
        {newModules.map((entry) => <li key={entry.id} data-testid="module-release-new-item" data-module-id={entry.id}>
          <span className="font-medium">{entry.name}</span> — {entry.description}
        </li>)}
      </ul>
    </div>}
    {dismissError && <p role="alert">{dismissError}</p>}
    {restartError && <p role="alert" data-testid="module-release-restart-error" className="text-ui-danger">{restartError}</p>}
    <div className="mt-2 flex gap-2">
      <button type="button" data-testid="module-release-open-store" className="taomni-btn" onClick={() => {
        openSettingsSection("module-store");
        openSettings();
      }}>{t("plugins.browse")}</button>
      {!!waitingForRestart && <button type="button" data-testid="module-release-restart" className="taomni-btn" disabled={restarting}
        onClick={() => {
          setRestartError(null);
          setRestarting(true);
          void relaunchApp().catch((reason: unknown) => {
            setRestartError(reason instanceof Error ? reason.message : String(reason));
            setRestarting(false);
          });
        }}>
        {restarting ? t("plugins.marketWorking") : t("plugins.marketRestartNow")}
      </button>}
      {!!newModules.length && <button type="button" data-testid="module-release-later" className="taomni-btn"
        onClick={() => void dismiss(newModules.map((entry) => entry.id))}>{t("plugins.marketLater")}</button>}
    </div>
  </aside>;
}
