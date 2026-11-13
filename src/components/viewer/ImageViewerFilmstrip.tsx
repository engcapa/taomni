import { useEffect, useRef, useState } from "react";
import { FileImage } from "lucide-react";
import { type FileEntry } from "../../lib/sftp";
import { viewerReadBytes } from "../../lib/viewer";
import { IMAGE_VIEWER_LIMIT, safeImageBlob } from "./ImageViewerImage";
import type { ImageResource } from "./ImageViewerResources";

function ImageThumbnail({ entry, current, selected, index, navigate }: {
  entry: FileEntry; current?: ImageResource; selected: boolean; index: number; navigate: (path: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumbnail, setThumbnail] = useState<{ path: string; url: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); setThumbnail(undefined); }, [entry.path, entry.mtime, current?.url]);
  useEffect(() => {
    const element = button.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((item) => item.isIntersecting));
    }, { root: element.parentElement, rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (current || !visible || entry.size > IMAGE_VIEWER_LIMIT) return;
    let stale = false;
    let url: string | undefined;
    void viewerReadBytes(entry.path, IMAGE_VIEWER_LIMIT).then((result) => {
      if (stale) return;
      url = URL.createObjectURL(safeImageBlob(result.bytes, result.mime, IMAGE_VIEWER_LIMIT));
      setThumbnail({ path: entry.path, url });
    }).catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; if (url) URL.revokeObjectURL(url); };
  }, [entry.path, entry.size, entry.mtime, visible, current]);
  const url = current?.url ?? (thumbnail?.path === entry.path ? thumbnail.url : undefined);
  return <button ref={button} type="button" className={`image-thumbnail${selected ? " on" : ""}`}
    data-testid={`image-thumbnail-${index}`} aria-label={entry.name} aria-current={selected ? "true" : undefined}
    title={entry.name} onClick={() => navigate(entry.path)}>
    {url && !failed ? <img src={url} alt="" draggable={false} onError={() => setFailed(true)} /> : <FileImage aria-hidden="true" />}
    <span>{entry.name}</span>
  </button>;
}

export function ImageViewerFilmstrip({ siblings, resource, path, label, navigate }: {
  siblings: FileEntry[]; resource?: ImageResource; path: string; label: string; navigate: (path: string) => void;
}) {
  const currentIndex = siblings.findIndex((entry) => entry.path === path);
  // Keep very large directories cheap. Neighbour navigation still spans the entire sorted list.
  const start = Math.max(0, currentIndex - 30);
  return <div className="image-filmstrip" data-testid="image-filmstrip" aria-label={label}>
    {siblings.slice(start, start + 61).map((entry, index) => <ImageThumbnail key={entry.path} entry={entry} index={start + index}
      current={resource?.path === entry.path ? resource : undefined} selected={entry.path === path} navigate={navigate} />)}
  </div>;
}
