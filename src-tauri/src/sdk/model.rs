use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

pub(super) const SDK_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SdkKind {
    Java,
    Kotlin,
    Scala,
    Python,
}

impl SdkKind {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Java => "JDK",
            Self::Kotlin => "Kotlin",
            Self::Scala => "Scala",
            Self::Python => "Python",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkOrigin {
    Manual,
    Discovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkStatus {
    Ready,
    Missing,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkRole {
    Project,
    Launcher,
    Tooling,
    Compiler,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkBindingMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkInstallation {
    pub id: String,
    pub kind: SdkKind,
    pub name: String,
    pub location: String,
    #[serde(default)]
    pub executables: BTreeMap<String, String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub architecture: Option<String>,
    pub origin: SdkOrigin,
    pub status: SdkStatus,
    pub last_error: Option<String>,
    pub last_probed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkDefault {
    pub kind: SdkKind,
    pub sdk_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkBinding {
    pub scope_path: String,
    pub kind: SdkKind,
    pub role: SdkRole,
    pub mode: SdkBindingMode,
    pub sdk_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkRegistry {
    pub schema_version: u32,
    #[serde(default)]
    pub installations: Vec<SdkInstallation>,
    #[serde(default)]
    pub defaults: Vec<SdkDefault>,
    #[serde(default)]
    pub bindings: Vec<WorkspaceSdkBinding>,
}

impl Default for SdkRegistry {
    fn default() -> Self {
        Self {
            schema_version: SDK_REGISTRY_SCHEMA_VERSION,
            installations: Vec::new(),
            defaults: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkProbe {
    pub kind: SdkKind,
    pub location: String,
    pub executables: BTreeMap<String, String>,
    pub version: Option<String>,
    pub vendor: Option<String>,
    pub architecture: Option<String>,
    pub status: SdkStatus,
    pub error: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSdkInstallationRequest {
    pub id: Option<String>,
    pub kind: SdkKind,
    pub name: Option<String>,
    pub location: String,
    #[serde(default)]
    pub origin: Option<SdkOrigin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSdkDefaultRequest {
    pub kind: SdkKind,
    pub sdk_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceSdkBindingRequest {
    pub scope_path: String,
    pub kind: SdkKind,
    pub role: SdkRole,
    pub mode: SdkBindingMode,
    pub sdk_id: Option<String>,
}
