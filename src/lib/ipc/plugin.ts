import { invoke } from "@tauri-apps/api/core";
import type { PluginManifest, PluginRecord } from "../pluginRegistry";
import { signalPluginRegistryChanged } from "../pluginRegistryEvents";
import type { AppProxyConfig } from "./proxy";

export interface ModuleNetworkConfig {
  mode: "app" | "custom" | "none";
  custom: AppProxyConfig;
}

export function getModuleNetworkConfig(): Promise<ModuleNetworkConfig> {
  return invoke<ModuleNetworkConfig>("plugin_network_get", {});
}

export function saveModuleNetworkConfig(config: ModuleNetworkConfig): Promise<void> {
  return invoke<void>("plugin_network_save", { config });
}

export interface PluginInvokeRequest<T = unknown> extends Record<string, unknown> {
  slug: string;
  command: string;
  payload?: T;
  requestId?: string;
}

export interface PluginInvokeOptions {
  requestId?: string;
}

export type ModuleDownloadPhase = "connecting" | "downloading" | "verifying" | "completed" | "cancelled" | "failed";

export interface ModuleDownloadProgress {
  revision: number;
  downloaded: number;
  total?: number | null;
  phase: ModuleDownloadPhase;
  error?: string | null;
}

export interface ModuleDownloadInfo {
  id: string;
  completedPath: string;
  progress: ModuleDownloadProgress;
}

export interface ModuleDownloadListing {
  tasks: ModuleDownloadInfo[];
  recoveryErrors: string[];
}

export interface ModuleDownloadProxyEndpoint {
  kind: "http" | "socks5";
  host: string;
  port: number;
}

export interface ModuleDownloadOptions {
  id: string;
  url: string;
  partialPath: string;
  completedPath: string;
  expectedTotal?: number;
  expectedSha256?: string;
  proxyMode?: "app" | "custom" | "none";
  applicationProxy?: ModuleDownloadProxyEndpoint;
  featureProxy?: ModuleDownloadProxyEndpoint;
}

export interface ModuleCatalogAsset {
  url: string;
  signature: string;
  sha256: string;
  size: number;
}

export interface ModuleCatalogPlugin {
  id: string;
  slug: string;
  name: string;
  version: string;
  coreApiVersion: string;
  kind?: PluginManifest["kind"] | null;
  permissions?: PluginManifest["permissions"] | null;
  description?: string;
  platforms: Record<string, ModuleCatalogAsset>;
}

export interface ModuleCatalog {
  coreApiVersion: string;
  sequence: number;
  updatedAt: string;
  plugins: Record<string, ModuleCatalogPlugin>;
}

export interface ModuleCatalogSelection {
  pluginId: string;
  version: string;
  sha256: string;
}

export interface ModuleReleasePlan {
  legacyWaiting: boolean;
  legacyPending: string[];
  legacyRestartRequired?: string[];
  legacyImportFailed?: string[];
  updates: string[];
  newModules: string[];
}

export interface ModuleMarketplaceCatalog {
  catalog: ModuleCatalog;
  platform: string;
  release?: ModuleReleasePlan;
}

export interface ModuleInstallReview {
  manifest: PluginManifest;
  dataDirectory: string;
  downloadId: string;
}

/** Every source uses the native pinned signature and anti-rollback verifier. */
export function fetchMarketplaceCatalog(url?: string): Promise<ModuleMarketplaceCatalog> {
  return invoke("plugin_marketplace_catalog", { url });
}

export function downloadMarketplaceModule(selection: ModuleCatalogSelection, installedVersion?: string): Promise<ModuleDownloadInfo> {
  return invoke("plugin_marketplace_download", { selection, installedVersion });
}

export function reviewMarketplaceModule(selection: ModuleCatalogSelection): Promise<ModuleInstallReview> {
  return invoke("plugin_marketplace_review", { selection });
}

export async function installMarketplaceModule(selection: ModuleCatalogSelection, installedVersion?: string): Promise<PluginRecord> {
  return mutationResult(await invoke("plugin_marketplace_install", { selection, installedVersion }));
}

export async function provisionMarketplaceModule(
  selection: ModuleCatalogSelection,
  retry: boolean,
): Promise<void | "restart-required"> {
  const result = await invoke<unknown>("plugin_marketplace_provision", { selection, retry });
  if (result && typeof result === "object" && "restartRequired" in result && result.restartRequired === true) {
    return "restart-required";
  }
  if (result) mutationResult(result);
}

export function dismissNewMarketplaceModules(ids: readonly string[]): Promise<void> {
  return invoke("plugin_marketplace_dismiss_new", { ids });
}

export type LegacyMigrationItem =
  | "rdp-vnc-sessions"
  | "vnc-sessions"
  | "mail-accounts"
  | "rdp-certificate-pins"
  | "server-configs"
  | "rdp-server-configs"
  | "vnc-server-configs"
  | "mfa"
  | "socks-cap"
  | "mobile";

export interface LegacyMigrationCandidate {
  item: LegacyMigrationItem;
  evidence: string[];
  plugin_slug: string;
}

export interface LegacyVaultEvidence {
  path: string;
  fixed_key_present: boolean;
}

export interface LegacyInstallSnapshot {
  from_version: string;
  database_path: string | null;
  database_tables: string[];
  candidates: LegacyMigrationCandidate[];
  source_fingerprints: Record<string, string>;
  retained_paths: string[];
  vault: LegacyVaultEvidence | null;
}

export interface MigrationExecutionResult {
  status: "pending" | "staged" | "complete" | "failed" | "rolled-back";
  committed: LegacyMigrationItem[];
  skipped: LegacyMigrationItem[];
  pending: LegacyMigrationItem[];
  pending_reason?: string | null;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function normalizePluginRecord(value: unknown): PluginRecord {
  const record = value as PluginRecord & { state?: PluginRecord["lifecycle"] };
  const entry = record.manifest?.entry;
  // Native serde emits null for an absent Option<String>. Normalize only this
  // wire representation; module.json validation still rejects explicit nulls.
  let manifest = record.manifest;
  if (manifest && entry && typeof entry === "object" && !Array.isArray(entry)) {
    const { host, frontend, ...fields } = entry;
    manifest = {
      ...manifest,
      entry: { ...fields, ...(host == null ? {} : { host }), ...(frontend == null ? {} : { frontend }) },
    };
  }
  // Rust's serde model calls this field `state`; the renderer uses
  // `lifecycle` so it can distinguish an invalid manifest's disabled state
  // from a missing record. Accept both during the M0 wire-contract rollout.
  return {
    ...record,
    manifest,
    slug: record.slug ?? record.manifest?.slug ?? "unknown",
    lifecycle: record.lifecycle ?? record.state ?? "disabled",
  };
}

function mutationResult(value: unknown): PluginRecord {
  const record = normalizePluginRecord(value);
  signalPluginRegistryChanged(record.slug);
  return record;
}

export async function listPlugins(): Promise<PluginRecord[]> {
  const records = await invoke<unknown[]>("plugin_list", {});
  return records.map(normalizePluginRecord);
}

export async function setPluginEnabled(slug: string, enabled: boolean): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return mutationResult(await invoke<unknown>("plugin_set_enabled", { slug, enabled }));
}

/** Activate a verified package directory that the native download layer staged. */
export async function installStagedPlugin(slug: string, version: string, packageDir: string): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return mutationResult(await invoke<unknown>("plugin_install_staged", { slug, version, packageDir }));
}

/** Native verifies the signature, platform and complete archive contents. */
export async function installPluginArchive(
  archivePath: string,
  trust: { pluginId: string } | { detachedSignature: string },
): Promise<PluginRecord> {
  if (!archivePath) throw new Error("Invalid module archive path");
  return mutationResult(await invoke<unknown>("plugin_install_archive", { archivePath, ...trust }));
}

export function cancelPluginRequest(slug: string, requestId: string): Promise<boolean> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  if (!requestId) return Promise.reject(new Error("Invalid plugin request id"));
  return invoke<boolean>("plugin_cancel_request", { slug, requestId });
}

export async function rollbackPlugin(slug: string, version?: string): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return mutationResult(await invoke<unknown>("plugin_rollback", { slug, version }));
}

export async function uninstallPlugin(slug: string, deleteData = false): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return mutationResult(await invoke<unknown>("plugin_uninstall", { slug, deleteData }));
}

export async function refreshPlugins(): Promise<PluginRecord[]> {
  const records = await invoke<unknown[]>("plugin_refresh", {});
  signalPluginRegistryChanged();
  return records.map(normalizePluginRecord);
}

export function startPluginDownload(options: ModuleDownloadOptions): Promise<ModuleDownloadProgress> {
  if (!options.id || !options.url || !options.partialPath || !options.completedPath) {
    return Promise.reject(new Error("Invalid module download request"));
  }
  return invoke<ModuleDownloadProgress>("plugin_download_start", {
    id: options.id,
    url: options.url,
    partialPath: options.partialPath,
    completedPath: options.completedPath,
    expectedTotal: options.expectedTotal,
    expectedSha256: options.expectedSha256,
    proxyMode: options.proxyMode,
    applicationProxy: options.applicationProxy,
    featureProxy: options.featureProxy,
  });
}

export function getPluginDownloadStatus(id: string): Promise<ModuleDownloadProgress | null> {
  if (!id) return Promise.reject(new Error("Invalid module download id"));
  return invoke<ModuleDownloadProgress | null>("plugin_download_status", { id });
}

export function listPluginDownloads(): Promise<ModuleDownloadListing> {
  return invoke<ModuleDownloadListing>("plugin_download_list", {});
}

/** Recovery is passive; resuming explicitly resolves the selected proxy again. */
export function resumePluginDownload(
  id: string,
  options: Pick<ModuleDownloadOptions, "proxyMode" | "applicationProxy" | "featureProxy"> = {},
): Promise<ModuleDownloadProgress> {
  if (!id) return Promise.reject(new Error("Invalid module download id"));
  return invoke<ModuleDownloadProgress>("plugin_download_resume", {
    id,
    proxyMode: options.proxyMode,
    applicationProxy: options.applicationProxy,
    featureProxy: options.featureProxy,
  });
}

export function cancelPluginDownload(id: string): Promise<ModuleDownloadProgress> {
  if (!id) return Promise.reject(new Error("Invalid module download id"));
  return invoke<ModuleDownloadProgress>("plugin_download_cancel", { id });
}

export async function forgetPluginDownload(id: string): Promise<void> {
  if (!id) throw new Error("Invalid module download id");
  await invoke("plugin_download_forget", { id });
}

export function fetchModuleCatalog(
  url: string,
  options: Pick<ModuleDownloadOptions, "proxyMode" | "applicationProxy" | "featureProxy"> = {},
): Promise<ModuleCatalog> {
  if (!url) return Promise.reject(new Error("Invalid module catalog URL"));
  return invoke<ModuleCatalog>("plugin_catalog_fetch", {
    url,
    proxyMode: options.proxyMode,
    applicationProxy: options.applicationProxy,
    featureProxy: options.featureProxy,
  });
}

export function inspectLegacyInstall(fromVersion?: string): Promise<LegacyInstallSnapshot> {
  return invoke<LegacyInstallSnapshot>("plugin_migration_inspect", { fromVersion });
}

export function executePluginMigration(fromVersion?: string): Promise<MigrationExecutionResult> {
  return invoke<MigrationExecutionResult>("plugin_migration_execute", { fromVersion });
}

export function migrateMfaAndRestart(archive: string | undefined, signature: string | undefined, masterPassword: string): Promise<void> {
  return invoke<void>("plugin_mfa_migrate_and_restart", { archive, signature, masterPassword });
}

export function isMfaMigrationRequired(): Promise<boolean> {
  return invoke<boolean>("plugin_mfa_migration_required");
}

export function getMfaMigrationResult(): Promise<"complete" | "failed" | null> {
  return invoke<"complete" | "failed" | null>("plugin_mfa_migration_result");
}

/** Route a plugin command through the single core permission boundary. */
export function invokePlugin<TResult = unknown, TPayload = unknown>(
  slug: string,
  command: string,
  payload?: TPayload,
  options?: PluginInvokeOptions,
): Promise<TResult> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(command)) return Promise.reject(new Error("Invalid plugin command"));
  const request: PluginInvokeRequest<TPayload> = { slug, command };
  if (payload !== undefined) request.payload = payload;
  if (options?.requestId) request.requestId = options.requestId;
  return invoke<TResult>("plugin_invoke", request);
}

