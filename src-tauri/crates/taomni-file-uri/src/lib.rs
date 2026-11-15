//! Protocol-independent conversion between filesystem paths and URI lists.
//!
//! The decoder deliberately retains Taomni's existing best-effort clipboard
//! behavior. Consumers that need strict URI validation must enforce it at their
//! own boundary; this crate does not access the filesystem or any clipboard.

use std::path::{Path, PathBuf};

/// Render a list of staged paths as the `text/uri-list` MIME format used
/// by Linux/macOS file pickers, GNOME Files, and Nautilus drag/drop.
/// Each path is converted to a `file://` URI with proper percent-encoding.
pub fn paths_to_uri_list<P: AsRef<Path>>(paths: &[P]) -> String {
    let mut out = String::new();
    for p in paths {
        let path = p.as_ref();
        let s = path.to_string_lossy();
        let encoded = percent_encode_path(&s);
        out.push_str("file://");
        if !encoded.starts_with('/') {
            out.push('/');
        }
        out.push_str(&encoded);
        out.push_str("\r\n");
    }
    out
}

/// Parse the inverse — extract paths from a `text/uri-list`. Best-effort:
/// invalid lines and non-`file://` URIs are dropped.
pub fn uri_list_to_paths(text: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("file://") {
            let rest = rest.trim_start_matches('/');
            let decoded = percent_decode(rest);
            // Re-anchor to absolute path on Unix; on Windows, drive letters
            // are already in place after the leading slash strip.
            // Unix-style absolute URIs (file:///tmp/foo) still need a leading
            // slash on Windows so path strings match host/remote expectations.
            let path = if cfg!(windows) {
                let looks_like_drive = decoded
                    .as_bytes()
                    .get(1)
                    .copied()
                    .is_some_and(|b| b == b':');
                if looks_like_drive {
                    PathBuf::from(decoded)
                } else {
                    PathBuf::from(format!("/{decoded}"))
                }
            } else {
                let mut p = PathBuf::from("/");
                p.push(decoded);
                p
            };
            out.push(path);
        }
    }
    out
}

fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b;
        let safe =
            c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~' | b'/' | b':');
        if safe {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
