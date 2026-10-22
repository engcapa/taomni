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
  /** Runtime probe from the backend (e.g. Java major + path for jdtls). */
  runtimeStatus?: string | null;
  commands: LspServerCommandStatus[];
}

export interface LspCapabilitySummary {
  /** LSP TextDocumentSyncKind: 0 = none, 1 = full, 2 = incremental. */
  textDocumentSyncKind?: number;
  completion: boolean;
  signatureHelp: boolean;
  hover: boolean;
  definition: boolean;
  declaration?: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  /** The provider accepts LSP 3.17 workspaceSymbol/resolve requests. */
  workspaceSymbolResolve?: boolean;
  rename: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  codeAction: boolean;
  documentHighlight: boolean;
  callHierarchy: boolean;
  typeHierarchy: boolean;
  inlayHint: boolean;
  selectionRange: boolean;
  semanticTokens: boolean;
  /** Whole-project pull diagnostics (`workspace/diagnostic`). */
  workspaceDiagnostics?: boolean;
  /** CodeActionKind values explicitly advertised by the server. Empty means unknown. */
  codeActionKinds?: string[];
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
  /** False while a provider such as JDT LS is still importing/indexing its workspace. */
  semanticReady?: boolean;
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

export interface LspDocumentContentChange {
  range: LspRange;
  rangeLength: number;
  text: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number | null;
  code: string | null;
  source: string | null;
  message: string;
  /** LSP DiagnosticTag: 1 = unnecessary, 2 = deprecated. */
  tags?: number[];
  relatedInformation?: LspDiagnosticRelatedInformation[];
  codeDescription?: string | null;
  /** Bounded opaque provider data, echoed back for code actions when present. */
  data?: unknown;
}

export interface LspLocation {
  uri: string;
  path: string | null;
  range: LspRange;
}

export interface LspDiagnosticRelatedInformation {
  location: LspLocation;
  message: string;
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

/** Library / virtual document opened from jdt://, jar:, or an absolute file URI. */
export interface LspUriContentsResult {
  status: LspDocumentStatus;
  uri: string;
  path: string | null;
  title: string;
  /** Package · jar/module label for the tab subtitle. */
  container: string | null;
  languageId: string;
  text: string;
  readOnly: boolean;
  /** True when `text` is decompiled bytecode; the UI offers "Download sources". */
  decompiled: boolean;
}

/** Outcome of an on-demand "Download sources" request (jdtls Java classes). */
export interface LspDownloadSourcesResult {
  /** True when attached (non-decompiled) source is now available. */
  attached: boolean;
  /** Fresh class contents to swap into the open buffer. */
  text: string;
  decompiled: boolean;
  /** Why nothing was attached, when `attached` is false. */
  message: string | null;
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
  annotationId?: string;
}

export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
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
  /** Completion-only dual range; other TextEdit consumers keep `textEdit`. */
  insertReplaceEdit?: LspInsertReplaceEdit | null;
  additionalTextEdits: LspTextEdit[];
  /** Original server item, passed back verbatim to completionItem/resolve. */
  raw: unknown;
}

export interface LspCompletionResult {
  status: LspDocumentStatus;
  isIncomplete: boolean;
  items: LspCompletionItem[];
  /** Backend truncated the item list at its hard cap (200). */
  truncated?: boolean | null;
}

export type LspCompletionResolveResult =
  | { kind: "resolved"; item: LspCompletionItem; }
  | { kind: "unavailable"; reason: string; }
  | { kind: "timeout"; }
  | { kind: "failed"; message: string; };

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
  /**
   * Virtual document URI to request instead of `filePath`'s own file URI, used by
   * library buffers (JDK / dependency `jdt://` sources). `filePath` still selects
   * the language-server session, so it must point at a file in the origin project.
   */
  documentUri?: string | null;
  languageId?: string | null;
  serverCommandId?: string | null;
  customServerCommand?: LspCustomServerCommand | null;
  /** Optional JDK home or java binary for jdtls (Java 21+). */
  javaHome?: string | null;
}

/**
 * jdtls `java.*` language settings mirrored to the backend. Field names match the
 * Rust `JavaLanguageSettings` serde shape (camelCase); the backend fills any omitted
 * field from its defaults, so partial payloads are safe.
 */
export interface LspJavaSettings {
  autobuildEnabled: boolean;
  lombokEnabled: boolean;
  lombokJarPath: string;
  saveActionsOrganizeImports: boolean;
  formatSettingsUrl: string;
  formatSettingsProfile: string;
  guessMethodArguments: boolean;
  completionImportOrder: string[];
  organizeImportsStarThreshold: number;
  organizeImportsStaticStarThreshold: number;
  mavenImportEnabled: boolean;
  gradleImportEnabled: boolean;
}

/**
 * jdtls extension bundle paths (M8). Each is a directory holding the versioned
 * jar, or the jar path itself. Lombok is NOT here — it loads as a `-javaagent`.
 */
export interface LspJavaBundleConfig {
  javaDebugPath: string;
  javaTestPath: string;
}

/** Probe result for one jdtls extension bundle. */
export interface LspBundleStatus {
  id: string;
  path: string | null;
  available: boolean;
}

/** A jdtls extension jar found inside an installed VS Code / Cursor extension. */
export interface LspDiscoveredBundle {
  /** "javaDebug" | "javaTest". */
  id: string;
  path: string;
  version: string;
  /** Where it was found, e.g. "vscode: vscjava.vscode-java-debug-0.58.0". */
  source: string;
}

/** A discovered Java test node (class or method) from the java-test bundle (M8 E). */
export interface JavaTestItem {
  name: string;
  fullName: string;
  /** "class" | "method" | "other". */
  kind: string;
  uri: string | null;
  range: LspRange | null;
  children: JavaTestItem[];
}

/** A java-test-resolved launch config for debugging a test (M9 debug-test). */
export interface JavaTestLaunch {
  mainClass: string;
  projectName: string;
  classPaths: string[];
  modulePaths: string[];
  args: string[];
  vmArgs: string[];
}

/** One file's diagnostics in the workspace-wide Problems view (M7-C). */
export interface WorkspaceDiagnosticFile {
  path: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

/** jdtls `BuildWorkspaceStatus`, so callers can distinguish "built with compile errors". */
export type LspBuildStatus = "failed" | "succeed" | "withError" | "cancelled";

/**
 * Repeated-Basic-call facts (§8.19.4). The second explicit invocation at one
 * caret requests expanded scope; the backend records what it received so the
 * provider side of the expansion story is traceable.
 */
export interface LspCompletionInvocation {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
}

export interface LspReferenceRequestOptions {
  /** Abort signal owned by the semantic query host. */
  signal?: AbortSignal;
  /** Per-file cancellation key shared with the native cancel registry. */
  cancelKey?: string;
  /**
   * Monotonic request sequence; a higher seq for the same cancelKey aborts
   * this request via `$/cancelRequest` (§8.18.6/§8.20.2).
   */
  requestSeq?: number;
}

// §8.20.3 W2: provider-owned Project Analysis facts.
export interface LspJavaProjectModuleInfo {
  id: string;
  rootUri: string | null;
}

export interface LspJavaClasspathProbeInfo {
  rootUri: string | null;
  entryCount: number;
  entriesSha256: string;
}

export interface LspBuildFileHashInfo {
  path: string;
  sha256: string;
}

export interface LspJavaProjectModelResult {
  status: LspDocumentStatus;
  active: boolean;
  processId: number | null;
  serverName: string | null;
  serverVersion: string | null;
  registeredCommands: string[];
  buildFiles: LspBuildFileHashInfo[];
  javaHomeUsed: string | null;
  javaProjects: LspJavaProjectModuleInfo[];
  classpathProbe: LspJavaClasspathProbeInfo | null;
  probeReason: string | null;
}

export interface LspFormattingResult {
  status: LspDocumentStatus;
  edits: LspTextEdit[];
}

export interface LspFormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
}

export interface LspFileTextEdits {
  uri: string;
  path: string | null;
  /** VersionedTextDocumentIdentifier.version; null/omitted accepts the current version. */
  version?: number | null;
  edits: LspTextEdit[];
  /** ChangeAnnotation ids referenced by AnnotatedTextEdit entries in this document. */
  annotationIds?: string[];
}

export interface LspChangeAnnotation {
  id: string;
  label: string;
  needsConfirmation: boolean;
  description: string | null;
}

export type LspWorkspaceEditOperation =
  | {
    kind: "text";
    document: LspFileTextEdits;
  }
  | {
    kind: "create";
    uri: string;
    path: string | null;
    overwrite: boolean;
    ignoreIfExists: boolean;
    annotationId: string | null;
  }
  | {
    kind: "rename";
    oldUri: string;
    oldPath: string | null;
    newUri: string;
    newPath: string | null;
    overwrite: boolean;
    ignoreIfExists: boolean;
    annotationId: string | null;
  }
  | {
    kind: "delete";
    uri: string;
    path: string | null;
    recursive: boolean;
    ignoreIfNotExists: boolean;
    annotationId: string | null;
  };

export interface LspWorkspaceEdit {
  documentEdits: LspFileTextEdits[];
  /** Ordered LSP documentChanges. Older local producers may omit this field. */
  operations?: LspWorkspaceEditOperation[];
  /** Normalized entries from WorkspaceEdit.changeAnnotations. */
  changeAnnotations?: LspChangeAnnotation[];
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

export interface LspCodeActionResolveResult {
  status: LspDocumentStatus;
  action: LspCodeAction | null;
}

export interface LspWorkspaceApplyEditRequest {
  requestId: string;
  workspaceId: string;
  label: string | null;
  edit: LspWorkspaceEdit;
}

export interface LspShowMessageAction {
  title: string;
  [key: string]: unknown;
}

export interface LspShowMessageRequest {
  requestId: string;
  workspaceId: string;
  serverLabel: string;
  /** LSP MessageType: 1 error, 2 warning, 3 info, 4 log. */
  messageType: number;
  message: string;
  actions: LspShowMessageAction[];
}

export interface LspShowMessageCancelled {
  requestId: string;
  workspaceId: string;
  reason: string;
}

export interface LspShowMessageNotification {
  workspaceId: string;
  serverLabel: string;
  messageType: number;
  message: string;
}

export interface LspWorkDoneProgressEvent {
  workspaceId: string;
  presetId: string;
  serverLabel: string;
  rootUri: string;
  token: string | number;
  kind: "begin" | "report" | "end";
  title: string | null;
  message: string | null;
  percentage: number | null;
  cancellable: boolean;
}

export interface LspWorkspaceFileOperationTarget {
  path: string;
  isDirectory: boolean;
}

export interface LspWorkspaceFileRenameTarget {
  oldPath: string;
  newPath: string;
  isDirectory: boolean;
}

export type LspWorkspaceFileOperation =
  | { kind: "create"; files: LspWorkspaceFileOperationTarget[]; }
  | { kind: "rename"; files: LspWorkspaceFileRenameTarget[]; }
  | { kind: "delete"; files: LspWorkspaceFileOperationTarget[]; };

export interface LspWatchedFileChange {
  path: string;
  /** LSP FileChangeType: 1 = created, 2 = changed, 3 = deleted. */
  type: 1 | 2 | 3;
}

export interface LspExternalFileChange {
  workspaceId: string;
  path: string;
  type: 1 | 2 | 3;
}

export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  containerName: string | null;
  uri: string;
  path: string | null;
  range: LspRange;
  selectionRange: LspRange;
  /** False when the provider returned only a URI and navigation must resolve it first. */
  resolved: boolean;
  /** Opaque, short-lived backend handle; raw provider payloads never enter the webview. */
  resolveToken?: string | null;
}

export interface LspWorkspaceSymbolsResult {
  status: LspDocumentStatus;
  symbols: LspWorkspaceSymbol[];
  /** Number of ready language-server sessions discovered for this workspace. */
  sessionCount: number;
  /** Number of provider sessions actually queried. */
  providerCount: number;
  /** Ready sessions skipped because they lack the capability or exceeded the fan-out bound. */
  skippedProviderCount: number;
  /** Providers whose request or response could not be consumed. */
  failedProviderCount: number;
  /** False when the provider fan-out failed, was unavailable, or truncated. */
  complete: boolean;
  truncated: boolean;
  diagnostics: string[];
}

export interface LspHierarchyItem {
  name: string;
  detail: string | null;
  kind: number;
  uri: string;
  path: string | null;
  range: LspRange;
  selectionRange: LspRange;
  /** Original server item retained for lazy hierarchy requests. */
  raw: unknown;
}

export interface LspHierarchyPrepareResult {
  status: LspDocumentStatus;
  items: LspHierarchyItem[];
}

export interface LspCallHierarchyEntry {
  item: LspHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyResult {
  status: LspDocumentStatus;
  entries: LspCallHierarchyEntry[];
}

export interface LspTypeHierarchyResult {
  status: LspDocumentStatus;
  items: LspHierarchyItem[];
}

export interface LspDocumentHighlight {
  range: LspRange;
  /** 1 = text, 2 = read, 3 = write. */
  kind: number | null;
}

export interface LspDocumentHighlightsResult {
  status: LspDocumentStatus;
  highlights: LspDocumentHighlight[];
}

export interface LspInlayHint {
  position: LspPosition;
  label: string;
  /** 1 = type, 2 = parameter. */
  kind: number | null;
  tooltip: string | null;
  paddingLeft: boolean;
  paddingRight: boolean;
}

export interface LspInlayHintsResult {
  status: LspDocumentStatus;
  hints: LspInlayHint[];
}

export interface LspSelectionRangesResult {
  status: LspDocumentStatus;
  ranges: LspRange[];
}

export interface LspSemanticToken {
  range: LspRange;
  tokenType: string;
  modifiers: string[];
}

export interface LspSemanticTokensResult {
  status: LspDocumentStatus;
  tokens: LspSemanticToken[];
}

export interface LspPrepareRenameResult {
  status: LspDocumentStatus;
  range: LspRange | null;
  placeholder: string | null;
  allowed: boolean;
  message: string | null;
}

export interface LspRenameResult {
  status: LspDocumentStatus;
  edit: LspWorkspaceEdit;
}

/** A Java project/module discovered by jdtls `java.project.getAll` (M7 F-4). */
export interface JavaModule {
  name: string;
  path: string;
  uri: string;
}
