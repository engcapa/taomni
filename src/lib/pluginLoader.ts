import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { PluginManifest, PluginRegistry } from "./pluginRegistry";

export class PluginLoadError extends Error {
  public constructor(message: string, public readonly slug: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginLoadError";
  }
}

export interface PluginFrontendModule {
  default?: ComponentType<Record<string, unknown>>;
  component?: ComponentType<Record<string, unknown>>;
  [key: string]: unknown;
}

export type PluginImporter = (url: string) => Promise<PluginFrontendModule>;

export function pluginFrontendUrl(manifest: PluginManifest): string {
  if (!manifest.entry.frontend) throw new PluginLoadError(`Plugin ${manifest.slug} has no frontend entry`, manifest.slug);
  // Encode each segment separately: a slug or entry path can never escape its
  // module directory, and the custom scheme is handled by the native protocol.
  const path = manifest.entry.frontend.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `taomni-plugin://${encodeURIComponent(manifest.slug)}/${path}`;
}

const defaultImporter: PluginImporter = (url) => import(/* @vite-ignore */ url) as Promise<PluginFrontendModule>;

export async function loadPluginFrontend(
  manifest: PluginManifest,
  importer: PluginImporter = defaultImporter,
): Promise<PluginFrontendModule> {
  try {
    const module = await importer(pluginFrontendUrl(manifest));
    if (!module || (typeof module.default !== "function" && typeof module.component !== "function")) {
      throw new Error("frontend module has no component export");
    }
    return module;
  } catch (error) {
    if (error instanceof PluginLoadError) throw error;
    throw new PluginLoadError(`Unable to load plugin ${manifest.slug}: ${error instanceof Error ? error.message : String(error)}`, manifest.slug, { cause: error });
  }
}

export function createPluginLazyComponent(
  registry: PluginRegistry,
  slug: string,
  importer: PluginImporter = defaultImporter,
): LazyExoticComponent<ComponentType<Record<string, unknown>>> {
  return lazy(async () => {
    const record = registry.get(slug);
    if (!record?.manifest || record.lifecycle !== "enabled") {
      throw new PluginLoadError(`Plugin ${slug} is not installed or enabled`, slug);
    }
    const module = await loadPluginFrontend(record.manifest, importer);
    return { default: (module.default ?? module.component)! };
  });
}

/** Compare a downloaded chunk's SHA-256 against the signed manifest entry. */
export async function verifyPluginSha256(data: ArrayBuffer | Uint8Array | string, expectedHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required to verify plugin content");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return actual === expectedHex.toLowerCase();
}

