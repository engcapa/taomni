import type { ModuleCatalogSelection, ModuleMarketplaceCatalog } from "../lib/ipc/plugin";
import { MODULE_PREVIEW_KEY, previewHelloManifest, previewModuleRecord, readModulePreview } from "./modulePreview";

/** Explicit browser fixture only. Paths and lifecycle are a local model;
 * this cannot verify a native signature or install a package. */
export const MARKETPLACE_PREVIEW_KEY = "taomni.preview.marketplace.v1";
const digest = "a".repeat(64);
const id = `module-hello-plugin-${digest}`;
export const marketplacePreviewCatalog: ModuleMarketplaceCatalog = { platform: "linux-x86_64", catalog: {
  coreApiVersion: "1", sequence: 42, updatedAt: "2026-11-16T00:00:00Z", plugins: {
    [previewHelloManifest.id]: { id: previewHelloManifest.id, slug: "hello-plugin", name: "Hello Plugin",
      version: "0.1.0", coreApiVersion: "1", kind: "collaboration", permissions: [],
      description: "Open a separate module tab and save text there.", platforms: {
        "linux-x86_64": { url: "https://preview.invalid/hello.taomni-plugin", signature: "explicit browser model", sha256: digest, size: 8192 },
      } },
  },
} };

const mailId = "taomni-plugin-mail";
const mailStaged = "taomni.preview.mail-provisioned";
function invokeLegacyMailPreview(command: string, args: Record<string, unknown> | undefined, failed: boolean): unknown {
  if (command === "plugin_marketplace_catalog") {
    const sample = marketplacePreviewCatalog.catalog.plugins[previewHelloManifest.id];
    return {
      ...marketplacePreviewCatalog,
      catalog: { ...marketplacePreviewCatalog.catalog, plugins: {
        [mailId]: { ...sample, id: mailId, slug: "mail", name: "Mail", description: "Mail and the unified inbox" },
      } },
      release: {
        legacyWaiting: false,
        legacyPending: [mailId],
        legacyRestartRequired: !failed && sessionStorage.getItem(mailStaged) ? [mailId] : [],
        legacyImportFailed: failed ? [mailId] : [],
        updates: [],
        newModules: [],
      },
    };
  }
  if (command === "plugin_marketplace_provision") {
    const selection = args?.selection as ModuleCatalogSelection | undefined;
    if (selection?.pluginId === mailId && selection.sha256 === digest && selection.version === "0.1.0"
      && (!failed || args?.retry === true)) {
      sessionStorage.setItem(mailStaged, "true");
      localStorage.setItem(MARKETPLACE_PREVIEW_KEY, "legacy-mail");
      return { restartRequired: true };
    }
  }
  throw new Error("Invalid browser Mail provision fixture");
}

export function invokeMarketplacePreview(command: string, args?: Record<string, unknown>): unknown {
  const mode = localStorage.getItem(MARKETPLACE_PREVIEW_KEY);
  if (mode === "legacy-mail" || mode === "legacy-mail-failed") {
    return invokeLegacyMailPreview(command, args, mode === "legacy-mail-failed");
  }
  if (mode !== "true" && mode !== "release" && mode !== "update") {
    if (command === "plugin_marketplace_catalog") return { ...marketplacePreviewCatalog, catalog: { ...marketplacePreviewCatalog.catalog, plugins: {} } };
    throw new Error("Browser preview cannot download or verify native module packages.");
  }
  const installed = readModulePreview();
  if (command === "plugin_marketplace_catalog") {
    const source = String(args?.url);
    if (source.includes("modules-bad")) throw new Error("Preview model: invalid catalog signature");
    if (source.includes("modules-older")) throw new Error("Preview model: catalog rollback rejected");
    if (mode === "release") {
      const baseline = source.includes("modules-baseline");
      return { ...marketplacePreviewCatalog, catalog: { ...marketplacePreviewCatalog.catalog,
        ...(baseline ? { sequence: 41, plugins: {} } : {}),
      }, release: { legacyWaiting: false, legacyPending: [], updates: [], newModules:
        baseline || installed || sessionStorage.getItem("taomni.preview.new-module-dismissed") ? [] : [previewHelloManifest.id],
      } };
    }
    if (mode === "update") {
      const eligible = installed?.version === "0.0.9" && installed.lifecycle !== "uninstalled";
      return { ...marketplacePreviewCatalog, release: {
        legacyWaiting: false, legacyPending: [], updates: eligible ? [previewHelloManifest.id] : [], newModules: [],
      } };
    }
    return marketplacePreviewCatalog;
  }
  if (command === "plugin_marketplace_dismiss_new") {
    sessionStorage.setItem("taomni.preview.new-module-dismissed", "true");
    return;
  }
  const selection = args?.selection as ModuleCatalogSelection;
  if (selection?.pluginId !== previewHelloManifest.id || selection.version !== "0.1.0" || selection.sha256 !== digest) throw new Error("Invalid browser model selection");
  if (args?.installedVersion && (installed?.version !== args.installedVersion || installed?.lifecycle === "uninstalled")) {
    throw new Error("Installed module changed. Refresh the module store before updating");
  }
  if (command === "plugin_marketplace_download") {
    const task = { id, completedPath: "preview/hello.taomni-plugin", progress: { revision: 1, phase: "completed", downloaded: 8192, total: 8192 } };
    localStorage.setItem("taomni.preview.module-downloads.v1", JSON.stringify({ tasks: [task], recoveryErrors: [] }));
    return task;
  }
  if (command === "plugin_marketplace_review") return { manifest: previewHelloManifest, dataDirectory: "preview/plugins/hello-plugin/data", downloadId: id };
  if (command === "plugin_marketplace_install") {
    if (mode === "update" && installed && args?.installedVersion === installed.version) {
      const updated = { ...installed, version: selection.version, previousVersion: installed.version };
      localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify(updated));
      return previewModuleRecord(updated);
    }
    localStorage.setItem(MODULE_PREVIEW_KEY, JSON.stringify({ lifecycle: "installed", values: [] }));
    return { manifest: previewHelloManifest, state: "installed", dataRetained: true };
  }
  throw new Error(`Unknown browser marketplace model command: ${command}`);
}
