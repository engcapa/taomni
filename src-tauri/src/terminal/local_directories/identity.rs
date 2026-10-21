use super::limits::MAX_ALIAS_CANDIDATES;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use std::path::Path;

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/// Validate a host-absolute path and produce a stable lexical identity key.
///
/// - Rejects empty strings, NUL bytes and paths that cannot be losslessly
///   encoded as UTF-8.
/// - Windows: recognizes drive, UNC share and extended-length prefixes;
///   normalizes separators and drive-letter case. `C:relative` is NOT treated
///   as absolute.
/// - POSIX: preserves `/` and meaningful `//` prefixes; backslashes are legal
///   filename characters and are never rewritten.
/// - `.` components are folded; `..` is kept (equivalence of `..`-containing
///   paths is only confirmed via real resolution, never lexical folding).
pub fn normalize_path_key(path: &Path) -> Option<String> {
    if path.as_os_str().is_empty() || path.as_os_str().to_string_lossy().contains('\0') {
        return None;
    }
    let Some(text) = path.to_str() else {
        return None; // non-UTF-8: no lossless identity
    };
    if text.trim().is_empty() {
        return None;
    }

    #[cfg(windows)]
    {
        normalize_windows_path_key(text)
    }
    #[cfg(not(windows))]
    {
        normalize_posix_path_key(text)
    }
}

#[cfg(windows)]
pub(super) fn normalize_windows_path_key(text: &str) -> Option<String> {
    // Recognized absolute forms: `\\?\UNC\server\share\rest`, `\\?\C:\rest`,
    // `\\server\share\rest`, `C:\rest` / `C:/rest`. `C:relative` is not
    // absolute and is rejected by the prefix match below.
    let (prefix, rest) = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        let mut parts = rest.splitn(3, ['\\', '/']);
        let (Some(server), Some(share), tail) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\?\UNC\{}\{}", server, share), tail.unwrap_or(""))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() < 3
            || bytes[1] != b':'
            || !bytes[0].is_ascii_alphabetic()
            || (bytes[2] != b'\\' && bytes[2] != b'/')
        {
            return None;
        }
        let drive = (bytes[0] as char).to_ascii_uppercase();
        (format!(r"{}:\", drive), &rest[3..])
    } else if let Some(rest) = text.strip_prefix(r"\\") {
        let mut parts = rest.splitn(3, ['\\', '/']);
        let (Some(server), Some(share), tail) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\{}\{}", server, share), tail.unwrap_or(""))
    } else {
        let bytes = text.as_bytes();
        if bytes.len() < 3
            || bytes[1] != b':'
            || !bytes[0].is_ascii_alphabetic()
            || (bytes[2] != b'\\' && bytes[2] != b'/')
        {
            return None;
        }
        let drive = (bytes[0] as char).to_ascii_uppercase();
        (format!(r"{}:\", drive), &text[3..])
    };

    let mut out = prefix;
    for part in rest.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if !out.ends_with('\\') {
            out.push('\\');
        }
        out.push_str(part);
    }
    Some(out)
}

#[cfg(not(windows))]
pub(super) fn normalize_posix_path_key(text: &str) -> Option<String> {
    let path = Path::new(text);
    if !path.is_absolute() {
        return None;
    }
    // Preserve a leading `//` (POSIX implementation-defined root).
    let double_slash = text.starts_with("//") && !text.starts_with("///");
    let mut parts: Vec<&str> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir
            | std::path::Component::CurDir
            | std::path::Component::Prefix(_) => {}
            std::path::Component::ParentDir => parts.push(".."),
            std::path::Component::Normal(part) => {
                let Some(part_str) = part.to_str() else {
                    return None;
                };
                parts.push(part_str);
            }
        }
    }
    let joined = parts.join("/");
    if double_slash {
        Some(format!("//{}", joined))
    } else {
        Some(format!("/{}", joined))
    }
}

/// Best-effort real-resolution key: canonicalize as evidence of the actual
/// directory identity. Returns `None` when the path cannot be resolved
/// (offline mount, permission, non-existent).
pub fn resolved_path_key(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    normalize_path_key(&canonical)
}

/// Cross-platform same-file confirmation for two accessible paths. Uses the
/// already-locked `same-file` crate as a direct dependency instead of
/// hand-rolling per-OS file-id APIs.
pub(super) fn same_directory_handle(a: &Path, b: &Path) -> bool {
    use same_file::Handle;
    match (Handle::from_path(a), Handle::from_path(b)) {
        (Ok(ha), Ok(hb)) => ha == hb,
        _ => false,
    }
}

/// Find the persisted directory id that `path` belongs to.
///
/// Phase A (caller holds no DB lock afterwards): returns the alias keys and
/// candidate display paths needed for filesystem confirmation.
pub struct IdentityProbe {
    pub lexical_key: String,
    pub resolved_key: Option<String>,
    pub alias_direct_hit: Option<String>,
    pub resolved_alias_hit: Option<String>,
    /// (directory_id, display_path) candidates for same-file comparison.
    pub compare_candidates: Vec<(String, String)>,
}

pub fn begin_identity_probe(
    conn: &Connection,
    path: &Path,
) -> Result<Option<IdentityProbe>, String> {
    let Some(lexical_key) = normalize_path_key(path) else {
        return Ok(None);
    };
    let direct: Option<String> = conn
        .query_row(
            "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
            params![lexical_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let resolved_key = resolved_path_key(path);
    let resolved_alias_hit = match &resolved_key {
        Some(key) if Some(key) != Some(&lexical_key) => conn
            .query_row(
                "SELECT directory_id FROM welcome_directory_alias WHERE path_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        _ => None,
    };

    let compare_candidates = if direct.is_none() && resolved_alias_hit.is_none() {
        let mut stmt = conn
            .prepare(
                "SELECT directory_id, display_path FROM welcome_directory_usage
                 ORDER BY last_used_at_ms IS NULL, last_used_at_ms DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_map(params![MAX_ALIAS_CANDIDATES as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };

    Ok(Some(IdentityProbe {
        lexical_key,
        resolved_key,
        alias_direct_hit: direct,
        resolved_alias_hit,
        compare_candidates,
    }))
}

/// Phase B: filesystem checks without any DB lock held. `path` is the
/// original (openable) path; the lexical key alone may not open on Windows.
pub fn finish_identity_probe(
    probe: &IdentityProbe,
    path: &Path,
) -> Result<ResolvedIdentity, String> {
    if let Some(id) = probe.alias_direct_hit.clone() {
        return Ok(ResolvedIdentity {
            directory_id: id,
            new_keys: Vec::new(),
        });
    }
    let mut keys = vec![probe.lexical_key.clone()];
    if let Some(resolved) = &probe.resolved_key {
        if *resolved != probe.lexical_key {
            keys.push(resolved.clone());
        }
    }
    if let Some(id) = probe.resolved_alias_hit.clone() {
        return Ok(ResolvedIdentity {
            directory_id: id,
            new_keys: keys,
        });
    }
    // Same-file confirmation against recently used display paths.
    for (directory_id, display) in &probe.compare_candidates {
        if same_directory_handle(path, Path::new(display)) {
            return Ok(ResolvedIdentity {
                directory_id: directory_id.clone(),
                new_keys: keys,
            });
        }
    }
    Ok(ResolvedIdentity {
        directory_id: String::new(),
        new_keys: keys,
    })
}

pub struct ResolvedIdentity {
    pub directory_id: String,
    /// Alias keys to register for this path (lexical + resolved, deduped).
    pub new_keys: Vec<String>,
}
