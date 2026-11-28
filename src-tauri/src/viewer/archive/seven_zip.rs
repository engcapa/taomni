use super::codec::{Cancellable, CheckedReader};
use super::{Entry, MAX_ENTRIES, Selection, UNSAFE_ENTRY, invalid, validate_member};
use rars::ReadCancellation;
use sevenz_rust2::{ArchiveReader, EntryDecision, Error, Password};
use std::collections::HashMap;
use std::io::{self, Read, Seek};

const MEMORY_LIMIT_KIB: usize = 64 * 1024;
const WINDOWS_REPARSE_POINT: u32 = 0x0400;

fn archive_error(error: Error) -> String {
    match error {
        Error::PasswordRequired | Error::MaybeBadPassword(_) => {
            invalid("Password-protected archives are unsupported")
        }
        Error::Other(message) => invalid(message),
        other => invalid(other),
    }
}

pub(super) fn visit(
    file: impl Read + Seek,
    selection: Selection,
    cancel: &ReadCancellation,
    mut visitor: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let mut reader =
        ArchiveReader::new_with_memory_limit(file, Password::empty(), MEMORY_LIMIT_KIB)
            .map_err(archive_error)?;
    reader.set_thread_count(1);
    let archive = reader.archive();
    if archive.files.len() > MAX_ENTRIES {
        return Err(invalid("7z directory exceeds 4,096 entries"));
    }

    let mut indices = HashMap::new();
    let mut entries = Vec::with_capacity(archive.files.len());
    let mut without_crc = false;
    let mut total = 0;
    for (index, item) in archive.files.iter().enumerate() {
        let permissions = item.windows_attributes >> 16;
        let kind = permissions & 0o170000;
        if item.is_anti_item
            || !matches!(kind, 0 | 0o100000 | 0o040000)
            || item.windows_attributes & WINDOWS_REPARSE_POINT != 0
            || (item.is_directory && item.size != 0)
        {
            return Err(invalid(UNSAFE_ENTRY));
        }
        if archive.is_file_encrypted(index) {
            return Err(invalid("Password-protected archives are unsupported"));
        }
        let name = item.name.strip_suffix('/').unwrap_or(&item.name);
        validate_member(name, item.size, &mut total)?;
        if indices.insert(item.name.clone(), index).is_some() {
            return Err(invalid("Duplicate 7z member name"));
        }
        without_crc |= !item.has_crc && item.size != 0;
        entries.push(Entry {
            index,
            name: name.to_owned(),
            directory: item.is_directory,
            size: item.size,
            crc: item.crc as u32,
        });
    }
    if matches!(selection, Selection::List) && !without_crc {
        return Ok(entries);
    }

    // Solid archives decode in block order, which can differ from the directory order.
    let mut visit_error = None;
    reader
        .for_each_entries_with_decision_allowing_surplus(|item, contents| {
            let index = indices[&item.name];
            let entry = &mut entries[index];
            let mut checked =
                CheckedReader::new(Cancellable::new(contents, cancel).take(entry.size + 1));
            if selection.includes(index)
                && let Err(reason) = visitor(entry, &mut checked)
            {
                visit_error = Some(reason);
                return Ok(EntryDecision::Stop);
            }
            io::copy(&mut checked, &mut io::sink())?;
            if checked.size != entry.size {
                return Err(io::Error::other("7z member size differs from the directory").into());
            }
            let crc = checked.crc.finalize();
            if item.has_crc && crc != entry.crc {
                return Err(Error::ChecksumVerificationFailed);
            }
            entry.crc = crc;
            Ok(EntryDecision::Continue)
        })
        .map_err(archive_error)?;
    if let Some(reason) = visit_error {
        return Err(reason);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests;
