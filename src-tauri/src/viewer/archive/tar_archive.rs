use super::codec::{CheckedReader, Codec};
use super::{Entry, MAX_ENTRIES, MAX_TOTAL, Selection, UNSAFE_ENTRY, invalid, validate_member};
use std::io::{self, Read};
use tar::EntryType;

const MAX_PADDING_AND_HEADERS: u64 = 8 << 20;
const MAX_EXTENSION: u64 = 16 << 10;

pub(super) fn suffix(path: &str) -> Option<(Codec, &'static str)> {
    let lower = path.to_ascii_lowercase();
    [
        (Codec::Plain, ".tar"),
        (Codec::Gzip, ".tar.gz"),
        (Codec::Gzip, ".tgz"),
        (Codec::Bzip2, ".tar.bz2"),
        (Codec::Xz, ".tar.xz"),
        (Codec::Zstd, ".tar.zst"),
    ]
    .into_iter()
    .find(|(_, suffix)| lower.ends_with(suffix))
}

#[derive(Default)]
struct ExtendedHeader {
    name: Option<String>,
    size: Option<u64>,
    pending: bool,
}

impl ExtendedHeader {
    fn set_name(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.name.is_some() {
            return Err(invalid("Multiple TAR names refer to the same entry"));
        }
        self.name = Some(std::str::from_utf8(bytes).map_err(invalid)?.to_owned());
        Ok(())
    }

    fn read(&mut self, entry: &mut tar::Entry<'_, impl Read>) -> Result<(), String> {
        if entry.size() > MAX_EXTENSION {
            return Err(invalid("TAR extended header exceeds 16 KiB"));
        }
        let kind = entry.header().entry_type();
        if kind == EntryType::GNULongName {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(invalid)?;
            if bytes.len() as u64 != entry.size() {
                return Err(invalid("Incomplete TAR extended header"));
            }
            self.set_name(bytes.strip_suffix(&[0]).unwrap_or(&bytes))?;
        } else if let Some(fields) = entry.pax_extensions().map_err(invalid)? {
            for field in fields {
                let field = field.map_err(invalid)?;
                match field.key_bytes() {
                    b"path" if kind == EntryType::XHeader => self.set_name(field.value_bytes())?,
                    b"size" if kind == EntryType::XHeader => {
                        let size = field.value().map_err(invalid)?.parse().map_err(invalid)?;
                        if self.size.replace(size).is_some() {
                            return Err(invalid("Multiple TAR sizes refer to the same entry"));
                        }
                    }
                    b"path" | b"size" | b"linkpath" => return Err(invalid(UNSAFE_ENTRY)),
                    key if key.starts_with(b"GNU.sparse.") => return Err(invalid(UNSAFE_ENTRY)),
                    _ => (),
                }
            }
        }
        self.pending |= kind != EntryType::XGlobalHeader;
        Ok(())
    }
}

pub(super) fn visit(
    format: Codec,
    input: impl Read + 'static,
    selection: Selection,
    mut visitor: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let budget = MAX_TOTAL + MAX_PADDING_AND_HEADERS;
    let reader = format.reader(input).map_err(invalid)?.take(budget + 1);
    let mut tar = tar::Archive::new(reader);
    let mut entries = Vec::new();
    let mut header = ExtendedHeader::default();
    let mut total = 0;
    // Inspect extension sizes before TAR opens any variable-length metadata.
    for (count, item) in tar.entries().map_err(invalid)?.raw(true).enumerate() {
        if count >= MAX_ENTRIES * 3 || entries.len() >= MAX_ENTRIES {
            return Err(invalid("TAR directory exceeds 4,096 entries"));
        }
        let mut item = item.map_err(invalid)?;
        let kind = item.header().entry_type();
        if matches!(
            kind,
            EntryType::GNULongName | EntryType::XHeader | EntryType::XGlobalHeader
        ) {
            header.read(&mut item)?;
            continue;
        }
        if !matches!(kind, EntryType::Regular | EntryType::Directory) {
            return Err(invalid(UNSAFE_ENTRY));
        }
        let size = item.size();
        let directory = kind.is_dir();
        let attributes = std::mem::take(&mut header);
        if attributes.size.is_some_and(|declared| declared != size) || (directory && size != 0) {
            return Err(invalid("TAR entry size differs from its header"));
        }
        let name = match attributes.name {
            Some(name) => name,
            None => String::from_utf8(item.path_bytes().into_owned()).map_err(invalid)?,
        };
        let relative = name.trim_start_matches("./");
        let relative = if directory {
            relative.trim_end_matches('/')
        } else {
            relative
        };
        if directory
            && (relative == "."
                || (relative.is_empty() && name.starts_with("./") && !name.contains("//")))
        {
            continue;
        }
        validate_member(relative, size, &mut total)?;
        let mut entry = Entry {
            index: entries.len(),
            name: relative.to_owned(),
            directory,
            size,
            crc: 0,
        };
        let mut checked = CheckedReader::new(item);
        if selection.includes(entry.index) {
            visitor(&entry, &mut checked)?;
        }
        io::copy(&mut checked, &mut io::sink()).map_err(invalid)?;
        if checked.size != size {
            return Err(invalid("TAR entry ended before its declared size"));
        }
        entry.crc = checked.crc.finalize();
        entries.push(entry);
    }
    if header.pending {
        return Err(invalid("TAR extended header has no following entry"));
    }
    finish(tar.into_inner(), budget)?;
    Ok(entries)
}

/// Drain zero padding and let the codec verify its trailer before publishing.
fn finish(mut reader: io::Take<Box<dyn Read>>, budget: u64) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader.read(&mut buffer).map_err(invalid)?;
        if reader.limit() == 0 {
            return Err(invalid("TAR exceeds the expanded size limit"));
        }
        if read == 0 {
            return if reader.limit() == budget + 1 {
                Err(invalid("Empty TAR input"))
            } else {
                Ok(())
            };
        }
        if buffer[..read].iter().any(|byte| *byte != 0) {
            return Err(invalid("Unexpected data after the TAR directory"));
        }
    }
}

#[cfg(test)]
mod tests;
