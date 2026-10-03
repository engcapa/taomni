// Image acquisition for QR import: clipboard (paste events, async Clipboard
// API, native arboard) and dropped/chosen files. Returns decoded QR texts.

import { readClipboardImageFiles } from "../clipboard";
import { isTauriRuntime } from "../runtime";
import { mfaErrorCode } from "./format";
import { mfaReadClipboardImage } from "./ipc";
import { decodeImageBlob, decodeLumaFrames } from "./qrImage";

/** No image was available from the requested source. */
export const NO_IMAGE = "no-image" as const;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name ?? "");
}

/** Image files carried by a paste or drop event. */
export function imageFilesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isImageFile(file)) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(transfer.files ?? [])) {
      if (isImageFile(file)) files.push(file);
    }
  }
  return files;
}

export async function decodeImageFiles(files: Blob[]): Promise<string[]> {
  const results = await Promise.all(files.map((file) => decodeImageBlob(file)));
  return unique(results.flat());
}

/**
 * Read the clipboard image. The desktop app asks the backend first because
 * WebKitGTK paste events usually omit images and WKWebView would show its
 * paste confirmation; browser preview uses the async Clipboard API.
 */
export async function readClipboardQrTexts(): Promise<string[] | typeof NO_IMAGE> {
  if (isTauriRuntime()) {
    try {
      return await decodeLumaFrames(await mfaReadClipboardImage());
    } catch (err) {
      if (mfaErrorCode(err) === "MFA_CLIPBOARD_NO_IMAGE") return NO_IMAGE;
      throw err;
    }
  }
  const files = await readClipboardImageFiles();
  if (files.length === 0) return NO_IMAGE;
  return decodeImageFiles(files);
}

/** Paste event handling: event images first, then the clipboard fallback. */
export async function pasteEventQrTexts(transfer: DataTransfer | null | undefined): Promise<string[] | typeof NO_IMAGE> {
  const files = imageFilesFromTransfer(transfer);
  if (files.length > 0) return decodeImageFiles(files);
  return readClipboardQrTexts();
}
