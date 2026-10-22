use super::fingerprint::fingerprint;
use super::paths::path_string;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub(super) const JDTLS_MIN_JAVA_MAJOR: u32 = 21;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeConfiguration {
    pub name: String,
    pub path: String,
    pub default: bool,
}

/// Backend-computed process environment shared by language servers, workspace
/// terminals and task runners. The frontend only transports the workspace and
/// scope paths; SDK precedence and compatibility remain backend-owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkEnvironment {
    pub workspace_root: String,
    pub scope_path: String,
    pub project_scope_path: String,
    pub fingerprint: String,
    pub environment: BTreeMap<String, String>,
    pub path_entries: Vec<String>,
    pub project_java_home: Option<String>,
    pub launcher_java_home: Option<String>,
    pub tooling_java_home: Option<String>,
    pub tooling_java_error: Option<String>,
    pub python_home: Option<String>,
    pub kotlin_home: Option<String>,
    pub scala_home: Option<String>,
    pub java_runtimes: Vec<JavaRuntimeConfiguration>,
}

impl WorkspaceSdkEnvironment {
    pub fn passthrough(workspace_root: &Path, scope_path: &Path) -> Self {
        let workspace_root = path_string(workspace_root);
        let scope_path = path_string(scope_path);
        // The requested file directory is diagnostic metadata, not process
        // identity. Keeping it here spawned one language server per package.
        let fingerprint = fingerprint(&[workspace_root.as_str(), "passthrough"]);
        Self {
            project_scope_path: workspace_root.clone(),
            workspace_root,
            scope_path,
            fingerprint,
            environment: BTreeMap::new(),
            path_entries: Vec::new(),
            project_java_home: None,
            launcher_java_home: None,
            tooling_java_home: None,
            tooling_java_error: None,
            python_home: None,
            kotlin_home: None,
            scala_home: None,
            java_runtimes: Vec::new(),
        }
    }

    pub fn prepend_path(&self, inherited: Option<&std::ffi::OsStr>) -> Option<std::ffi::OsString> {
        if self.path_entries.is_empty() {
            return None;
        }
        let mut paths = self
            .path_entries
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        if let Some(inherited) = inherited {
            paths.extend(std::env::split_paths(inherited));
        }
        std::env::join_paths(paths).ok()
    }
}
