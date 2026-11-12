import { invoke } from "@tauri-apps/api/core";
import { notifyWorkspaceFilesChanged } from "./changes";
import { isWorkspaceEntry } from "./decoding";
import type { WorkspaceEntry } from "./model";

export interface WorkspaceImportResult {
  imported: WorkspaceEntry[];
  failures: { sourcePath: string; message: string }[];
}

function decodeImportResult(value: unknown): WorkspaceImportResult {
  if (!value || typeof value !== "object") throw new Error("workspace_import_paths returned no payload");
  const result = value as Partial<WorkspaceImportResult>;
  if (!Array.isArray(result.imported) || !result.imported.every(isWorkspaceEntry)
    || !Array.isArray(result.failures) || !result.failures.every((failure) => failure
      && typeof failure.sourcePath === "string" && typeof failure.message === "string")) {
    throw new Error("workspace_import_paths returned a malformed result");
  }
  return result as WorkspaceImportResult;
}

export async function workspaceImportPaths(repoRoot: string, directory: string, sourcePaths: string[]): Promise<WorkspaceImportResult> {
  const result = decodeImportResult(await invoke<unknown>("workspace_import_paths", { repoRoot, directory, sourcePaths }));
  if (result.imported.length) notifyWorkspaceFilesChanged(repoRoot, result.imported.map((entry) => entry.path));
  return result;
}
