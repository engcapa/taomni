import { useEffect, useState } from "react";
import { readStreamOpen, readStreamRead, readStreamClose } from "../../../lib/ipc/files";
import { readSessionBookmark, bookmarkOpacity } from "../../../lib/sessionBookmark";

const MAX_BYTES = 8 * 1024 * 1024;

/** Read only local raster assets, with a bounded file stream and stale-result
 * cleanup. Remote URLs and active SVG content are never loaded as backgrounds. */
export async function loadBookmarkImage(path: string, cancelled: () => boolean): Promise<string | null> {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path) || !/\.(png|jpe?g|webp|gif)$/i.test(path)) {
    throw new Error("Choose a local PNG, JPEG, WebP or GIF background image.");
  }
  const file = await readStreamOpen(path);
  try {
    if (file.size > MAX_BYTES) throw new Error("Background image must be 8 MiB or smaller.");
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (!cancelled()) {
      const bytes = await readStreamRead(file.handleId);
      if (!bytes.length) break;
      size += bytes.length;
      if (size > MAX_BYTES) throw new Error("Background image must be 8 MiB or smaller.");
      parts.push(new Uint8Array(bytes));
    }
    if (cancelled()) return null;
    const suffix = path.split(".").pop()?.toLowerCase();
    const type = suffix === "jpg" || suffix === "jpeg" ? "image/jpeg" : `image/${suffix}`;
    return URL.createObjectURL(new Blob(parts, { type }));
  } finally {
    await readStreamClose(file.handleId);
  }
}

export function useBookmarkBackground(optionsJson?: string | null) {
  const bookmark = readSessionBookmark(optionsJson);
  const [image, setImage] = useState<{ path: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let ownedUrl: string | null = null;
    setError(null);
    if (bookmark.bgImage) void loadBookmarkImage(bookmark.bgImage, () => cancelled).then((url) => {
      if (!url) return;
      ownedUrl = url;
      if (cancelled) URL.revokeObjectURL(url);
      else setImage({ path: bookmark.bgImage, url });
    }).catch((error) => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [bookmark.bgImage]);
  return { url: image?.path === bookmark.bgImage ? image.url : null, opacity: bookmarkOpacity(bookmark.bgOpacity), error };
}
