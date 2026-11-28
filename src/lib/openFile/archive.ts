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

export type ArchiveExtractionPhase = "preparing" | "extracting" | "verifying" | "publishing"
  | "cancelling" | "cancelled" | "completed" | "failed";

export interface ArchiveExtraction {
  id: string;
  phase: ArchiveExtractionPhase;
  destination: string;
  member: string | null;
  bytes: number;
  totalBytes: number | null;
  retainedBytes: number;
  canResume: boolean;
  output: string | null;
  error: string | null;
}

export function archiveExtractionCanCancel(phase: ArchiveExtractionPhase) {
  return phase === "preparing" || phase === "extracting" || phase === "verifying";
}

export function archiveExtractionActive(phase: ArchiveExtractionPhase) {
  return archiveExtractionCanCancel(phase) || phase === "publishing" || phase === "cancelling";
}

export const archiveExtraction = {
  status(path: string) {
    return invoke<ArchiveExtraction | null>("viewer_archive_job_status", { path });
  },
  start(path: string, destination: string, totalBytes: number, entry?: ArchiveEntry) {
    return invoke<ArchiveExtraction>("viewer_archive_job_start", { path, destination, entry, totalBytes });
  },
  cancel(path: string, id: string) {
    return invoke<ArchiveExtraction>("viewer_archive_job_cancel", { path, id });
  },
  resume(path: string, id: string) {
    return invoke<ArchiveExtraction>("viewer_archive_job_resume", { path, id });
  },
  discard(path: string, id: string) {
    return invoke<void>("viewer_archive_job_discard", { path, id });
  },
};
