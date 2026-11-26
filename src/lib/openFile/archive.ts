import { invoke } from "@tauri-apps/api/core";
import type { ViewerTemp } from "../viewer";

export interface ArchiveEntry {
  index: number;
  name: string;
  directory: boolean;
  size: number;
  crc: number;
}

export function listArchive(path: string) {
  return invoke<ArchiveEntry[]>("viewer_archive_list", { path });
}

export function previewArchiveEntry(path: string, entry: ArchiveEntry) {
  return invoke<ViewerTemp>("viewer_archive_preview", { path, entry });
}

export function extractArchive(path: string, destination: string, entry?: ArchiveEntry) {
  return invoke<string>("viewer_archive_extract", { path, destination, entry });
}
