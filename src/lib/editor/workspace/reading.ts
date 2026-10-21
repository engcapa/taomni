import { invoke } from "@tauri-apps/api/core";
import { invokeWithPerformanceObservation } from "../../performanceInstrumentation";
import { type WorkspaceFile } from "./model";

export function workspaceReadFile(
  repoRoot: string,
  path: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  const args = {
    repoRoot,
    path,
    maxBytes: maxBytes ?? null,
  };
  return invokeWithPerformanceObservation(
    "workspace_read_file",
    args,
    () => invoke<WorkspaceFile>("workspace_read_file", args),
  );
}

export function workspaceReadLooseFile(
  path: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  const args = {
    path,
    maxBytes: maxBytes ?? null,
  };
  return invokeWithPerformanceObservation(
    "workspace_read_loose_file",
    args,
    () => invoke<WorkspaceFile>("workspace_read_loose_file", args),
  );
}

/** Read a workspace file using an explicit charset selected in the editor. */
export function workspaceReadFileWithEncoding(
  repoRoot: string,
  path: string,
  encoding: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_file_with_encoding", {
    repoRoot,
    path,
    maxBytes: maxBytes ?? null,
    encoding,
  });
}

/** Read a loose file using an explicit charset selected in the editor. */
export function workspaceReadLooseFileWithEncoding(
  path: string,
  encoding: string,
  maxBytes?: number,
): Promise<WorkspaceFile> {
  return invoke<WorkspaceFile>("workspace_read_loose_file_with_encoding", {
    path,
    maxBytes: maxBytes ?? null,
    encoding,
  });
}
