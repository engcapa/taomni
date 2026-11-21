//! Keep archived server rows in step with the captured module datasets.

use std::{fs::File, io::BufReader};

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use taomni_server_process::{rdp, vnc};

use super::archive_writer::StagedFile;

pub(super) fn module_owned_rows(
    files: &[StagedFile],
    includes_sessions: bool,
) -> Result<Vec<&'static str>, String> {
    let mut rows = Vec::new();
    if staged_settings::<vnc::StoredSettings>(files, vnc::CONFIG_PATH)?
        .is_some_and(|record| !record.settings.credential_migration_required)
    {
        rows.push("vnc");
    }
    if let Some(record) = staged_settings::<rdp::StoredSettings>(files, rdp::CONFIG_PATH)? {
        record.validate().map_err(|error| error.to_string())?;
        if !record.needs_legacy_password() {
            rows.push(rdp::SERVER_TYPE);
        } else if !includes_sessions {
            return Err("Save the migrated RDP Server settings with Vault unlocked before backing up module data separately.".into());
        }
    }
    Ok(rows)
}

pub(super) fn omit_rollback_rows(
    snapshot: &Connection,
    module_owned_rows: Vec<&str>,
) -> Result<(), String> {
    if !module_owned_rows.is_empty() {
        snapshot
            .pragma_update(None, "secure_delete", true)
            .map_err(|error| error.to_string())?;
    }
    for server in module_owned_rows {
        snapshot
            .execute(
                "DELETE FROM server_configs WHERE server_type = ?1",
                [server],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn staged_settings<T: DeserializeOwned>(
    files: &[StagedFile],
    archive_path: &str,
) -> Result<Option<T>, String> {
    files
        .iter()
        .find(|file| file.archive_path == archive_path)
        .map(|file| {
            let stream = File::open(&file.disk_path).map_err(|error| error.to_string())?;
            serde_json::from_reader(BufReader::new(stream)).map_err(|error| error.to_string())
        })
        .transpose()
}
