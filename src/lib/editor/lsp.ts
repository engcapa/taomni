import { invoke } from "@tauri-apps/api/core";

export interface LspServerCommandPreset {
  id: string;
  label: string;
  command: string;
  args: string[];
  installHint: string;
  fallback: boolean;
}

export interface LspServerPreset {
  id: string;
  displayName: string;
  documentLanguageIds: string[];
  fileExtensions: string[];
  fileNames: string[];
  commands: LspServerCommandPreset[];
}

export interface LspCustomServerCommand {
  label?: string | null;
  command: string;
  args: string[];
}

export interface LspServerCommandStatus extends LspServerCommandPreset {
  available: boolean;
}

export interface LspServerStatus {
  presetId: string;
  displayName: string;
  documentLanguageIds: string[];
  available: boolean;
  active: boolean;
  selectedCommandId: string | null;
  selectedCommand: string | null;
  installHint: string;
  error: string | null;
  commands: LspServerCommandStatus[];
}

export interface LspDocumentStatus {
  path: string;
  uri: string;
  presetId: string | null;
  languageId: string | null;
  displayName: string | null;
  available: boolean;
  active: boolean;
  selectedCommandId: string | null;
  selectedCommand: string | null;
  installHint: string | null;
  error: string | null;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number | null;
  code: string | null;
  source: string | null;
  message: string;
}

export interface LspLocation {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface LspDiagnosticsResult {
  status: LspDocumentStatus;
  diagnostics: LspDiagnostic[];
}

export interface LspHoverResult {
  status: LspDocumentStatus;
  contents: string | null;
  range: LspRange | null;
}

export interface LspLocationsResult {
  status: LspDocumentStatus;
  locations: LspLocation[];
}

export interface LspDocumentDescriptor {
  workspaceId: string;
  rootPath?: string | null;
  filePath: string;
  languageId?: string | null;
  serverCommandId?: string | null;
  customServerCommand?: LspCustomServerCommand | null;
}

function documentArgs(descriptor: LspDocumentDescriptor) {
  return {
    workspaceId: descriptor.workspaceId,
    rootPath: descriptor.rootPath ?? null,
    filePath: descriptor.filePath,
    languageId: descriptor.languageId ?? null,
    serverCommandId: descriptor.serverCommandId ?? null,
    customServerCommand: descriptor.customServerCommand ?? null,
  };
}

export function lspListPresets(): Promise<LspServerPreset[]> {
  return invoke<LspServerPreset[]>("lsp_list_presets");
}

export function lspDetectServers(): Promise<LspServerStatus[]> {
  return invoke<LspServerStatus[]>("lsp_detect_servers");
}

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
  text: string,
  version: number,
): Promise<LspDocumentStatus> {
  return invoke<LspDocumentStatus>("lsp_change_document", {
    ...documentArgs(descriptor),
    text,
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

export function lspGetDiagnostics(
  descriptor: LspDocumentDescriptor,
): Promise<LspDiagnosticsResult> {
  return invoke<LspDiagnosticsResult>("lsp_get_diagnostics", documentArgs(descriptor));
}

export function lspHover(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspHoverResult> {
  return invoke<LspHoverResult>("lsp_hover", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspDefinition(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_definition", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspReferences(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  includeDeclaration = true,
): Promise<LspLocationsResult> {
  return invoke<LspLocationsResult>("lsp_references", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    includeDeclaration,
  });
}
