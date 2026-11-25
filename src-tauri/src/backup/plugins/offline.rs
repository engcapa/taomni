//! Offline data copies hold the same exclusive owner lease as the actual host.
use super::{
    super::{archive_writer::StagedFile, snapshot_context::SnapshotContext},
    contracts::{PluginDataFile, PluginDataFileKind},
};
use crate::plugin::{
    data_contract::PluginDataRoot,
    retained_data::{self, DataFileKind},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::Path,
};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

pub(crate) struct OfflineSnapshot {
    pub(crate) files: Vec<StagedFile>,
    pub(crate) inventory: Vec<PluginDataFile>,
    pub(crate) schema: u32,
}

pub(crate) fn stage(
    profile: &ProfileRoot,
    slug: &str,
    schema: Option<u32>,
    staging: &Path,
    context: &SnapshotContext,
) -> Result<OfflineSnapshot, String> {
    context.check()?;
    let owner = PluginSlug::parse(slug).map_err(|e| e.to_string())?;
    let _lease = PluginDataLease::try_acquire(profile, &owner)
        .map_err(|e| format!("Plugin {slug} is in use by another instance: {e}"))?;
    let plugins = profile.path().join("plugins");
    let retained = retained_data::load(&plugins, slug).map_err(|e| e.to_string())?;
    let schema = schema
        .or_else(|| retained.as_ref().map(|locator| locator.data_schema_version))
        .unwrap_or(1);
    // A locator can be older than the data. Always rescan the bounded data
    // subtree so unknown/new files are not silently dropped from a backup.
    let inventory = retained_data::discover(&plugins, slug, schema).map_err(|e| e.to_string())?;
    let actual: BTreeMap<_, _> = inventory
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.kind))
        .collect();
    if let Some(retained) = &retained {
        for file in &retained.files {
            if file.kind == DataFileKind::Sqlite
                && actual.get(file.path.as_str()) == Some(&DataFileKind::File)
                && !retained_data::opaque_file(slug, &file.path)
            {
                return Err(format!(
                    "Known SQLite data has an invalid header: {slug}/{}",
                    file.path
                ));
            }
        }
    }
    let root = PluginDataRoot::open(&plugins, slug).map_err(|e| e.to_string())?;
    let sqlite: BTreeSet<_> = inventory
        .files
        .iter()
        .filter(|file| file.kind == DataFileKind::Sqlite)
        .map(|file| file.path.as_str())
        .collect();
    let sidecars: BTreeSet<_> = sqlite
        .iter()
        .flat_map(|path| ["-wal", "-shm", "-journal"].map(|suffix| format!("{path}{suffix}")))
        .collect();
    let temporary = tempfile::Builder::new()
        .prefix("plugin-")
        .tempdir_in(staging)
        .map_err(|e| e.to_string())?;
    let mut result = OfflineSnapshot {
        files: Vec::new(),
        inventory: Vec::new(),
        schema,
    };
    for file in &inventory.files {
        context.check()?;
        if sidecars.contains(&file.path) {
            continue;
        }
        let target = temporary.path().join(&file.path);
        fs::create_dir_all(target.parent().ok_or("Invalid plugin snapshot target")?)
            .map_err(|e| e.to_string())?;
        let source = root.resolve_file(&file.path).map_err(|e| e.to_string())?;
        let kind = if file.kind == DataFileKind::Sqlite {
            if !context.snapshot_existing(&source, &target)? {
                return Err(format!("Plugin {slug} data disappeared during snapshot"));
            }
            PluginDataFileKind::Sqlite
        } else {
            copy_open_file(
                root.open_file(&file.path).map_err(|e| e.to_string())?,
                &target,
                context,
            )?;
            PluginDataFileKind::File
        };
        result.inventory.push(PluginDataFile {
            path: file.path.clone(),
            kind,
        });
        result.files.push(StagedFile {
            archive_path: format!("plugins/{slug}/data/{}", file.path),
            disk_path: target,
        });
    }
    context.check()?;
    temporary.keep(); // Whole-backup staging owns successful artifacts.
    Ok(result)
}

fn copy_open_file(
    source: fs::File,
    target: &Path,
    context: &SnapshotContext,
) -> Result<(), String> {
    let mut source = context.reader(source);
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|e| e.to_string())?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
    }
    context.check()?;
    output.sync_all().map_err(|e| e.to_string())
}
