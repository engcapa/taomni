use russh_sftp::protocol::FileAttributes;
use russh_sftp::protocol::FileType as SftpFileType;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct FileEntryDto {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub mode: u32,
    #[serde(rename = "fileType")]
    pub file_type: String,
    /// Effective type after one level of symlink resolution. `None` for
    /// non-symlinks; `"dir"` / `"file"` / `"unknown"` when the link target
    /// could be stat'd; left as `None` for broken or permission-denied
    /// links (callers fall back to `file_type`).
    #[serde(rename = "targetFileType", skip_serializing_if = "Option::is_none")]
    pub target_file_type: Option<String>,
    #[serde(rename = "isHidden")]
    pub is_hidden: bool,
    #[serde(rename = "symlinkTarget")]
    pub symlink_target: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

pub(super) fn entry_from_attrs(name: String, path: String, attrs: FileAttributes) -> FileEntryDto {
    let file_type = match attrs.file_type() {
        SftpFileType::Dir => "dir",
        SftpFileType::File => "file",
        SftpFileType::Symlink => "symlink",
        SftpFileType::Other => "unknown",
    };
    let mode = attrs.permissions.unwrap_or(0);
    let mtime = attrs.mtime.map(|t| t as i64).unwrap_or(0);
    FileEntryDto {
        is_hidden: name.starts_with('.'),
        name,
        path,
        size: attrs.size.unwrap_or(0),
        mtime,
        mode,
        file_type: file_type.into(),
        target_file_type: None,
        symlink_target: None,
        owner: attrs.uid.map(|u| u.to_string()),
        group: attrs.gid.map(|g| g.to_string()),
    }
}

pub fn join_remote(base: &str, name: &str) -> String {
    if base.is_empty() {
        return name.to_string();
    }
    if base == "/" {
        return format!("/{}", name);
    }
    if base.ends_with('/') {
        format!("{}{}", base, name)
    } else {
        format!("{}/{}", base, name)
    }
}

pub(super) fn remote_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name,
        None => trimmed,
    }
}
