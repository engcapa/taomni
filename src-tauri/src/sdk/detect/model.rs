use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SdkConstraintPolicy {
    Any,
    Exact,
    ExactMajor,
    PreferredMajor,
    Minimum,
    Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkVersionConstraint {
    pub raw: String,
    pub policy: SdkConstraintPolicy,
    pub major: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkEvidence {
    pub source_path: String,
    pub key: String,
    pub value: String,
    pub confidence: SdkConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkRequirement {
    pub kind: SdkKind,
    pub role: SdkRole,
    pub constraint: Option<SdkVersionConstraint>,
    pub required_location: Option<String>,
    pub managed_by_build: bool,
    pub source: String,
    pub confidence: SdkConfidence,
    pub evidence: Vec<SdkEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectBuildSystem {
    Maven,
    Gradle,
    Sbt,
    Pyproject,
    Standalone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KotlinPlatform {
    Jvm,
    Android,
    Multiplatform,
    Js,
    Wasm,
    Native,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KotlinCompilerMode {
    BuildManaged,
    Standalone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KotlinProjectProfile {
    pub platform: KotlinPlatform,
    pub compiler_mode: KotlinCompilerMode,
    pub compiler_version: Option<String>,
    pub language_version: Option<String>,
    pub api_version: Option<String>,
    pub jvm_target: Option<String>,
    pub java_toolchain: Option<String>,
    pub gradle_launcher_java_home: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSdkProfile {
    pub scope_path: String,
    pub relative_path: String,
    pub display_name: String,
    pub build_systems: Vec<ProjectBuildSystem>,
    pub languages: Vec<SdkKind>,
    pub requirements: Vec<SdkRequirement>,
    pub kotlin: Option<KotlinProjectProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkAnalysis {
    pub workspace_root: String,
    pub profiles: Vec<ProjectSdkProfile>,
    pub warnings: Vec<String>,
}
