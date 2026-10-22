use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFormattingResult {
    pub status: LspDocumentStatus,
    pub edits: Vec<LspTextEdit>,
}

/// One file's worth of TextEdits from a WorkspaceEdit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFileTextEdits {
    pub uri: String,
    pub path: Option<String>,
    pub version: Option<i64>,
    pub edits: Vec<LspTextEdit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotation_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspChangeAnnotation {
    pub id: String,
    pub label: String,
    pub needs_confirmation: bool,
    pub description: Option<String>,
}

/// Normalized workspace edit for clients (rename / code actions / replace).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LspWorkspaceEditOperation {
    Text {
        document: LspFileTextEdits,
    },
    Create {
        uri: String,
        path: Option<String>,
        overwrite: bool,
        ignore_if_exists: bool,
        annotation_id: Option<String>,
    },
    Rename {
        old_uri: String,
        old_path: Option<String>,
        new_uri: String,
        new_path: Option<String>,
        overwrite: bool,
        ignore_if_exists: bool,
        annotation_id: Option<String>,
    },
    Delete {
        uri: String,
        path: Option<String>,
        recursive: bool,
        ignore_if_not_exists: bool,
        annotation_id: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceEdit {
    pub document_edits: Vec<LspFileTextEdits>,
    #[serde(default)]
    pub operations: Vec<LspWorkspaceEditOperation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub change_annotations: Vec<LspChangeAnnotation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceFileOperationTarget {
    pub path: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceFileRenameTarget {
    pub old_path: String,
    pub new_path: String,
    #[serde(default)]
    pub is_directory: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LspWorkspaceFileOperation {
    Create {
        files: Vec<LspWorkspaceFileOperationTarget>,
    },
    Rename {
        files: Vec<LspWorkspaceFileRenameTarget>,
    },
    Delete {
        files: Vec<LspWorkspaceFileOperationTarget>,
    },
}

/// A local filesystem event forwarded to language servers that registered
/// `workspace/didChangeWatchedFiles` watchers. The numeric `type` values are
/// the LSP FileChangeType enum: 1 = created, 2 = changed, 3 = deleted.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspWatchedFileChange {
    pub path: String,
    #[serde(rename = "type")]
    pub change_type: u8,
}

impl LspWorkspaceFileOperation {
    pub(super) fn will_method(&self) -> &'static str {
        match self {
            Self::Create { .. } => "workspace/willCreateFiles",
            Self::Rename { .. } => "workspace/willRenameFiles",
            Self::Delete { .. } => "workspace/willDeleteFiles",
        }
    }

    pub(super) fn did_method(&self) -> &'static str {
        match self {
            Self::Create { .. } => "workspace/didCreateFiles",
            Self::Rename { .. } => "workspace/didRenameFiles",
            Self::Delete { .. } => "workspace/didDeleteFiles",
        }
    }

    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Create { .. } => "creating files",
            Self::Rename { .. } => "renaming files",
            Self::Delete { .. } => "deleting files",
        }
    }

    pub(super) fn watched_file_changes(&self) -> Vec<LspWatchedFileChange> {
        match self {
            Self::Create { files } => files
                .iter()
                .map(|file| LspWatchedFileChange {
                    path: file.path.clone(),
                    change_type: 1,
                })
                .collect(),
            Self::Delete { files } => files
                .iter()
                .map(|file| LspWatchedFileChange {
                    path: file.path.clone(),
                    change_type: 3,
                })
                .collect(),
            Self::Rename { files } => files
                .iter()
                .flat_map(|file| {
                    [
                        LspWatchedFileChange {
                            path: file.old_path.clone(),
                            change_type: 3,
                        },
                        LspWatchedFileChange {
                            path: file.new_path.clone(),
                            change_type: 1,
                        },
                    ]
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub edit: Option<LspWorkspaceEdit>,
    pub command: Option<String>,
    pub command_arguments: Option<Value>,
    /// Original server action for executeCommand / resolve.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeActionsResult {
    pub status: LspDocumentStatus,
    pub actions: Vec<LspCodeAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeActionResolveResult {
    pub status: LspDocumentStatus,
    pub action: Option<LspCodeAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPrepareRenameResult {
    pub status: LspDocumentStatus,
    pub range: Option<LspRange>,
    pub placeholder: Option<String>,
    pub allowed: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRenameResult {
    pub status: LspDocumentStatus,
    pub edit: LspWorkspaceEdit,
}
