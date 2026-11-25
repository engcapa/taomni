import { beforeEach, expect, it } from "vitest";
import { invokeModuleDownloadPreview, MODULE_DOWNLOAD_PREVIEW_KEY } from "./moduleDownloadPreview";

beforeEach(() => localStorage.clear());

it("keeps ordinary browser preview empty and rejects invented native downloads", () => {
  expect(invokeModuleDownloadPreview("plugin_download_list")).toEqual({ tasks: [], recoveryErrors: [] });
  expect(() => invokeModuleDownloadPreview("plugin_download_resume", { id: "missing" })).toThrow("desktop app");
  expect(localStorage.getItem(MODULE_DOWNLOAD_PREVIEW_KEY)).toBeNull();
});

it("persists only an explicitly seeded model across view reload and clears errors after retry", () => {
  localStorage.setItem(MODULE_DOWNLOAD_PREVIEW_KEY, JSON.stringify({ tasks: [{ id: "fixture", completedPath: "preview.pkg", progress: { revision: 1, phase: "failed", downloaded: 2, total: 4, error: "fixture failure" } }], recoveryErrors: [] }));
  expect(invokeModuleDownloadPreview("plugin_download_resume", { id: "fixture" })).toEqual({ revision: 2, phase: "completed", downloaded: 4, total: 4, error: null });
  expect(invokeModuleDownloadPreview("plugin_download_list")).toMatchObject({ tasks: [{ progress: { phase: "completed" } }] });
  invokeModuleDownloadPreview("plugin_download_forget", { id: "fixture" });
  expect(invokeModuleDownloadPreview("plugin_download_list")).toEqual({ tasks: [], recoveryErrors: [] });
});
