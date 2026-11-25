import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import type { ModuleCatalogPlugin, ModuleCatalogSelection } from "../../lib/ipc/plugin";
import { PLUGIN_CORE_API_VERSION } from "../../lib/pluginRegistry";
import { useModuleDownloadStore } from "../../stores/moduleDownloadStore";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { useModuleStore } from "../../stores/moduleStore";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";

export function ModuleMarketplace() {
  const t = useT();
  const state = useModuleMarketplaceStore();
  const records = useModuleStore((owner) => owner.records);
  const downloads = useModuleDownloadStore((owner) => owner.tasks);
  const refreshDownloads = useModuleDownloadStore((owner) => owner.refresh);
  const [source, setSource] = useState(state.source);
  const [query, setQuery] = useState("");
  const [download, setDownload] = useState<{
    entry: ModuleCatalogPlugin; selection: ModuleCatalogSelection; size: number; installedVersion?: string;
  } | null>(null);
  useEffect(() => { void state.refresh(); }, [state.refresh]);

  const entries = useMemo(() => Object.values(state.catalog?.catalog.plugins ?? {})
    .filter((entry) => `${entry.name} ${entry.description ?? ""} ${entry.slug}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (a.kind ?? "").localeCompare(b.kind ?? "") || a.name.localeCompare(b.name)), [state.catalog, query]);

  const selection = (entry: ModuleCatalogPlugin): ModuleCatalogSelection => ({
    pluginId: entry.id, version: entry.version,
    sha256: entry.platforms[state.catalog!.platform].sha256,
  });
  const permissionLabels = (permissions: readonly string[] | null | undefined) => permissions
    ? permissions.length ? permissions.map((permission) => t(`plugins.permission.${permission}`)).join("\n") : t("plugins.marketNoPermissions")
    : t("plugins.marketPermissionsAfterDownload");
  const displaySize = (size?: number) => size == null ? "—" : `${(size / 1024 / 1024).toFixed(2)} MiB`;

  const review = state.review;
  return <section data-testid="module-marketplace" className="mb-5 rounded-md border border-[var(--taomni-divider)] p-3">
    <h3 className="text-ui-title font-semibold">{t("plugins.marketTitle")}</h3>
    <p className="my-2 text-ui-body text-[var(--taomni-text-muted)]">{t("plugins.marketHint")}</p>
    <div className="flex gap-2">
      <input data-testid="module-marketplace-search" aria-label={t("plugins.marketSearch")} value={query}
        onChange={(event) => setQuery(event.target.value)} className="taomni-input min-w-0 flex-1 text-ui-body" />
      <button type="button" data-testid="module-marketplace-refresh" className="taomni-btn text-ui-body" disabled={state.loading}
        onClick={() => { void state.refresh(source); }}>{t("plugins.marketRefresh")}</button>
    </div>
    <details className="mt-2 text-ui-body">
      <summary data-testid="module-marketplace-source-toggle" className="cursor-pointer">{t("plugins.marketSource")}</summary>
      <p className="my-2 text-[var(--taomni-text-muted)]">{t("plugins.marketSourceHint")}</p>
      <input data-testid="module-marketplace-source" aria-label={t("plugins.marketSource")} value={source}
        onChange={(event) => setSource(event.target.value)} className="taomni-input w-full text-ui-body" />
    </details>
    {state.loading && <p data-testid="module-marketplace-loading" className="my-2 text-ui-body">{t("plugins.marketLoading")}</p>}
    {state.error && <p data-testid="module-marketplace-error" role="alert" className="my-2 text-ui-body text-red-500">{state.error}</p>}
    {state.catalog && <p data-testid="module-marketplace-checked" className="my-2 text-ui-small text-[var(--taomni-text-muted)]">
      {t("plugins.marketChecked", { date: state.catalog.catalog.updatedAt })}
      {state.catalogSource && <span className="block break-all">{t("plugins.marketCatalogSource", { source: state.catalogSource })}</span>}
    </p>}
    {state.catalog && !entries.length && <p data-testid="module-marketplace-empty" className="my-2 text-ui-body">{t("plugins.marketEmpty")}</p>}
    <div className="mt-3 space-y-3">
      {entries.map((entry) => {
        const asset = entry.platforms[state.catalog!.platform];
        const id = asset ? `module-${entry.slug}-${asset.sha256.toLowerCase()}` : null;
        const task = downloads.find((task) => task.id === id);
        const active = task && ["connecting", "downloading", "verifying"].includes(task.progress.phase);
        const installedVersion = records[entry.slug]?.activeVersion;
        const release = state.catalog?.release;
        const update = !!installedVersion && installedVersion !== entry.version && release?.updates.includes(entry.id);
        const legacyPending = release?.legacyPending.includes(entry.id);
        const isNew = !installedVersion && release?.newModules.includes(entry.id);
        const compatible = entry.coreApiVersion === PLUGIN_CORE_API_VERSION;
        const busy = state.busy[entry.id];
        return <article key={entry.id} data-testid="module-marketplace-card" data-module-id={entry.id}
          className="rounded border border-[var(--taomni-divider)] p-3 text-ui-body">
          <div className="flex flex-wrap justify-between gap-2 font-medium"><span>{entry.name}</span>
            <span>{entry.version} · {displaySize(asset?.size)}</span></div>
          <p className="mt-1 text-[var(--taomni-text-muted)]">{t(`plugins.category.${entry.kind ?? "other"}`)}</p>
          {entry.description && <p className="my-1">{entry.description}</p>}
          {installedVersion && <p data-testid="module-marketplace-installed">
            {t("plugins.marketInstalled", { version: installedVersion })}
          </p>}
          {update && <p data-testid="module-marketplace-update">{t("plugins.marketUpdateAvailable", { version: entry.version })}</p>}
          {isNew && <p data-testid="module-marketplace-new">{t("plugins.marketNew")}</p>}
          {(!asset || !compatible) && <p data-testid="module-marketplace-unavailable">{t("plugins.marketUnavailable")}</p>}
          {task && <p data-testid="module-marketplace-task">{t(`plugins.downloadPhase${task.progress.phase}`)}</p>}
          {legacyPending && release?.legacyRestartRequired?.includes(entry.id)
            && <p>{t("plugins.marketMailRestartRequired")}</p>}
          {legacyPending && release?.legacyImportFailed?.includes(entry.id)
            && <p role="alert" data-testid="module-marketplace-mail-import-failed">{t("plugins.marketMailImportFailed")}</p>}
          {state.errors[entry.id] && <p data-testid="module-marketplace-action-error" role="alert" className="my-2 text-red-500">{state.errors[entry.id]}</p>}
          <div className="mt-2 flex gap-2">
            {legacyPending && !installedVersion ? <button type="button" data-testid="module-marketplace-provision" className="taomni-btn"
              disabled={!!busy || !asset || !compatible} onClick={() => { void state.provision(entry.id, true); }}>
              {busy ? t("plugins.marketWorking") : t("plugins.marketLegacyResume")}
            </button> : installedVersion && !update ? (
              installedVersion === entry.version ? <span data-testid="module-marketplace-current">{t("plugins.marketCurrent")}</span> : null
            ) : task?.progress.phase === "completed" ? <button type="button" data-testid="module-marketplace-review" className="taomni-btn"
              disabled={!!busy || !compatible || !asset} onClick={() => { void state.openReview(selection(entry), installedVersion); }}>
              {busy ? t("plugins.marketWorking") : t(update ? "plugins.marketReviewUpdate" : "plugins.marketReview")}
            </button> : <button type="button" data-testid="module-marketplace-download" className="taomni-btn"
              disabled={!!busy || !asset || !compatible || !!active}
              onClick={() => setDownload({ entry, selection: selection(entry), size: asset.size, installedVersion })}>
              {busy ? t("plugins.marketWorking") : active ? t("plugins.downloadPhasedownloading") : t(update ? "plugins.marketDownloadUpdate" : "plugins.marketDownload")}
            </button>}
          </div>
        </article>;
      })}
    </div>
    {download && <ConfirmDialog title={t(download.installedVersion ? "plugins.marketDownloadUpdateTitle" : "plugins.marketDownloadTitle")}
      confirmLabel={t(download.installedVersion ? "plugins.marketDownloadUpdate" : "plugins.marketDownload")}
      message={[`${download.entry.name} ${download.entry.version}`, displaySize(download.size),
        permissionLabels(download.entry.permissions), `plugins/${download.entry.slug}/data/`, t("plugins.marketAuthorization")].join("\n\n")}
      onCancel={() => setDownload(null)} onConfirm={() => {
        const { selection: requested, installedVersion } = download;
        setDownload(null);
        void state.download(requested, installedVersion).then(() => refreshDownloads());
      }} />}
    {review && <ConfirmDialog title={t(review.installedVersion ? "plugins.marketUpdateTitle" : "plugins.marketInstallTitle")}
      confirmLabel={t(review.installedVersion ? "plugins.marketUpdate" : "plugins.marketInstall")}
      message={[`${review.detail.manifest.name} ${review.detail.manifest.version}`, permissionLabels(review.detail.manifest.permissions),
        review.detail.dataDirectory, t("plugins.marketAuthorization")].join("\n\n")}
      onCancel={state.dismissReview} onConfirm={() => { void state.install(); state.dismissReview(); }} />}
  </section>;
}
