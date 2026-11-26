use super::filesystem::open_regular;
use super::paths::{ScopedRoot, absolute, display, io_error};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_ARCHIVE: u64 = 64 << 20;
const MAX_ENTRY: u64 = 32 << 20;
const MAX_TOTAL: u64 = 256 << 20;
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    index: usize,
    name: String,
    directory: bool,
    size: u64,
    crc: u32,
}

fn invalid(error: impl std::fmt::Display) -> String {
    format!("archive: {error}")
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1024
        && name.split('/').all(|part| {
            let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !part.is_empty()
                && part.len() <= 255
                && !part.ends_with(['.', ' '])
                && !part.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
                && !part.chars().any(char::is_control)
                && !matches!(
                    base.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                && !["COM", "LPT"].iter().any(|prefix| {
                    base.strip_prefix(prefix).is_some_and(|n| {
                        matches!(
                            n,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                })
        })
}

fn catalog(path: &str) -> Result<(ZipArchive<File>, Vec<Entry>), String> {
    let (_, file, meta) = open_regular(path)?;
    if meta.len() > MAX_ARCHIVE {
        return Err(invalid("ZIP input exceeds 64 MiB"));
    }
    let mut zip = ZipArchive::new(file).map_err(invalid)?;
    if zip.len() > MAX_ENTRIES {
        return Err(invalid("ZIP directory exceeds 4,096 entries"));
    }
    let mut entries = Vec::with_capacity(zip.len());
    let mut total = 0u64;
    for index in 0..zip.len() {
        let file = zip.by_index_raw(index).map_err(invalid)?;
        let directory = file.is_dir();
        let name = file.name().strip_suffix('/').unwrap_or(file.name());
        let kind = file.unix_mode().unwrap_or(0) & 0o170000;
        if !safe_name(name) || file.is_symlink() || !matches!(kind, 0 | 0o100000 | 0o040000) {
            return Err(invalid(
                "Archive contains an unsafe path or non-regular entry",
            ));
        }
        if file.encrypted() {
            return Err(invalid("Password-protected archives are unsupported"));
        }
        total = total.saturating_add(file.size());
        if file.size() > MAX_ENTRY || total > MAX_TOTAL {
            return Err(invalid("Archive exceeds the expanded size limit"));
        }
        entries.push(Entry {
            index,
            name: name.into(),
            directory,
            size: file.size(),
            crc: file.crc32(),
        });
    }
    Ok((zip, entries))
}

pub(crate) fn list(path: &str) -> Result<Vec<Entry>, String> {
    catalog(path).map(|(_, entries)| entries)
}

fn copy(zip: &mut ZipArchive<File>, entry: &Entry, mut target: impl Write) -> Result<(), String> {
    let file = zip.by_index(entry.index).map_err(invalid)?;
    let count = io::copy(&mut file.take(entry.size + 1), &mut target).map_err(invalid)?;
    if count != entry.size {
        return Err(invalid("File size differs from the directory"));
    }
    Ok(())
}

pub(crate) fn preview(path: &str, entry: Entry) -> Result<super::TempFile, String> {
    let (mut archive, entries) = catalog(path)?;
    if entries.get(entry.index) != Some(&entry) || entry.directory {
        return Err(invalid("Archive changed. Reload before opening the entry"));
    }
    let mut bytes = Vec::new();
    copy(&mut archive, &entry, &mut bytes)?;
    super::create_temp(entry.name.rsplit('/').next().unwrap_or(""), &bytes)
}

/// Stage all output under a private directory. Publish in one no-replace rename
/// so invalid later members and destination collisions preserve existing files.
pub(crate) fn extract(
    path: &str,
    destination: &str,
    selection: Option<Entry>,
) -> Result<String, String> {
    let (mut zip, entries) = catalog(path)?;
    let dest = absolute(destination)?;
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| invalid("Missing archive name"))?;
    if !safe_name(stem) {
        return Err(invalid("Invalid output directory name"));
    }
    let temp = tempfile::Builder::new()
        .prefix(".taomni-extract-")
        .tempdir_in(&dest)
        .map_err(invalid)?;
    let root = ScopedRoot::new(temp.path())?;
    let (selected, output): (&[Entry], PathBuf) = if let Some(entry) = selection.as_ref() {
        if entry.directory || entries.get(entry.index) != Some(entry) {
            return Err(invalid(
                "Archive changed. Reload before extracting the entry",
            ));
        }
        (
            std::slice::from_ref(entry),
            dest.join(entry.name.rsplit('/').next().unwrap_or("")),
        )
    } else {
        (&entries, dest.join(stem))
    };
    for entry in selected {
        if entry.directory {
            root.create_directory(&entry.name)?;
        } else {
            let mut file = root.create(&entry.name).map_err(invalid)?;
            copy(&mut zip, entry, &mut file)?;
            file.sync_all().map_err(invalid)?;
        }
    }
    drop(root);
    let source = selection.map_or_else(
        || temp.path().to_owned(),
        |entry| temp.path().join(entry.name),
    );
    crate::filebrowser::local_ops::rename_no_replace(&source, &output)
        .map_err(|error| io_error("publish archive output", error))?;
    Ok(display(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_and_extract_keep_payloads_and_collisions_intact() {
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("bundle.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.add_directory("empty/", options).unwrap();
        zip.start_file("notes/é.txt", options).unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();
        let path = path.to_str().unwrap();
        let entries = list(path).unwrap();
        let preview = preview(path, entries[1].clone()).unwrap();
        assert_eq!(std::fs::read(&preview.path).unwrap(), b"hello");
        super::super::release_temp(&preview.path).unwrap();
        let dest = files.path().to_str().unwrap();
        extract(path, dest, None).unwrap();
        assert!(files.path().join("bundle/empty").is_dir());
        assert_eq!(
            std::fs::read(files.path().join("bundle/notes/é.txt")).unwrap(),
            b"hello"
        );
        assert!(extract(path, dest, None).is_err());
        extract(path, dest, Some(entries[1].clone())).unwrap();
        assert_eq!(std::fs::read(files.path().join("é.txt")).unwrap(), b"hello");
    }
}
