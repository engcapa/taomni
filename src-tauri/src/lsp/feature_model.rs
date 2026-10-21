use super::navigation_model::LspLocation;
use super::status_model::LspDocumentStatus;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentContentChange {
    pub range: LspRange,
    pub range_length: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u8>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
    pub tags: Vec<u8>,
    pub related_information: Vec<LspDiagnosticRelatedInformation>,
    pub code_description: Option<String>,
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticRelatedInformation {
    pub location: LspLocation,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsResult {
    pub status: LspDocumentStatus,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Contents of a library / virtual document (JDK, dependency JAR, jdt:// URI).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspUriContentsResult {
    pub status: LspDocumentStatus,
    pub uri: String,
    pub path: Option<String>,
    pub title: String,
    /// Human label for where the source came from (package · jar/module).
    pub container: Option<String>,
    pub language_id: String,
    pub text: String,
    pub read_only: bool,
    /// True when `text` is FernFlower-decompiled bytecode rather than attached
    /// source. The UI offers "Download sources" in this case (jdtls only).
    pub decompiled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlight {
    pub range: LspRange,
    /// 1 = text, 2 = read, 3 = write.
    pub kind: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentHighlightsResult {
    pub status: LspDocumentStatus,
    pub highlights: Vec<LspDocumentHighlight>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHint {
    pub position: LspPosition,
    pub label: String,
    /// 1 = type, 2 = parameter.
    pub kind: Option<u8>,
    pub tooltip: Option<String>,
    pub padding_left: bool,
    pub padding_right: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHintsResult {
    pub status: LspDocumentStatus,
    pub hints: Vec<LspInlayHint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSelectionRangesResult {
    pub status: LspDocumentStatus,
    /// Innermost to outermost range for the requested position.
    pub ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticToken {
    pub range: LspRange,
    pub token_type: String,
    pub modifiers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticTokensResult {
    pub status: LspDocumentStatus,
    pub tokens: Vec<LspSemanticToken>,
}

/// Feature summary distilled from the server's `initialize` response so the
/// UI can enable/disable entry points per capability instead of guessing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilitySummary {
    /// 0 = none, 1 = full, 2 = incremental.
    pub text_document_sync_kind: u8,
    pub completion: bool,
    pub signature_help: bool,
    pub hover: bool,
    pub definition: bool,
    pub declaration: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub references: bool,
    pub document_symbol: bool,
    pub workspace_symbol: bool,
    /// The workspace-symbol provider accepts `workspaceSymbol/resolve`.
    pub workspace_symbol_resolve: bool,
    pub rename: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub code_action: bool,
    pub document_highlight: bool,
    pub call_hierarchy: bool,
    pub type_hierarchy: bool,
    pub inlay_hint: bool,
    pub selection_range: bool,
    pub semantic_tokens: bool,
    pub workspace_diagnostics: bool,
    pub code_action_kinds: Vec<String>,
    pub completion_trigger_characters: Vec<String>,
    pub signature_trigger_characters: Vec<String>,
}
