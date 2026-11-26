import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../runtime";
import { viewerReadBytes, type ViewerBytes } from "../viewer";

export interface MediaSourceLease { url: string; close: () => void }

export function readModuleDocument(path: string, slug: string, version: string): Promise<ViewerBytes> {
  return isTauriRuntime() ? invoke("viewer_document_read", { path, slug, version }) : viewerReadBytes(path);
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
