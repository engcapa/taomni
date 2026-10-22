import { invoke } from "@tauri-apps/api/core";
import { type LspWorkspaceFileOperation, type LspWatchedFileChange } from "./types";

export function lspResolveWorkspaceEdit(
  requestId: string,
  workspaceId: string,
  applied: boolean,
  failureReason: string | null = null,
  failedChange: number | null = null,
): Promise<void> {
  return invoke<void>("lsp_resolve_workspace_edit", {
    requestId,
    workspaceId,
    applied,
    failureReason,
    failedChange,
  });
}

export function lspResolveShowMessageRequest(
  requestId: string,
  workspaceId: string,
  actionIndex: number | null,
): Promise<void> {
  return invoke<void>("lsp_resolve_show_message_request", {
    requestId,
    workspaceId,
    actionIndex,
  });
}

export function lspCancelWorkDoneProgress(
  workspaceId: string,
  presetId: string,
  rootUri: string,
  token: string | number,
): Promise<boolean> {
  return invoke<boolean>("lsp_cancel_work_done_progress", {
    workspaceId,
    presetId,
    rootUri,
    token,
  });
}

export function lspWorkspaceWillFileOperation(
  workspaceId: string,
  operation: LspWorkspaceFileOperation,
): Promise<number> {
  return invoke<number>("lsp_workspace_will_file_operation", { workspaceId, operation });
}

export function lspWorkspaceDidFileOperation(
  workspaceId: string,
  operation: LspWorkspaceFileOperation,
): Promise<number> {
  return invoke<number>("lsp_workspace_did_file_operation", { workspaceId, operation });
}

export function lspWorkspaceDidChangeWatchedFiles(
  workspaceId: string,
  changes: LspWatchedFileChange[],
): Promise<number> {
  return invoke<number>("lsp_workspace_did_change_watched_files", { workspaceId, changes });
}

export function lspStartWorkspaceWatcher(
  workspaceId: string,
  roots: string[],
): Promise<void> {
  return invoke<void>("lsp_start_workspace_watcher", { workspaceId, roots });
}

export function lspStopWorkspaceWatcher(workspaceId: string): Promise<void> {
  return invoke<void>("lsp_stop_workspace_watcher", { workspaceId });
}
