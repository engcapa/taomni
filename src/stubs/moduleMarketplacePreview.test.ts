import { beforeEach, expect, it } from "vitest";
import { MODULE_PREVIEW_KEY, previewHelloManifest } from "./modulePreview";
import {
  invokeMarketplacePreview, MARKETPLACE_PREVIEW_KEY, marketplacePreviewCatalog,
} from "./moduleMarketplacePreview";

const selection = {
  pluginId: previewHelloManifest.id, version: "0.1.0", sha256: "a".repeat(64),
};

beforeEach(() => localStorage.clear());

it("keeps ordinary preview empty and rejects native package operations without the explicit fixture", () => {
  expect(invokeMarketplacePreview("plugin_marketplace_catalog")).toEqual({
    ...marketplacePreviewCatalog, catalog: { ...marketplacePreviewCatalog.catalog, plugins: {} },
  });
  for (const command of ["plugin_marketplace_download", "plugin_marketplace_review", "plugin_marketplace_install"]) {
    expect(() => invokeMarketplacePreview(command, { selection })).toThrow("cannot download or verify");
  }
  expect(localStorage.getItem(MODULE_PREVIEW_KEY)).toBeNull();
  expect(localStorage.getItem("taomni.preview.module-downloads.v1")).toBeNull();
});

it("rejects stale fixture selections and models feed errors without changing installed or download state", () => {
  localStorage.setItem(MARKETPLACE_PREVIEW_KEY, "true");
  for (const changed of [{ ...selection, version: "9.0.0" }, { ...selection, sha256: "b".repeat(64) }]) {
    expect(() => invokeMarketplacePreview("plugin_marketplace_install", { selection: changed })).toThrow("Invalid browser model selection");
  }
  for (const source of ["modules-bad", "modules-older"]) {
    expect(() => invokeMarketplacePreview("plugin_marketplace_catalog", { url: `https://preview.invalid/${source}.json` })).toThrow("Preview model:");
  }
  expect(localStorage.getItem(MODULE_PREVIEW_KEY)).toBeNull();
  expect(localStorage.getItem("taomni.preview.module-downloads.v1")).toBeNull();
  expect(invokeMarketplacePreview("plugin_marketplace_catalog")).toEqual(marketplacePreviewCatalog);
});

it("keeps a modeled completed transfer separate from the explicit installation action", () => {
  localStorage.setItem(MARKETPLACE_PREVIEW_KEY, "true");
  invokeMarketplacePreview("plugin_marketplace_download", { selection });
  const task = JSON.parse(localStorage.getItem("taomni.preview.module-downloads.v1")!).tasks[0];
  expect(task.progress).toMatchObject({ phase: "completed", downloaded: 8192, total: 8192 });
  expect(localStorage.getItem(MODULE_PREVIEW_KEY)).toBeNull();
  expect(invokeMarketplacePreview("plugin_marketplace_review", { selection })).toMatchObject({
    manifest: previewHelloManifest, dataDirectory: "preview/plugins/hello-plugin/data", downloadId: task.id,
  });
  expect(localStorage.getItem(MODULE_PREVIEW_KEY)).toBeNull();
  invokeMarketplacePreview("plugin_marketplace_install", { selection });
  expect(JSON.parse(localStorage.getItem(MODULE_PREVIEW_KEY)!)).toEqual({ lifecycle: "installed", values: [] });
});

it("accepts the JSON fixture used by the Mail upgrade case and resumes a failed import", () => {
  const pluginId = "taomni-plugin-mail";
  const args = { selection: { ...selection, pluginId } };
  sessionStorage.removeItem("taomni.preview.mail-provisioned");
  localStorage.setItem(MARKETPLACE_PREVIEW_KEY, '"legacy-mail"');
  expect(invokeMarketplacePreview("plugin_marketplace_catalog")).toMatchObject({
    release: { legacyPending: [pluginId], legacyRestartRequired: [] },
  });
  expect(invokeMarketplacePreview("plugin_marketplace_provision", args)).toEqual({ restartRequired: true });
  localStorage.setItem(MARKETPLACE_PREVIEW_KEY, '"legacy-mail-failed"');
  expect(invokeMarketplacePreview("plugin_marketplace_catalog")).toMatchObject({
    release: { legacyImportFailed: [pluginId], legacyRestartRequired: [] },
  });
  expect(invokeMarketplacePreview("plugin_marketplace_provision", { ...args, retry: true }))
    .toEqual({ restartRequired: true });
  expect(invokeMarketplacePreview("plugin_marketplace_catalog")).toMatchObject({
    release: { legacyImportFailed: [], legacyRestartRequired: [pluginId] },
  });
});
