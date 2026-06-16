import { selectFilePath, readFileBytes } from "./ipc";
import { isTauriRuntime } from "./runtime";
import { openTextFileWithName, openBinaryFile, type OpenedTextFile } from "./fileHelpers";
import { decodeImportedText } from "./sessionImportExport";

/**
 * File picker for the session-import flows.
 *
 * In the browser dev server we fall back to the HTML `<input type="file">`
 * picker (the only option there). In the Tauri desktop app we use the native
 * OS file dialog instead, because the WebKitGTK webview on Linux builds its
 * file-chooser filter from MIME types only: extensions that have no MIME
 * mapping (e.g. ZeroOmega's `.bak`, WindTerm's `.sessions`) are silently
 * dropped from the filter, leaving those files invisible with no "All files"
 * escape hatch. The native dialog shows every file, and the parsers validate
 * by content rather than by suffix anyway.
 *
 * The `accept` argument is only used by the browser fallback; the native
 * dialog intentionally does not filter by extension.
 */

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** Pick a file and return its decoded text plus the original file name. */
export async function pickImportText(accept: string): Promise<OpenedTextFile | null> {
  if (!isTauriRuntime()) {
    return openTextFileWithName(accept);
  }
  const path = await selectFilePath();
  if (!path) return null;
  const bytes = await readFileBytes(path);
  return { name: basename(path), text: decodeImportedText(bytes) };
}

export interface OpenedBinaryFile {
  name: string;
  bytes: Uint8Array;
}

/** Pick a file and return its raw bytes plus the original file name. */
export async function pickImportBytes(accept: string): Promise<OpenedBinaryFile | null> {
  if (!isTauriRuntime()) {
    const buffer = await openBinaryFile(accept);
    if (!buffer) return null;
    return { name: "", bytes: new Uint8Array(buffer) };
  }
  const path = await selectFilePath();
  if (!path) return null;
  const bytes = await readFileBytes(path);
  return { name: basename(path), bytes };
}
