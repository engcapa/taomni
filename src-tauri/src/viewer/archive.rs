use super::filesystem::open_regular;
use super::paths::{ScopedRoot, absolute, display, io_error};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use zip::ZipArchive;

mod codec;
mod compressed_file;
mod seven_zip;
mod tar_archive;

const MAX_ARCHIVE: u64 = 64 << 20;
const MAX_ENTRY: u64 = 32 << 20;
const MAX_TOTAL: u64 = 256 << 20;
const MAX_ENTRIES: usize = 4096;
const UNSAFE_ENTRY: &str = "Archive contains an unsafe path or non-regular entry";

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

fn zip_catalog(file: File) -> Result<(ZipArchive<File>, Vec<Entry>), String> {
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
        if file.is_symlink() || !matches!(kind, 0 | 0o100000 | 0o040000) {
            return Err(invalid(UNSAFE_ENTRY));
        }
        if file.encrypted() {
            return Err(invalid("Password-protected archives are unsupported"));
        }
        validate_member(name, file.size(), &mut total)?;
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

fn validate_member(name: &str, size: u64, total: &mut u64) -> Result<(), String> {
    if !safe_name(name) {
        return Err(invalid(UNSAFE_ENTRY));
    }
    *total = total.saturating_add(size);
    if size > MAX_ENTRY || *total > MAX_TOTAL {
        return Err(invalid("Archive exceeds the expanded size limit"));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Selection {
    List,
    One(usize),
    All,
}

impl Selection {
    fn includes(self, index: usize) -> bool {
        matches!(self, Self::All) || matches!(self, Self::One(selected) if selected == index)
    }
}

fn visit(
    path: &str,
    selection: Selection,
    mut member: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let (_, file, meta) = open_regular(path)?;
    if meta.len() > MAX_ARCHIVE {
        return Err(invalid("Archive input exceeds 64 MiB"));
    }
    if let Some((format, _)) = tar_archive::suffix(path) {
        return tar_archive::visit(format, file.take(meta.len()), selection, member);
    }
    if Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("7z"))
    {
        return seven_zip::visit(file, selection, member);
    }
    if let Some(codec) = compressed_file::codec(path) {
        return compressed_file::visit(
            file,
            meta.len(),
            archive_stem(path)?,
            codec,
            selection,
            member,
        );
    }

    let (mut zip, entries) = zip_catalog(file)?;
    for entry in entries
        .iter()
        .filter(|entry| selection.includes(entry.index))
    {
        if entry.directory {
            member(entry, &mut io::empty())?;
        } else {
            let mut contents = zip.by_index(entry.index).map_err(invalid)?;
            member(entry, &mut contents)?;
        }
    }
    Ok(entries)
}

pub(crate) fn list(path: &str) -> Result<Vec<Entry>, String> {
    visit(path, Selection::List, |_, _| Ok(()))
}

fn copy_entry(
    entry: &Entry,
    contents: &mut dyn Read,
    mut target: impl Write,
) -> Result<(), String> {
    let count = io::copy(&mut contents.take(entry.size + 1), &mut target).map_err(invalid)?;
    if count != entry.size {
        return Err(invalid("File size differs from the directory"));
    }
    Ok(())
}

pub(crate) fn preview(path: &str, entry: Entry) -> Result<super::TempFile, String> {
    let mut bytes = Vec::new();
    let entries = visit(path, Selection::One(entry.index), |current, contents| {
        copy_entry(current, contents, &mut bytes)
    })?;
    if entries.get(entry.index) != Some(&entry) || entry.directory {
        return Err(invalid("Archive changed. Reload before opening the entry"));
    }
    super::create_temp(entry.name.rsplit('/').next().unwrap_or(""), &bytes)
}

/// Stage all output under a private directory. Publish in one no-replace rename
/// so invalid later members and destination collisions preserve existing files.
pub(crate) fn extract(
    path: &str,
    destination: &str,
    selection: Option<Entry>,
) -> Result<String, String> {
    let dest = absolute(destination)?;
    let temp = tempfile::Builder::new()
        .prefix(".taomni-extract-")
        .tempdir_in(&dest)
        .map_err(invalid)?;
    let root = ScopedRoot::new(temp.path())?;
    let mode = selection
        .as_ref()
        .map_or(Selection::All, |entry| Selection::One(entry.index));
    let entries = visit(path, mode, |entry, contents| {
        if entry.directory {
            root.create_directory(&entry.name)?;
        } else {
            let mut file = root.create(&entry.name).map_err(invalid)?;
            copy_entry(entry, contents, &mut file)?;
            file.sync_all().map_err(invalid)?;
        }
        Ok(())
    })?;
    drop(root);
    let entry = selection.as_ref().or_else(|| {
        if is_single_compressed_file(path) {
            entries.first()
        } else {
            None
        }
    });
    let (source, output) = if let Some(entry) = entry {
        if entry.directory || entries.get(entry.index) != Some(entry) {
            return Err(invalid(
                "Archive changed. Reload before extracting the entry",
            ));
        }
        (
            temp.path().join(&entry.name),
            dest.join(entry.name.rsplit('/').next().unwrap_or("")),
        )
    } else {
        let stem = archive_stem(path)?;
        (temp.path().to_owned(), dest.join(stem))
    };
    crate::filebrowser::local_ops::rename_no_replace(&source, &output)
        .map_err(|error| io_error("publish archive output", error))?;
    Ok(display(&output))
}

fn archive_stem(path: &str) -> Result<&str, String> {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("Missing archive name"))?;
    let suffix_length = tar_archive::suffix(name).map_or_else(
        || name.rfind('.').map_or(0, |dot| name.len() - dot),
        |(_, suffix)| suffix.len(),
    );
    let stem = &name[..name.len() - suffix_length];
    if !safe_name(stem) {
        return Err(invalid("Invalid output directory name"));
    }
    Ok(stem)
}

fn is_single_compressed_file(path: &str) -> bool {
    tar_archive::suffix(path).is_none() && compressed_file::codec(path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_paths_and_links_fail_before_publishing_output() {
        let files = tempfile::tempdir().unwrap();
        let options = zip::write::SimpleFileOptions::default();
        let destination = files.path().to_str().unwrap();
        let cases = [
            ("traversal.zip", Some("../outside.txt")),
            ("absolute.zip", Some("/outside.txt")),
            ("device.zip", Some("folder/COM1.txt")),
            ("symlink.zip", None),
        ];
        std::fs::write(files.path().join("outside.txt"), "existing data").unwrap();
        for (name, unsafe_name) in cases {
            let path = files.path().join(name);
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            zip.start_file("earlier.txt", options).unwrap();
            zip.write_all(b"valid earlier member").unwrap();
            if let Some(unsafe_name) = unsafe_name {
                zip.start_file(unsafe_name, options).unwrap();
                zip.write_all(b"replacement").unwrap();
            } else {
                zip.add_symlink("linked.txt", "../outside.txt", options)
                    .unwrap();
            }
            zip.finish().unwrap();
            let source = path.to_str().unwrap();
            assert!(list(source).unwrap_err().contains("unsafe path"));
            assert!(extract(source, destination, None).is_err());
            assert!(!files.path().join(path.file_stem().unwrap()).exists());
        }
        assert_eq!(
            std::fs::read(files.path().join("outside.txt")).unwrap(),
            b"existing data"
        );
    }

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
