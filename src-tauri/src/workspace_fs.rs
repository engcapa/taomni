//! WorkspaceFs abstraction spike (M5/P2).
//!
//! Goal: centralize local-path assumptions so a future SFTP-backed workspace
//! root can share list/read/write/rename operations without rewriting the UI.
//!
//! This module is intentionally incomplete: it only defines the trait surface
//! and a local implementation used by unit tests. Production workspace.rs
//! commands still own the live path; migration is intentionally deferred.

use async_trait::async_trait;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsFile {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub mtime: u64,
}

/// Minimal filesystem operations required by Code Workspace roots.
#[async_trait]
pub trait WorkspaceFs: Send + Sync {
    async fn list_dir(&self, path: &str) -> Result<Vec<WorkspaceFsEntry>, String>;
    async fn read_text(&self, path: &str) -> Result<WorkspaceFsFile, String>;
    async fn write_text(&self, path: &str, text: &str) -> Result<WorkspaceFsFile, String>;
    async fn create_dir(&self, path: &str) -> Result<WorkspaceFsEntry, String>;
    async fn remove_path(&self, path: &str) -> Result<(), String>;
    async fn rename_path(&self, from: &str, to: &str) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub struct LocalWorkspaceFs {
    root: PathBuf,
}

impl LocalWorkspaceFs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let mut relative = PathBuf::new();
        for component in Path::new(path.trim()).components() {
            match component {
                Component::Normal(part) => relative.push(part),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err("path escapes workspace root".into());
                }
            }
        }
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|e| format!("canonicalize root: {e}"))?;
        let joined = canonical_root.join(relative);
        let mut ancestor = joined.as_path();
        let mut missing = Vec::new();
        while !ancestor.exists() {
            let name = ancestor
                .file_name()
                .ok_or_else(|| "path has no existing ancestor".to_string())?;
            missing.push(name.to_os_string());
            ancestor = ancestor
                .parent()
                .ok_or_else(|| "path has no existing ancestor".to_string())?;
        }
        let mut candidate = ancestor
            .canonicalize()
            .map_err(|e| format!("canonicalize path: {e}"))?;
        if !candidate.starts_with(&canonical_root) {
            return Err("path escapes workspace root".into());
        }
        for component in missing.iter().rev() {
            candidate.push(component);
        }
        Ok(candidate)
    }

    fn entry_for(path: &Path, relative: &str) -> Result<WorkspaceFsEntry, String> {
        let meta = fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(WorkspaceFsEntry {
            name: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| relative.to_string()),
            path: relative.replace('\\', "/"),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime,
        })
    }
}

#[async_trait]
impl WorkspaceFs for LocalWorkspaceFs {
    async fn list_dir(&self, path: &str) -> Result<Vec<WorkspaceFsEntry>, String> {
        let abs = self.resolve(path)?;
        let mut entries = Vec::new();
        for item in fs::read_dir(&abs).map_err(|e| format!("list dir: {e}"))? {
            let item = item.map_err(|e| format!("dir entry: {e}"))?;
            let name = item.file_name().to_string_lossy().into_owned();
            let relative = if path.trim().is_empty() {
                name.clone()
            } else {
                format!("{}/{}", path.trim().trim_matches('/'), name)
            };
            entries.push(Self::entry_for(&item.path(), &relative)?);
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    }

    async fn read_text(&self, path: &str) -> Result<WorkspaceFsFile, String> {
        let abs = self.resolve(path)?;
        let text = fs::read_to_string(&abs).map_err(|e| format!("read: {e}"))?;
        let meta = fs::metadata(&abs).map_err(|e| format!("stat: {e}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(WorkspaceFsFile {
            path: path.replace('\\', "/"),
            size: meta.len(),
            mtime,
            text,
        })
    }

    async fn write_text(&self, path: &str, text: &str) -> Result<WorkspaceFsFile, String> {
        let abs = self.resolve(path)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
        }
        fs::write(&abs, text.as_bytes()).map_err(|e| format!("write: {e}"))?;
        self.read_text(path).await
    }

    async fn create_dir(&self, path: &str) -> Result<WorkspaceFsEntry, String> {
        let abs = self.resolve(path)?;
        fs::create_dir_all(&abs).map_err(|e| format!("mkdir: {e}"))?;
        Self::entry_for(&abs, path)
    }

    async fn remove_path(&self, path: &str) -> Result<(), String> {
        if path.trim().is_empty() {
            return Err("cannot remove workspace root".into());
        }
        let abs = self.resolve(path)?;
        if abs.is_dir() {
            fs::remove_dir_all(&abs).map_err(|e| format!("remove dir: {e}"))
        } else {
            fs::remove_file(&abs).map_err(|e| format!("remove file: {e}"))
        }
    }

    async fn rename_path(&self, from: &str, to: &str) -> Result<(), String> {
        if from.trim().is_empty() || to.trim().is_empty() {
            return Err("rename paths cannot be empty".into());
        }
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
        }
        fs::rename(src, dst).map_err(|e| format!("rename: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn local_workspace_fs_round_trip() {
        let dir = tempdir().unwrap();
        let fs_impl = LocalWorkspaceFs::new(dir.path());
        fs_impl.create_dir("src").await.unwrap();
        fs_impl
            .write_text("src/nested/main.ts", "export const n = 1;\n")
            .await
            .unwrap();
        let listed = fs_impl.list_dir("src/nested").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "main.ts");
        let file = fs_impl.read_text("src/nested/main.ts").await.unwrap();
        assert!(file.text.contains("export const n"));
        fs_impl
            .rename_path("src/nested/main.ts", "src/app.ts")
            .await
            .unwrap();
        assert!(fs_impl.read_text("src/app.ts").await.is_ok());
        fs_impl.remove_path("src/app.ts").await.unwrap();
        assert!(fs_impl.list_dir("src/nested").await.unwrap().is_empty());
        assert!(fs_impl.remove_path("").await.is_err());
    }

    #[tokio::test]
    async fn rejects_path_escape() {
        let dir = tempdir().unwrap();
        let fs_impl = LocalWorkspaceFs::new(dir.path());
        let err = fs_impl.read_text("../secret").await.unwrap_err();
        assert!(err.contains("escapes"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        let fs_impl = LocalWorkspaceFs::new(root.path());

        let error = fs_impl.read_text("outside/secret.txt").await.unwrap_err();
        assert!(error.contains("escapes"));
    }
}
