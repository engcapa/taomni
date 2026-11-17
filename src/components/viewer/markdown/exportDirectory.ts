/** Shared across Markdown formats and diagram copies. Only a completed native
 * write updates this preference; cancellation and failed generation/write do not. */
export const MARKDOWN_EXPORT_DIRECTORY_KEY = "taomni.markdown.exportDirectory.v1";
function absoluteDirectory(value: unknown): value is string {
  return typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(value) && !/[\x00-\x1f]/.test(value) && /[\\/]$/.test(value);
}
export function lastMarkdownExportDirectory(): string | undefined {
  try {
    const path: unknown = JSON.parse(localStorage.getItem(MARKDOWN_EXPORT_DIRECTORY_KEY) || "null");
    return absoluteDirectory(path) ? path : undefined;
  } catch { return undefined; }
}
export function rememberMarkdownExportDirectory(path: string, directory = false): void {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
  const slash = windows ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/");
  const separator = windows && path.includes("\\") ? "\\" : "/";
  const parent = directory ? (/[\\/]$/.test(path) ? path : path + separator) : slash >= 0 ? path.slice(0, slash + 1) : "";
  if (!absoluteDirectory(parent)) return;
  // Preference storage being unavailable must not turn a completed file write
  // into a reported failure or suggest retrying an already successful export.
  try { localStorage.setItem(MARKDOWN_EXPORT_DIRECTORY_KEY, JSON.stringify(parent)); } catch { /* File is already safely saved. */ }
}
