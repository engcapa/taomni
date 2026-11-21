use super::{
    super::{
        archive_writer::{StagedFile, pack_staged_archive_with_plugins},
        manifest::BackupManifest,
        snapshot_context::SnapshotContext,
    },
    contracts::{PluginDataFile, PluginDataFileKind, PluginDataSet},
};
use std::{fs, path::Path};
use taomni_plugin_api::services::{ProfileGeneration, SnapshotJobId};

pub(super) fn dataset(slug: &str, files: &[(&str, PluginDataFileKind)]) -> PluginDataSet {
    let files: Vec<_> = files
        .iter()
        .map(|(path, kind)| PluginDataFile {
            path: (*path).into(),
            kind: *kind,
        })
        .collect();
    PluginDataSet {
        slug: slug.into(),
        data_schema_version: 7,
        requires_vault: super::contracts::dataset_requires_vault(slug, &files),
        job: SnapshotJobId::parse("018f6811-b7b1-7000-8000-000000000001").unwrap(),
        profile_generation: ProfileGeneration::parse("018f6811-b7b1-7000-8000-000000000002")
            .unwrap(),
        files,
    }
}

pub(super) fn manifest(data: PluginDataSet) -> BackupManifest {
    let mut manifest = BackupManifest::new("test".into(), "core".into(), false);
    manifest.format_version = 2;
    for file in &data.files {
        manifest.add_file(data.archive_path(&file.path), "a".repeat(64), 1);
    }
    if data.requires_vault {
        manifest.add_file("databases/vault.db".into(), "b".repeat(64), 1);
    }
    manifest.plugin_datasets.push(data);
    manifest
}

pub(super) fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

pub(super) fn archive(
    root: &Path,
    dataset: PluginDataSet,
    files: &[StagedFile],
    password: Option<&str>,
) -> std::path::PathBuf {
    let archive = root.join("modular.taobak");
    pack_staged_archive_with_plugins(
        files,
        "test",
        "core",
        password,
        &archive,
        None,
        vec![dataset],
        &SnapshotContext::default(),
    )
    .unwrap();
    archive
}
