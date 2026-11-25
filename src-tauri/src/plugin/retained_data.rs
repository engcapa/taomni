//! Core-owned data inventory. This is deliberately not a ModuleManifest and
//! contains no commands, permissions, package/version pointers or key grants.
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use taomni_profile_locks::PluginSlug;

use super::PluginError;
use super::data_contract::{
    PluginDataRoot, invalid, is_link, open_regular, require_directory, require_file,
    validate_relative,
};

const CONTROL_DIRECTORY: &str = ".retained-data";
const FORMAT_VERSION: u32 = 1;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 16_384;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DataFileKind {
    File,
    Sqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetainedDataFile {
    /// Relative to this owner's `plugins/<slug>/data/`, never the profile root.
    pub(crate) path: String,
    pub(crate) kind: DataFileKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetainedDataLocator {
    pub(crate) format_version: u32,
    pub(crate) slug: String,
    pub(crate) data_schema_version: u32,
    pub(crate) files: Vec<RetainedDataFile>,
}

impl RetainedDataLocator {
    pub(crate) fn validate(&self, slug: &str) -> Result<(), PluginError> {
        PluginSlug::parse(slug).map_err(|_| invalid("invalid retained data owner"))?;
        if self.format_version != FORMAT_VERSION
            || self.slug != slug
            || self.data_schema_version == 0
        {
            return Err(invalid("retained data identity/schema is invalid"));
        }
        if self.files.len() > MAX_FILES {
            return Err(invalid("retained data inventory exceeds file limit"));
        }
        let mut seen = BTreeSet::new();
        for file in &self.files {
            validate_relative(&file.path)?;
            if !seen.insert(file.path.to_lowercase()) {
                return Err(invalid("retained data paths conflict"));
            }
        }
        Ok(())
    }

    /// Dependency comes from core owner policy, never locator self-report.
    pub(crate) fn requires_vault(&self) -> bool {
        self.slug == taomni_plugin_services::MFA_FIXED_KEY_OWNER.slug && !self.files.is_empty()
    }
}

/// Call under the owner's exclusive PluginDataLease. Unknown data is included
/// conservatively; executable version/control directories are never visited.
pub(crate) fn discover(
    plugins: &Path,
    slug: &str,
    schema: u32,
) -> Result<RetainedDataLocator, PluginError> {
    let root = PluginDataRoot::open(plugins, slug)?;
    let mut files = Vec::new();
    if root.data.exists() {
        collect(&root, slug, &root.data, &mut files)?;
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let locator = RetainedDataLocator {
        format_version: FORMAT_VERSION,
        slug: slug.into(),
        data_schema_version: schema,
        files,
    };
    locator.validate(slug)?;
    Ok(locator)
}

fn collect(
    root: &PluginDataRoot,
    slug: &str,
    path: &Path,
    files: &mut Vec<RetainedDataFile>,
) -> Result<(), PluginError> {
    require_directory(path)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(&root.data)
            .expect("data descendant")
            .to_str()
            .ok_or_else(|| invalid("plugin data names must be UTF-8"))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_relative(&relative)?;
        let metadata = fs::symlink_metadata(&path)?;
        if is_link(&metadata) {
            return Err(invalid("plugin data contains a link/reparse point"));
        }
        if metadata.is_dir() {
            collect(root, slug, &path, files)?;
        } else {
            require_file(&metadata)?;
            if files.len() == MAX_FILES {
                return Err(invalid("retained data inventory exceeds file limit"));
            }
            let mut header = Vec::with_capacity(16);
            root.open_file(&relative)?
                .take(16)
                .read_to_end(&mut header)?;
            let kind = if is_database(slug, &relative, &header) {
                DataFileKind::Sqlite
            } else {
                DataFileKind::File
            };
            files.push(RetainedDataFile {
                path: relative,
                kind,
            });
        }
    }
    Ok(())
}

/// Attachments contain downloaded bytes with no SQLite lifecycle.
pub(crate) fn opaque_file(slug: &str, relative: &str) -> bool {
    slug == "mail" && relative.starts_with("attachments/")
}

pub(crate) fn is_database(slug: &str, relative: &str, header: &[u8]) -> bool {
    !opaque_file(slug, relative) && header == b"SQLite format 3\0"
}

pub(crate) fn save(plugins: &Path, locator: &RetainedDataLocator) -> Result<(), PluginError> {
    locator.validate(&locator.slug)?;
    require_directory(plugins)?;
    let directory = plugins.join(CONTROL_DIRECTORY);
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    require_directory(&directory)?;
    let bytes = serde_json::to_vec_pretty(locator)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("retained data locator exceeds size limit"));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(format!("{}.json", locator.slug)))
        .map_err(|error| error.error)?;
    sync_directory(&directory)?;
    Ok(())
}

pub(crate) fn load(plugins: &Path, slug: &str) -> Result<Option<RetainedDataLocator>, PluginError> {
    PluginSlug::parse(slug).map_err(|_| invalid("invalid retained data owner"))?;
    require_directory(plugins)?;
    let directory = plugins.join(CONTROL_DIRECTORY);
    let path = directory.join(format!("{slug}.json"));
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => require_directory(&directory)?,
    }
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) => require_file(&metadata)?,
    }
    let mut bytes = Vec::new();
    open_regular(&path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("retained data locator exceeds size limit"));
    }
    let locator: RetainedDataLocator = serde_json::from_slice(&bytes)?;
    locator.validate(slug)?;
    Ok(Some(locator))
}

pub(crate) fn remove(plugins: &Path, slug: &str) -> Result<(), PluginError> {
    // Validate existing metadata/control paths before removing anything.
    if load(plugins, slug)?.is_none() {
        return Ok(());
    }
    let directory = plugins.join(CONTROL_DIRECTORY);
    fs::remove_file(directory.join(format!("{slug}.json")))?;
    sync_directory(&directory)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), PluginError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
#[path = "retained_data_tests.rs"]
mod tests;
