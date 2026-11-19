import { Channel, invoke } from "@tauri-apps/api/core";
import { safeImageBlob } from "./imageSafety";
import { bytesDataUrl, readMarkdownImage } from "./markdownAssets";
import { useFileOpenPreferences, type FileOpenPreferences } from "./openFile/preferences";
import { isTauriRuntime } from "./runtime";
import type { ViewerBytes } from "./viewer";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_TTL = 60_000;
const pending = new Map<string, Promise<string>>();
const cache = new Map<string, { data: string; expires: number }>();
let cacheSize = 0;
let network = new AbortController();

export function markdownImagePolicy(prefs: FileOpenPreferences): string {
  return JSON.stringify([
    prefs.markdownRestrictRemoteImages,
    prefs.markdownProxyMode,
    prefs.markdownProxyMode === "custom" ? prefs.markdownCustomProxy : null,
  ]);
}

useFileOpenPreferences.subscribe((next, previous) => {
  if (markdownImagePolicy(next) === markdownImagePolicy(previous)) return;
  network.abort(new Error("Markdown image access settings changed"));
  network = new AbortController();
  pending.clear();
  cache.clear();
  cacheSize = 0;
});

async function nativeImage(url: string, preferences: FileOpenPreferences, signal: AbortSignal): Promise<ViewerBytes> {
  let id: string | undefined;
  const cancel = () => {
    if (id) void invoke("viewer_markdown_image_cancel", { id }).catch(() => undefined);
  };
  const ready = new Channel<string>((token) => {
    id = token;
    if (signal.aborted) cancel();
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await invoke<ViewerBytes>("viewer_markdown_image", {
      url, proxyMode: preferences.markdownProxyMode,
      customProxy: preferences.markdownProxyMode === "custom" ? preferences.markdownCustomProxy : undefined,
      ready,
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function browserImage(url: string, preferences: FileOpenPreferences, signal: AbortSignal): Promise<Blob> {
  if (preferences.markdownProxyMode === "custom") {
    throw new Error("An independent Markdown image proxy requires the desktop app");
  }
  const response = await fetch(url, {
    credentials: "omit", referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (response.status !== 200 || !response.body) throw new Error(`The remote image returned HTTP ${response.status}`);
  const mime = response.headers.get("content-type") ?? "";
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("The remote image exceeds the 20 MiB limit");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("The remote image exceeds the 20 MiB limit");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return safeImageBlob(bytes, mime, MAX_IMAGE_BYTES);
}

function remember(url: string, data: string): void {
  for (const [key, value] of cache) {
    if (cacheSize + data.length <= CACHE_BYTES && cache.size < 32) break;
    cache.delete(key);
    cacheSize -= value.data.length;
  }
  cache.set(url, { data, expires: Date.now() + CACHE_TTL });
  cacheSize += data.length;
}

/** Disk Markdown uses the current access policy in both preview and export.
 * View remounts can share the same resource request and its finished bytes. */
export async function readFileMarkdownImage(docPath: string, reference: string): Promise<string> {
  const value = reference.trim();
  if (!/^https?:\/\//i.test(value)) return readMarkdownImage(docPath, reference);
  const preferences = useFileOpenPreferences.getState();
  if (preferences.markdownRestrictRemoteImages) throw new Error("Remote images are blocked in File Open settings");
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Markdown image URLs cannot contain credentials");
  url.hash = "";
  const key = url.href;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  if (cached) {
    cache.delete(key);
    cacheSize -= cached.data.length;
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const { signal } = network;
  const task = (async () => {
    let blob: Blob;
    if (isTauriRuntime()) {
      const result = await nativeImage(key, preferences, signal);
      blob = safeImageBlob(result.bytes, result.mime, MAX_IMAGE_BYTES);
    } else {
      blob = await browserImage(key, preferences, signal);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal.throwIfAborted();
    const data = bytesDataUrl(bytes, blob.type);
    remember(key, data);
    return data;
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}
