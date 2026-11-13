import { useEffect, useState } from "react";
import {
  explorerCancelOperation,
  explorerReadPreviewBytes,
  explorerReadPreviewText,
  localProperties,
  type LocalProperties,
} from "../../../lib/explorer";
import { sftpListLocalDetailed, type FileEntry } from "../../../lib/sftp";
import { IMAGE_PREVIEW_LIMIT, previewImageBlob, previewKind, type PreviewKind } from "./previewModel";

export interface ExplorerPreviewState {
  key: string;
  kind: PreviewKind;
  loading: boolean;
  error?: string;
  text?: string;
  truncated?: boolean;
  imageUrl?: string;
  properties?: LocalProperties[];
  children?: FileEntry[];
  childCount?: number;
  propertyErrors?: string[];
}

function requestKey(entries: FileEntry[], currentPath: string): string {
  return JSON.stringify([currentPath, entries.map((entry) => [entry.path, entry.fileType, entry.targetFileType, entry.size, entry.mtime])]);
}

function selectionKind(entries: FileEntry[]): PreviewKind {
  return entries.length === 0 ? "empty" : entries.length > 1 ? "multi" : previewKind(entries[0]);
}

/** One effect owns each selection's requests, cancellations and object URLs. */
export function useExplorerPreview(entries: FileEntry[], currentPath: string, tabId: string): ExplorerPreviewState {
  const key = requestKey(entries, currentPath);
  const kind = selectionKind(entries);
  const [state, setState] = useState<ExplorerPreviewState>({ key, kind, loading: true });

  useEffect(() => {
    let active = true;
    let imageUrl: string | undefined;
    const operations = new Set<string>();
    const result: ExplorerPreviewState = { key, kind, loading: false };
    const publish = () => {
      if (active) setState({ ...result });
    };
    setState({ key, kind, loading: true });

    async function properties(path: string): Promise<LocalProperties> {
      const operationId = `explorer-preview-${tabId}-${crypto.randomUUID()}`;
      operations.add(operationId);
      try {
        return await localProperties(path, operationId);
      } finally {
        operations.delete(operationId);
      }
    }

    async function load() {
      try {
        const entry = entries[0];
        if (kind === "empty" || kind === "directory") {
          const path = entry?.path ?? currentPath;
          const [metadata, listing] = await Promise.allSettled([
            properties(path),
            sftpListLocalDetailed(path),
          ]);
          if (!active) return;
          result.propertyErrors = [];
          if (metadata.status === "fulfilled") {
            result.properties = [metadata.value];
            result.truncated = metadata.value.truncated;
          } else {
            result.propertyErrors.push(String(metadata.reason));
          }
          if (listing.status === "fulfilled") {
            result.children = listing.value.entries.slice(0, 8);
            result.childCount = listing.value.entries.length;
            if (listing.value.skippedCount > 0) result.truncated = true;
          } else {
            result.propertyErrors.push(String(listing.reason));
          }
          if (metadata.status === "rejected" && listing.status === "rejected") {
            throw metadata.reason;
          }
        } else if (kind === "multi") {
          // File lengths are already known from the authoritative directory listing.
          // Only recurse into real directories; symlinks are never followed here.
          const directories = entries.filter((item) => item.fileType === "dir");
          result.properties = [];
          result.propertyErrors = [];
          let next = 0;
          async function worker() {
            while (active && next < directories.length) {
              const directory = directories[next++];
              try {
                const value = await properties(directory.path);
                if (active) result.properties!.push(value);
              } catch (error) {
                if (active) result.propertyErrors!.push(`${directory.name}: ${String(error)}`);
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(4, directories.length) }, worker));
          result.truncated = result.properties.some((value) => value.truncated);
        } else if (kind === "text" || kind === "markdown" || kind === "csv") {
          const text = await explorerReadPreviewText(entry.path);
          if (!active) return;
          if (text.binary) {
            result.kind = "binary";
          } else {
            result.text = text.text;
            result.truncated = text.truncated;
          }
        } else if (kind === "image") {
          const image = await explorerReadPreviewBytes(entry.path, IMAGE_PREVIEW_LIMIT);
          // Do not allocate a URL for a request whose selection has already gone away.
          if (!active) return;
          imageUrl = URL.createObjectURL(previewImageBlob(image.bytes, image.mime));
          result.imageUrl = imageUrl;
        }
        publish();
      } catch (error) {
        if (!active) return;
        result.kind = /too_large/.test(String(error)) ? "too-large" : "error";
        result.error = error instanceof Error ? error.message : String(error);
        publish();
      }
    }
    void load();
    return () => {
      active = false;
      for (const operationId of operations) {
        void explorerCancelOperation(operationId).catch(() => {});
      }
      operations.clear();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
    // Selection identity is content-derived, not the caller's array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tabId]);

  // Never render previous content during the render before the new effect runs.
  return state.key === key ? state : { key, kind, loading: true };
}
