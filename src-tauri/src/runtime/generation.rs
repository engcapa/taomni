//! Core metadata is outside restore mappings and uses a stable lock inode.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
use taomni_plugin_api::services::ProfileGeneration;
use taomni_profile_locks::{ProfileRoot, ProfileStateLease, WaitControl};

const STATE_FILE: &str = ".profile-state.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileState {
    format_version: u16,
    generation: ProfileGeneration,
}

pub(crate) fn current(data: &Path) -> Result<ProfileGeneration, String> {
    access(data, None)
}

/// Call only while holding exclusive profile ownership, before replacing any
/// database. Recovery retains this new value even when data rolls back.
pub(crate) fn begin_restore(data: &Path) -> Result<ProfileGeneration, String> {
    access(data, Some(fresh()))
}

/// Keep a matching journal generation. Legacy/mismatched journals receive a
/// fresh value instead of reviving a previously used context.
pub(crate) fn recover_restore(
    data: &Path,
    expected: Option<&ProfileGeneration>,
) -> Result<ProfileGeneration, String> {
    let generation = current(data)?;
    if expected == Some(&generation) {
        Ok(generation)
    } else {
        begin_restore(data)
    }
}

fn fresh() -> ProfileGeneration {
    ProfileGeneration::parse(uuid::Uuid::new_v4().to_string()).expect("canonical UUID")
}

fn access(
    data: &Path,
    replacement: Option<ProfileGeneration>,
) -> Result<ProfileGeneration, String> {
    let root = ProfileRoot::prepare(data).map_err(|e| e.to_string())?;
    let wait = WaitControl::new(Instant::now() + Duration::from_secs(5), &|| false);
    let _lease = ProfileStateLease::acquire(&root, &wait).map_err(|e| e.to_string())?;
    access_locked(&root, replacement)
}

/// MFA export and recovery already own the exact profile-state lock.
pub(crate) fn access_for_mfa_upgrade(
    maintenance: &crate::plugin::migration::export::MfaMaintenance,
    replacement: Option<ProfileGeneration>,
) -> Result<ProfileGeneration, String> {
    access_locked(maintenance.profile(), replacement)
}

fn access_locked(
    root: &ProfileRoot,
    replacement: Option<ProfileGeneration>,
) -> Result<ProfileGeneration, String> {
    let path = root.path().join(STATE_FILE);
    let old = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || is_reparse(&metadata) || metadata.len() > 4096 {
                return Err("Invalid profile state file".into());
            }
            let state: ProfileState =
                serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|_| "Invalid profile state file")?;
            if state.format_version != 1 {
                return Err("Unsupported profile state version".into());
            }
            Some(state.generation)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if let Some(generation) = old.as_ref().filter(|_| replacement.is_none()) {
        return Ok(generation.clone());
    }
    let generation = replacement.unwrap_or_else(fresh);
    crate::backup::control::write_json(
        &path,
        &ProfileState {
            format_version: 1,
            generation: generation.clone(),
        },
    )?;
    #[cfg(unix)]
    fs::File::open(root.path())
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(generation)
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_is_stable_until_restore_and_replay_keeps_the_new_value() {
        let root = tempfile::tempdir().unwrap();
        let original = current(root.path()).unwrap();
        assert_eq!(current(root.path()).unwrap(), original);
        let restored = begin_restore(root.path()).unwrap();
        assert_ne!(restored, original);
        assert_eq!(
            recover_restore(root.path(), Some(&restored)).unwrap(),
            restored
        );
        assert_eq!(current(root.path()).unwrap(), restored);
        let recovery = recover_restore(root.path(), Some(&original)).unwrap();
        assert_ne!(recovery, original);
        assert_ne!(recovery, restored);
        let locks = root.path().join(".profile-locks/profile-state.lock");
        assert!(locks.is_file());
        let _lock =
            ProfileStateLease::try_acquire(&ProfileRoot::prepare(root.path()).unwrap()).unwrap();
        assert!(
            ProfileStateLease::try_acquire(&ProfileRoot::prepare(root.path()).unwrap()).is_err()
        );
    }

    #[test]
    fn corrupt_state_is_not_silently_replaced_even_during_recovery() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(STATE_FILE), b"broken").unwrap();
        assert!(current(root.path()).is_err());
        assert!(begin_restore(root.path()).is_err());
        assert_eq!(fs::read(root.path().join(STATE_FILE)).unwrap(), b"broken");
    }

    #[test]
    fn concurrent_cores_initialize_one_generation_under_the_stable_state_lock() {
        let root = tempfile::tempdir().unwrap();
        let workers = (0..8)
            .map(|_| {
                let data = root.path().to_owned();
                std::thread::spawn(move || current(&data).unwrap())
            })
            .collect::<Vec<_>>();
        let generations = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert!(
            generations
                .iter()
                .all(|generation| generation == &generations[0])
        );
    }

    #[test]
    #[cfg(unix)]
    fn metadata_symlink_cannot_redirect_generation_reads_or_restore_writes() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::NamedTempFile::new().unwrap();
        fs::write(external.path(), b"outside profile").unwrap();
        std::os::unix::fs::symlink(external.path(), root.path().join(STATE_FILE)).unwrap();
        assert!(current(root.path()).is_err());
        assert!(begin_restore(root.path()).is_err());
        assert_eq!(fs::read(external.path()).unwrap(), b"outside profile");
    }
}
