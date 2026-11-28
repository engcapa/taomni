import { compatibleMedia } from "./containerPlayback.js";
import { outputFormats } from "./conversion.js";
import { convertWithHost } from "./nativeConversion.js";

const legacy = new Set(["avi", "flv", "wmv", "rm", "rmvb"]);

export function nativePlaybackFormat(canPlay) {
  return Object.entries(outputFormats).find(([, format]) => canPlay(format.playback))?.[0]
    ?? Object.entries(outputFormats).find(([, format]) => canPlay(format.mime))?.[0]
    ?? "webm";
}

export async function openMediaResource(source, mime, attempt, signal, onProgress, api, canNative) {
  if (attempt === "stream") return source.openMedia(mime);
  if (attempt === "native" && !canNative) {
    throw new Error("Legacy media conversion requires the Taomni desktop app.");
  }

  // The host enforces the document read limit and current module permission.
  const data = await source.read();
  signal?.throwIfAborted();
  const canPlay = (type) => document.createElement("video").canPlayType(type) !== "";
  let file;
  if (attempt === "compatible") {
    file = await compatibleMedia(data, canPlay, signal, onProgress);
  } else if (attempt === "native") {
    file = await convertWithHost(api, data, { container: nativePlaybackFormat(canPlay), start: 0 }, signal, onProgress);
  } else {
    file = new Blob([data], { type: mime });
  }
  signal?.throwIfAborted();
  const url = URL.createObjectURL(file);
  return { url, file, close: () => URL.revokeObjectURL(url) };
}

export function shouldRetryAsBlob(attempt, url) {
  return attempt === "stream" && !url.startsWith("blob:");
}

export function initialMediaAttempt(extension, canPlay) {
  if (legacy.has(extension)) return "native";
  return extension === "mkv" && !canPlay("video/x-matroska") ? "compatible" : "stream";
}

export function fallbackAttempt(extension, attempt, canNative, url) {
  if (attempt === "native") return null;
  if (extension === "mkv" && (attempt === "stream" || attempt === "blob")) return "compatible";
  if (legacy.has(extension)) return null;
  if (url && shouldRetryAsBlob(attempt, url)) return "blob";
  return canNative ? "native" : null;
}

export function mediaSeekTarget(currentTime, duration, key) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration < 0) return null;
  if (key === "ArrowLeft") return Math.max(0, currentTime - 5);
  if (key === "ArrowRight") return Math.min(duration, currentTime + 5);
  return null;
}
