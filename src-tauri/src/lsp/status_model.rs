use super::feature_model::LspCapabilitySummary;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandPreset {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub install_hint: String,
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCustomServerCommand {
    #[serde(default)]
    pub label: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerPreset {
    pub id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub file_extensions: Vec<String>,
    pub file_names: Vec<String>,
    pub commands: Vec<LspServerCommandPreset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandStatus {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub install_hint: String,
    pub fallback: bool,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub preset_id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: String,
    pub error: Option<String>,
    /// Human-readable runtime probe for Settings (e.g. Java major + path for jdtls).
    #[serde(default)]
    pub runtime_status: Option<String>,
    pub commands: Vec<LspServerCommandStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentStatus {
    pub path: String,
    pub uri: String,
    pub preset_id: Option<String>,
    pub language_id: Option<String>,
    pub display_name: Option<String>,
    pub available: bool,
    pub active: bool,
    /// True once the provider can answer semantic requests for this workspace.
    /// JDT LS initializes before Maven/Gradle import and reports this separately.
    #[serde(default)]
    pub semantic_ready: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: Option<String>,
    pub error: Option<String>,
    /// Present only while a session is active for this document.
    #[serde(default)]
    pub capabilities: Option<LspCapabilitySummary>,
}

#[derive(Clone, Debug)]
pub(super) struct DetectedLanguage {
    pub(super) preset_id: String,
    pub(super) language_id: String,
}
