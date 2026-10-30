import { invoke } from "@tauri-apps/api/core";
import { type WorkspaceEntry, type WorkspaceFile } from "./model";
import { notifyWorkspaceFilesChanged } from "./changes";

export function workspaceCreateFile(
  repoRoot: string,
  path: string,
  contents = "",
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_create_file", {
    repoRoot,
    path,
    contents,
  }).then((file) => {
    notifyWorkspaceFilesChanged(repoRoot, [path]);
    return file;
  });
}

export function workspaceCreateDir(
  repoRoot: string,
  path: string,
): Promise<WorkspaceEntry> {
  return invoke<WorkspaceEntry>("workspace_create_dir", { repoRoot, path });
}

export function workspaceDeletePath(
  repoRoot: string,
  path: string,
  recursive = false,
): Promise<void> {
  return invoke<void>("workspace_delete_path", { repoRoot, path, recursive }).then(() => {
    notifyWorkspaceFilesChanged(repoRoot, [path]);
  });
}

export function workspaceRenamePath(
  repoRoot: string,
  fromPath: string,
  toPath: string,
): Promise<WorkspaceEntry> {
  return invoke<WorkspaceEntry>("workspace_rename_path", {
    repoRoot,
    fromPath,
    toPath,
  }).then((entry) => {
    notifyWorkspaceFilesChanged(repoRoot, [fromPath, toPath]);
    return entry;
  });
}

export type WorkspaceResourceOperation =
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
    /** Destination workspace root; omitted for a rename within repoRoot. */
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

export interface WorkspaceResourceOperationResult {
  ignored: boolean;
}

export function workspaceApplyResourceOperation(
  repoRoot: string,
  operation: WorkspaceResourceOperation,
): Promise<WorkspaceResourceOperationResult> {
  return invoke<WorkspaceResourceOperationResult>("workspace_apply_resource_operation", {
    repoRoot,
    operation,
  }).then((result) => {
    if (!result.ignored) {
      if (operation.kind === "rename") {
        notifyWorkspaceFilesChanged(repoRoot, [operation.fromPath]);
        notifyWorkspaceFilesChanged(operation.toRepoRoot ?? repoRoot, [operation.toPath]);
      } else {
        notifyWorkspaceFilesChanged(repoRoot, [operation.path]);
      }
    }
    return result;
  });
}
