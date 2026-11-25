import type { ModuleDownloadListing } from "../lib/ipc/plugin";

export const MODULE_DOWNLOAD_PREVIEW_KEY = "taomni.preview.module-downloads.v1";

/** An opt-in browser fixture model, with no network, filesystem or signature
 * claims. Ordinary preview has an empty list and cannot create downloads. */
export function invokeModuleDownloadPreview(command: string, args?: Record<string, unknown>): unknown {
  const saved = localStorage.getItem(MODULE_DOWNLOAD_PREVIEW_KEY);
  const listing: ModuleDownloadListing = saved ? JSON.parse(saved) : { tasks: [], recoveryErrors: [] };
  if (command === "plugin_download_list") return listing;
  const task = listing.tasks.find((entry) => entry.id === args?.id);
  if (!task) throw new Error("Module downloads require the desktop app; no preview fixture is active.");
  if (command === "plugin_download_cancel") task.progress = { ...task.progress, revision: task.progress.revision + 1, phase: "cancelled" };
  else if (command === "plugin_download_resume") task.progress = {
    ...task.progress, revision: task.progress.revision + 1, phase: "completed",
    downloaded: task.progress.total ?? task.progress.downloaded, error: null,
  };
  else if (command === "plugin_download_forget") listing.tasks = listing.tasks.filter((entry) => entry !== task);
  else throw new Error("Unsupported browser download model operation");
  localStorage.setItem(MODULE_DOWNLOAD_PREVIEW_KEY, JSON.stringify(listing));
  return command === "plugin_download_forget" ? undefined : task.progress;
}
