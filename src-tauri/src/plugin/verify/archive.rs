//! Restricted plugin ZIP extraction and exact file-tree integrity checks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::TrustError;

const MAX_FILES: usize = 50_000;
const MAX_EXPANDED_BYTES: u64 = 12 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 8 * 1024 * 1024;
pub(super) type TreeDigests = BTreeMap<String, String>;

pub(super) struct ArchiveInspection {
    pub(super) checksums: TreeDigests,
    pub(super) manifest_bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
enum SpecialEntry {
    Checksums,
    Manifest,
}

pub(super) fn extract(
    file: &mut File,
    destination: &Path,
    max_manifest_bytes: u64,
) -> Result<ArchiveInspection, TrustError> {
    scan_archive(file, Some(destination), max_manifest_bytes)
}

pub(super) fn inspect(
    file: &mut File,
    max_manifest_bytes: u64,
) -> Result<ArchiveInspection, TrustError> {
    scan_archive(file, None, max_manifest_bytes)
}

fn scan_archive(
    file: &mut File,
    destination: Option<&Path>,
    max_manifest_bytes: u64,
) -> Result<ArchiveInspection, TrustError> {
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
    if archive.len() > MAX_FILES {
        return Err(invalid("archive contains too many entries"));
    }
    let mut seen = BTreeSet::new();
    let mut actual = BTreeMap::new();
    let mut expanded = 0_u64;
    let mut raw_checksums: Option<Vec<u8>> = None;
    let mut raw_manifest: Option<Vec<u8>> = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| invalid("archive names must be UTF-8"))?
            .trim_end_matches('/')
            .to_owned();
        validate_path(&name)?;
        if !seen.insert(name.to_lowercase()) {
            return Err(invalid("archive has duplicate or case-conflicting paths"));
        }
        let directory = entry.is_dir();
        let mode = entry.unix_mode().unwrap_or_default();
        let kind = mode & 0o170000;
        if !matches!(kind, 0 | 0o100000 | 0o040000)
            || (kind == 0o040000 && !directory)
            || (kind == 0o100000 && directory)
        {
            return Err(invalid("archive links and special files are forbidden"));
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| invalid("expanded archive exceeds 12 GiB"))?;
        if entry.size() > MAX_FILE_BYTES
            || (entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > 1000)
        {
            return Err(invalid("archive entry exceeds size or expansion limits"));
        }
        if directory {
            if entry.size() != 0 {
                return Err(invalid("archive directory contains data"));
            }
            if let Some(root) = destination {
                fs::create_dir_all(root.join(&name))?;
            }
            continue;
        }
        let capture = match name.as_str() {
            "SHA256SUMS" => Some((
                SpecialEntry::Checksums,
                MAX_CHECKSUM_BYTES,
                "SHA256SUMS exceeds 8 MiB",
            )),
            "module.json" => Some((
                SpecialEntry::Manifest,
                max_manifest_bytes,
                "module.json exceeds 2 MiB",
            )),
            _ => None,
        };
        let mut captured = capture.map(|_| Vec::new());
        let mut output = if let Some(root) = destination {
            let target = root.join(&name);
            fs::create_dir_all(target.parent().expect("validated relative path"))?;
            Some((
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&target)?,
                target,
            ))
        } else {
            None
        };
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let count = entry.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > entry.size() {
                return Err(invalid("archive entry exceeds its declared size"));
            }
            if let (Some((_, limit, message)), Some(bytes)) = (capture, captured.as_mut()) {
                if written > limit {
                    return Err(invalid(message));
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            hasher.update(&buffer[..count]);
            if let Some((file_out, _)) = output.as_mut() {
                file_out.write_all(&buffer[..count])?;
            }
        }
        if written != entry.size() {
            return Err(invalid("archive entry is truncated"));
        }
        if let Some((file_out, target)) = output {
            file_out.sync_all()?;
            // Preserve only the executable bit; package-supplied setuid, group or
            // world-write permissions never reach the installed filesystem.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &target,
                    fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o700 } else { 0o600 }),
                )?;
            }
            #[cfg(not(unix))]
            let _ = target;
        }
        match (capture, captured) {
            (Some((SpecialEntry::Checksums, _, _)), Some(bytes)) => raw_checksums = Some(bytes),
            (Some((SpecialEntry::Manifest, _, _)), Some(bytes)) => raw_manifest = Some(bytes),
            _ => {}
        }
        actual.insert(name, hex::encode(hasher.finalize()));
    }
    let Some(sums_bytes) = raw_checksums else {
        return Err(invalid("package is missing SHA256SUMS"));
    };
    let raw = String::from_utf8(sums_bytes).map_err(|_| invalid("SHA256SUMS must be UTF-8"))?;
    let declared = parse_checksums(&raw)?;
    if declared.len() + 1 != actual.len()
        || declared
            .iter()
            .any(|(name, digest)| actual.get(name) != Some(digest))
    {
        return Err(invalid(
            "SHA256SUMS does not match the exact package contents",
        ));
    }
    let Some(manifest_bytes) = raw_manifest else {
        return Err(invalid("package is missing module.json"));
    };
    Ok(ArchiveInspection {
        checksums: actual,
        manifest_bytes,
    })
}

fn parse_checksums(raw: &str) -> Result<TreeDigests, TrustError> {
    let mut checksums = BTreeMap::new();
    for line in raw.lines().filter(|line| !line.is_empty()) {
        if line.len() < 67 || !line.is_char_boundary(64) || !line.is_char_boundary(66) {
            return Err(invalid("invalid SHA256SUMS entry"));
        }
        let digest = &line[..64];
        if !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(&line[64..66], "  " | " *")
        {
            return Err(invalid("invalid SHA256SUMS digest/separator"));
        }
        let name = &line[66..];
        validate_path(name)?;
        if name == "SHA256SUMS"
            || checksums
                .insert(name.to_owned(), digest.to_lowercase())
                .is_some()
        {
            return Err(invalid("SHA256SUMS has duplicate/self-referential entries"));
        }
    }
    Ok(checksums)
}

pub(super) fn validate_path(value: &str) -> Result<(), TrustError> {
    if value.is_empty()
        || value.len() > 1024
        || value.split('/').count() > 32
        || value.chars().any(|ch| {
            ch.is_control() || matches!(ch, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(invalid("invalid package path"));
    }
    for part in value.split('/') {
        if part.is_empty() || matches!(part, "." | "..") || part.ends_with(['.', ' ']) {
            return Err(invalid("package path is not portable and relative"));
        }
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid("package path uses a reserved Windows name"));
        }
    }
    if value
        .split('/')
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case(".taomni-trust"))
    {
        return Err(invalid("package uses the reserved trust-proof directory"));
    }
    Ok(())
}

pub(super) fn check_tree(root: &Path, expected: &TreeDigests) -> Result<(), TrustError> {
    let mut actual = BTreeMap::new();
    collect_tree(root, root, &mut actual, false)?;
    if actual != *expected {
        return Err(invalid(
            "verified package contents changed before installation",
        ));
    }
    Ok(())
}

pub(super) fn check_installed_tree(root: &Path, expected: &TreeDigests) -> Result<(), TrustError> {
    let mut actual = BTreeMap::new();
    collect_tree(root, root, &mut actual, true)?;
    if actual != *expected {
        return Err(invalid(
            "installed plugin bytes differ from the signed package",
        ));
    }
    Ok(())
}

fn collect_tree(
    root: &Path,
    path: &Path,
    actual: &mut TreeDigests,
    installed: bool,
) -> Result<(), TrustError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(invalid("verified package contains a symbolic link"));
    }
    if metadata.is_dir() {
        for child in fs::read_dir(path)? {
            let child = child?;
            if installed && path == root && child.file_name() == ".taomni-trust" {
                continue;
            }
            collect_tree(root, &child.path(), actual, installed)?;
        }
    } else if metadata.is_file() {
        let name = path
            .strip_prefix(root)
            .expect("tree descendant")
            .to_str()
            .ok_or_else(|| invalid("package path must be UTF-8"))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_path(&name)?;
        actual.insert(name, hash_file(&mut File::open(path)?)?);
    } else {
        return Err(invalid("verified package contains a special file"));
    }
    Ok(())
}

pub(super) fn hash_file(file: &mut File) -> Result<String, TrustError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn invalid(message: &str) -> TrustError {
    TrustError::Package(message.into())
}

fn zip_error(error: zip::result::ZipError) -> TrustError {
    invalid(&format!("invalid plugin archive: {error}"))
}
