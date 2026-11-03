use super::model::AgentSettings;
use std::path::Path;

pub fn load(path: &Path) -> Result<AgentSettings, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let settings: AgentSettings = serde_json::from_slice(&bytes)
                .map_err(|_| "SETTINGS_CORRUPT: shared agent settings could not be read")?;
            settings.validate()?;
            Ok(settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentSettings::default()),
        Err(_) => Err("SETTINGS_UNAVAILABLE: cannot read shared agent settings".into()),
    }
}
pub fn save(path: &Path, settings: &AgentSettings, expected: u64) -> Result<AgentSettings, String> {
    settings.validate()?;
    let current = load(path)?;
    if current.revision != expected {
        return Err("STALE_SETTINGS: reload shared settings before saving".into());
    }
    let mut next = settings.clone();
    next.revision = current.revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
    next.name = next.name.trim().into();
    let parent = path.parent().ok_or("SETTINGS_PATH")?;
    std::fs::create_dir_all(parent).map_err(|_| "SETTINGS_UNAVAILABLE")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "SETTINGS_UNAVAILABLE")?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?)
        .map_err(|_| "SETTINGS_UNAVAILABLE")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "SETTINGS_UNAVAILABLE")?;
    file.persist(path)
        .map_err(|_| "SETTINGS_UNAVAILABLE: failed to publish shared settings")?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_settings_are_versioned_and_stale_writes_do_not_win() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let settings = load(&path).unwrap();
        let snapshot = settings.clone();
        let mut changed = settings;
        changed.name = "Team defaults".into();
        assert_eq!(save(&path, &changed, 1).unwrap().revision, 2);
        assert!(save(&path, &changed, 1).is_err());
        assert_eq!(snapshot.name, "日常开发");
        assert_eq!(load(&path).unwrap().name, "Team defaults");
        changed.name = "  ".into();
        assert!(save(&path, &changed, 2).is_err());
    }
}
