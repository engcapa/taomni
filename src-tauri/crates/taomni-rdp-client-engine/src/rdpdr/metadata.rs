use super::paths::safe_join_from;
use super::paths::validate_confined_path;
use ironrdp::rdpdr::pdu::efs;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy)]
pub(super) struct FileTimes {
    pub(super) creation: i64,
    pub(super) access: i64,
    pub(super) write: i64,
    pub(super) change: i64,
}

pub(super) fn metadata_times(metadata: &fs::Metadata) -> FileTimes {
    let creation = metadata_time(metadata.created().ok());
    let access = metadata_time(metadata.accessed().ok());
    let write = metadata_time(metadata.modified().ok());
    FileTimes {
        creation,
        access,
        write,
        change: write.max(creation),
    }
}

pub(super) fn metadata_time(time: Option<SystemTime>) -> i64 {
    let Some(time) = time else { return 0 };
    let Ok(duration) = time.duration_since(UNIX_EPOCH) else {
        return 0;
    };
    let ticks = (duration.as_secs().saturating_add(11_644_473_600)).saturating_mul(10_000_000)
        + u64::from(duration.subsec_nanos() / 100);
    ticks.min(i64::MAX as u64) as i64
}

pub(super) fn file_attributes(metadata: &fs::Metadata, name: &str) -> efs::FileAttributes {
    let mut attrs = efs::FileAttributes::empty();
    if metadata.is_dir() {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_DIRECTORY;
    } else {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_ARCHIVE;
    }
    if metadata.permissions().readonly() {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    if name.starts_with('.') && name.len() > 1 {
        attrs |= efs::FileAttributes::FILE_ATTRIBUTE_HIDDEN;
    }
    attrs
}

pub(super) fn display_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

pub(super) fn directory_info(
    class: &efs::FileInformationClassLevel,
    metadata: &fs::Metadata,
    name: String,
) -> Option<efs::FileInformationClass> {
    let attrs = file_attributes(metadata, &name);
    let times = metadata_times(metadata);
    let size = metadata.len().min(i64::MAX as u64) as i64;
    if *class == efs::FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::BothDirectory(
            efs::FileBothDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_FULL_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::FullDirectory(
            efs::FileFullDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_NAMES_INFORMATION {
        Some(efs::FileInformationClass::Names(
            efs::FileNamesInformation::new(name),
        ))
    } else if *class == efs::FileInformationClassLevel::FILE_DIRECTORY_INFORMATION {
        Some(efs::FileInformationClass::Directory(
            efs::FileDirectoryInformation::new(
                times.creation,
                times.access,
                times.write,
                times.change,
                size,
                attrs,
                name,
            ),
        ))
    } else {
        None
    }
}

pub(super) fn query_entries(root: &Path, base: &Path, query: &str) -> Result<Vec<PathBuf>, String> {
    let query = query.trim_end_matches('\0').replace('\\', "/");
    if query.is_empty() || query == "*" {
        return list_directory(root, base);
    }
    if query.contains('*') {
        let (parent, pattern) = split_query_pattern(&query);
        let dir = safe_join_from(root, base, parent)?;
        validate_confined_path(root, &dir)?;
        let mut entries = list_directory(root, &dir)?;
        if pattern != "*" {
            let prefix = pattern.trim_end_matches('*');
            entries.retain(|entry| display_name(entry, "").starts_with(prefix));
        }
        return Ok(entries);
    }
    let path = safe_join_from(root, base, &query)?;
    validate_confined_path(root, &path)?;
    if path.exists() {
        Ok(vec![path])
    } else {
        Ok(Vec::new())
    }
}

pub(super) fn split_query_pattern(query: &str) -> (&str, &str) {
    match query.rfind('/') {
        Some(index) => (&query[..index], &query[index + 1..]),
        None => ("", query),
    }
}

pub(super) fn list_directory(root: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    validate_confined_path(root, dir)?;
    let mut entries = fs::read_dir(dir)
        .map_err(|e| format!("rdpdr: read directory '{}': {}", dir.display(), e))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| validate_confined_path(root, path).is_ok())
        .collect::<Vec<_>>();
    entries.sort_by_key(|path| display_name(path, ""));
    Ok(entries)
}

pub(super) fn volume_serial(root: &Path) -> u32 {
    root.to_string_lossy()
        .bytes()
        .fold(0x4e4d_5244u32, |acc, b| acc.rotate_left(5) ^ u32::from(b))
}
