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
