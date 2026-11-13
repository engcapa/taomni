import { useEffect, useRef, useState } from "react";
import { effectiveFileType, sftpListLocal, parentPath, basename, type FileEntry } from "../../lib/sftp";
import { viewerReadBytes, type ViewerDocument } from "../../lib/viewer";
import { IMAGE_EXTENSIONS, IMAGE_VIEWER_LIMIT, imageExtension, safeImageBlob } from "./ImageViewerImage";

export interface ImageResource { path: string; url: string; blob: Blob; mime: string }

export function useImageResource(document: ViewerDocument, svg: boolean, retry: number) {
  const [resource, setResource] = useState<ImageResource>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let stale = false;
    let objectUrl: string | undefined;
    setResource(undefined);
    setError("");
    setLoading(false);
    if (document.loading) return;
    if (document.size > IMAGE_VIEWER_LIMIT || document.truncated) { setError("image_viewer_limit"); return; }
    setLoading(true);
    void (async () => {
      const bytes = svg ? { bytes: new TextEncoder().encode(document.content), mime: "image/svg+xml" }
        : await viewerReadBytes(document.path, IMAGE_VIEWER_LIMIT);
      if (stale) return;
      const blob = safeImageBlob(bytes.bytes, bytes.mime, IMAGE_VIEWER_LIMIT);
      objectUrl = URL.createObjectURL(blob);
      setResource({ path: document.path, url: objectUrl, blob, mime: blob.type });
    })().catch((cause) => {
      if (!stale) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!stale) setLoading(false); });
    return () => {
      stale = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document.path, document.content, document.loading, document.error, document.size, document.truncated, document.mtime, document.savedHash, svg, retry]);
  return { resource: resource?.path === document.path ? resource : undefined, loading, error };
}

export function useImageSiblings(document: ViewerDocument, retry: number, enabled = true) {
  const [siblings, setSiblings] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    const current: FileEntry = { name: basename(document.path), path: document.path, size: document.size,
      mtime: document.mtime, fileType: "file", mode: 0, isHidden: false };
    setSiblings([current]);
    setError("");
    if (!enabled) return;
    void sftpListLocal(parentPath(document.path)).then((entries) => {
      if (stale) return;
      const images = entries.filter((entry) => effectiveFileType(entry) === "file" && IMAGE_EXTENSIONS.has(imageExtension(entry.name)));
      if (!images.some((entry) => entry.path === document.path)) images.push(current);
      images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      setSiblings(images);
    }).catch((cause) => { if (!stale) setError(String(cause)); });
    return () => { stale = true; };
  }, [document.path, document.size, document.mtime, retry, enabled]);
  return { siblings, error };
}

/** A stale decode must not leave dimensions or an exportable ref from the previous file. */
export function useImageDimensions(url?: string) {
  const image = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useEffect(() => { setDimensions({ width: 0, height: 0 }); }, [url]);
  return { image, dimensions, setDimensions };
}
