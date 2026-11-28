//! A bounded breadth-first walk keeps newly created and unindexed user files
//! discoverable. Only filenames and file types are read.
use crate::locations::Locations;
use crate::matching::Matches;
use crate::{Provider, SearchResults, check_cancelled, providers::Indexed};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 6000;
const MAX_DIRS: usize = 512;
const MAX_DEPTH: usize = 6;

fn excluded_name(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "$RECYCLE.BIN" | "System Volume Information"
        )
}

#[cfg(windows)]
fn regular_entry(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // No reparse points (junctions, offline placeholders) or hidden/system files.
    metadata.file_attributes() & (0x400 | 0x2 | 0x4) == 0
}

#[cfg(not(windows))]
fn regular_entry(metadata: &fs::Metadata) -> bool {
    !metadata.file_type().is_symlink()
}

pub(super) fn finish(
    query: &str,
    indexed: Indexed,
    roots: Vec<PathBuf>,
    cancelled: &AtomicBool,
) -> Result<SearchResults, String> {
    let locations = Locations::new();
    let mut matches = Matches::new(query);
    let mut truncated = indexed.limited;
    let deadline = Instant::now() + Duration::from_millis(140);
    for path in indexed.paths {
        check_cancelled(cancelled)?;
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        if !locations.allows(&path)
            || path
                .components()
                .any(|c| c.as_os_str().to_str().is_some_and(|s| s.starts_with('.')))
        {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rank) = matches.rank(name) else {
            continue;
        };
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if regular_entry(&meta) && (meta.is_file() || meta.is_dir()) {
                matches.insert(&path, name, meta.is_dir(), rank);
            }
        }
    }

    let budget = if indexed.provider == Provider::BoundedScan {
        MAX_ENTRIES
    } else {
        1500
    };
    let deadline = Instant::now() + Duration::from_millis(100);
    let mut queue = VecDeque::new();
    let mut visited_dirs = HashSet::new();
    let mut scanned_roots = Vec::new();
    let mut scanned = 0;
    for root in roots {
        // Never start a recursive fallback walk at a drive or filesystem root.
        if root.parent().is_some()
            && locations.allows(&root)
            && fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir() && regular_entry(&m))
            && visited_dirs.insert(root.clone())
        {
            queue.push_back((root, 0));
        }
    }
    'walk: while let Some((dir, depth)) = queue.pop_front() {
        check_cancelled(cancelled)?;
        if Instant::now() >= deadline {
            truncated = true;
            break;
        }
        let Ok(items) = fs::read_dir(&dir) else {
            truncated = true;
            continue;
        };
        if depth == 0 {
            scanned_roots.push(dir.to_string_lossy().into_owned());
        }
        for item in items {
            check_cancelled(cancelled)?;
            if scanned >= budget || Instant::now() >= deadline {
                truncated = true;
                break 'walk;
            }
            scanned += 1;
            let Ok(item) = item else {
                truncated = true;
                continue;
            };
            let filename = item.file_name();
            let Some(name) = filename.to_str() else {
                continue;
            };
            if excluded_name(name) {
                continue;
            }
            let Ok(kind) = item.file_type() else {
                truncated = true;
                continue;
            };
            if !kind.is_file() && !kind.is_dir() {
                continue;
            }
            let path = item.path();
            if !locations.allows(&path) {
                continue;
            }
            #[cfg(windows)]
            if !item.metadata().is_ok_and(|meta| regular_entry(&meta)) {
                continue;
            }
            if let Some(rank) = matches.rank(name) {
                matches.insert(&path, name, kind.is_dir(), rank);
            }
            if kind.is_dir() {
                if depth >= MAX_DEPTH || visited_dirs.len() >= MAX_DIRS {
                    truncated = true;
                } else if visited_dirs.insert(path.clone()) {
                    queue.push_back((path, depth + 1));
                }
            }
        }
    }
    check_cancelled(cancelled)?;
    if indexed.provider == Provider::BoundedScan && scanned_roots.is_empty() {
        return Err("unavailable: No usable system index or readable search folders".into());
    }
    Ok(SearchResults {
        provider: indexed.provider,
        truncated: truncated || matches.clipped,
        entries: matches.entries(),
        scanned_roots,
    })
}
