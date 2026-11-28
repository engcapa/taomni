import { MAX_MEDIA_BYTES } from "./conversion.js";

const BLOCK = 768 * 1024;
const POLL_INTERVAL = 200;
const MAX_WAIT = 10 * 60 * 1000;

function encode(bytes) {
  const strings = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    strings.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(strings.join(""));
}

function wait(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, POLL_INTERVAL);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function hasNativeConverter() {
  return Boolean(globalThis.__TAURI_INTERNALS__ || globalThis.__TAURI__);
}

export async function convertWithHost(api, file, options, signal, progress) {
  if (!file.size || file.size > MAX_MEDIA_BYTES) throw new Error("Media conversion is limited to 32 MiB input.");
  const id = crypto.randomUUID();
  const cleanup = api.deferCleanup?.("media/close", { id })
    ?? (() => { void api.invoke("media/close", { id }).catch(() => {}); });
  const invoke = (command, payload = {}) => api.invoke("media/" + command, { id, ...payload }, { signal });
  try {
    await invoke("begin", { size: file.size });
    for (let offset = 0; offset < file.size; offset += BLOCK) {
      const chunk = new Uint8Array(await file.slice(offset, offset + BLOCK).arrayBuffer());
      signal.throwIfAborted();
      await invoke("append", { offset, data: encode(chunk) });
    }
    await invoke("convert", { options: {
      container: options.container,
      startMs: Math.round(options.start * 1000),
      endMs: options.end == null ? null : Math.round(options.end * 1000),
      width: options.width ?? null,
    } });
    const deadline = Date.now() + MAX_WAIT;
    let result;
    while (Date.now() < deadline) {
      result = await invoke("status");
      if (result.state === "error") throw new Error(result.error);
      if (result.state === "ready") break;
      if (result.state !== "converting") throw new Error("The media converter returned an unexpected state.");
      progress(result.progress);
      await wait(signal);
    }
    const type = result?.mime;
    if (result?.state !== "ready") throw new Error("The conversion took too long. Choose a shorter clip.");
    if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.size > MAX_MEDIA_BYTES
      || (type !== "video/" + options.container && type !== "audio/" + options.container)) {
      throw new Error("The media converter returned an invalid file.");
    }
    const bytes = new Uint8Array(result.size);
    for (let offset = 0; offset < bytes.length; offset += BLOCK) {
      const { data } = await invoke("read", { offset });
      const decoded = atob(data);
      if (decoded.length !== Math.min(BLOCK, bytes.length - offset)) {
        throw new Error("The media transfer was incomplete. Try again.");
      }
      for (let i = 0; i < decoded.length; i += 1) bytes[offset + i] = decoded.charCodeAt(i);
    }
    signal.throwIfAborted();
    return new Blob([bytes], { type });
  } finally {
    cleanup();
  }
}
