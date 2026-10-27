import { invoke } from "@tauri-apps/api/core";
import {
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspDocumentContentChange,
  type LspDiagnosticsResult,
  type WorkspaceDiagnosticFile,
  type LspDocumentSymbolsResult,
} from "./types";
import { documentArgs } from "./documentArguments";

export function lspDocumentStatus(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_document_status", documentArgs(descriptor));
}

export function lspOpenDocument(
  descriptor: LspDocumentDescriptor,
  text: string,
  version: number,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_open_document", {
    ...documentArgs(descriptor),
    text,
    version,
  });
}

export function lspChangeDocument(
  descriptor: LspDocumentDescriptor,
  text: string | null,
  version: number,
  change: LspDocumentContentChange | null = null,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_change_document", {
    ...documentArgs(descriptor),
    text,
    change,
    version,
  });
}

export function lspSaveDocument(
  descriptor: LspDocumentDescriptor,
  text: string | null,
  version: number,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_save_document", {
    ...documentArgs(descriptor),
    text,
    version,
  });
}

export function lspCloseDocument(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_close_document", documentArgs(descriptor));
}

export function lspStopWorkspace(workspaceId: string, preserveFileWatcher = false): Promise<number> {
  return invoke<number>("lsp_stop_workspace", {
    workspaceId,
    ...(preserveFileWatcher ? { preserveFileWatcher: true } : {}),
  });
}

export function lspGetDiagnostics(
  descriptor: LspDocumentDescriptor,
): Promise<LspDiagnosticsResult> {
  return invoke<LspDiagnosticsResult>("lsp_get_diagnostics", documentArgs(descriptor));
}

/**
 * Refresh pull-capable LSP 3.17 servers, then return diagnostics stored across
 * the workspace's active sessions, including files the user never opened. The
 * Problems panel polls this while whole-project scope is open.
 */
export function lspWorkspaceDiagnostics(workspaceId: string): Promise<WorkspaceDiagnosticFile[]> {
  return invoke<WorkspaceDiagnosticFile[]>("lsp_workspace_diagnostics", { workspaceId });
}

export function lspDocumentSymbols(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentSymbolsResult> {
  return invoke<LspDocumentSymbolsResult>("lsp_document_symbols", documentArgs(descriptor));
}
