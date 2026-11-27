use super::codec::CheckedReader;
use super::{
    Entry, MAX_ENTRIES, MAX_ENTRY, MAX_TOTAL, Selection, UNSAFE_ENTRY, invalid, validate_member,
};
use rars::filename::LegacyNameEncoding;
use rars::{
    ArchiveMember, ArchiveMemberDetail, ArchiveReadOptions, ArchiveReader, AttrSource, Error,
    ErrorKind, ExtractionDecision,
};
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

const READ_MEMORY: u64 = 64 << 20;
const WINDOWS_REPARSE_POINT: u64 = 0x0400;

fn archive_error(error: Error) -> String {
    if matches!(
        error.kind(),
        ErrorKind::PasswordRequired | ErrorKind::BadPassword
    ) || matches!(
        error.root_cause(),
        Error::UnsupportedEncryption { .. }
            | Error::FeatureDisabled {
                feature: "encryption"
            }
    ) {
        invalid("Password-protected archives are unsupported")
    } else {
        invalid(error)
    }
}

fn catalog_entry(
    index: usize,
    member: ArchiveMember,
    total: &mut u64,
) -> Result<(Entry, bool), String> {
    let meta = &member.meta;
    if meta.is_encrypted {
        return Err(invalid("Password-protected archives are unsupported"));
    }
    if meta.is_split_before || meta.is_split_after {
        return Err(invalid("Multi-volume RAR archives are unsupported"));
    }
    let unsafe_attributes = match meta.attr_source() {
        AttrSource::Unix => !matches!(
            (meta.is_directory, meta.file_attr & 0o170000),
            (_, 0) | (false, 0o100000) | (true, 0o040000)
        ),
        AttrSource::Dos => meta.file_attr & WINDOWS_REPARSE_POINT != 0,
        _ => false,
    };
    if meta.is_redirection || unsafe_attributes || (meta.is_directory && meta.unpacked_size != 0) {
        return Err(invalid(UNSAFE_ENTRY));
    }

    let encoding =
        (std::str::from_utf8(meta.name_bytes()).is_err()).then_some(LegacyNameEncoding::Cp437);
    let name = member.decoded_name(encoding).map_err(archive_error)?;
    let name = std::str::from_utf8(&name).map_err(|_| invalid("Invalid RAR member name"))?;
    // Backslash separates Windows paths. A leading backslash becomes an
    // absolute path and fails the shared validator.
    let name = name.replace('\\', "/");
    let name = if meta.is_directory {
        name.strip_suffix('/').unwrap_or(&name)
    } else {
        &name
    };
    validate_member(name, meta.unpacked_size, total)?;
    let stored_crc = match member.detail {
        ArchiveMemberDetail::Rar13 { file_checksum, .. } => Some(u32::from(file_checksum)),
        ArchiveMemberDetail::Rar15To40 { crc32, .. } => Some(crc32),
        ArchiveMemberDetail::Rar50Plus { crc32, .. } => crc32,
        _ => None,
    };
    Ok((
        Entry {
            index,
            name: name.to_owned(),
            directory: meta.is_directory,
            size: meta.unpacked_size,
            crc: stored_crc.unwrap_or_default(),
        },
        stored_crc.is_none() && meta.unpacked_size > 0,
    ))
}

fn consume(
    entry: &mut Entry,
    mut contents: File,
    calculate_crc: bool,
    selection: Selection,
    visitor: &mut impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<(), String> {
    contents.seek(SeekFrom::Start(0)).map_err(invalid)?;
    let mut checked = CheckedReader::new(contents.take(entry.size + 1));
    if selection.includes(entry.index) {
        visitor(entry, &mut checked)?;
    }
    io::copy(&mut checked, &mut io::sink()).map_err(invalid)?;
    if checked.size != entry.size {
        return Err(invalid("RAR member size differs from the directory"));
    }
    if calculate_crc {
        entry.crc = checked.crc.finalize();
    }
    Ok(())
}

pub(super) fn visit(
    file: File,
    selection: Selection,
    mut visitor: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let options = ArchiveReadOptions::default()
        .with_max_header_count((MAX_ENTRIES + 64) as u64)
        .with_max_header_bytes(8 << 20)
        .with_max_member_output_bytes(MAX_ENTRY)
        .with_max_total_output_bytes(MAX_TOTAL)
        .with_max_reader_workspace_bytes(READ_MEMORY)
        .with_rar50_dictionary_size_limit(READ_MEMORY)
        .with_rar50_buffered_decode_limit(4 << 20);
    let archive = ArchiveReader::read_reader_with_options(file, options).map_err(archive_error)?;
    if archive.is_volume() {
        return Err(invalid("Multi-volume RAR archives are unsupported"));
    }
    let mut entries = Vec::new();
    let mut missing_crc = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0;
    for (index, member) in archive.members().enumerate() {
        if index >= MAX_ENTRIES {
            return Err(invalid("RAR directory exceeds 4,096 entries"));
        }
        let (entry, calculate_crc) = catalog_entry(index, member, &mut total)?;
        if !names.insert(entry.name.clone()) {
            return Err(invalid("Duplicate RAR member name"));
        }
        entries.push(entry);
        missing_crc.push(calculate_crc);
    }
    if matches!(selection, Selection::List) && !missing_crc.contains(&true) {
        return Ok(entries);
    }

    let mut index = 0;
    let mut pending: Option<(usize, File)> = None;
    let mut visit_error = None;
    let result = archive.extract_with_control(options, |_| {
        // RAR verifies the previous entry before requesting another writer.
        // Hand the shared viewer a reader using at most one disk-backed spool.
        if let Some((previous, contents)) = pending.take()
            && let Err(error) = consume(
                &mut entries[previous],
                contents,
                missing_crc[previous],
                selection,
                &mut visitor,
            )
        {
            visit_error = Some(error);
            return Ok(ExtractionDecision::Stop);
        }
        let current = index;
        index += 1;
        let entry = entries
            .get(current)
            .ok_or_else(|| io::Error::other("Unexpected RAR member"))?;
        if selection.includes(current) && entry.directory {
            if let Err(error) = visitor(entry, &mut io::empty()) {
                visit_error = Some(error);
                return Ok(ExtractionDecision::Stop);
            }
        } else if selection.includes(current) || missing_crc[current] {
            let contents = tempfile::tempfile()?;
            let writer = contents.try_clone()?;
            pending = Some((current, contents));
            return Ok(ExtractionDecision::Extract(Box::new(writer)));
        }
        // Solid histories need earlier members decoded before later selections.
        Ok(ExtractionDecision::Extract(Box::new(io::sink())))
    });
    if let Some(error) = visit_error {
        return Err(error);
    }
    result.map_err(archive_error)?;
    if index != entries.len() {
        return Err(invalid("RAR member count differs from the directory"));
    }
    if let Some((last, contents)) = pending {
        consume(
            &mut entries[last],
            contents,
            missing_crc[last],
            selection,
            &mut visitor,
        )?;
    }
    Ok(entries)
}

#[cfg(test)]
mod tests;
