import { CheckCircle2, Download, Loader2, Package, RotateCcw, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import type { LegacyInstallSnapshot, MigrationExecutionResult } from "../../lib/ipc";
import { type ModuleRecord, type ModuleTransition } from "../../lib/moduleStore";
import { useModuleStore } from "../../stores/moduleStore";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";
import { ModuleTabActions } from "../plugins/ModuleTabActions";
import { ModuleMfaUpgrade } from "./ModuleMfaUpgrade";
import { ModuleSocksCapRecovery } from "./ModuleSocksCapRecovery";

/**
 * The settings surface deliberately owns no catalog or native IPC concerns.
 * The eventual SettingsPanelView integration should provide a manifest-backed
 * catalog, hydrate `useModuleStore` from the native registry, and inject all
 * lifecycle callbacks. Keeping those inputs explicit avoids hard-coded IPC;
 * browser harnesses may omit callbacks to exercise the local projection,
 * while the production host should inject native operations for real actions.
 */
export interface ModuleStoreCatalogEntry {
  slug: string;
  name: string;
  description: string;
  version: string;
  coreApiVersion: string;
  sizeBytes?: number;
  permissions?: string[];
}

export interface ModuleStorePanelProps {
  /** Manifest entries fetched from the signed modules.json catalog. */
  catalog?: readonly ModuleStoreCatalogEntry[];
  /** Core API negotiated by the native host; used to gate incompatible modules. */
  coreApiVersion?: string;
  /** Native registry/catalog loading state. */
  catalogLoading?: boolean;
  /** A catalog refresh error is kept separate from lifecycle action errors. */
  catalogError?: string | null;
  /** Native installer/supervisor operations; each runs before the local projection advances. */
  onInstall?: (entry: ModuleStoreCatalogEntry) => Promise<void> | void;
  onEnable?: (entry: ModuleStoreCatalogEntry) => Promise<void> | void;
  onDisable?: (entry: ModuleStoreCatalogEntry) => Promise<void> | void;
  onUninstall?: (entry: ModuleStoreCatalogEntry, deleteData: boolean) => Promise<void> | void;
  onRollback?: (entry: ModuleStoreCatalogEntry, version: string) => Promise<ModuleRecord | void> | void;
  /** Legacy 0.5.x preflight shown before any migration writes occur. */
  migrationSnapshot?: LegacyInstallSnapshot | null;
  migrationLoading?: boolean;
  migrationError?: string | null;
  migrationResult?: MigrationExecutionResult | null;
  onMigrationExecute?: () => Promise<void> | void;
}

const DEFAULT_CORE_API_VERSION = "1";

function formatSize(bytes: number | undefined, unknownLabel: string): string {
  if (!Number.isFinite(bytes) || bytes === undefined || bytes < 0) return unknownLabel;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function statusClass(record: ModuleRecord | undefined): string {
  switch (record?.lifecycle) {
    case"enabled": return"border-ui-success-border bg-ui-success-surface text-ui-success";
    case"disabled": return"border-ui-warning-border bg-ui-warning-surface text-ui-warning";
    case"rollback": return"border-ui-info-border bg-ui-info-surface text-ui-info";
    case "uninstalled": return "border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[var(--taomni-text-muted)]";
    default: return "border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[var(--taomni-text-muted)]";
  }
}

function statusIcon(record: ModuleRecord | undefined) {
  if (record?.lifecycle === "enabled") return <ToggleRight className="h-3.5 w-3.5" />;
  if (record?.lifecycle === "disabled") return <ToggleLeft className="h-3.5 w-3.5" />;
  if (record?.lifecycle === "rollback") return <RotateCcw className="h-3.5 w-3.5" />;
  return <Package className="h-3.5 w-3.5" />;
}

function lifecycleLabel(record: ModuleRecord | undefined, t: ReturnType<typeof useT>): string {
  switch (record?.lifecycle) {
    case "enabled": return t("settings.moduleStoreStatusEnabled");
    case "disabled": return t("settings.moduleStoreStatusDisabled");
    case "rollback": return t("settings.moduleStoreStatusRollingBack");
    case "uninstalled": return t("settings.moduleStoreStatusUninstalled");
    case "installed": return t("settings.moduleStoreStatusInstalled");
    default: return t("settings.moduleStoreStatusAvailable");
  }
}

export function ModuleStorePanel({
  catalog = [],
  coreApiVersion = DEFAULT_CORE_API_VERSION,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRollback,
  catalogLoading = false,
  catalogError = null,
  migrationSnapshot = null,
  migrationLoading = false,
  migrationError = null,
  migrationResult = null,
  onMigrationExecute,
}: ModuleStorePanelProps) {
  const t = useT();
  const records = useModuleStore((state) => state.records);
  const apply = useModuleStore((state) => state.apply);
  const updateRecord = useModuleStore((state) => state.update);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteData, setDeleteData] = useState<Record<string, boolean>>({});
  const [pendingUninstall, setPendingUninstall] = useState<{ entry: ModuleStoreCatalogEntry; removeData: boolean } | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);

  const entries = useMemo(() => [...catalog].sort((left, right) => left.name.localeCompare(right.name)), [catalog]);
  const migrationModules = [...new Set(migrationSnapshot?.candidates.map((candidate) => candidate.plugin_slug))];

  const run = async (
    entry: ModuleStoreCatalogEntry,
    action: string,
    callback: (() => Promise<void> | void) | undefined,
    transition: ModuleTransition,
  ) => {
    const key = `${entry.slug}:${action}`;
    setBusy(key);
    setError(null);
    try {
      await callback?.();
      apply(entry.slug, transition);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      if (records[entry.slug]) apply(entry.slug, { type: "fail", error: message });
    } finally {
      setBusy(null);
    }
  };

  const install = (entry: ModuleStoreCatalogEntry) => run(entry, "install", onInstall ? () => onInstall(entry) : undefined, { type: "install", version: entry.version });
  const enable = (entry: ModuleStoreCatalogEntry) => run(entry, "enable", onEnable ? () => onEnable(entry) : undefined, { type: "enable" });
  const disable = (entry: ModuleStoreCatalogEntry) => run(entry, "disable", onDisable ? () => onDisable(entry) : undefined, { type: "disable" });
  const performUninstall = (entry: ModuleStoreCatalogEntry, removeData: boolean) =>
    run(entry, "uninstall", onUninstall ? () => onUninstall(entry, removeData) : undefined, { type: "uninstall", deleteData: removeData });
  const uninstall = (entry: ModuleStoreCatalogEntry) => setPendingUninstall({ entry, removeData: deleteData[entry.slug] === true });
  const rollback = (entry: ModuleStoreCatalogEntry, record: ModuleRecord) => {
    const version = record.previousVersion;
    if (!version) return;
    setBusy(`${entry.slug}:rollback`);
    setError(null);
    void (async () => {
      try {
        const updated = await onRollback?.(entry, version);
        if (updated) {
          updateRecord(updated);
        } else {
          apply(entry.slug, { type: "begin-rollback" });
          apply(entry.slug, { type: "complete-rollback", version });
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        apply(entry.slug, { type: "fail", error: message });
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <section data-testid="module-store-panel" className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <Package className="mt-0.5 h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-title font-semibold">{t("settings.moduleStoreTitle")}</div>
          <div className="text-ui-body text-[var(--taomni-text-muted)]">{t("settings.moduleStoreSubtitle")}</div>
        </div>
        <span data-testid="module-store-core-api" className="text-ui-small text-[var(--taomni-text-muted)]">
          {t("settings.moduleStoreCoreApi", { version: coreApiVersion })}
        </span>
      </div>
      <ModuleMfaUpgrade
        eligible={migrationSnapshot?.candidates.some((item) => item.item === "mfa" && item.evidence.includes("mfa.db")) === true}
        installed={!!records.mfa?.activeVersion}
      />
      <ModuleSocksCapRecovery />
      {migrationSnapshot && (
        <div
          data-testid="module-upgrade-status"
          data-state={migrationSnapshot.candidates.length > 0 ? "candidates" : "empty"}
          className="mb-3 rounded border border-ui-info-border bg-ui-info-surface p-3"
        >
          <div className="text-ui-body font-semibold">{t("settings.moduleUpgradeTitle")}</div>
          <div className="mt-1 text-ui-body text-[var(--taomni-text-muted)]">
            {t("settings.moduleUpgradeSubtitle", { version: migrationSnapshot.from_version })}
          </div>
          {migrationSnapshot.candidates.length > 0 ? (
            <ul data-testid="module-upgrade-candidates" className="mt-2 list-disc pl-5 text-ui-body">
              {migrationModules.map((slug) => (
                <li key={slug}>{slug}</li>
              ))}
            </ul>
          ) : (
            <div data-testid="module-upgrade-empty" className="mt-2 text-ui-body text-[var(--taomni-text-muted)]">
              {t("settings.moduleUpgradeNone")}
            </div>
          )}
          {migrationSnapshot.retained_paths.length > 0 && (
            <div data-testid="module-upgrade-retained" className="mt-2 text-ui-small text-[var(--taomni-text-muted)]">
              {t("settings.moduleUpgradeRetained", { count: migrationSnapshot.retained_paths.length })}
            </div>
          )}
          {migrationModules.includes("mfa") && (
            <p data-testid="module-upgrade-mfa-hint" className="mt-2 text-ui-small text-[var(--taomni-text-muted)]">
              {t("settings.moduleUpgradeMfaHint")}
            </p>
          )}
          {migrationModules.includes("mail") && (
            <p data-testid="module-upgrade-mail-hint" className="mt-2 text-ui-small text-[var(--taomni-text-muted)]">
              {t("settings.moduleUpgradeMailHint")}
            </p>
          )}
          {migrationResult?.pending.length ? (
            <div data-testid="module-upgrade-pending" className="mt-2 rounded border border-ui-warning-border bg-ui-warning-surface p-2 text-ui-body text-ui-warning">
              {migrationResult.pending_reason || t("settings.moduleUpgradePending")}
            </div>
          ) : null}
          {migrationError && <div role="alert" data-testid="module-upgrade-error" className="mt-2 text-ui-body text-ui-danger">{migrationError}</div>}
          {migrationSnapshot.candidates.length > 0 && (
            <button
              type="button"
              data-testid="module-upgrade-migrate"
              className="taomni-btn mt-3 h-7 px-2.5 text-ui-small"
              disabled={migrationLoading || migrationBusy || !onMigrationExecute}
              onClick={() => {
                if (!onMigrationExecute) return;
                setMigrationBusy(true);
                void Promise.resolve(onMigrationExecute())
                  .catch(() => undefined)
                  .finally(() => setMigrationBusy(false));
              }}
            >
              {migrationLoading || migrationBusy ? t("settings.moduleUpgradeWorking") : t("settings.moduleUpgradeMigrate")}
            </button>
          )}
        </div>
      )}
      {migrationError && !migrationSnapshot && (
        <div data-testid="module-upgrade-status" data-state="error" className="mb-3 rounded border border-ui-danger-border bg-ui-danger-surface p-3">
          <div className="text-ui-body font-semibold">{t("settings.moduleUpgradeTitle")}</div>
          <div role="alert" data-testid="module-upgrade-error" className="mt-1 text-ui-body text-ui-danger">{migrationError}</div>
        </div>
      )}
      {catalogError && <div role="alert" data-testid="module-store-catalog-error" className="mb-3 rounded border border-ui-danger-border bg-ui-danger-surface p-2 text-ui-body text-ui-danger">{catalogError}</div>}
      {error && <div role="alert" data-testid="module-store-error" className="mb-3 rounded border border-ui-danger-border bg-ui-danger-surface p-2 text-ui-body text-ui-danger">{error}</div>}
      {catalogLoading ? (
        <div data-testid="module-store-loading" className="rounded border border-dashed border-[var(--taomni-divider)] p-4 text-ui-body text-[var(--taomni-text-muted)]">{t("settings.moduleStoreLoading")}</div>
      ) : entries.length === 0 ? (
        <div data-testid="module-store-empty" className="rounded border border-dashed border-[var(--taomni-divider)] p-4 text-ui-body text-[var(--taomni-text-muted)]">{t("settings.moduleStoreEmpty")}</div>
      ) : (
        <div data-testid="module-store-list" className="space-y-2">
          {entries.map((entry) => {
            const record = records[entry.slug];
            const compatible = entry.coreApiVersion === coreApiVersion;
            const isBusy = busy?.startsWith(`${entry.slug}:`) === true;
            return (
              <article key={entry.slug} data-testid={`module-card-${entry.slug}`} className="rounded border border-[var(--taomni-divider)] p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-ui-body font-semibold">
                      <span>{entry.name}</span>
                      {compatible && <CheckCircle2 className="h-3.5 w-3.5 text-ui-success" aria-label={t("settings.moduleStoreCompatible")} />}
                    </div>
                    <p className="mt-1 text-ui-body text-[var(--taomni-text-muted)]">{entry.description}</p>
                  </div>
                  <span data-testid={`module-status-${entry.slug}`} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-ui-small ${statusClass(record)}`}>
                    {statusIcon(record)} {lifecycleLabel(record, t)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-ui-small text-[var(--taomni-text-muted)]">
                  <span data-testid={`module-version-${entry.slug}`}>{t("settings.moduleStoreVersion", { version: entry.version })}</span>
                  <span>{formatSize(entry.sizeBytes, t("settings.moduleStoreSizeUnknown"))}</span>
                  <span className={compatible ? "" : "text-ui-warning"}>{compatible ? t("settings.moduleStoreCompatible") : t("settings.moduleStoreIncompatible")}</span>
                  {record?.dataRetained && record.lifecycle === "uninstalled" && <span data-testid={`module-data-retained-${entry.slug}`}>{t("settings.moduleStoreDataRetained")}</span>}
                </div>
                {entry.permissions && entry.permissions.length > 0 && <div data-testid={`module-permissions-${entry.slug}`} className="mt-2 text-ui-small text-[var(--taomni-text-muted)]">{t("settings.moduleStorePermissions", { permissions: entry.permissions.join(", ") })}</div>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <ModuleTabActions slug={entry.slug} disabled={isBusy} />
                  {!record || record.lifecycle === "uninstalled" ? (
                    <button type="button" data-testid={`module-action-install-${entry.slug}`} className="taomni-btn inline-flex h-7 items-center gap-1 px-2.5 text-ui-small" disabled={!compatible || isBusy} onClick={() => void install(entry)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {t("settings.moduleStoreInstall")}
                    </button>
                  ) : record.lifecycle === "enabled" ? (
                    <button type="button" data-testid={`module-action-disable-${entry.slug}`} className="taomni-btn h-7 px-2.5 text-ui-small" disabled={isBusy} onClick={() => void disable(entry)}>{t("settings.moduleStoreDisable")}</button>
                  ) : record.lifecycle !== "rollback" && (
                    <button type="button" data-testid={`module-action-enable-${entry.slug}`} className="taomni-btn h-7 px-2.5 text-ui-small" disabled={!compatible || isBusy} onClick={() => void enable(entry)}>{t("settings.moduleStoreEnable")}</button>
                  )}
                  {record && record.lifecycle !== "uninstalled" && record.lifecycle !== "rollback" && <>
                    <button type="button" data-testid={`module-action-uninstall-${entry.slug}`} className="taomni-btn inline-flex h-7 items-center gap-1 px-2.5 text-ui-small" disabled={isBusy} onClick={() => void uninstall(entry)}><Trash2 className="h-3.5 w-3.5" /> {t("settings.moduleStoreUninstall")}</button>
                    <label className="inline-flex items-center gap-1 text-ui-small text-[var(--taomni-text-muted)]"><input type="checkbox" data-testid={`module-delete-data-${entry.slug}`} checked={deleteData[entry.slug] === true} onChange={(event) => setDeleteData((current) => ({ ...current, [entry.slug]: event.target.checked }))} /> {t("settings.moduleStoreDeleteData")}</label>
                  </>}
                  {record?.previousVersion && record.lifecycle !== "uninstalled" && <button type="button" data-testid={`module-action-rollback-${entry.slug}`} className="taomni-btn inline-flex h-7 items-center gap-1 px-2.5 text-ui-small" disabled={isBusy || !compatible} onClick={() => rollback(entry, record)}><RotateCcw className="h-3.5 w-3.5" /> {t("settings.moduleStoreRollback", { version: record.previousVersion })}</button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {pendingUninstall && <ConfirmDialog
        title={t("settings.moduleStoreUninstall")}
        message={t(pendingUninstall.removeData ? "settings.moduleStoreUninstallDeleteConfirm" : "settings.moduleStoreUninstallConfirm", { name: pendingUninstall.entry.name })}
        confirmLabel={t("settings.moduleStoreUninstall")}
        danger={pendingUninstall.removeData}
        onCancel={() => setPendingUninstall(null)}
        onConfirm={() => {
          const { entry, removeData } = pendingUninstall;
          setPendingUninstall(null);
          if (removeData) setDeleteData((current) => ({ ...current, [entry.slug]: false }));
          void performUninstall(entry, removeData);
        }}
      />}
    </section>
  );
}

