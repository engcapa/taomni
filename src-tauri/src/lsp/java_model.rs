use super::status_model::LspDocumentStatus;
use serde::Deserialize;
use serde::Serialize;

/// One provider-reported Java project/module root (`java.project.list`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaProjectModule {
    pub id: String,
    pub root_uri: Option<String>,
}

/// §8.20.3 W2: hashed summary of one project's resolved classpath. Entry
/// paths are never returned verbatim — only their count and joint hash —
/// so fingerprints stay free of machine-local plaintext.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaClasspathProbe {
    pub root_uri: Option<String>,
    pub entry_count: u64,
    pub entries_sha256: String,
}

/// Build descriptor under a workspace root (pom.xml / build.gradle* /
/// settings.gradle*) with its content hash. Feeds the project fingerprint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspBuildFileHash {
    pub path: String,
    pub sha256: String,
}

/// Provider-owned Project Analysis facts (§8.20.3 W2). Lifecycle-only
/// providers leave `classpath_probe` unset and explain why in
/// `probe_reason`; the frontend derives phase/completeness from exactly
/// these fields and never invents module details.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspJavaProjectModelResult {
    pub status: LspDocumentStatus,
    pub active: bool,
    pub process_id: Option<u32>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    /// `workspace/executeCommand` command names the provider registered.
    pub registered_commands: Vec<String>,
    pub build_files: Vec<LspBuildFileHash>,
    /// Tooling JDK home used to launch this session (hashed client-side;
    /// never embedded verbatim into fingerprints or traces).
    pub java_home_used: Option<String>,
    pub java_projects: Vec<LspJavaProjectModule>,
    pub classpath_probe: Option<LspJavaClasspathProbe>,
    pub probe_reason: Option<String>,
}
