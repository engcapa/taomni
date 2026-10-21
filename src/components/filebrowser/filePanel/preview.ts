import { type FileEntry } from "../../../lib/sftp";

export const SUPPORTED_PREVIEW_EXT = new Set([
  "txt", "md", "log", "json", "yaml", "yml", "js", "ts", "tsx",
  "jsx", "html", "css", "py", "rs", "go", "rb", "sh", "conf", "ini",
]);

export function isPreviewable(entry: FileEntry): boolean {
  if (entry.fileType !== "file") return false;
  if (!entry.name.includes(".")) return entry.size <= 256 * 1024;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_PREVIEW_EXT.has(ext);
}
