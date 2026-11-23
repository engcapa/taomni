//! Merge legacy mailboxes into an offline restored Mail directory.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

use taomni_mail_engine::migration::{HostedMailboxData, LegacyMailbox, StagedMailData};
use taomni_sqlite_snapshot::SnapshotControl;

use super::{DataReceipt, OWNER, RECEIPT, load_receipt, paths};
use crate::plugin::{data_contract::PluginDataRoot, retained_data};

pub(super) fn saved_data(module: &Path, transaction: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(transaction).map_err(|_| "Invalid Mail upgrade transaction")?;
    let profile = module
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid Mail module path")?;
    let generation = crate::runtime::generation::current(profile)?;
    Ok(module.join(format!(".mail-restored-{id}-{}", generation.as_str())))
}

fn data_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => paths::directory(path).map(|_| true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn recover_before_activation(
    module: &Path,
    data: &Path,
    transaction: &str,
    schema: u32,
) -> Result<(), String> {
    let saved = saved_data(module, transaction)?;
    if !data_exists(&saved)? {
        return Ok(());
    }
    // The saved directory holds the original restored files. Only the staged
    // replacement from this transaction can be moved out of its way.
    if !data_exists(data)? {
        fs::rename(saved, data).map_err(|error| error.to_string())?;
        return paths::sync_directory(module);
    }
    load_receipt(data, schema, Some(transaction), false)?
        .ok_or("Cannot recover restored Mail data over an unrecognized directory")?;
    let staging = tempfile::tempdir_in(module).map_err(|error| error.to_string())?;
    let replacement = staging.path().join("replacement");
    fs::rename(data, &replacement).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(saved, data) {
        if let Err(restore) = fs::rename(replacement, data) {
            let preserved = staging.keep();
            return Err(format!(
                "Could not recover restored Mail data: {error}. {restore}. Pending data: {}",
                preserved.display(),
            ));
        }
        return Err(error.to_string());
    }
    paths::sync_directory(module)
}

pub(super) fn publish(
    root: &PluginDataRoot,
    plugins: &Path,
    missing: &[LegacyMailbox],
    restored_pop3: &[String],
    hosted: HostedMailboxData,
    receipt: &DataReceipt,
    control: &SnapshotControl,
) -> Result<(), String> {
    let module = root.data.parent().ok_or("Invalid Mail module path")?;
    let preserved = saved_data(module, &receipt.transaction_id)?;
    if data_exists(&preserved)? {
        return Err("Restored Mail data still requires recovery".into());
    }
    let stage = StagedMailData::prepare(module, missing, hosted, control)?;
    let staged = stage.data();
    // Preserve the actual current directory, including retained files added
    // since the original restore. Portable data discovery rejects links.
    let current = retained_data::discover(plugins, OWNER, receipt.data_schema_version)
        .map_err(|error| error.to_string())?;
    for entry in current.files {
        if entry.path == RECEIPT {
            continue;
        }
        let source = root
            .resolve_file(&entry.path)
            .map_err(|error| error.to_string())?;
        let destination = staged.join(entry.path);
        copy_retained_file(&source, &destination, control)?;
    }
    for account in restored_pop3 {
        control.check().map_err(|error| error.to_string())?;
        taomni_mail_engine::pop3::ownership::mark_owned(&staged, account)
            .map_err(|error| error.to_string())?;
    }
    paths::write_json_durable(&staged.join(RECEIPT), receipt)?;
    sync_tree(&staged, control)?;
    control.check().map_err(|error| error.to_string())?;
    fs::rename(&root.data, &preserved).map_err(|error| error.to_string())?;
    let publication = paths::sync_directory(module)
        .and_then(|()| fs::rename(&staged, &root.data).map_err(|error| error.to_string()));
    if let Err(error) = publication {
        fs::rename(preserved, &root.data).map_err(|restore| {
            format!("Could not publish or recover restored Mail data: {error}. {restore}")
        })?;
        paths::sync_directory(module)?;
        return Err(error);
    }
    paths::sync_directory(module)
}

fn copy_retained_file(
    source: &Path,
    destination: &Path,
    control: &SnapshotControl,
) -> Result<(), String> {
    fs::create_dir_all(destination.parent().ok_or("Invalid retained Mail path")?)
        .map_err(|error| error.to_string())?;
    let mut source = paths::open_file(source)?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| {
            format!(
                "Could not preserve restored Mail file {}: {error}",
                destination.display()
            )
        })?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        control.check().map_err(|error| error.to_string())?;
        let length = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        target
            .write_all(&buffer[..length])
            .map_err(|error| error.to_string())?;
    }
    target.sync_all().map_err(|error| error.to_string())
}

fn sync_tree(path: &Path, control: &SnapshotControl) -> Result<(), String> {
    control.check().map_err(|error| error.to_string())?;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            sync_tree(&entry.path(), control)?;
        }
    }
    paths::sync_directory(path)
}

pub(super) fn remove_preserved_data(module: &Path, transaction: &str) -> Result<(), String> {
    let preserved = saved_data(module, transaction)?;
    if data_exists(&preserved)? {
        fs::remove_dir_all(preserved).map_err(|error| error.to_string())?;
        paths::sync_directory(module)?;
    }
    Ok(())
}
