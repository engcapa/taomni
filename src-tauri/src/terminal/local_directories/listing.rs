use super::identity::normalize_path_key;
use super::identity::resolved_path_key;
use super::identity::same_directory_handle;
use super::limits::MAX_DISPLAYED_NON_DEFAULT;
use super::model::Availability;
use super::model::DirectoryListEnvelope;
use super::model::DirectoryRow;
use super::model::DirectoryShortcut;
use super::model::PersistedRow;
use super::probes::probe_availability;
use super::schema::directory_revision;
use rusqlite::Connection;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Default candidates
// ---------------------------------------------------------------------------

/// The fixed default-rank order from design §4.1.3: system folders first,
/// then common home subdirectories. Returns (default_id, rank, label, path).
pub fn default_candidates(home: Option<&Path>) -> Vec<(String, u32, String, PathBuf)> {
    let Some(home) = home else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut push = |id: &str, rank: u32, label: &str, path: PathBuf| {
        out.push((id.to_string(), rank, label.to_string(), path));
    };
    push("home", 0, "Home", home.to_path_buf());
    if let Some(p) = dirs::desktop_dir() {
        push("desktop", 1, "Desktop", p);
    }
    if let Some(p) = dirs::document_dir() {
        push("documents", 2, "Documents", p);
    }
    if let Some(p) = dirs::download_dir() {
        push("downloads", 3, "Downloads", p);
    }
    if let Some(p) = dirs::picture_dir() {
        push("pictures", 4, "Pictures", p);
    }
    if let Some(p) = dirs::audio_dir() {
        push("music", 5, "Music", p);
    }
    if let Some(p) = dirs::video_dir() {
        push("videos", 6, "Videos", p);
    }
    for (index, name) in [
        "Code",
        "code",
        "Projects",
        "projects",
        "Workspace",
        "workspace",
        "work",
        "dev",
        "Developer",
        "src",
    ]
    .iter()
    .enumerate()
    {
        let label = name.to_string();
        push(
            name.to_ascii_lowercase().as_str(),
            7 + index as u32,
            label.as_str(),
            home.join(name),
        );
    }
    out
}

pub(super) fn load_persisted_rows(conn: &Connection) -> Result<Vec<PersistedRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT u.directory_id, u.display_path, u.last_used_at_ms, u.last_use_source,
                    u.legacy_rank,
                    (SELECT MIN(a.path_key) FROM welcome_directory_alias a
                     WHERE a.directory_id = u.directory_id) AS identity_key
             FROM welcome_directory_usage u
             ORDER BY identity_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (
            directory_id,
            display_path,
            last_used_at_ms,
            last_use_source,
            legacy_rank,
            identity_key,
        ) = row.map_err(|e| e.to_string())?;
        let Some(identity_key) = identity_key else {
            continue; // orphan usage row without alias: skip defensively
        };
        out.push(PersistedRow {
            label: path_display_label(Path::new(&display_path), "Directory"),
            kind: "personal".to_string(),
            directory_id,
            display_path,
            last_used_at_ms,
            last_use_source,
            legacy_rank,
            identity_key,
        });
    }
    Ok(out)
}

pub(super) fn path_display_label(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// Merge persisted rows and default candidates by directory identity, then
/// sort with the fixed comparison tuple. Pure function (except key lookups
/// against `aliases`), fully covered by V-01 tests.
pub(crate) fn merge_directory_candidates(
    persisted: Vec<PersistedRow>,
    defaults: &[(String, u32, String, PathBuf)],
) -> Vec<DirectoryRow> {
    let mut by_id: HashMap<String, DirectoryRow> = HashMap::new();
    let mut by_key: HashMap<String, String> = HashMap::new(); // path key -> directory id

    for row in persisted {
        by_key.insert(row.identity_key.clone(), row.directory_id.clone());
        by_id.insert(
            row.directory_id.clone(),
            DirectoryRow {
                directory_id: row.directory_id.clone(),
                display_path: row.display_path.clone(),
                label: row.label.clone(),
                kind: row.kind.clone(),
                last_used_at_ms: row.last_used_at_ms,
                time_source: row.last_use_source,
                legacy_rank: row.legacy_rank,
                default_rank: None,
                default_id: None,
                identity_key: row.identity_key.clone(),
                availability: Availability::Unknown,
            },
        );
    }

    for (default_id, default_rank, label, path) in defaults {
        // Identity resolution for the default candidate: lexical, then
        // canonicalized, then existing-row display path equivalence.
        let mut matched: Option<String> = None;
        if let Some(key) = normalize_path_key(path) {
            if let Some(id) = by_key.get(&key) {
                matched = Some(id.clone());
            }
        }
        if matched.is_none() {
            if let Some(key) = resolved_path_key(path) {
                if let Some(id) = by_key.get(&key) {
                    matched = Some(id.clone());
                }
            }
        }
        if matched.is_none() {
            for (id, row) in by_id.iter_mut() {
                let _ = id;
                if same_directory_handle(path, Path::new(&row.display_path)) {
                    matched = Some(row.directory_id.clone());
                    break;
                }
            }
        }
        match matched {
            Some(id) => {
                let row = by_id.get_mut(&id).expect("matched row exists");
                // Default identity wins: default label/kind, minimal
                // defaultRank, display path from the default.
                row.default_id = Some(default_id.clone());
                row.default_rank = Some(match row.default_rank {
                    Some(existing) => existing.min(*default_rank),
                    None => *default_rank,
                });
                row.label = label.clone();
                row.kind = "system".to_string();
                row.display_path = path.to_string_lossy().into_owned();
                if let Some(key) = normalize_path_key(path) {
                    if key < row.identity_key {
                        row.identity_key = key;
                    }
                }
            }
            None => {
                // Unconfirmed default: ephemeral in-memory row with a stable,
                // label-independent id. Guesses only surface when the
                // directory actually exists.
                let path_exists = path.is_dir();
                let is_system_folder = *default_rank < 7;
                if !path_exists && !is_system_folder {
                    continue; // non-existent guesses never create rows
                }
                let id = format!("default:{default_id}");
                let key = normalize_path_key(path)
                    .or_else(|| resolved_path_key(path))
                    .unwrap_or_else(|| default_id.clone());
                by_key.entry(key.clone()).or_insert_with(|| id.clone());
                by_id.entry(id.clone()).or_insert_with(|| DirectoryRow {
                    directory_id: id.clone(),
                    display_path: path.to_string_lossy().into_owned(),
                    label: label.clone(),
                    kind: "system".to_string(),
                    last_used_at_ms: None,
                    time_source: None,
                    legacy_rank: None,
                    default_rank: Some(*default_rank),
                    default_id: Some(default_id.clone()),
                    identity_key: key,
                    availability: Availability::Unknown,
                });
            }
        }
    }

    let mut rows: Vec<DirectoryRow> = by_id.into_values().collect();
    rows.sort_by(compare_directories);

    // Cap non-default rows at MAX_DISPLAYED_NON_DEFAULT after sorting.
    let mut kept: Vec<DirectoryRow> = Vec::new();
    let mut non_default = 0usize;
    for row in rows {
        if row.default_rank.is_none() {
            if non_default >= MAX_DISPLAYED_NON_DEFAULT {
                continue;
            }
            non_default += 1;
        }
        kept.push(row);
    }
    kept
}

/// Fixed ordering tuple from design §4.1.3. UTF-8 binary order for strings.
pub fn compare_directories(a: &DirectoryRow, b: &DirectoryRow) -> Ordering {
    let a_confirmed = a.last_used_at_ms;
    let b_confirmed = b.last_used_at_ms;
    match (a_confirmed, b_confirmed) {
        (Some(x), Some(y)) => return y.cmp(&x).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    match (a.legacy_rank, b.legacy_rank) {
        (Some(x), Some(y)) => return x.cmp(&y).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    match (a.default_rank, b.default_rank) {
        (Some(x), Some(y)) => return x.cmp(&y).then_with(|| a.identity_key.cmp(&b.identity_key)),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        (None, None) => {}
    }
    a.identity_key.cmp(&b.identity_key)
}

/// Build the sorted, probed listing. Runs the DB reads, then releases the
/// connection before filesystem probing (design §4.1.4: probes never inside
/// the DB lock).
pub fn list_directory_shortcuts(conn: &Connection) -> Result<DirectoryListEnvelope, String> {
    let persisted = load_persisted_rows(conn)?;
    let revision = directory_revision(conn);
    let defaults = default_candidates(dirs::home_dir().as_deref());
    let mut rows = merge_directory_candidates(persisted, &defaults);
    let paths: Vec<String> = rows.iter().map(|r| r.display_path.clone()).collect();
    let availability = probe_availability(&paths);
    for (row, probe) in rows.iter_mut().zip(availability) {
        row.availability = probe;
    }
    let directories = rows
        .into_iter()
        .map(|row| DirectoryShortcut {
            label: row.label,
            path: row.display_path,
            kind: row.kind,
            directory_id: row.directory_id,
            last_used_at_ms: row.last_used_at_ms,
            time_source: row.time_source,
            legacy_rank: row.legacy_rank,
            default_id: row.default_id,
            availability: row.availability.as_str().to_string(),
        })
        .collect();
    Ok(DirectoryListEnvelope {
        revision,
        directories,
    })
}
