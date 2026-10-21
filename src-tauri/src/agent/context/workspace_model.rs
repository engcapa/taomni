use super::files::legacy_paths_to_files;
use super::files::normalize_code_workspace_file;
use super::files::normalize_code_workspace_files;
use super::files::normalize_code_workspace_loose_files;
use super::files::normalize_code_workspace_paths;
use super::files::normalize_code_workspace_roots;
use super::files::root_file_for_path;
use super::language::normalize_code_workspace_lsp;
use super::paths::clean_code_workspace_os_path;
use super::paths::clean_code_workspace_path;
use super::paths::code_workspace_basename;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLooseFile {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceFile {
    pub kind: String,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_name: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLspStatus {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub language_id: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub selected_command: Option<String>,
    #[serde(default)]
    pub install_hint: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLspDiagnostic {
    pub file: AgentCodeWorkspaceFile,
    #[serde(default)]
    pub error_count: u32,
    #[serde(default)]
    pub warning_count: u32,
    #[serde(default)]
    pub info_count: u32,
    #[serde(default)]
    pub messages: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspaceLsp {
    #[serde(default)]
    pub active_status: Option<AgentCodeWorkspaceLspStatus>,
    #[serde(default)]
    pub diagnostics: Vec<AgentCodeWorkspaceLspDiagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspace {
    #[serde(default)]
    pub repo_root: String,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub open_paths: Vec<String>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
    #[serde(default)]
    pub roots: Vec<AgentCodeWorkspaceRoot>,
    #[serde(default)]
    pub loose_files: Vec<AgentCodeWorkspaceLooseFile>,
    #[serde(default)]
    pub active_file: Option<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub open_files: Vec<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub dirty_files: Vec<AgentCodeWorkspaceFile>,
    #[serde(default)]
    pub lsp: Option<AgentCodeWorkspaceLsp>,
}

impl AgentCodeWorkspace {
    pub fn normalized(&self) -> Option<Self> {
        let mut roots = normalize_code_workspace_roots(&self.roots);
        let repo_root = clean_code_workspace_os_path(&self.repo_root);
        if roots.is_empty() {
            if let Some(root) = repo_root.as_deref() {
                roots.push(AgentCodeWorkspaceRoot {
                    id: "root-1".to_string(),
                    name: code_workspace_basename(root).unwrap_or_else(|| "Workspace".into()),
                    path: root.to_string(),
                    kind: Some("git".into()),
                });
            }
        }
        let loose_files = normalize_code_workspace_loose_files(&self.loose_files);
        if roots.is_empty() && loose_files.is_empty() {
            return None;
        }
        let repo_root = repo_root
            .or_else(|| roots.first().map(|root| root.path.clone()))
            .unwrap_or_default();
        let open_paths = normalize_code_workspace_paths(&self.open_paths);
        let dirty_paths = normalize_code_workspace_paths(&self.dirty_paths);
        let open_files = normalize_code_workspace_files(&self.open_files, &roots, &loose_files)
            .or_else(|| legacy_paths_to_files(&open_paths, &roots))
            .unwrap_or_default();
        let dirty_files = normalize_code_workspace_files(&self.dirty_files, &roots, &loose_files)
            .or_else(|| legacy_paths_to_files(&dirty_paths, &roots))
            .unwrap_or_default();
        let active_file = self
            .active_file
            .as_ref()
            .and_then(|file| normalize_code_workspace_file(file, &roots, &loose_files))
            .or_else(|| {
                self.active_path
                    .as_deref()
                    .and_then(clean_code_workspace_path)
                    .and_then(|path| roots.first().map(|root| root_file_for_path(root, path)))
            });
        let lsp = self
            .lsp
            .as_ref()
            .and_then(|lsp| normalize_code_workspace_lsp(lsp, &roots, &loose_files));
        Some(Self {
            repo_root,
            active_path: self
                .active_path
                .as_deref()
                .and_then(clean_code_workspace_path),
            open_paths,
            dirty_paths,
            roots,
            loose_files,
            active_file,
            open_files,
            dirty_files,
            lsp,
        })
    }
}
