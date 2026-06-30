import { invoke } from "@tauri-apps/api/core";

export type WorkspaceEntryType = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  fileType: WorkspaceEntryType;
  size: number;
  mtime: number;
  isHidden: boolean;
}

export interface WorkspaceFile {
  path: string;
  text: string;
  size: number;
  mtime: number;
  hash: string;
}

export function workspaceListDir(
  repoRoot: string,
  path = "",
): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>("workspace_list_dir", { repoRoot, path });
}

export function workspaceReadFile(
  repoRoot: string,
  path: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_file", {
    repoRoot,
    path,
    maxBytes: maxBytes ?? null,
  });
}

export function workspaceWriteFile(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_write_file", {
    repoRoot,
    path,
    contents,
    expectedHash: expectedHash ?? null,
  });
}
