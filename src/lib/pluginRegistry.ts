/**
 * Frontend side of the signed module registry.
 *
 * The native registry is the source of truth for installation and process
 * state.  This small, dependency free mirror deliberately only keeps the
 * information needed by the renderer: which tabs are available and whether
 * a module may be loaded.  Keeping validation here gives browser preview and
 * the desktop WebView the same failure behaviour.
 */

import { pluginDataErrors } from "./pluginDataContract";

export const PLUGIN_CORE_API_VERSION = "1";

export const PLUGIN_PERMISSION_NAMES = [
  "vault.ref",
  "vault.session-secret",
  "vault.fixed-key",
  "session.read",
  "network.egress",
  "fs.dataDir",
  "fs.readUserFile",
  "window.open",
  "capture.screen",
  "terminal.observe",
  "terminal.control",
  "chat.observe",
  "chat.control",
  "desktop.input",
  "backup.snapshot",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSION_NAMES)[number];
export type PluginKind = "remote-client" | "local-server" | "collaboration" | "media" | "auth" | "ai-local" | "mobile";
export type PluginStatus = "stable" | "provisional";
export type PluginLifecycle = "installed" | "enabled" | "disabled" | "uninstalled";
export type PluginPlatform = "windows-x86_64" | "darwin-aarch64" | "darwin-x86_64" | "linux-x86_64";

export interface PluginEntry {
  host?: string;
  frontend?: string;
  protocol: number;
}

export interface PluginTab {
  kind: string;
  title: string;
}

export interface DocumentTypes {
  fileKinds: string[];
  extensions: string[];
}

export function validDocumentTypes(input: unknown): input is DocumentTypes {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "fileKinds" && key !== "extensions")) return false;
  return [input.fileKinds, input.extensions].every((list) => Array.isArray(list)
    && list.length > 0 && list.length <= 64 && new Set(list).size === list.length
    && list.every((name) => typeof name === "string" && /^[a-z0-9]{1,24}$/.test(name)));
}

export interface PluginManifest {
  id: string;
  slug: string;
  name: string;
  description?: string;
  version: string;
  coreApiVersion: string;
  kind: PluginKind;
  document?: DocumentTypes;
  status: PluginStatus;
  removalCandidate?: boolean;
  platforms: PluginPlatform[];
  entry: PluginEntry;
  tabs: PluginTab[];
  commands: string[];
  permissions: PluginPermission[];
  dataDir: string;
  dataSchemaVersion?: number;
  backupPaths: string[];
  legacyTables: string[];
  vaultFixedKeys: string[];
  snapshot: "rpc" | "file";
}

export interface PluginManifestValidationOptions {
  coreApiVersion?: string;
  platform?: string;
}

export interface PluginManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
}

export interface PluginRecord {
  slug: string;
  manifest: PluginManifest | null;
  lifecycle: PluginLifecycle;
  /** A human readable reason is retained for the disabled/invalid view. */
  reason?: string;
  dataRetained?: boolean;
  previousVersion?: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KINDS = new Set<PluginKind>(["remote-client", "local-server", "collaboration", "media", "auth", "ai-local", "mobile"]);
const STATUSES = new Set<PluginStatus>(["stable", "provisional"]);
const PERMISSIONS = new Set<string>(PLUGIN_PERMISSION_NAMES);
const PLATFORMS = new Set<PluginPlatform>(["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.split("/").every((part) => part && part !== "." && part !== ".." && !/[%\\:\x00-\x1f\x7f?#]/.test(part));
}

const MANIFEST_FIELDS = new Set([
  "id", "slug", "name", "description", "version", "coreApiVersion", "kind", "status", "removalCandidate", "platforms",
  "entry", "tabs", "commands", "permissions", "dataDir", "dataSchemaVersion", "backupPaths", "legacyTables", "vaultFixedKeys", "snapshot", "document",
]);

function asStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Validate a module.json before it can enter the renderer registry. */
export function validatePluginManifest(
  input: unknown,
  options: PluginManifestValidationOptions = {},
): PluginManifestValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["manifest must be an object"] };
  for (const field of Object.keys(input)) if (!MANIFEST_FIELDS.has(field)) errors.push(`unknown field ${field}`);

  const slug = input.slug;
  const id = input.id;
  if (typeof slug !== "string" || !SLUG.test(slug)) errors.push("slug must contain lowercase letters, numbers, and hyphens");
  if (typeof id !== "string" || (typeof slug === "string" && id !== `taomni-plugin-${slug}`)) {
    errors.push("id must equal taomni-plugin-<slug>");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) errors.push("name is required");
  if (input.description !== undefined && typeof input.description !== "string") errors.push("description must be a string");
  if (typeof input.version !== "string" || !VERSION.test(input.version)) errors.push("version must be a semantic version");
  const coreApiVersion = typeof input.coreApiVersion === "string" ? input.coreApiVersion : "";
  if (!coreApiVersion) errors.push("coreApiVersion is required");
  if (options.coreApiVersion && coreApiVersion !== options.coreApiVersion) errors.push(`coreApiVersion ${coreApiVersion || "<missing>"} is incompatible`);
  if (typeof input.kind !== "string" || !KINDS.has(input.kind as PluginKind)) errors.push("kind is not supported");
  if (typeof input.status !== "string" || !STATUSES.has(input.status as PluginStatus)) errors.push("status is not supported");
  if (input.removalCandidate !== undefined && typeof input.removalCandidate !== "boolean") errors.push("removalCandidate must be boolean");

  const platforms = input.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((item) => typeof item !== "string" || !PLATFORMS.has(item as PluginPlatform))) {
    errors.push("platforms must be a non-empty string array");
  } else if (options.platform && !platforms.includes(options.platform)) {
    errors.push(`platform ${options.platform} is not supported`);
  }

  const entry = input.entry;
  if (input.document !== undefined && (!validDocumentTypes(input.document) || !isRecord(entry) || !entry.frontend)) {
    errors.push("document associations require a frontend and valid file kinds and extensions");
  }
  if (!isRecord(entry) || Object.keys(entry).some((key) => !["host", "frontend", "protocol"].includes(key))
    || (entry.host === undefined && entry.frontend === undefined)
    || (entry.host !== undefined && !isSafeRelativePath(entry.host))
    || (entry.frontend !== undefined && (!isSafeRelativePath(entry.frontend) || !entry.frontend.startsWith("frontend/")))
    || entry.protocol !== 1) {
    errors.push("entry must contain a safe host or frontend path and protocol 1");
  }
  if (!Array.isArray(input.tabs) || input.tabs.some((tab) => !isRecord(tab)
    || Object.keys(tab).some((key) => !["kind", "title"].includes(key))
    || typeof tab.kind !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tab.kind)
    || typeof tab.title !== "string" || !tab.title.trim() || tab.title.length > 256)
    || new Set(input.tabs.map((tab) => isRecord(tab) ? tab.kind : undefined)).size !== input.tabs.length) {
    errors.push("tabs must be an array of {kind,title}");
  }
  if (!asStringArray(input.commands)) errors.push("commands must be a string array");
  if (!asStringArray(input.permissions) || input.permissions.some((permission) => !PERMISSIONS.has(permission))) {
    errors.push("permissions contains an unsupported value");
  }
  if (input.dataDir !== `plugins/${slug}`) errors.push("dataDir must be plugins/<slug>");
  for (const field of ["backupPaths", "legacyTables", "vaultFixedKeys"] as const) {
    if (!asStringArray(input[field])) errors.push(`${field} must be a string array`);
  }
  errors.push(...pluginDataErrors(slug, input.dataSchemaVersion, input.backupPaths));
  if (input.snapshot !== "rpc" && input.snapshot !== "file") errors.push("snapshot must be rpc or file");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      id: id as string,
      slug: slug as string,
      name: input.name as string,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      version: input.version as string,
      coreApiVersion,
      kind: input.kind as PluginKind,
      ...(input.document === undefined ? {} : { document: input.document as DocumentTypes }),
      status: input.status as PluginStatus,
      ...(input.removalCandidate === undefined ? {} : { removalCandidate: input.removalCandidate as boolean }),
      platforms: platforms as PluginPlatform[],
      entry: entry as unknown as PluginEntry,
      tabs: input.tabs as PluginTab[],
      commands: input.commands as string[],
      permissions: input.permissions as PluginPermission[],
      dataDir: input.dataDir as string,
      dataSchemaVersion: input.dataSchemaVersion === undefined ? 1 : input.dataSchemaVersion as number,
      backupPaths: input.backupPaths as string[],
      legacyTables: input.legacyTables as string[],
      vaultFixedKeys: input.vaultFixedKeys as string[],
      snapshot: input.snapshot as "rpc" | "file",
    },
  };
}

/** In-memory registry used by the main WebView and detached plugin windows. */
export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();

  public constructor(private readonly options: PluginManifestValidationOptions = { coreApiVersion: PLUGIN_CORE_API_VERSION }) {}

  public register(input: unknown): PluginRecord {
    const candidate = isRecord(input) && typeof input.slug === "string" ? input.slug : "unknown";
    const validation = validatePluginManifest(input, this.options);
    const record: PluginRecord = validation.ok
      ? { slug: validation.manifest!.slug, manifest: validation.manifest!, lifecycle: "installed" }
      : { slug: candidate, manifest: null, lifecycle: "disabled", reason: validation.errors.join("; ") };
    this.records.set(record.slug, record);
    return record;
  }

  public unregister(slug: string): void {
    this.records.delete(slug);
  }

  public get(slug: string): PluginRecord | undefined {
    return this.records.get(slug);
  }

  public list(): PluginRecord[] {
    return [...this.records.values()];
  }

  public setEnabled(slug: string, enabled: boolean): PluginRecord {
    const record = this.records.get(slug);
    if (!record || !record.manifest) throw new Error(`Plugin ${slug} is unavailable`);
    record.lifecycle = enabled ? "enabled" : "disabled";
    record.reason = undefined;
    return record;
  }

  public isEnabled(slug: string): boolean {
    return this.records.get(slug)?.lifecycle === "enabled";
  }

  public resolveTab(kind: string): { plugin: PluginRecord; tab: PluginTab } | undefined {
    for (const plugin of this.records.values()) {
      const tab = plugin.manifest?.tabs.find((candidate) => candidate.kind === kind);
      if (tab && plugin.lifecycle === "enabled") return { plugin, tab };
    }
    return undefined;
  }
}

