use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PATH_CACHE_TTL: Duration = Duration::from_secs(10);
const MAX_DIR_ENTRIES: usize = 500;

pub struct PathScanner {
    cache: Mutex<PathCache>,
}

struct PathCache {
    executables: Vec<String>,
    refreshed_at: Option<Instant>,
}

impl PathScanner {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(PathCache {
                executables: vec![],
                refreshed_at: None,
            }),
        }
    }

    /// Return executables from $PATH that start with `prefix` (case-insensitive on Windows).
    pub fn match_executables(&self, prefix: &str, limit: usize) -> Vec<String> {
        self.ensure_cache();
        let cache = self.cache.lock().unwrap();
        let prefix_lower = prefix.to_lowercase();
        cache.executables.iter()
            .filter(|e| e.to_lowercase().starts_with(&prefix_lower))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Return files/dirs in `dir` whose name starts with the last component of `prefix`.
    pub fn match_files(&self, prefix: &str, dir: &str, limit: usize) -> Vec<String> {
        // Split prefix into directory part and file name part.
        let (search_dir, name_prefix) = if let Some(slash) = prefix.rfind(|c| c == '/' || c == '\\') {
            let d = &prefix[..=slash];
            let n = &prefix[slash + 1..];
            (d.to_string(), n.to_string())
        } else {
            (String::new(), prefix.to_string())
        };

        let base = if search_dir.is_empty() {
            PathBuf::from(dir)
        } else if search_dir.starts_with('/') || (search_dir.len() >= 2 && search_dir.chars().nth(1) == Some(':')) {
            PathBuf::from(&search_dir)
        } else {
            Path::new(dir).join(&search_dir)
        };

        let Ok(entries) = std::fs::read_dir(&base) else {
            return vec![];
        };

        let name_lower = name_prefix.to_lowercase();
        let mut results = Vec::new();

        for entry in entries.flatten().take(MAX_DIR_ENTRIES) {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.to_lowercase().starts_with(&name_lower) {
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let suffix = if is_dir { "/" } else { "" };
                results.push(format!("{}{}{}", search_dir, name, suffix));
                if results.len() >= limit {
                    break;
                }
            }
        }

        results.sort();
        results
    }

    fn ensure_cache(&self) {
        let needs_refresh = {
            let cache = self.cache.lock().unwrap();
            cache.refreshed_at
                .map(|t| t.elapsed() > PATH_CACHE_TTL)
                .unwrap_or(true)
        };

        if needs_refresh {
            let executables = scan_path_executables();
            let mut cache = self.cache.lock().unwrap();
            cache.executables = executables;
            cache.refreshed_at = Some(Instant::now());
        }
    }
}

fn scan_path_executables() -> Vec<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let separator = if cfg!(windows) { ';' } else { ':' };

    let mut names: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for dir in path_var.split(separator) {
        let dir = dir.trim();
        if dir.is_empty() { continue; }
        let Ok(entries) = std::fs::read_dir(dir) else { continue; };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue; };
            if !file_type.is_file() && !file_type.is_symlink() { continue; }

            let name = entry.file_name().to_string_lossy().to_string();

            // On Windows, only include .exe, .cmd, .bat, .ps1; strip extension for display.
            #[cfg(windows)]
            {
                let lower = name.to_lowercase();
                if !lower.ends_with(".exe") && !lower.ends_with(".cmd")
                    && !lower.ends_with(".bat") && !lower.ends_with(".ps1") {
                    continue;
                }
                let display = lower.rsplit_once('.')
                    .map(|(base, _)| base.to_string())
                    .unwrap_or_else(|| lower.clone());
                if seen.insert(display.clone()) {
                    names.push(display);
                }
            }

            // On Unix, check executable bit.
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = entry.metadata() {
                    if meta.permissions().mode() & 0o111 != 0 && seen.insert(name.clone()) {
                        names.push(name);
                    }
                }
            }
        }
    }

    names.sort();
    names
}
