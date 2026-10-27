/**
 * Local filesystem helpers for the Workspaces mode (TASK-05/06/07).
 *
 * The platform workspace root folders are plain absolute paths. All reads and
 * writes go through the existing `workspace_*` IPC (browser preview runs use
 * the virtual local filesystem stub), so file management behaves the same in
 * the browser harness and the packaged desktop app.
 */
import {
  workspaceCreateDir,
  workspaceCreateFile,
  workspaceDeletePath,
  workspaceListDir,
  workspaceReadFile,
  workspaceRenamePath,
  workspaceWriteFile,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "../../lib/editor/workspace";

export interface WorkspaceFileNode {
  name: string;
  path: string;
  kind: "file" | "folder";
  rootId: string;
}

export function joinRelativePath(directory: string, name: string): string {
  const cleanName = name.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const cleanDir = directory.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleanDir) return cleanName;
  return `${cleanDir}/${cleanName}`;
}

export function parentRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function entryName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

export async function listWorkspaceDirectory(rootPath: string, path: string): Promise<WorkspaceEntry[]> {
  const result = await workspaceListDir(rootPath, path);
  if (result.state === "ready") return [...result.entries];
  return [];
}

export function listErrorMessage(result: { state: string; message?: string; reason?: string }): string | null {
  if (result.state === "failed") return result.message ?? "Cannot list directory";
  if (result.state === "unavailable") return result.reason ?? "Filesystem unavailable";
  return null;
}

export async function createWorkspaceFileNode(rootPath: string, path: string): Promise<WorkspaceFile> {
  return workspaceCreateFile(rootPath, path);
}

export async function createWorkspaceFolderNode(rootPath: string, path: string): Promise<WorkspaceEntry> {
  return workspaceCreateDir(rootPath, path);
}

export async function readWorkspaceText(rootPath: string, path: string): Promise<WorkspaceFile> {
  return workspaceReadFile(rootPath, path);
}

export async function writeWorkspaceText(
  rootPath: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  return workspaceWriteFile(rootPath, path, contents, expectedHash ?? null);
}

export async function deleteWorkspaceEntry(rootPath: string, path: string, recursive = false): Promise<void> {
  await workspaceDeletePath(rootPath, path, recursive);
}

export async function renameWorkspaceEntry(
  rootPath: string,
  fromPath: string,
  toPath: string,
): Promise<WorkspaceEntry> {
  return workspaceRenamePath(rootPath, fromPath, toPath);
}

export function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    const aFolder = a.fileType === "dir" ? 0 : 1;
    const bFolder = b.fileType === "dir" ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
