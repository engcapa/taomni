import { invoke } from "@tauri-apps/api/core";
import { type WorkspaceFile } from "./model";
import { parseWorkspaceWriteError, type WorkspaceWriteAck } from "./writeModel";
import { notifyWorkspaceFilesChanged } from "./changes";

export async function workspaceWriteFile(
  repoRoot: string,
  path: string,
  contents: string,
  expectedHash?: string | null,
): Promise<WorkspaceFile> {
  try {
    const file = await invoke<WorkspaceFile>("workspace_write_file", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
    notifyWorkspaceFilesChanged(repoRoot, [path]);
    return file;
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
    const file = await invoke<WorkspaceFile>("workspace_write_loose_file", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
    });
    notifyWorkspaceFilesChanged("", [path]);
    return file;
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
    const ack = await invoke<WorkspaceWriteAck>("workspace_write_file_encoded", {
      repoRoot,
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
    notifyWorkspaceFilesChanged(repoRoot, [path]);
    return ack;
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
    const ack = await invoke<WorkspaceWriteAck>("workspace_write_loose_file_encoded", {
      path,
      contents,
      expectedHash: expectedHash ?? null,
      encoding,
      bom,
    });
    notifyWorkspaceFilesChanged("", [path]);
    return ack;
  } catch (err) {
    throw parseWorkspaceWriteError(err);
  }
}
