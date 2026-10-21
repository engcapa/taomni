use super::*;

pub(super) fn file_from_bytes(
    root: &Path,
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let (text, encoding, bom) = decode_workspace_bytes(&bytes, None)?;
    Ok(WorkspaceFile {
        path: relative_path(root, target)?,
        text,
        encoding,
        bom,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

pub(super) fn loose_file_from_bytes(
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
) -> Result<WorkspaceFile, String> {
    let (text, encoding, bom) = decode_workspace_bytes(&bytes, None)?;
    Ok(WorkspaceFile {
        path: path_for_display(target),
        text,
        encoding,
        bom,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

pub(super) fn file_from_bytes_with_encoding(
    root: &Path,
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
    requested_encoding: Option<&str>,
) -> Result<WorkspaceFile, String> {
    let (text, encoding, bom) = decode_workspace_bytes(&bytes, requested_encoding)?;
    Ok(WorkspaceFile {
        path: relative_path(root, target)?,
        text,
        encoding,
        bom,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

pub(super) fn loose_file_from_bytes_with_encoding(
    target: &Path,
    bytes: Vec<u8>,
    meta: fs::Metadata,
    requested_encoding: Option<&str>,
) -> Result<WorkspaceFile, String> {
    let (text, encoding, bom) = decode_workspace_bytes(&bytes, requested_encoding)?;
    Ok(WorkspaceFile {
        path: path_for_display(target),
        text,
        encoding,
        bom,
        size: meta.len(),
        mtime: mtime_secs(&meta),
        hash: sha256_hex(&bytes),
    })
}

pub(super) fn decode_workspace_bytes(
    bytes: &[u8],
    requested_encoding: Option<&str>,
) -> Result<(String, String, bool), String> {
    const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
    const UTF16LE_BOM: &[u8] = b"\xFF\xFE";
    const UTF16BE_BOM: &[u8] = b"\xFE\xFF";

    let (encoding, payload, bom) = if let Some(label) = requested_encoding {
        let encoding = encoding_for_label(label)?;
        let (payload, bom) = if encoding == UTF_8 && bytes.starts_with(UTF8_BOM) {
            (&bytes[UTF8_BOM.len()..], true)
        } else if encoding == UTF_16LE && bytes.starts_with(UTF16LE_BOM) {
            (&bytes[UTF16LE_BOM.len()..], true)
        } else if encoding == UTF_16BE && bytes.starts_with(UTF16BE_BOM) {
            (&bytes[UTF16BE_BOM.len()..], true)
        } else {
            (bytes, false)
        };
        (encoding, payload, bom)
    } else if bytes.starts_with(UTF8_BOM) {
        (UTF_8, &bytes[UTF8_BOM.len()..], true)
    } else if bytes.starts_with(UTF16LE_BOM) {
        (UTF_16LE, &bytes[UTF16LE_BOM.len()..], true)
    } else if bytes.starts_with(UTF16BE_BOM) {
        (UTF_16BE, &bytes[UTF16BE_BOM.len()..], true)
    } else if let Some(encoding) = detect_utf16_without_bom(bytes) {
        (encoding, bytes, false)
    } else if std::str::from_utf8(bytes).is_ok() {
        (UTF_8, bytes, false)
    } else {
        let mut detector = EncodingDetector::new();
        detector.feed(bytes, true);
        (detector.guess(None, true), bytes, false)
    };

    let text = encoding
        .decode_without_bom_handling_and_without_replacement(payload)
        .ok_or_else(|| {
            format!(
                "File cannot be decoded as {} without data loss",
                encoding.name()
            )
        })?
        .into_owned();
    if encoding != UTF_16LE
        && encoding != UTF_16BE
        && (looks_binary_bytes(bytes)
            || (requested_encoding.is_none()
                && encoding != UTF_8
                && looks_suspicious_legacy_bytes(bytes, &text)))
    {
        return Err("File appears to be binary; open it in a binary-capable viewer".into());
    }
    Ok((text, encoding.name().to_string(), bom))
}

pub(super) fn encoding_for_label(label: &str) -> Result<&'static Encoding, String> {
    let normalized = label.trim().replace('_', "-");
    Encoding::for_label(normalized.as_bytes())
        .ok_or_else(|| format!("Unsupported text encoding: {label}"))
}

pub(super) fn detect_utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    if bytes.len() < 2 || bytes.len() % 2 != 0 {
        return None;
    }
    let pairs = bytes.chunks_exact(2);
    let mut even_zeroes = 0usize;
    let mut odd_zeroes = 0usize;
    for pair in pairs {
        if pair[0] == 0 {
            even_zeroes += 1;
        }
        if pair[1] == 0 {
            odd_zeroes += 1;
        }
    }
    let total = bytes.len() / 2;
    if odd_zeroes * 3 >= total * 2 {
        Some(UTF_16LE)
    } else if even_zeroes * 3 >= total * 2 {
        Some(UTF_16BE)
    } else {
        None
    }
}

pub(super) fn looks_binary_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let controls = bytes
        .iter()
        .filter(|&&byte| byte == 0 || (byte < 0x09) || (byte > 0x0D && byte < 0x20))
        .count();
    controls * 100 > bytes.len() * 2
}

/// Legacy single-byte encodings can decode every byte sequence, so a tiny
/// arbitrary high-byte blob must not silently become editable text. Keep this
/// conservative: real legacy documents normally contain either whitespace,
/// ASCII punctuation, or enough bytes to establish a text sample.
pub(super) fn looks_suspicious_legacy_bytes(bytes: &[u8], text: &str) -> bool {
    if bytes.is_empty() {
        return false;
    }
    if bytes.len() <= 4 && bytes.iter().all(|byte| *byte >= 0x80) {
        return true;
    }
    if bytes.len() < 16 {
        let has_text_shape = bytes
            .iter()
            .any(|byte| matches!(*byte, b' '..=b'~' | b'\t' | b'\n' | b'\r'));
        if !has_text_shape {
            return true;
        }
    }
    text.chars().all(|character| character.is_control())
}

pub(super) fn encode_workspace_text(
    contents: &str,
    label: &str,
    bom: bool,
) -> Result<Vec<u8>, String> {
    let encoding = encoding_for_label(label)?;
    let mut bytes = if encoding == UTF_16LE || encoding == UTF_16BE {
        let mut output = Vec::with_capacity(contents.len() * 2);
        for unit in contents.encode_utf16() {
            let encoded = if encoding == UTF_16LE {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            };
            output.extend_from_slice(&encoded);
        }
        output
    } else {
        let (encoded, _, had_errors) = encoding.encode(contents);
        if had_errors {
            return Err(format!(
                "Text contains characters not representable in {}",
                encoding.name()
            ));
        }
        encoded.into_owned()
    };
    if bom && encoding == UTF_8 {
        bytes.splice(0..0, [0xEF, 0xBB, 0xBF]);
    } else if bom && encoding == UTF_16LE {
        bytes.splice(0..0, [0xFF, 0xFE]);
    } else if bom && encoding == UTF_16BE {
        bytes.splice(0..0, [0xFE, 0xFF]);
    }
    Ok(bytes)
}
