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

export interface LspCapabilitySummary {
  completion: boolean;
  signatureHelp: boolean;
  hover: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  rename: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  codeAction: boolean;
  documentHighlight: boolean;
  callHierarchy: boolean;
  typeHierarchy: boolean;
  inlayHint: boolean;
  completionTriggerCharacters: string[];
  signatureTriggerCharacters: string[];
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
  capabilities?: LspCapabilitySummary | null;
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

export interface LspDocumentSymbol {
  name: string;
  detail: string | null;
  kind: number;
  depth: number;
  range: LspRange;
  selectionRange: LspRange;
}

export interface LspDocumentSymbolsResult {
  status: LspDocumentStatus;
  symbols: LspDocumentSymbol[];
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspCompletionItem {
  label: string;
  kind: number | null;
  detail: string | null;
  documentation: string | null;
  insertText: string | null;
  /** 1 = plain text, 2 = snippet. */
  insertTextFormat: number | null;
  filterText: string | null;
  sortText: string | null;
  textEdit: LspTextEdit | null;
  additionalTextEdits: LspTextEdit[];
  /** Original server item, passed back verbatim to completionItem/resolve. */
  raw: unknown;
}

export interface LspCompletionResult {
  status: LspDocumentStatus;
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspSignatureParameter {
  label: string;
  documentation: string | null;
  labelStart: number | null;
  labelEnd: number | null;
}

export interface LspSignatureInfo {
  label: string;
  documentation: string | null;
  parameters: LspSignatureParameter[];
  activeParameter: number | null;
}

export interface LspSignatureHelpResult {
  status: LspDocumentStatus;
  signatures: LspSignatureInfo[];
  activeSignature: number;
  activeParameter: number;
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

export function lspDocumentSymbols(
  descriptor: LspDocumentDescriptor,
): Promise<LspDocumentSymbolsResult> {
  return invoke<LspDocumentSymbolsResult>("lsp_document_symbols", documentArgs(descriptor));
}

export function lspCompletion(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
): Promise<LspCompletionResult> {
  return invoke<LspCompletionResult>("lsp_completion", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
  });
}

export function lspCompletionResolve(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspCompletionItem | null> {
  return invoke<LspCompletionItem | null>("lsp_completion_resolve", {
    ...documentArgs(descriptor),
    item,
  });
}

export function lspSignatureHelp(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
): Promise<LspSignatureHelpResult> {
  return invoke<LspSignatureHelpResult>("lsp_signature_help", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
  });
}

export interface LspFormattingResult {
  status: LspDocumentStatus;
  edits: LspTextEdit[];
}

export interface LspFormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
}

export function lspFormatting(
  descriptor: LspDocumentDescriptor,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_formatting", {
    ...documentArgs(descriptor),
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export function lspRangeFormatting(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_range_formatting", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export interface LspFileTextEdits {
  uri: string;
  path: string | null;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  documentEdits: LspFileTextEdits[];
}

export interface LspCodeAction {
  title: string;
  kind: string | null;
  isPreferred: boolean;
  edit: LspWorkspaceEdit | null;
  command: string | null;
  commandArguments: unknown;
  raw: unknown;
}

export interface LspCodeActionsResult {
  status: LspDocumentStatus;
  actions: LspCodeAction[];
}

export function lspCodeActions(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  diagnostics?: unknown[] | null,
): Promise<LspCodeActionsResult> {
  return invoke<LspCodeActionsResult>("lsp_code_actions", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    diagnostics: diagnostics ?? null,
  });
}

export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  containerName: string | null;
  uri: string;
  path: string | null;
  range: LspRange;
  selectionRange: LspRange;
}

export interface LspWorkspaceSymbolsResult {
  status: LspDocumentStatus;
  symbols: LspWorkspaceSymbol[];
}

export function lspWorkspaceSymbols(
  descriptor: LspDocumentDescriptor,
  query: string,
): Promise<LspWorkspaceSymbolsResult> {
  return invoke<LspWorkspaceSymbolsResult>("lsp_workspace_symbols", {
    ...documentArgs(descriptor),
    query,
  });
}

/** LSP SymbolKind values treated as "classes" in Search Everywhere. */
export const LSP_CLASS_SYMBOL_KINDS = new Set([5, 10, 11, 23, 26]);

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
