import { VFS_ROOT, vfsRemove, vfsRename, vfsStat, vfsWriteText } from "../../localVfs";
import { assertWorkspaceWritablePath, joinWorkspacePath, parentWorkspacePath, relativeWorkspacePath } from "./paths";

export type StubWorkspaceResourceOperation =
  | {
    kind: "create";
    path: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "rename";
    fromPath: string;
    toPath: string;
    toRepoRoot?: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "delete";
    path: string;
    recursive: boolean;
    ignoreIfNotExists: boolean;
  };

export async function workspaceResourceVfsEntry(path: string): Promise<Awaited<ReturnType<typeof vfsStat>> | null> {
  try {
    return await vfsStat(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not found:")) return null;
    throw error;
  }
}

export async function applyStubWorkspaceResourceOperation(
  repoRoot: string,
  operation: StubWorkspaceResourceOperation,
): Promise<{ ignored: boolean; }> {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  if (operation.kind === "create") {
    assertWorkspaceWritablePath(operation.path);
    const target = joinWorkspacePath(root, operation.path);
    const existing = await workspaceResourceVfsEntry(target);
    if (existing) {
      if (operation.overwrite) {
        if (existing.fileType === "dir") {
          throw new Error(`CreateFile cannot overwrite directory: ${target}`);
        }
        await vfsRemove(target, false);
        await vfsWriteText(target, "");
      } else if (operation.ignoreIfExists) {
        return { ignored: true };
      } else {
        throw new Error(`Path already exists: ${target}`);
      }
    } else {
      await vfsWriteText(target, "");
    }
    return { ignored: false };
  }

  if (operation.kind === "delete") {
    assertWorkspaceWritablePath(operation.path);
    const target = joinWorkspacePath(root, operation.path);
    if (relativeWorkspacePath(root, target) === "") {
      throw new Error("Cannot delete the workspace root");
    }
    if (!(await workspaceResourceVfsEntry(target))) {
      if (operation.ignoreIfNotExists) return { ignored: true };
      throw new Error(`Path does not exist: ${target}`);
    }
    await vfsRemove(target, operation.recursive);
    return { ignored: false };
  }

  assertWorkspaceWritablePath(operation.fromPath);
  assertWorkspaceWritablePath(operation.toPath);
  const from = joinWorkspacePath(root, operation.fromPath);
  const destinationRoot = (operation.toRepoRoot || root).replace(/\/+$/, "") || VFS_ROOT;
  const to = joinWorkspacePath(destinationRoot, operation.toPath);
  const sourceEntry = await workspaceResourceVfsEntry(from);
  if (!sourceEntry) throw new Error(`Path does not exist: ${from}`);
  if (from === to) return { ignored: true };
  if (sourceEntry.fileType === "dir" && to.startsWith(`${from}/`)) {
    throw new Error(`Cannot move directory ${from} inside itself`);
  }
  const destinationEntry = await workspaceResourceVfsEntry(to);
  if (destinationEntry) {
    if (operation.overwrite) {
      await vfsRemove(to, true);
    } else if (operation.ignoreIfExists) {
      return { ignored: true };
    } else {
      throw new Error(`Path already exists: ${to}`);
    }
  }
  const destinationParent = parentWorkspacePath(to);
  if (destinationParent && !(await workspaceResourceVfsEntry(destinationParent))) {
    throw new Error(`Parent does not exist: ${destinationParent}`);
  }
  await vfsRename(from, to);
  return { ignored: false };
}

export async function workspaceEntryFromVfs(repoRoot: string, path: string) {
  const entry = await vfsStat(path);
  return {
    name: entry.name,
    path: relativeWorkspacePath(repoRoot, entry.path),
    fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
    size: entry.size,
    mtime: entry.mtime,
    isHidden: entry.isHidden,
  };
}
