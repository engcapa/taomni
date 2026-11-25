//! Running owners export on their store actor. Core copies verified handles
//! into private staging, while the host barrier remains held for the Vault copy.
use super::{
    super::{archive_writer::StagedFile, snapshot_context::SnapshotContext},
    contracts::{PluginDataFile, PluginDataFileKind},
    offline::OfflineSnapshot,
};
use crate::plugin::{
    HostSnapshot, PluginRegistry,
    retained_data::{self, DataFileKind, RetainedDataFile},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
    time::Instant,
};
use taomni_plugin_api::services::*;

#[derive(Debug)]
pub(super) struct LiveSnapshot {
    host: HostSnapshot,
    _export: tempfile::TempDir,
}

impl LiveSnapshot {
    pub(super) fn release(self) -> Result<(), String> {
        self.host.release()
    }
}

pub(super) fn stage(
    registry: &PluginRegistry,
    slug: &str,
    schema: u32,
    staging: &Path,
    context: &SnapshotContext,
    job: &SnapshotJobId,
    generation: &ProfileGeneration,
    deadline: Instant,
) -> Result<(OfflineSnapshot, LiveSnapshot), String> {
    context.check()?;
    let files = inventory(registry.root(), slug, schema)?;
    let export = tempfile::Builder::new()
        .prefix("host-export-")
        .tempdir_in(staging)
        .map_err(|e| e.to_string())?;
    let root = fs::canonicalize(export.path()).map_err(|e| e.to_string())?;
    let token = StagingToken::parse(uuid::Uuid::new_v4().to_string()).map_err(|e| e.to_string())?;
    let grant = SnapshotDestinationGrant {
        token: token.clone(),
        absolute_job_root: root.clone(),
        allowed_files: files
            .iter()
            .map(|file| SafeRelativePath::parse(file.path.clone()).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?,
        opaque_files: files
            .iter()
            .filter(|file| retained_data::opaque_file(slug, &file.path))
            .map(|file| SafeRelativePath::parse(file.path.clone()).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?,
    };
    let host = registry.prepare_data_snapshot(
        slug,
        PrepareSnapshot {
            job: job.clone(),
            profile_generation: generation.clone(),
            destination: grant,
        },
        deadline,
        &|| context.check().is_err(),
    )?;
    let live = LiveSnapshot {
        host,
        _export: export,
    };
    // A writer may have created/removed a file just before freeze. Do not
    // silently omit it; release the barrier and let the user retry this job.
    if inventory(registry.root(), slug, schema)? != files {
        return Err(
            "Plugin data inventory changed while preparing snapshot; retry the backup".into(),
        );
    }
    let result = live.host.export(deadline, &|| context.check().is_err())?;
    let snapshot = validate_and_copy(&root, staging, slug, schema, &files, &result.files, context)?;
    Ok((snapshot, live))
}

fn inventory(plugins: &Path, slug: &str, schema: u32) -> Result<Vec<RetainedDataFile>, String> {
    let mut files = retained_data::discover(plugins, slug, schema)
        .map_err(|e| e.to_string())?
        .files;
    let sidecars: BTreeSet<_> = files
        .iter()
        .filter(|file| file.kind == DataFileKind::Sqlite)
        .flat_map(|file| {
            ["-wal", "-shm", "-journal"].map(|suffix| format!("{}{suffix}", file.path))
        })
        .collect();
    files.retain(|file| !sidecars.contains(&file.path));
    Ok(files)
}

pub(super) fn validate_and_copy(
    export: &Path,
    staging: &Path,
    slug: &str,
    schema: u32,
    expected: &[RetainedDataFile],
    actual: &[SnapshotFile],
    context: &SnapshotContext,
) -> Result<OfflineSnapshot, String> {
    if expected.len() != actual.len() || actual.len() > 16_384 {
        return Err("Plugin snapshot inventory is incomplete".into());
    }
    let private = tempfile::Builder::new()
        .prefix("verified-plugin-")
        .tempdir_in(staging)
        .map_err(|e| e.to_string())?;
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    let mut result = OfflineSnapshot {
        files: Vec::new(),
        inventory: Vec::new(),
        schema,
    };
    for metadata in actual {
        context.check()?;
        let relative = metadata.relative_path.as_str();
        let expected = expected
            .iter()
            .find(|file| file.path == relative)
            .ok_or("Plugin snapshot returned an ungranted file")?;
        if !seen.insert(relative.to_lowercase()) || metadata.size_bytes > 64 * 1024 * 1024 * 1024 {
            return Err("Plugin snapshot has duplicate or oversized files".into());
        }
        total = total
            .checked_add(metadata.size_bytes)
            .ok_or("Plugin snapshot size overflow")?;
        if total > 256 * 1024 * 1024 * 1024 {
            return Err("Plugin snapshot exceeds job size limit".into());
        }
        let input = super::open_snapshot::open(export, relative)?;
        if input.metadata().map_err(|e| e.to_string())?.len() != metadata.size_bytes {
            return Err("Plugin snapshot file size disagrees with response".into());
        }
        let target = private.path().join(relative);
        fs::create_dir_all(target.parent().ok_or("Invalid snapshot target")?)
            .map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        let mut input = context.reader(input);
        let mut digest = Sha256::new();
        let mut count = 0u64;
        let mut header: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 65_536];
        loop {
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            count += read as u64;
            if count > metadata.size_bytes {
                return Err("Plugin snapshot changed while copying".into());
            }
            header.extend(
                buffer[..read]
                    .iter()
                    .take(16usize.saturating_sub(header.len()))
                    .copied(),
            );
            digest.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
        }
        if count != metadata.size_bytes
            || hex::encode(digest.finalize()) != metadata.sha256.as_str()
        {
            return Err("Plugin snapshot checksum disagrees with response".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let sqlite = retained_data::is_database(slug, relative, &header);
        if sqlite != (expected.kind == DataFileKind::Sqlite) {
            return Err("Plugin snapshot database type disagrees with its inventory".into());
        }
        if sqlite {
            check_sqlite(&target, context)?;
        }
        result.inventory.push(PluginDataFile {
            path: relative.into(),
            kind: if sqlite {
                PluginDataFileKind::Sqlite
            } else {
                PluginDataFileKind::File
            },
        });
        result.files.push(StagedFile {
            archive_path: format!("plugins/{slug}/data/{relative}"),
            disk_path: target,
        });
    }
    context.check()?;
    private.keep();
    Ok(result)
}

fn check_sqlite(path: &Path, context: &SnapshotContext) -> Result<(), String> {
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|e| e.to_string())?;
    context.sqlite(&db, || {
        let result: String = db
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if result != "ok" {
            return Err("Plugin SQLite snapshot failed quick_check".into());
        }
        Ok(())
    })?;
    db.close().map_err(|(_, error)| error.to_string())
}
