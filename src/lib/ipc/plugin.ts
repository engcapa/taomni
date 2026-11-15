import { invoke } from "@tauri-apps/api/core";
import type { PluginRecord } from "../pluginRegistry";

export interface PluginInvokeRequest<T = unknown> extends Record<string, unknown> {
  slug: string;
  command: string;
  payload?: T;
  requestId?: string;
}

export interface PluginInvokeOptions {
  requestId?: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function normalizePluginRecord(value: unknown): PluginRecord {
  const record = value as PluginRecord & { state?: PluginRecord["lifecycle"] };
  // Rust's serde model calls this field `state`; the renderer uses
  // `lifecycle` so it can distinguish an invalid manifest's disabled state
  // from a missing record. Accept both during the M0 wire-contract rollout.
  return { ...record, lifecycle: record.lifecycle ?? record.state ?? "disabled" };
}

export async function listPlugins(): Promise<PluginRecord[]> {
  const records = await invoke<unknown[]>("plugin_list", {});
  return records.map(normalizePluginRecord);
}

export async function setPluginEnabled(slug: string, enabled: boolean): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return normalizePluginRecord(await invoke<unknown>("plugin_set_enabled", { slug, enabled }));
}

/** Activate a verified package directory that the native download layer staged. */
export async function installStagedPlugin(slug: string, version: string, packageDir: string): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return normalizePluginRecord(await invoke<unknown>("plugin_install_staged", { slug, version, packageDir }));
}

export async function rollbackPlugin(slug: string): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return normalizePluginRecord(await invoke<unknown>("plugin_rollback", { slug }));
}

export async function uninstallPlugin(slug: string, deleteData = false): Promise<PluginRecord> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  return normalizePluginRecord(await invoke<unknown>("plugin_uninstall", { slug, deleteData }));
}

export async function refreshPlugins(): Promise<PluginRecord[]> {
  const records = await invoke<unknown[]>("plugin_refresh", {});
  return records.map(normalizePluginRecord);
}

/** Route a plugin command through the single core permission boundary. */
export function invokePlugin<TResult = unknown, TPayload = unknown>(
  slug: string,
  command: string,
  payload?: TPayload,
  options?: PluginInvokeOptions,
): Promise<TResult> {
  if (!SLUG.test(slug)) return Promise.reject(new Error(`Invalid plugin slug: ${slug}`));
  if (!command || command.includes("\0") || command.includes("/")) return Promise.reject(new Error("Invalid plugin command"));
  const request: PluginInvokeRequest<TPayload> = { slug, command };
  if (payload !== undefined) request.payload = payload;
  if (options?.requestId) request.requestId = options.requestId;
  return invoke<TResult>("plugin_invoke", request);
}

