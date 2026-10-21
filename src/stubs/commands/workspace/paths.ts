import { VFS_ROOT } from "../../localVfs";

export function joinWorkspacePath(repoRoot: string, relative = ""): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const clean = relative.replace(/^\/+/, "").replace(/\\/g, "/");
  return clean ? `${root}/${clean}` : root;
}

export function relativeWorkspacePath(repoRoot: string, path: string): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const normalized = path.replace(/\\/g, "/");
  return normalized === root ? "" : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

export function parentWorkspacePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : separator === 0 ? "/" : null;
}

export function assertWorkspaceWritablePath(path: string): void {
  if (path.split(/[\\/]+/).includes(".git")) {
    throw new Error("Writing inside .git is not allowed");
  }
}
