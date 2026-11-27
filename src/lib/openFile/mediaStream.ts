import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../runtime";
import { viewerReadBytes, type ViewerBytes } from "../viewer";

export interface MediaSourceLease { url: string; close: () => void }

export function readModuleDocument(path: string, slug: string, version: string): Promise<ViewerBytes> {
  return isTauriRuntime() ? invoke("viewer_document_read", { path, slug, version }) : viewerReadBytes(path);
}

export function saveModuleDocumentCopy(path: string, name: string, slug: string, version: string, bytes: Uint8Array): Promise<string | null> {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) {
    return Promise.reject(new Error("Document copies are limited to 32 MiB."));
  }
  if (isTauriRuntime()) return invoke("viewer_document_save_copy", { path, slug, version, bytes: Array.from(bytes) });
  const filename = name.replace(/\.([^.]+)$/, " - copy.$1");
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve(filename);
}

export async function openDocumentMedia(path: string, mime: string, slug: string, version: string): Promise<MediaSourceLease> {
  if (isTauriRuntime()) {
    const { token, url } = await invoke<{ token: string; url: string }>("viewer_media_open", { path, slug, version });
    return { url, close: () => { void invoke("viewer_media_close", { token }).catch(() => {}); } };
  }
  const data = await viewerReadBytes(path);
  const url = URL.createObjectURL(new Blob([Uint8Array.from(data.bytes)], { type: mime }));
  return { url, close: () => URL.revokeObjectURL(url) };
}
