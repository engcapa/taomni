//! Dirty-shutdown recovery journal + automated repair helpers.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub platform: String,
    pub capture_backend: String,
    pub config_hash: String,
    pub pid: u32,
    /// When true, the previous run stopped cleanly (journal should be absent).
    pub clean: bool,
    /// Optional: last relay port (for diagnostics).
    #[serde(default)]
    pub relay_port: Option<u16>,
    /// Optional: helper control port (diagnostics only; token never stored).
    #[serde(default)]
    pub helper_port: Option<u16>,
}

pub fn write_journal(path: &Path, j: &RecoveryJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(j).map_err(|e| e.to_string())?;
    // Atomic-ish replace.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn clear_journal(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn read_journal(path: &Path) -> Option<RecoveryJournal> {
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn needs_repair(path: &Path) -> bool {
    match read_journal(path) {
        Some(j) => !j.clean,
        None => path.exists(), // corrupt / unreadable file still needs cleanup
    }
}

/// Mark a clean stop: write clean=true then remove (so crash mid-stop still has a journal).
pub fn mark_clean_and_clear(path: &Path) -> Result<(), String> {
    if let Some(mut j) = read_journal(path) {
        j.clean = true;
        let _ = write_journal(path, &j);
    }
    clear_journal(path)
}

/// Journal path under app data sockscap dir.
pub fn journal_path(sockscap_dir: &Path) -> PathBuf {
    sockscap_dir.join("recovery.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("sockscap-recovery-test-{n}"));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[test]
    fn journal_roundtrip() {
        let path = temp_path("recovery.json");
        write_journal(
            &path,
            &RecoveryJournal {
                platform: "test".into(),
                capture_backend: "none".into(),
                config_hash: "abc".into(),
                pid: 1,
                clean: false,
                relay_port: Some(1234),
                helper_port: Some(9999),
            },
        )
        .unwrap();
        assert!(needs_repair(&path));
        let j = read_journal(&path).unwrap();
        assert_eq!(j.relay_port, Some(1234));
        clear_journal(&path).unwrap();
        assert!(!needs_repair(&path));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn clean_flag_skips_repair() {
        let path = temp_path("recovery-clean.json");
        write_journal(
            &path,
            &RecoveryJournal {
                platform: "test".into(),
                capture_backend: "windivert".into(),
                config_hash: "x".into(),
                pid: 2,
                clean: true,
                relay_port: None,
                helper_port: None,
            },
        )
        .unwrap();
        assert!(!needs_repair(&path));
        mark_clean_and_clear(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_journal_needs_repair() {
        let path = temp_path("recovery-bad.json");
        std::fs::write(&path, b"not-json{{{").unwrap();
        assert!(needs_repair(&path));
        clear_journal(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
