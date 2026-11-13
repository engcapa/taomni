use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationFailure {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompletedEntry {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Default, Serialize)]
pub struct EntryOperationResult {
    pub done: Vec<CompletedEntry>,
    pub failed: Vec<OperationFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRef {
    pub id: String,
    pub original_path: String,
}

#[derive(Debug, Default, Serialize)]
pub struct TrashResult {
    pub trashed: Vec<TrashRef>,
    pub failed: Vec<OperationFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProperties {
    pub path: String,
    pub name: String,
    pub file_type: String,
    pub size: u64,
    pub item_count: u64,
    pub truncated: bool,
    pub mtime: i64,
    pub created_at: Option<i64>,
    pub mode: u32,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PreviewText {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
pub struct PreviewBytes {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug)]
pub(super) struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn io(action: &str, path: &std::path::Path, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::AlreadyExists => "already_exists",
            std::io::ErrorKind::StorageFull => "disk_full",
            _ => "io_error",
        };
        Self::new(code, format!("{action} {}: {error}", path.display()))
    }

    pub fn failure(self, path: String) -> OperationFailure {
        OperationFailure {
            path,
            code: self.code.into(),
            message: self.message,
        }
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub(super) type OpResult<T> = Result<T, OpError>;
