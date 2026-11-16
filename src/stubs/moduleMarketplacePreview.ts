import type { ModuleCatalogSelection, ModuleMarketplaceCatalog } from "../lib/ipc/plugin";
import { MODULE_PREVIEW_KEY, previewHelloManifest } from "./modulePreview";

/** Explicit browser fixture only. Paths and lifecycle are a local model;
 * this cannot verify a native signature or install a package. */
export const MARKETPLACE_PREVIEW_KEY = "taomni.preview.marketplace.v1";
const digest = "a".repeat(64);
const id = `module-hello-plugin-${digest}`;
export const marketplacePreviewCatalog: ModuleMarketplaceCatalog = { platform: "linux-x86_64", catalog: {
  coreApiVersion: "1", sequence: 42, updatedAt: "2026-11-16T00:00:00Z", plugins: {
    [previewHelloManifest.id]: { id: previewHelloManifest.id, slug: "hello-plugin", name: "Hello Plugin",
      version: "0.1.0", coreApiVersion: "1", kind: "collaboration", permissions: [], platforms: {
        "linux-x86_64": { url: "https://preview.invalid/hello.taomni-plugin", signature: "explicit browser model", sha256: digest, size: 8192 },
      } },
  },
} };

export function invokeMarketplacePreview(command: string, args?: Record<string, unknown>): unknown {
  if (localStorage.getItem(MARKETPLACE_PREVIEW_KEY) !== "true") {
    if (command === "plugin_marketplace_catalog") return { ...marketplacePreviewCatalog, catalog: { ...marketplacePreviewCatalog.catalog, plugins: {} } };
    throw new Error("Browser preview cannot download or verify native module packages.");
  }
  if (command === "plugin_marketplace_catalog") {
    const source = String(args?.url);
    if (source.includes("modules-bad")) throw new Error("Preview model: invalid catalog signature");
    if (source.includes("modules-older")) throw new Error("Preview model: catalog rollback rejected");
    return marketplacePreviewCatalog;
  }
  const selection = args?.selection as ModuleCatalogSelection;
  if (selection?.pluginId !== previewHelloManifest.id || selection.version !== "0.1.0" || selection.sha256 !== digest) throw new Error("Invalid browser model selection");
  if (command === "plugin_marketplace_download") {
    const task = { id, completedPath: "preview/hello.taomni-plugin", progress: { revision: 1, phase: "completed", downloaded: 8192, total: 8192 } };
    localStorage.setItem("taomni.preview.module-downloads.v1", JSON.stringify({ tasks: [task], recoveryErrors: [] }));
    return task;
  }
  if (command === "plugin_marketplace_review") return { manifest: previewHelloManifest, dataDirectory: "preview/plugins/hello-plugin/data", downloadId: id };
  if (command === "plugin_marketplace_install") {
    localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify({ lifecycle: "installed", values: [] }));
    return { manifest: previewHelloManifest, state: "installed", dataRetained: true };
  }
  throw new Error(`Unknown browser marketplace model command: ${command}`);
}
