import { invoke } from "@tauri-apps/api/core";

export interface OperationFailure {
  path: string;
  code: string;
  message: string;
}

export interface EntryOperationResult {
  done: { from: string; to: string }[];
  failed: OperationFailure[];
}

export interface TrashRef {
  id: string;
  originalPath: string;
}

export interface TrashResult {
  trashed: TrashRef[];
  failed: OperationFailure[];
}

export interface LocalProperties {
  path: string;
  name: string;
  fileType: string;
  size: number;
  itemCount: number;
  truncated: boolean;
  mtime: number;
  createdAt: number | null;
  mode: number;
  owner: string | null;
  group: string | null;
  symlinkTarget: string | null;
}

export interface ExplorerProgress {
  operationId: string;
  bytes: number;
  items: number;
  path: string;
}

export interface PreviewText {
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface PreviewBytes {
  bytes: number[];
  mime: string;
}

export function explorerCanonicalPath(path: string): Promise<string> {
  return invoke("explorer_canonical_path", { path });
}

export function explorerSameVolume(source: string, destDir: string): Promise<boolean> {
  return invoke("explorer_same_volume", { source, destDir });
}

export function explorerWriteClipboardFiles(paths: string[], cut: boolean): Promise<void> {
  return invoke("explorer_write_clipboard_files", { paths, cut });
}

export function explorerUpdateCutClipboard(expectedPaths: string[], remainingPaths: string[]): Promise<boolean> {
  return invoke("explorer_update_cut_clipboard", { expectedPaths, remainingPaths });
}

export function localCopyEntries(sources: string[], destDir: string, operationId?: string): Promise<EntryOperationResult> {
  return invoke("local_copy_entries", { sources, destDir, conflict: "rename", operationId });
}

export function localMoveEntries(sources: string[], destDir: string, operationId?: string): Promise<EntryOperationResult> {
  return invoke("local_move_entries", { sources, destDir, conflict: "rename", operationId });
}

export function localTrashEntries(paths: string[]): Promise<TrashResult> {
  return invoke("local_trash_entries", { paths });
}

export function localTrashRestore(items: TrashRef[]): Promise<EntryOperationResult> {
  return invoke("local_trash_restore", { items });
}

export function localProperties(path: string, operationId?: string): Promise<LocalProperties> {
  return invoke("local_properties", { path, operationId });
}

export function explorerReadPreviewBytes(path: string, maxBytes = 20 * 1024 * 1024): Promise<PreviewBytes> {
  return invoke("explorer_read_preview_bytes", { path, maxBytes });
}

export function explorerReadPreviewText(path: string): Promise<PreviewText> {
  return invoke("explorer_read_preview_text", { path });
}

export function explorerCancelOperation(operationId: string): Promise<void> {
  return invoke("explorer_cancel_operation", { operationId });
}

export function localRenameEntry(path: string, name: string): Promise<string> {
  return invoke("local_rename_entry", { path, name });
}

export function localCreateEntry(destDir: string, name: string, directory: boolean): Promise<string> {
  return invoke("local_create_entry", { destDir, name, directory });
}
