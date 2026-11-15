//! Byte-offset text paging. Decode only complete source characters; never emit
//! U+FFFD or carry an incomplete UTF-8/UTF-16/legacy multibyte character forward.
use super::filesystem::{bounded_read, limit, open_regular};
use super::paths::io_error;
use super::{HARD_TEXT_BYTES, TextChunk};
use crate::workspace::viewer_io::{decode_text_bytes, text_encoding};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

const DEFAULT_CHUNK: u64 = 256 * 1024;
const DETECTION_SAMPLE: u64 = 64 * 1024;

pub(super) fn detect_encoding(file: &mut File, requested: Option<&str>) -> Result<String, String> {
    if let Some(label) = requested {
        return text_encoding(label)
            .map(|encoding| encoding.name().to_string())
            .map_err(|error| format!("binary: {error}"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| io_error("seek text sample", error))?;
    let mut sample = Vec::new();
    file.take(DETECTION_SAMPLE)
        .read_to_end(&mut sample)
        .map_err(|error| io_error("read text sample", error))?;
    let unicode = if sample.starts_with(b"\xef\xbb\xbf") {
        Some("UTF-8")
    } else if sample.starts_with(b"\xff\xfe") {
        Some("UTF-16LE")
    } else if sample.starts_with(b"\xfe\xff") {
        Some("UTF-16BE")
    } else if std::str::from_utf8(&sample).is_err_and(|error| error.error_len().is_none()) {
        // A sample ending in the middle of an otherwise valid UTF-8 sequence.
        Some("UTF-8")
    } else {
        None
    };
    if let Some(label) = unicode {
        return Ok(label.into());
    }
    decode_text_bytes(&sample, None)
        .map(|(_, encoding, _)| encoding)
        .map_err(|error| format!("binary: {error}"))
}

/// Returns text, BOM flag, and bytes consumed. `offset > 0` must not strip a
/// literal U+FEFF at the start of a later chunk.
pub(super) fn decode_prefix(
    bytes: &[u8],
    encoding: &str,
    offset: u64,
    truncated: bool,
) -> Result<(String, bool, usize), String> {
    let selected = text_encoding(encoding).map_err(|error| format!("binary: {error}"))?;
    // Only malformed bytes exactly at an incomplete trailing character may be
    // withheld. Arbitrarily retrying shorter decodes would hide real invalid
    // bytes at the end of a truncated prefix (for example 0xff in UTF-8).
    let mut decoder = selected.new_decoder_without_bom_handling();
    let mut decoded = String::with_capacity(
        decoder
            .max_utf8_buffer_length_without_replacement(bytes.len())
            .ok_or("too_large: Decoder output capacity overflow")?,
    );
    let (result, _) = decoder.decode_to_string_without_replacement(bytes, &mut decoded, false);
    if matches!(result, encoding_rs::DecoderResult::Malformed(_, _)) {
        return Err(format!("binary: Invalid {encoding} data inside text chunk"));
    }
    let max_trim = if truncated { bytes.len().min(8) } else { 0 };
    for trim in 0..=max_trim {
        let end = bytes.len() - trim;
        let prefix = &bytes[..end];
        if matches!(encoding, "UTF-16LE" | "UTF-16BE") && (offset + end as u64) % 2 != 0 {
            continue;
        }
        if let Ok((mut content, _, bom)) = decode_text_bytes(prefix, Some(encoding)) {
            if offset != 0 && bom {
                content.insert(0, '\u{feff}');
            }
            return Ok((content, offset == 0 && bom, end));
        }
    }
    Err(format!(
        "binary: File cannot be decoded losslessly as {encoding}"
    ))
}

pub(crate) fn read_text_chunk(
    path: &str,
    offset: u64,
    max_bytes: Option<u64>,
    encoding: Option<&str>,
) -> Result<TextChunk, String> {
    let limit = limit(max_bytes, DEFAULT_CHUNK, HARD_TEXT_BYTES)?;
    let (_, mut file, metadata) = open_regular(path)?;
    if offset > metadata.len() {
        return Err("permission: Text offset exceeds file size".into());
    }
    let encoding = detect_encoding(&mut file, encoding)?;
    // These encodings have shift state that a byte-only paging contract cannot
    // reconstruct. Full reads remain available; do not silently corrupt pages.
    if encoding == "ISO-2022-JP" && offset != 0 {
        return Err("binary: Stateful encoding requires a full text read".into());
    }
    if matches!(encoding.as_str(), "UTF-16LE" | "UTF-16BE") && offset % 2 != 0 {
        return Err("binary: UTF-16 offset must be at a code-unit boundary".into());
    }
    validate_start(&mut file, offset, &encoding)?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error("seek text chunk", error))?;
    let mut bytes = bounded_read(&mut file, limit)?;
    let more = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    let (content, _, consumed) = decode_prefix(&bytes, &encoding, offset, more)?;
    if consumed == 0 && !bytes.is_empty() {
        return Err("too_large: Chunk budget is smaller than one encoded character".into());
    }
    Ok(TextChunk {
        content,
        next_offset: offset + consumed as u64,
        eof: !more,
    })
}

fn validate_start(file: &mut File, offset: u64, encoding: &str) -> Result<(), String> {
    if offset == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error("seek text boundary", error))?;
    let mut first = [0u8; 2];
    let count = file
        .read(&mut first)
        .map_err(|error| io_error("read text boundary", error))?;
    if encoding == "UTF-8" && count > 0 && first[0] & 0xc0 == 0x80 {
        return Err("binary: Offset is inside a UTF-8 character".into());
    }
    if count == 2 && matches!(encoding, "UTF-16LE" | "UTF-16BE") {
        let unit = if encoding == "UTF-16LE" {
            u16::from_le_bytes(first)
        } else {
            u16::from_be_bytes(first)
        };
        if (0xdc00..=0xdfff).contains(&unit) {
            return Err("binary: Offset is inside a UTF-16 surrogate pair".into());
        }
    }
    Ok(())
}
