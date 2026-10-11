//! This directory is deliberately outside the archive restore allowlist.
use super::model::*;
use std::path::{Path, PathBuf};
static CONTROL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn process_lock(root: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(root).map_err(|_| "Cannot create backup control directory")?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(root.join("config.lock"))
        .map_err(|_| "Cannot open backup configuration lock")?;
    file.lock()
        .map_err(|_| "Cannot lock backup configuration")?;
    Ok(file)
}

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let path = db
        .path()
        .ok_or("Cloud backups require a file-backed SQLite database")?;
    root_for_database(Path::new(path))
}
fn root_for_database(path: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("Missing SQLite parent directory")?;
    // Preserve existing controls/credentials for the standard database. Resolve
    // directory aliases before locking, so additional app processes share it.
    let relative = if path.file_name().and_then(|v| v.to_str()) == Some("taomni.db") {
        PathBuf::from("backup-control")
    } else {
        use sha2::{Digest, Sha256};
        PathBuf::from(".taomni-backup-sources")
            .join(hex::encode(Sha256::digest(
                path.to_string_lossy().as_bytes(),
            )))
            .join("backup-control")
    };
    Ok(parent.join(relative))
}

fn default_device_name() -> String {
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").unwrap_or_default();
    #[cfg(unix)]
    let name = {
        let mut buffer = [0u8; 256];
        // gethostname writes at most buffer.len() bytes; read only on success.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
            String::from_utf8_lossy(&buffer[..end]).into_owned()
        } else {
            String::new()
        }
    };
    #[cfg(not(any(windows, unix)))]
    let name = String::new();
    let mut clean = String::new();
    for c in name.trim().chars().filter(|c| !c.is_control()) {
        if clean.len() + c.len_utf8() > 128 {
            break;
        }
        clean.push(c);
    }
    if clean.is_empty() {
        "Taomni".into()
    } else {
        clean
    }
}
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing backup control directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    tmp.write_all(&bytes).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn read_at(root: &Path) -> Result<ControlConfig, String> {
    let path = root.join("config.json");
    if path.exists() {
        let config: ControlConfig =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(
                |_| "Backup configuration is damaged; restore the control file before continuing",
            )?;
        if config.format_version != 1 {
            return Err("Unsupported backup configuration version".into());
        }
        validate_id(&config.device.id)?;
        return Ok(config);
    }
    let config = ControlConfig {
        format_version: 1,
        device: DeviceIdentity {
            id: uuid::Uuid::new_v4().to_string(),
            name: default_device_name(),
        },
        targets: vec![],
        connections: vec![],
        selected_target_ids: vec!["local".into()],
    };
    write_json(&path, &config)?;
    Ok(config)
}
pub fn load_at(root: &Path) -> Result<ControlConfig, String> {
    let _guard = CONTROL_LOCK.lock().map_err(|e| e.to_string())?;
    let _process = process_lock(root)?;
    read_at(root)
}
pub fn load(app: &tauri::AppHandle) -> Result<ControlConfig, String> {
    let _guard = CONTROL_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = root(app)?;
    let _process = process_lock(&dir)?;
    let mut config = read_at(&dir)?;
    let mut migrated = false;
    for target in &mut config.targets {
        if target.app_id.is_empty() {
            continue;
        }
        let old = super::credentials::get(&config.device.id, &target.id)?;
        if old.app_secret.is_empty() {
            return Err("Legacy Feishu application credentials are missing; repair the control configuration before reconnecting".into());
        }
        let id = target
            .connection_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut secret = super::credentials::ConnectionSecrets::default();
        secret.app_id = target.app_id.clone();
        secret.app_secret = old.app_secret.clone();
        // The draft's protocol/scopes were never verified: retain its app, not its token.
        super::credentials::put_connection(&config.device.id, &id, &secret)?;
        config.connections.push(FeishuConnection {
            id: id.clone(),
            app_id: target.app_id.clone(),
            label: target.app_id.clone(),
            origin: "legacy".into(),
            account_id: String::new(),
            account_name: String::new(),
            tenant_key: String::new(),
            auth_protocol_version: 1,
            scope_manifest_version: 1,
            registration_pending: false,
        });
        target.connection_id = Some(id);
        target.app_id.clear();
        migrated = true;
    }
    if migrated {
        write_json(&dir.join("config.json"), &config)?;
    }
    Ok(config)
}
pub fn save(app: &tauri::AppHandle, mut config: ControlConfig) -> Result<(), String> {
    load(app)?; // Finish legacy migration before taking the mutation lock.
    let _guard = CONTROL_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = root(app)?;
    let _process = process_lock(&dir)?;
    let current = read_at(&dir)?;
    // A frontend form or a foreign archive must never replace device identity.
    config.device.id = current.device.id;
    // Application bindings and identity are backend-owned, never editable via a form.
    config.connections = current.connections;
    for target in &mut config.targets {
        target.connection_id = current
            .targets
            .iter()
            .find(|t| t.id == target.id)
            .and_then(|t| t.connection_id.clone());
        target.app_id.clear();
    }
    if config.format_version != 1
        || config.device.name.trim().is_empty()
        || config.device.name.len() > 128
    {
        return Err("Invalid backup configuration".into());
    }
    let mut ids = std::collections::HashSet::new();
    for target in &config.targets {
        validate_id(&target.id)?;
        if !ids.insert(&target.id) {
            return Err("Duplicate backup target".into());
        }
        if target.kind != ProviderKind::Feishu {
            return Err("PROVIDER_NOT_IMPLEMENTED".into());
        }
        if !target.root_token.is_empty() {
            validate_token(&target.root_token)?;
        }
        if target.name.trim().is_empty() || target.name.len() > 128 {
            return Err("Invalid backup target name".into());
        }
        if !["app", "custom", "none"].contains(&target.proxy.mode.as_str()) {
            return Err("Invalid backup proxy mode".into());
        }
        if target.source.kind != "taomni"
            || target.source.schema_version != 1
            || !["core", "full", "custom"].contains(&target.source.scope.as_str())
        {
            return Err("Unsupported backup source".into());
        }
    }
    let mut selections = std::collections::HashSet::new();
    for id in &config.selected_target_ids {
        if !selections.insert(id) || (id != "local" && !config.targets.iter().any(|t| &t.id == id))
        {
            return Err("Invalid selected backup destinations".into());
        }
    }
    write_json(&dir.join("config.json"), &config)
}
/// Update only backend-owned fields against a freshly read control file.
pub fn update(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut ControlConfig) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = CONTROL_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = root(app)?;
    let _process = process_lock(&dir)?;
    let mut config = read_at(&dir)?;
    change(&mut config)?;
    write_json(&dir.join("config.json"), &config)
}
pub fn target(app: &tauri::AppHandle, id: &str) -> Result<BackupTarget, String> {
    load(app)?
        .targets
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Backup target not found".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_path_aliases_share_identity_but_other_databases_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("taomni.db");
        std::fs::write(&db, b"").unwrap();
        let a = root_for_database(&db).unwrap();
        let b = root_for_database(&dir.path().join(".").join("taomni.db")).unwrap();
        assert_eq!(a, b);
        assert_eq!(
            load_at(&a).unwrap().device.id,
            load_at(&b).unwrap().device.id
        );
        let other = dir.path().join("other.db");
        std::fs::write(&other, b"").unwrap();
        assert_eq!(
            root_for_database(&other).unwrap().file_name().unwrap(),
            "backup-control"
        );
        assert_ne!(
            load_at(&a).unwrap().device.id,
            load_at(&root_for_database(&other).unwrap())
                .unwrap()
                .device
                .id
        );
    }
    #[test]
    fn identity_is_stable_and_corruption_does_not_silently_reenroll() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_at(dir.path()).unwrap();
        assert_eq!(a.device.name, default_device_name());
        assert_eq!(a.device.id, load_at(dir.path()).unwrap().device.id);
        let mut renamed = a.clone();
        renamed.device.name = "Office laptop".into();
        write_json(&dir.path().join("config.json"), &renamed).unwrap();
        assert_eq!(load_at(dir.path()).unwrap().device.name, "Office laptop");
        let other = tempfile::tempdir().unwrap();
        assert_ne!(a.device.id, load_at(other.path()).unwrap().device.id);
        std::fs::write(dir.path().join("config.json"), b"{").unwrap();
        assert!(load_at(dir.path()).is_err());
    }
}
