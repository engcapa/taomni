import { invoke } from "@tauri-apps/api/core";
import { type WorkspaceFile } from "./model";
import { parseWorkspaceWriteError, type WorkspaceWriteAck } from "./writeModel";

export async function workspaceWriteFile(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_file", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

export async function workspaceWriteLooseFile(
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  try {
    return await invoke<WorkspaceFile>("workspace_write_loose_file", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

/** Persist a workspace file using an explicit charset and BOM preference. */
export async function workspaceWriteFileEncoded(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceWriteAck> {
  try {
    return await invoke<WorkspaceWriteAck>("workspace_write_file_encoded", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}

/** Persist a loose file using an explicit charset and BOM preference. */
export async function workspaceWriteLooseFileEncoded(
  path: string,
  contents: string,
  expectedHash: string | null | undefined,
  encoding: string,
  bom = false,
): Promise<WorkspaceWriteAck> {
  try {
    return await invoke<WorkspaceWriteAck>("workspace_write_loose_file_encoded", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}
