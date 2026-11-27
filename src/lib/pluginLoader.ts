import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PluginManifest, PluginRegistry } from "./pluginRegistry";
import { isTauriRuntime } from "./runtime";
import type { PluginFrontendProps } from "./pluginFrontendHost";

export class PluginLoadError extends Error {
  public constructor(message: string, public readonly slug: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginLoadError";
  }
}

export interface PluginFrontendModule<Props = PluginFrontendProps> {
  default?: ComponentType<Props>;
  component?: ComponentType<Props>;
  [key: string]: unknown;
}

export type PluginImporter<Props = PluginFrontendProps> = (url: string) => Promise<PluginFrontendModule<Props>>;

export function pluginFrontendUrl(manifest: PluginManifest, documentUrl = globalThis.location?.href): string {
  if (!manifest.entry.frontend) throw new PluginLoadError(`Plugin ${manifest.slug} has no frontend entry`, manifest.slug);
  const parts = [manifest.slug, manifest.version, ...manifest.entry.frontend.split("/")];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || !manifest.entry.frontend.startsWith("frontend/")
    || parts.some((part) => !part || part === "." || part === ".." || /[%\\/:\x00-\x1f\x7f?#]/.test(part))) {
    throw new PluginLoadError(`Plugin ${manifest.slug} has an unsafe frontend path`, manifest.slug);
  }
  // Tauri maps custom schemes to http(s)://<scheme>.localhost on WebView2.
  // Ask its converter only for the origin, then append encoded path segments:
  // converting the full path encodes '/' and breaks relative ESM chunk URLs.
  let origin = isTauriRuntime()
    ? convertFileSrc("", "taomni-plugin").replace(/\/$/, "")
    : "taomni-plugin://localhost";
  // WKWebView cannot reliably import ESM across two custom schemes. Packaged
  // renderers use a reserved path on their own application origin instead.
  // Its native handler applies the same installed/version/hash checks. Keep
  // external dev servers on the dedicated protocol, never on Vite's SPA path.
  if (isTauriRuntime() && documentUrl) {
    const document = new URL(documentUrl);
    const appOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
    const documentOrigin = `${document.protocol}//${document.host}`;
    if (appOrigins.includes(documentOrigin) && !document.username && !document.password) {
      origin = `${documentOrigin}/__taomni_plugins__`;
    }
  }
  return `${origin}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

const defaultImporter = <Props>(url: string) => import(/* @vite-ignore */ url) as Promise<PluginFrontendModule<Props>>;

function isComponentExport(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  const marker = (value as { $$typeof?: unknown }).$$typeof;
  return marker === Symbol.for("react.memo") || marker === Symbol.for("react.forward_ref");
}

export async function loadPluginFrontend<Props = PluginFrontendProps>(
  manifest: PluginManifest,
  importer: PluginImporter<Props> = defaultImporter,
  activation?: string,
): Promise<PluginFrontendModule<Props>> {
  try {
    let url = pluginFrontendUrl(manifest);
    // Preview serves repository sources, with no claim of native package trust.
    // Native builds only load the immutable, verified custom-protocol URL.
    if (importer === defaultImporter && import.meta.env.DEV && !isTauriRuntime()) {
      if (manifest.slug === "hello-plugin") url = "/src-tauri/plugins/hello-plugin/frontend/index.js";
      if (manifest.document) url = `/src-tauri/plugins/${manifest.slug}/${manifest.entry.frontend}`;
      if (manifest.slug === "taoffice-pdf") url = `/src-tauri/plugins/${manifest.slug}/dist/${manifest.entry.frontend}`;
      if (manifest.slug === "vnc-client") url = "/src-tauri/plugins/vnc-client/renderer/VncPanel.tsx";
      if (manifest.slug === "rdp-client") url = "/src-tauri/plugins/rdp-client/renderer/RdpPanel.tsx";
      if (manifest.slug === "mail") url = "/src-tauri/plugins/mail/renderer/MailView.tsx";
      if (manifest.slug === "mfa") url = "/src-tauri/plugins/mfa/renderer/MfaView.tsx";
      if (manifest.slug === "sockscap") url = "/src-tauri/plugins/sockscap/renderer/SocksCapViewEntry.tsx";
      if (manifest.slug === "rdp-server") url = "/src-tauri/plugins/rdp-server/renderer/RdpSettings.tsx";
      if (manifest.slug === "vnc-server") url = "/src-tauri/plugins/vnc-server/renderer/VncSettings.tsx";
      if (manifest.slug === "servers") url = "/src-tauri/plugins/servers/renderer/LocalServerSettings.tsx";
    }
    if (manifest.slug === "vnc-client") {
      const { installVncViewerHost } = await import("./vnc/viewerHost");
      installVncViewerHost();
    }
    if (manifest.slug === "rdp-client") {
      const { installRdpViewerHost } = await import("./rdpViewerHost");
      installRdpViewerHost();
    }
    if (manifest.slug === "mail") {
      const { installMailRendererHost } = await import("./mail/rendererHost");
      installMailRendererHost();
    }
    if (manifest.slug === "mfa") {
      const { installMfaRendererHost } = await import("./mfa/rendererHost");
      installMfaRendererHost();
    }
    if (manifest.slug === "sockscap") {
      const { installSocksCapRendererHost } = await import("./sockscap/rendererHost");
      installSocksCapRendererHost();
    }
    if (manifest.slug === "servers" || manifest.slug === "rdp-server" || manifest.slug === "vnc-server") {
      const { installServerSettingsRendererHost } = await import("./servers/rendererHost");
      installServerSettingsRendererHost();
    }
    // A fragment changes ESM identity for retry/reactivation without changing
    // the signed resource path or allowing a query through the native protocol.
    if (activation) url += `#${encodeURIComponent(activation)}`;
    const module = await importer(url);
    if (!module || !isComponentExport(module.default ?? module.component)) {
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
): LazyExoticComponent<ComponentType<PluginFrontendProps>> {
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

