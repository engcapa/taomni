import { explorerCanonicalPath } from "../../lib/explorer";
import { explorerPathKey } from "../../lib/explorer/openExplorer";
import {
  selectSaveFilePath, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen,
} from "../../lib/ipc/files";
import { isTauriRuntime } from "../../lib/runtime";

function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Cannot read export data"));
    reader.readAsArrayBuffer(blob);
  });
}

/** Native chooser and existing bounded streaming writer; a cancelled chooser writes nothing. */
export async function saveImageCopy(blob: Blob, filename: string, sourcePath: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return filename;
  }
  const path = await selectSaveFilePath(filename, sourcePath);
  if (!path) return null;
  // Streams truncate on open. Never allow a view-only operation to overwrite its source,
  // including aliases and symlinks, even when the save chooser confirms overwrite.
  const source = explorerPathKey(await explorerCanonicalPath(sourcePath));
  let target: string;
  try { target = explorerPathKey(await explorerCanonicalPath(path)); }
  catch { target = explorerPathKey(path); }
  if (source === target || explorerPathKey(sourcePath) === target) throw new Error("Choose a different file; the source image is never overwritten");
  const bytes = await blobBytes(blob);
  let handle: string | undefined;
  try {
    handle = await writeStreamOpen(path);
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      await writeStreamAppend(handle, bytes.subarray(offset, offset + 256 * 1024));
    }
    await writeStreamClose(handle);
    return path;
  } catch (error) {
    if (handle) await writeStreamAbort(handle).catch(() => undefined);
    throw error;
  }
}
