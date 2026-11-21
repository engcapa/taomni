use super::{NotepadEncodingGroup, NotepadEncodingLossReport, NotepadHashResult};
use crate::viewer::{HARD_BYTES, path_io_error};
use crate::workspace::viewer_io::{encode_text_bytes, text_encoding};
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub(crate) fn compute_hash(
    algorithm: &str,
    text: Option<&str>,
    file_path: Option<&str>,
) -> Result<NotepadHashResult, String> {
    let normalized = algorithm.trim().to_ascii_lowercase();
    let hex_value = if let Some(path_str) = file_path {
        let mut file = File::open(Path::new(path_str))
            .map_err(|e| path_io_error("open file for hashing", e))?;
        let meta = file.metadata().map_err(|e| path_io_error("stat file", e))?;
        if !meta.is_file() {
            return Err("permission: Hash target must be a regular file".into());
        }
        if meta.len() > HARD_BYTES {
            return Err("too_large: File exceeds 64 MiB hash limit".into());
        }
        hash_reader(&normalized, &mut file)?
    } else {
        let input = text.unwrap_or("").as_bytes();
        hash_bytes(&normalized, input)?
    };
    Ok(NotepadHashResult {
        algorithm: normalized,
        hex: hex_value,
    })
}

fn hash_bytes(algorithm: &str, bytes: &[u8]) -> Result<String, String> {
    match algorithm {
        "md5" => Ok(hex::encode(Md5::digest(bytes))),
        "sha1" | "sha-1" => Ok(hex::encode(Sha1::digest(bytes))),
        "sha256" | "sha-256" => Ok(hex::encode(Sha256::digest(bytes))),
        "sha512" | "sha-512" => Ok(hex::encode(Sha512::digest(bytes))),
        _ => Err(format!(
            "unsupported: Unsupported hash algorithm: {algorithm}"
        )),
    }
}

fn hash_reader(algorithm: &str, reader: &mut dyn Read) -> Result<String, String> {
    let mut buf = [0u8; 64 * 1024];
    match algorithm {
        "md5" => {
            let mut h = Md5::new();
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| path_io_error("hash read", e))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        "sha1" | "sha-1" => {
            let mut h = Sha1::new();
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| path_io_error("hash read", e))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        "sha256" | "sha-256" => {
            let mut h = Sha256::new();
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| path_io_error("hash read", e))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        "sha512" | "sha-512" => {
            let mut h = Sha512::new();
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| path_io_error("hash read", e))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        _ => Err(format!(
            "unsupported: Unsupported hash algorithm: {algorithm}"
        )),
    }
}

pub(crate) fn list_encodings() -> Vec<NotepadEncodingGroup> {
    vec![
        NotepadEncodingGroup {
            group: "Unicode".into(),
            encodings: vec![
                "UTF-8".into(),
                "UTF-8 BOM".into(),
                "UTF-16LE".into(),
                "UTF-16BE".into(),
            ],
        },
        NotepadEncodingGroup {
            group: "East Asian ANSI".into(),
            encodings: vec![
                "GBK".into(),
                "GB18030".into(),
                "Big5".into(),
                "Shift_JIS".into(),
                "EUC-JP".into(),
                "EUC-KR".into(),
            ],
        },
        NotepadEncodingGroup {
            group: "Western / Latin".into(),
            encodings: vec![
                "windows-1252".into(),
                "ISO-8859-1".into(),
                "ISO-8859-15".into(),
                "windows-1250".into(),
            ],
        },
        NotepadEncodingGroup {
            group: "Cyrillic / Greek".into(),
            encodings: vec![
                "windows-1251".into(),
                "KOI8-R".into(),
                "ISO-8859-5".into(),
                "windows-1253".into(),
            ],
        },
    ]
}

pub(crate) fn check_encoding_loss(
    content: &str,
    encoding_label: &str,
) -> Result<NotepadEncodingLossReport, String> {
    let cleaned = encoding_label.trim().trim_end_matches(" BOM").trim();
    let upper = cleaned.to_ascii_uppercase();
    if upper == "UTF-8" || upper == "UTF-16LE" || upper == "UTF-16BE" || upper == "UTF-16" {
        return Ok(NotepadEncodingLossReport {
            encoding: encoding_label.to_string(),
            unrepresentable_count: 0,
            samples: Vec::new(),
        });
    }
    let encoding = text_encoding(cleaned)?;
    let mut count = 0usize;
    let mut samples = Vec::new();
    let mut buf = [0u8; 4];
    for ch in content.chars() {
        let ch_str = ch.encode_utf8(&mut buf);
        if encode_text_bytes(ch_str, encoding.name(), false).is_err() {
            count += 1;
            let s = ch.to_string();
            if samples.len() < 5 && !samples.contains(&s) {
                samples.push(s);
            }
        }
    }
    Ok(NotepadEncodingLossReport {
        encoding: encoding_label.to_string(),
        unrepresentable_count: count,
        samples,
    })
}
