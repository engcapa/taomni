//! Dirty-shutdown recovery journal.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub platform: String,
    pub capture_backend: String,
    pub config_hash: String,
    pub pid: u32,
    /// When true, the previous run stopped cleanly (journal should be absent).
    pub clean: bool,
}

pub fn write_journal(path: &Path, j: &RecoveryJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(j).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

pub fn clear_journal(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn needs_repair(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<RecoveryJournal>(&s) {
            Ok(j) => !j.clean,
            Err(_) => true,
        },
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn journal_roundtrip() {
        let mut dir = std::env::temp_dir();
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("sockscap-recovery-test-{n}"));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("recovery.json");
        write_journal(
            &path,
            &RecoveryJournal {
                platform: "test".into(),
                capture_backend: "none".into(),
                config_hash: "abc".into(),
                pid: 1,
                clean: false,
            },
        )
        .unwrap();
        assert!(needs_repair(&path));
        clear_journal(&path).unwrap();
        assert!(!needs_repair(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
