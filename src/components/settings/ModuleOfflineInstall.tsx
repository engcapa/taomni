import { CheckCircle2, Loader2, PackageOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { selectOnePath } from "../../lib/ipc/files";
import { useModuleInstallStore } from "../../stores/moduleInstallStore";

export interface ModuleOfflineInstallProps {
  /** Refresh catalog metadata after native installation succeeds, including
   * when Settings was closed during the operation and is opened again. */
  onRegistryChanged?: () => void;
}

export function ModuleOfflineInstall({ onRegistryChanged }: ModuleOfflineInstallProps) {
  const t = useT();
  const state = useModuleInstallStore();
  const [pickerError, setPickerError] = useState<string | null>(null);
  const busy = state.phase === "verifying";

  useEffect(() => {
    if (state.completionRevision > 0) onRegistryChanged?.();
  }, [state.completionRevision, onRegistryChanged]);

  const chooseArchive = async () => {
    setPickerError(null);
    try {
      const path = await selectOnePath({
        title: t("settings.moduleOfflineChoose"),
        directory: false,
        defaultPath: state.archivePath.trim() || undefined,
        filters: [{ name: "Taomni", extensions: ["taomni-plugin"] }],
      });
      if (path) useModuleInstallStore.getState().setArchivePath(path);
    } catch (reason) {
      setPickerError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section data-testid="module-offline-install" data-phase={state.phase}
      className="mb-3 rounded border border-[var(--taomni-divider)] p-3">
      <div className="flex items-center gap-2 text-ui-body font-semibold">
        <PackageOpen className="h-4 w-4" />{t("settings.moduleOfflineTitle")}
      </div>
      <p className="mt-1 text-ui-body text-[var(--taomni-text-muted)]">{t("settings.moduleOfflineDescription")}</p>
      <form className="mt-3 space-y-2" onSubmit={(event) => {
        event.preventDefault();
        setPickerError(null);
        void state.install();
      }}>
        <label className="block text-ui-body" htmlFor="module-offline-archive">{t("settings.moduleOfflineArchive")}</label>
        <div className="flex gap-2">
          <input id="module-offline-archive" data-testid="module-offline-archive"
            className="taomni-input min-w-0 flex-1 text-ui-body" disabled={busy}
            value={state.archivePath} onChange={(event) => state.setArchivePath(event.target.value)} />
          <button type="button" className="taomni-btn px-2 text-ui-body" disabled={busy}
            data-testid="module-offline-choose" onClick={() => { void chooseArchive(); }}>
            {t("settings.moduleOfflineChoose")}
          </button>
        </div>
        <label className="block text-ui-body" htmlFor="module-offline-signature">{t("settings.moduleOfflineSignature")}</label>
        <textarea id="module-offline-signature" data-testid="module-offline-signature" rows={4}
          spellCheck={false} disabled={busy} value={state.detachedSignature}
          className="taomni-input w-full resize-y font-mono text-ui-small"
          onChange={(event) => state.setDetachedSignature(event.target.value)} />
        {(state.validationError || state.error || pickerError) && (
          <div data-testid="module-offline-error" role="alert" className="text-ui-body text-red-700 dark:text-red-300">
            {state.validationError ? t("settings.moduleOfflineRequired") : state.error || pickerError}
          </div>
        )}
        <div role="status" aria-live="polite" data-testid="module-offline-status" className="flex items-center gap-2 text-ui-body">
          {busy && <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("settings.moduleOfflineWorking")}</>}
          {state.phase === "completed" && <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            {t("settings.moduleOfflineCompleted", { name: state.installed?.manifest?.name ?? state.installed?.slug ?? "" })}</>}
          {state.phase === "failed" && t("settings.moduleOfflineFailed")}
        </div>
        {state.refreshError && <div data-testid="module-offline-refresh-error" role="alert"
          className="text-ui-body text-amber-700 dark:text-amber-300">
          {t("settings.moduleOfflineRefreshFailed")} {state.refreshError}
        </div>}
        <button type="submit" data-testid="module-offline-submit" disabled={busy} className="taomni-btn px-3 text-ui-body">
          {busy ? t("settings.moduleOfflineWorking") : t("settings.moduleOfflineInstall")}
        </button>
      </form>
    </section>
  );
}
