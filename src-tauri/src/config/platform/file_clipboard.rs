//! File clipboard contracts, independent of the user's system clipboard.
//!
//! Native file IPCs never interpret plain text as files. The separate
//! clipboard_parse_file_paths command retains its existing text semantics.

use std::path::Path;

pub(crate) const MAX_FILES: usize = 256;
pub(crate) const MAX_PATH_BYTES: usize = 32 * 1024;
pub(crate) const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn error(kind: &str, detail: impl std::fmt::Display) -> String {
    format!("clipboard_files:{kind}: {detail}")
}

/// Validate the complete list before touching the clipboard. In particular,
/// canonicalize/metadata/Path::exists would dereference symlinks: copying a
/// directory link must publish that link, not silently substitute its target.
pub(crate) fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.len() > MAX_FILES {
        return Err(error(
            "invalid",
            format!("accepts at most {MAX_FILES} paths"),
        ));
    }
    let mut total = 0usize;
    for value in paths {
        if value.is_empty() || value.contains('\0') || value.len() > MAX_PATH_BYTES {
            return Err(error("invalid", "empty, NUL-containing, or oversized path"));
        }
        total = total.saturating_add(value.len());
        if total > MAX_PAYLOAD_BYTES {
            return Err(error("invalid", "file path list exceeds size limit"));
        }
        let path = Path::new(value);
        if !path.is_absolute() {
            return Err(error(
                "invalid",
                format!("path must be absolute: {value:?}"),
            ));
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|cause| {
            let kind = if cause.kind() == std::io::ErrorKind::PermissionDenied {
                "permission_denied"
            } else {
                "invalid"
            };
            error(kind, format!("cannot access {value:?}: {cause}"))
        })?;
        let kind = metadata.file_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err(error(
                "invalid",
                format!("not a file, directory, or link: {value:?}"),
            ));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FileListFormat {
    GnomeCopiedFiles,
    UriList,
}

#[cfg(any(target_os = "linux", test))]
impl FileListFormat {
    pub(crate) const ALL: [Self; 2] = [Self::GnomeCopiedFiles, Self::UriList];

    pub(crate) fn mime(self) -> &'static str {
        match self {
            Self::GnomeCopiedFiles => "x-special/gnome-copied-files",
            Self::UriList => "text/uri-list",
        }
    }

    pub(crate) fn decode(self, bytes: &[u8]) -> Result<Vec<String>, String> {
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(error("invalid", "native file clipboard exceeds size limit"));
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| error("invalid", "native file list is not UTF-8"))?;
        let mut lines = text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line));
        if self == Self::GnomeCopiedFiles && !matches!(lines.next(), Some("copy" | "cut")) {
            return Err(error("invalid", "GNOME file list has no copy/cut header"));
        }
        let mut paths = Vec::new();
        for line in lines {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if paths.len() == MAX_FILES {
                return Err(error(
                    "invalid",
                    format!("accepts at most {MAX_FILES} paths"),
                ));
            }
            // URL parsers can silently trim whitespace and accept invalid '%' escapes.
            // File lists must be lossless; spaces/control characters belong in escapes.
            let bytes = line.as_bytes();
            if bytes
                .iter()
                .any(|byte| byte.is_ascii_control() || *byte == b' ')
                || bytes.iter().enumerate().any(|(index, byte)| {
                    *byte == b'%'
                        && !bytes
                            .get(index + 1..index + 3)
                            .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
                })
            {
                return Err(error("invalid", "malformed file URI escaping"));
            }
            let uri = url::Url::parse(line).map_err(|cause| error("invalid", cause))?;
            if uri.scheme() != "file" || uri.query().is_some() || uri.fragment().is_some() {
                return Err(error(
                    "invalid",
                    "expected a local file URI without query/fragment",
                ));
            }
            #[cfg(not(windows))]
            if uri
                .host_str()
                .is_some_and(|host| !host.is_empty() && host != "localhost")
            {
                return Err(error(
                    "unsupported",
                    "remote file URI authority is not supported",
                ));
            }
            let path = uri
                .to_file_path()
                .map_err(|_| error("invalid", "invalid local file URI"))?;
            let value = path.into_os_string().into_string().map_err(|_| {
                error(
                    "invalid",
                    "file path cannot be represented losslessly in IPC",
                )
            })?;
            if value.contains('\0') || value.len() > MAX_PATH_BYTES {
                return Err(error(
                    "invalid",
                    "NUL-containing or oversized file URI path",
                ));
            }
            paths.push(value);
        }
        Ok(paths)
    }
}

/// This owned offer moves into GTK's get-data callback. GTK frees the callback
/// only when ownership is lost, not when the write IPC or its dialog finishes.
#[cfg(any(target_os = "linux", test))]
pub(crate) struct FileOffer {
    gnome: Vec<u8>,
    uris: Vec<u8>,
}

#[cfg(any(target_os = "linux", test))]
impl FileOffer {
    pub(crate) fn new(paths: &[String]) -> Result<Self, String> {
        validate_paths(paths)?;
        let uris = paths
            .iter()
            .map(|path| {
                url::Url::from_file_path(path)
                    .map(String::from)
                    .map_err(|_| error("invalid", "cannot encode absolute file path"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // RFC 2483 text/uri-list uses CRLF. GNOME's copy header uses LF;
        // Nautilus rejects an empty URI, so do not append a final GNOME newline.
        let gnome = format!("copy\n{}", uris.join("\n")).into_bytes();
        let uris = if uris.is_empty() {
            Vec::new()
        } else {
            format!("{}\r\n", uris.join("\r\n")).into_bytes()
        };
        if gnome.len() > MAX_PAYLOAD_BYTES || uris.len() > MAX_PAYLOAD_BYTES {
            return Err(error("invalid", "encoded file list exceeds size limit"));
        }
        Ok(Self { gnome, uris })
    }

    pub(crate) fn payload(&self, format: FileListFormat) -> &[u8] {
        match format {
            FileListFormat::GnomeCopiedFiles => &self.gnome,
            FileListFormat::UriList => &self.uris,
        }
    }
}

#[cfg(any(windows, test))]
#[path = "file_clipboard_hdrop.rs"]
pub(crate) mod hdrop;

#[cfg(test)]
#[path = "file_clipboard_tests.rs"]
mod tests;
