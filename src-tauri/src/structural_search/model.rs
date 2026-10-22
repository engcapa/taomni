use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

pub const BACKEND_ID: &str = "tree-sitter-java";
pub const PARSER_VERSION: &str = "tree-sitter 0.25.10";
pub const GRAMMAR_VERSION: &str = "tree-sitter-java 0.23.5";
pub(super) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const MAX_MATCHES: usize = 5_000;
pub(super) const VAR_PREFIX: &str = "__ssr_var_";

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StructuralQueryVariable {
    pub min_count: u32,
    pub max_count: Option<u32>,
    pub text: Option<String>,
    #[serde(rename = "type")]
    pub type_constraint: Option<String>,
    pub reference: Option<String>,
    pub invert: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralQuery {
    pub schema_version: u32,
    pub language_id: String,
    pub pattern: String,
    #[serde(default)]
    pub variables: BTreeMap<String, StructuralQueryVariable>,
    pub scope: String,
    #[serde(default)]
    pub match_case: bool,
    /// Structural Replace payload. Only its presence is inspected: Replace is
    /// a later card and is rejected as an unsupported constraint.
    #[serde(default)]
    pub replacement: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchRoot {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralActiveFile {
    pub root_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchBuffer {
    pub root_id: String,
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchRequest {
    pub request_id: String,
    pub query: StructuralQuery,
    pub roots: Vec<StructuralSearchRoot>,
    #[serde(default)]
    pub active_file: Option<StructuralActiveFile>,
    #[serde(default)]
    pub buffers: Vec<StructuralSearchBuffer>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralBackendInfo {
    pub id: &'static str,
    pub parser: &'static str,
    pub grammar: &'static str,
}

pub(super) fn backend_info() -> StructuralBackendInfo {
    StructuralBackendInfo {
        id: BACKEND_ID,
        parser: PARSER_VERSION,
        grammar: GRAMMAR_VERSION,
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralPosition {
    /// Zero-based line.
    pub line: usize,
    /// Zero-based UTF-16 column (the editor/LSP convention).
    pub character: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralCapture {
    pub name: String,
    pub text: String,
    pub start: StructuralPosition,
    pub end: StructuralPosition,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralContainer {
    /// `class`, `interface`, `enum`, `record`, `method` or `constructor`.
    pub kind: &'static str,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralMatch {
    pub root_id: String,
    pub root_name: String,
    pub path: String,
    pub start: StructuralPosition,
    pub end: StructuralPosition,
    pub start_byte: usize,
    pub end_byte: usize,
    /// Full text of the first matched line, for the result row preview.
    pub line_text: String,
    pub matched_text: String,
    pub captures: Vec<StructuralCapture>,
    /// Outermost first, e.g. `[class StructuralTarget, method run]`.
    pub containers: Vec<StructuralContainer>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchStats {
    pub files_scanned: usize,
    pub files_with_parse_errors: usize,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralUnavailableReason {
    UnsupportedLanguage,
    BackendMissing,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralErrorCode {
    InvalidPattern,
    UnsupportedConstraint,
    InvalidScope,
    InvalidRequest,
    FileRead,
    UnsupportedEncoding,
    FileTooLarge,
    FileParse,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum StructuralSearchResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        request_id: String,
        backend: StructuralBackendInfo,
        matches: Vec<StructuralMatch>,
        truncated: bool,
        stats: StructuralSearchStats,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        request_id: String,
        reason: StructuralUnavailableReason,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        request_id: String,
        code: StructuralErrorCode,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Cancelled {
        request_id: String,
        stats: StructuralSearchStats,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchCapabilities {
    pub available: bool,
    pub backend: StructuralBackendInfo,
    pub languages: Vec<&'static str>,
    pub scopes: Vec<&'static str>,
    pub active_requests: usize,
}
