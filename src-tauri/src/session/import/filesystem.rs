use super::model::LocalSessionFile;
use super::model::MAX_LOCAL_SESSION_FILE_BYTES;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(super) fn scan_dir_for_ext(
    source: &str,
    root: &Path,
    ext: &str,
    files: &mut Vec<LocalSessionFile>,
) {
    scan_dir(source, root, files, &|path| {
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    });
}

pub(super) fn scan_dir_for_names(
    source: &str,
    root: &Path,
    names: &[&str],
    files: &mut Vec<LocalSessionFile>,
) {
    scan_dir(source, root, files, &|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(|value| names.iter().any(|name| value.eq_ignore_ascii_case(name)))
            .unwrap_or(false)
    });
}

pub(super) fn scan_dir<F>(source: &str, root: &Path, files: &mut Vec<LocalSessionFile>, matches: &F)
where
    F: Fn(&Path) -> bool,
{
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(source, &path, files, matches);
        } else if matches(&path) {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            push_file(source, &path, &relative, files);
        }
    }
}

pub(super) fn dedup_files_by_path_case_insensitive(files: &mut Vec<LocalSessionFile>) {
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.to_ascii_lowercase()));
}

pub(super) fn push_file(
    source: &str,
    path: &Path,
    relative_path: &str,
    files: &mut Vec<LocalSessionFile>,
) {
    if !path.is_file() {
        return;
    }
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.len() > MAX_LOCAL_SESSION_FILE_BYTES {
        return;
    }
    if let Ok(bytes) = fs::read(path) {
        files.push(LocalSessionFile {
            source: source.to_string(),
            path: path.to_string_lossy().into_owned(),
            relative_path: relative_path.to_string(),
            text: decode_command_output(&bytes),
        });
    }
}

pub(super) fn split_user_host(host_name: &str, explicit_user: String) -> (Option<String>, String) {
    if let Some((user, host)) = host_name.split_once('@') {
        if !user.trim().is_empty() && !host.trim().is_empty() {
            return (Some(user.trim().to_string()), host.trim().to_string());
        }
    }
    let user = if explicit_user.trim().is_empty() {
        None
    } else {
        Some(explicit_user.trim().to_string())
    };
    (user, host_name.trim().to_string())
}

pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.len() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    if bytes.iter().filter(|byte| **byte == 0).count() > bytes.len() / 8 {
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units).replace('\u{0}', "");
    }
    String::from_utf8_lossy(bytes).replace('\u{0}', "")
}

pub(super) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(super) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub(super) fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(windows)]
pub(super) fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}
