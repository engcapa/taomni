import { invoke } from "@tauri-apps/api/core";
import { decodeWorkspaceCompactChain, decodeWorkspaceEntries, errorMessage } from "./decoding";
import { type WorkspaceEntry, type WorkspaceGitRoot, type WorkspaceGitRootCandidate, type WorkspaceTreeLoadResult } from "./model";

export function workspaceListDir(
  repoRoot: string,
  path = "",
): Promise<WorkspaceTreeLoadResult<WorkspaceEntry>> {
  return invoke<unknown>("workspace_list_dir", { repoRoot, path })
    .then((value) => decodeWorkspaceEntries(value, "workspace_list_dir"))
    .catch((error: unknown) => ({
      state: "failed" as const,
      message: errorMessage(error),
    }));
}

export function workspaceCompactChain(
  repoRoot: string,
  path: string,
  maxDepth?: number,
): Promise<WorkspaceTreeLoadResult<WorkspaceEntry>> {
  return invoke<unknown>("workspace_compact_chain", {
    repoRoot,
    path,
    maxDepth: maxDepth ?? null,
  })
    .then((value) => decodeWorkspaceCompactChain(value, "workspace_compact_chain"))
    .catch((error: unknown) => ({
      state: "failed" as const,
      message: errorMessage(error),
    }));
}

export function workspaceListFilesRecursive(
  repoRoot: string,
  path = "",
  maxDepth?: number,
  maxFiles?: number,
): Promise<WorkspaceTreeLoadResult<WorkspaceEntry>> {
  return invoke<unknown>("workspace_list_files_recursive", {
    repoRoot,
    path,
    maxDepth: maxDepth ?? null,
    maxFiles: maxFiles ?? null,
  })
    .then((value) =>
      decodeWorkspaceEntries(value, "workspace_list_files_recursive", maxFiles),
    )
    .catch((error: unknown) => ({
      state: "failed" as const,
      message: errorMessage(error),
    }));
}

export function workspaceDetectGitRoots(
  roots: WorkspaceGitRootCandidate[],
): Promise<WorkspaceGitRoot[]> {
  return invoke<WorkspaceGitRoot[]>("workspace_detect_git_roots", { roots });
}
