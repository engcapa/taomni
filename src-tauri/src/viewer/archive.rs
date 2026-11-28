use super::filesystem::open_regular;

use rars::ReadCancellation;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use zip::ZipArchive;

mod codec;
mod compressed_file;
pub(crate) mod jobs;
mod rar_archive;
mod seven_zip;
mod stage;
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

fn zip_catalog<R: Read + io::Seek>(file: R) -> Result<(ZipArchive<R>, Vec<Entry>), String> {
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
    member: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let (_, file, meta) = open_regular(path)?;
    visit_open(
        path,
        file,
        meta.len(),
        selection,
        &ReadCancellation::new(),
        member,
    )
}

fn visit_open(
    path: &str,
    file: File,
    length: u64,
    selection: Selection,
    cancel: &ReadCancellation,
    mut member: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    if length > MAX_ARCHIVE {
        return Err(invalid("Archive input exceeds 64 MiB"));
    }
    let file = codec::Cancellable::new(file, cancel);
    if let Some((format, _)) = tar_archive::suffix(path) {
        return tar_archive::visit(format, file.take(length), selection, cancel, member);
    }
    if let Some(extension) = Path::new(path).extension() {
        if extension.eq_ignore_ascii_case("7z") {
            return seven_zip::visit(file, selection, cancel, member);
        }
        if extension.eq_ignore_ascii_case("rar") {
            return rar_archive::visit(file, selection, cancel, member);
        }
    }
    if let Some(codec) = compressed_file::codec(path) {
        return compressed_file::visit(
            file,
            length,
            archive_stem(path)?,
            codec,
            selection,
            cancel,
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
            member(entry, &mut codec::Cancellable::new(&mut contents, cancel))?;
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
    let cancel = ReadCancellation::new();
    let target = stage::Target::new(destination)?;
    let (_guard, stamp) = stage::Stage::allocate(&target)?;
    let stage = stage::Stage::open(&target, &stamp)?;
    let (source, input) = stage::Source::open(path, &cancel)?;
    let mode = selection
        .as_ref()
        .map_or(Selection::All, |entry| Selection::One(entry.index));
    let entries = visit_open(
        path,
        input,
        source.size(),
        mode,
        &cancel,
        |entry, contents| stage.write(entry, contents, |_| {}),
    )?;
    let (relative, output_name) = output_paths(path, selection.as_ref(), &entries)?;
    stage.verify(
        entries.iter().filter(|entry| mode.includes(entry.index)),
        &cancel,
    )?;
    let (current, _) = stage::Source::open(path, &cancel)?;
    if current != source {
        return Err(invalid("The source archive changed during extraction"));
    }
    let publication = stage.prepare(relative, output_name)?;
    stage.publish(&target, &stamp, relative, &publication)
}

fn output_paths<'a>(
    path: &'a str,
    selected: Option<&'a Entry>,
    entries: &'a [Entry],
) -> Result<(&'a str, &'a str), String> {
    let entry = selected.or_else(|| {
        if is_single_compressed_file(path) {
            entries.first()
        } else {
            None
        }
    });
    if let Some(entry) = entry {
        if entry.directory || entries.get(entry.index) != Some(entry) {
            return Err(invalid(
                "Archive changed. Reload before extracting the entry",
            ));
        }
        Ok((&entry.name, entry.name.rsplit('/').next().unwrap_or("")))
    } else {
        Ok(("", archive_stem(path)?))
    }
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
