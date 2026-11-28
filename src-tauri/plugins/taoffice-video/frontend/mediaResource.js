import { compatibleMedia } from "./containerPlayback.js";

export async function openMediaResource(source, mime, attempt, signal, onProgress) {
  if (attempt === "stream") return source.openMedia(mime);

  // The host enforces the document read limit and current module permission.
  const data = await source.read();
  signal?.throwIfAborted();
  const browserSupport = (type) => document.createElement("video").canPlayType(type) !== "";
  const file = attempt === "compatible" ? await compatibleMedia(data, browserSupport, signal, onProgress)
    : new Blob([data], { type: mime });
  const url = URL.createObjectURL(file);
  return { url, close: () => URL.revokeObjectURL(url) };
}

export function shouldRetryAsBlob(attempt, url) {
  return attempt === "stream" && !url.startsWith("blob:");
}

export function initialMediaAttempt(extension, canPlay) {
  return extension === "mkv" && !canPlay("video/x-matroska") ? "compatible" : "stream";
}

export function mediaSeekTarget(currentTime, duration, key) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration < 0) return null;
  if (key === "ArrowLeft") return Math.max(0, currentTime - 5);
  if (key === "ArrowRight") return Math.min(duration, currentTime + 5);
  return null;
}
