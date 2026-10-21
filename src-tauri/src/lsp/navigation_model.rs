use super::feature_model::LspRange;
use super::status_model::LspDocumentStatus;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub status: LspDocumentStatus,
    pub contents: Option<String>,
    pub range: Option<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocationsResult {
    pub status: LspDocumentStatus,
    pub locations: Vec<LspLocation>,
}

/// One entry of a flattened `textDocument/documentSymbol` tree; `depth`
/// preserves the hierarchy for indented rendering.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub depth: u32,
    pub range: LspRange,
    pub selection_range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspDocumentSymbol>,
}

/// Normalized CallHierarchyItem / TypeHierarchyItem. `raw` is echoed back to
/// the server for lazy child requests so opaque server `data` is preserved.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyItem {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHierarchyPrepareResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyEntry {
    pub item: LspHierarchyItem,
    pub from_ranges: Vec<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyResult {
    pub status: LspDocumentStatus,
    pub entries: Vec<LspCallHierarchyEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTypeHierarchyResult {
    pub status: LspDocumentStatus,
    pub items: Vec<LspHierarchyItem>,
}
