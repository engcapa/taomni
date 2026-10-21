use super::feature_model::LspRange;
use super::status_model::LspDocumentStatus;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextEdit {
    pub range: LspRange,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInsertReplaceEdit {
    pub new_text: String,
    pub insert: LspRange,
    pub replace: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
    /// 1 = plain text, 2 = snippet (`${1:placeholder}` syntax).
    pub insert_text_format: Option<u32>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub text_edit: Option<LspTextEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_replace_edit: Option<LspInsertReplaceEdit>,
    pub additional_text_edits: Vec<LspTextEdit>,
    /// Original server item, echoed back verbatim for `completionItem/resolve`.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResult {
    pub status: LspDocumentStatus,
    pub is_incomplete: bool,
    pub items: Vec<LspCompletionItem>,
    /// True when the server list was locally truncated at the hard cap.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LspCompletionResolveResult {
    Resolved { item: LspCompletionItem },
    Unavailable { reason: String },
    Timeout,
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
    /// Offsets into the signature label when the server sends `[start, end]`.
    pub label_start: Option<u32>,
    pub label_end: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspSignatureParameter>,
    pub active_parameter: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureHelpResult {
    pub status: LspDocumentStatus,
    pub signatures: Vec<LspSignatureInfo>,
    pub active_signature: u32,
    pub active_parameter: u32,
}
