use super::codec::{Cancellable, CheckedReader, Codec};
use super::{Entry, MAX_ENTRY, Selection, invalid, validate_member};
use rars::ReadCancellation;
use std::io::{self, Read, Seek, SeekFrom};

pub(super) fn codec(path: &str) -> Option<Codec> {
    let (_, extension) = path.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "gz" => Some(Codec::Gzip),
        "bz2" => Some(Codec::Bzip2),
        "xz" => Some(Codec::Xz),
        "zst" => Some(Codec::Zstd),
        _ => None,
    }
}

pub(super) fn visit(
    mut file: impl Read + Seek,
    input_size: u64,
    name: &str,
    codec: Codec,
    selection: Selection,
    cancel: &ReadCancellation,
    mut visitor: impl FnMut(&Entry, &mut dyn Read) -> Result<(), String>,
) -> Result<Vec<Entry>, String> {
    let (size, crc) = {
        let decoder = codec
            .reader((&mut file).take(input_size))
            .map_err(invalid)?;
        let mut checked = CheckedReader::new(Cancellable::new(decoder, cancel).take(MAX_ENTRY + 1));
        io::copy(&mut checked, &mut io::sink()).map_err(invalid)?;
        (checked.size, checked.crc.finalize())
    };
    validate_member(name, size, &mut 0)?;
    let entry = Entry {
        index: 0,
        name: name.to_owned(),
        directory: false,
        size,
        crc,
    };
    if selection.includes(0) {
        file.seek(SeekFrom::Start(0)).map_err(invalid)?;
        let decoder = codec.reader(file.take(input_size)).map_err(invalid)?;
        let mut checked = CheckedReader::new(Cancellable::new(decoder, cancel).take(size + 1));
        visitor(&entry, &mut checked)?;
        if checked.size != size || checked.crc.finalize() != crc {
            return Err(invalid(
                "Compressed file changed. Reload before extracting or previewing",
            ));
        }
    }
    Ok(vec![entry])
}
