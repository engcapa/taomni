//! Discover data owners without reading executable packages or starting hosts.
use crate::plugin::data_contract::{is_link, require_directory};
use std::{fs, path::Path};
use taomni_profile_locks::PluginSlug;

use super::contracts::MAX_DATASETS;

pub(crate) fn discover_owners(plugins: &Path) -> Result<Vec<String>, String> {
    match fs::symlink_metadata(plugins) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => require_directory(plugins).map_err(|e| e.to_string())?,
    }
    let mut owners = Vec::new();
    for entry in fs::read_dir(plugins).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if PluginSlug::parse(&slug).is_err() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if is_link(&fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?) {
            return Err("Plugin backup owner directory must not be linked".into());
        }
        if !metadata.is_dir() {
            continue;
        }
        match fs::symlink_metadata(entry.path().join("data")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
            Ok(_) => (), // The data contract rejects non-directory/link roots.
        }
        owners.push(slug);
        if owners.len() > MAX_DATASETS {
            return Err("Too many plugin data owners to back up".into());
        }
    }
    owners.sort();
    Ok(owners)
}
