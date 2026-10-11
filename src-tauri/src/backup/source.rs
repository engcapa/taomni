use super::{engine, manifest::file_sha256, model::*, restore};
use std::path::Path;

/// Adding another source must not require any change to a destination adapter.
pub trait BackupSource {
    fn snapshot(
        &self,
        app: &tauri::AppHandle,
        spec: &SourceSpec,
        path: &Path,
        password: &str,
    ) -> Result<Artifact, String>;
    fn inspect(
        &self,
        path: &Path,
        password: &str,
    ) -> Result<super::manifest::BackupManifest, String>;
}
pub struct TaomniSource;
impl BackupSource for TaomniSource {
    fn snapshot(
        &self,
        app: &tauri::AppHandle,
        spec: &SourceSpec,
        path: &Path,
        password: &str,
    ) -> Result<Artifact, String> {
        if password.trim().is_empty() {
            return Err("Cloud backups require an independent archive password".into());
        }
        if spec.kind != "taomni" || spec.schema_version != 1 {
            return Err("Unsupported backup source".into());
        }
        let result = engine::create_cloud_snapshot(
            app,
            spec,
            path.to_string_lossy().into_owned(),
            password.into(),
        )?;
        let manifest = restore::inspect_archive(path, Some(password))?;
        Ok(Artifact {
            path: result.file_path,
            snapshot_id: manifest
                .provenance
                .ok_or("Missing snapshot identity")?
                .snapshot_id,
            size: result.size_bytes,
            sha256: file_sha256(path).map_err(|e| e.to_string())?,
            source_kind: spec.kind.clone(),
        })
    }
    fn inspect(
        &self,
        path: &Path,
        password: &str,
    ) -> Result<super::manifest::BackupManifest, String> {
        restore::inspect_archive(path, Some(password))
    }
}
