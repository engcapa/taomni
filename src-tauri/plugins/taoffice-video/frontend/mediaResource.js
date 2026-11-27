export async function openMediaResource(source, mime, attempt) {
  if (attempt === "stream") return source.openMedia(mime);

  // The host enforces the document read limit and current module permission.
  const data = await source.read();
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  return { url, close: () => URL.revokeObjectURL(url) };
}

export function shouldRetryAsBlob(attempt, url) {
  return attempt === "stream" && !url.startsWith("blob:");
}

export function mediaSeekTarget(currentTime, duration, key) {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration < 0) return null;
  if (key === "ArrowLeft") return Math.max(0, currentTime - 5);
  if (key === "ArrowRight") return Math.min(duration, currentTime + 5);
  return null;
}
