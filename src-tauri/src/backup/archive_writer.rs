//! Archive writing and atomic publication, independent of live application databases.
use super::{crypto::encrypt_stream, manifest::BackupManifest, snapshot_context::SnapshotContext};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

/// Helper struct for staging files before compressing into the backup archive.
#[derive(Debug, Clone)]
pub struct StagedFile {
    pub archive_path: String,
    pub disk_path: PathBuf,
}

/// Package staged files into a zip archive with manifest and optional encryption.
pub fn pack_staged_archive(
    staged_files: &[StagedFile],
    app_version: &str,
    scope: &str,
    password: Option<&str>,
    out_file_path: &Path,
) -> Result<(BackupManifest, u64), String> {
    pack_staged_archive_with_provenance(
        staged_files,
        app_version,
        scope,
        password,
        out_file_path,
        None,
        &SnapshotContext::default(),
    )
}

pub(crate) fn pack_staged_archive_with_provenance(
    staged_files: &[StagedFile],
    app_version: &str,
    scope: &str,
    password: Option<&str>,
    out_file_path: &Path,
    provenance: Option<super::model::Provenance>,
    context: &SnapshotContext,
) -> Result<(BackupManifest, u64), String> {
    let total = staged_files
        .iter()
        .try_fold(0u64, |sum, f| {
            context.check().map_err(std::io::Error::other)?;
            std::fs::metadata(&f.disk_path).map(|m| sum.saturating_add(m.len()))
        })
        .map_err(|e| e.to_string())?;
    context.begin("packing", Some(total.saturating_mul(2)))?;
    let is_encrypted = password.as_ref().is_some_and(|p| !p.trim().is_empty());
    let mut manifest =
        BackupManifest::new(app_version.to_string(), scope.to_string(), is_encrypted);
    manifest.provenance = provenance;

    let parent = out_file_path.parent().ok_or("Invalid backup destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut zip_buffer = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = ZipWriter::new(zip_buffer.as_file_mut());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for staged in staged_files {
            let sha256 = context
                .hash(&staged.disk_path)
                .map_err(|e| format!("calculate sha256 for {}: {e}", staged.disk_path.display()))?;
            let size = std::fs::metadata(&staged.disk_path)
                .map(|m| m.len())
                .unwrap_or(0);

            manifest.add_file(staged.archive_path.clone(), sha256, size);

            zip.start_file(
                &staged.archive_path,
                options
                    .large_file(size >= u32::MAX as u64)
                    .compression_method(if staged.archive_path.ends_with(".eml.gz") {
                        CompressionMethod::Stored
                    } else {
                        CompressionMethod::Deflated
                    }),
            )
            .map_err(|e| format!("start zip file {}: {e}", staged.archive_path))?;

            let mut f = context
                .reader(File::open(&staged.disk_path).map_err(|e| {
                    format!("open staged file {}: {e}", staged.disk_path.display())
                })?);
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = f.read(&mut buf).map_err(|e| format!("read file: {e}"))?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n])
                    .map_err(|e| format!("write to zip: {e}"))?;
            }
        }

        // Add manifest.json to the zip archive
        let manifest_bytes = manifest
            .to_json_bytes()
            .map_err(|e| format!("serialize manifest: {e}"))?;
        zip.start_file(super::manifest::MANIFEST_FILE_NAME, options)
            .map_err(|e| format!("start manifest in zip: {e}"))?;
        zip.write_all(&manifest_bytes)
            .map_err(|e| format!("write manifest to zip: {e}"))?;

        zip.finish().map_err(|e| format!("finish zip: {e}"))?;
    }

    zip_buffer
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let mut output = if let Some(pw) = password.filter(|pw| !pw.trim().is_empty()) {
        let mut encrypted = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        context.begin(
            "encrypting",
            Some(
                zip_buffer
                    .as_file()
                    .metadata()
                    .map_err(|e| e.to_string())?
                    .len(),
            ),
        )?;
        encrypt_stream(
            context.reader(zip_buffer.as_file_mut()),
            pw.trim(),
            encrypted.as_file_mut(),
        )?;
        encrypted
    } else {
        zip_buffer
    };
    output.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    let file_size = output
        .as_file()
        .metadata()
        .map_err(|e| e.to_string())?
        .len();
    context.check()?;
    let _cache_reservation = super::cache::reserve(out_file_path, file_size)?;
    context.check()?;
    output
        .persist(out_file_path)
        .map_err(|e| format!("Publish backup: {}", e.error))?;

    Ok((manifest, file_size))
}
