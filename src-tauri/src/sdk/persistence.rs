use super::model::SDK_REGISTRY_SCHEMA_VERSION;
use super::model::SdkRegistry;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub fn default_sdk_registry_path() -> PathBuf {
    crate::resolved_config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("taomni")
        .join("sdk.json")
}

pub(super) fn load_registry(path: &Path) -> Result<SdkRegistry, String> {
    if !path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            return read_registry(&backup);
        }
        return Ok(SdkRegistry::default());
    }
    read_registry(path)
}

pub(super) fn read_registry(path: &Path) -> Result<SdkRegistry, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let mut registry: SdkRegistry = serde_json::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if registry.schema_version != SDK_REGISTRY_SCHEMA_VERSION {
        return Err(format!(
            "unsupported SDK registry schema version {}",
            registry.schema_version
        ));
    }
    // Heal registries written before verbatim-prefix stripping: a stored
    // `\\?\C:\...` location becomes `JAVA_HOME` / a PATH entry that cmd.exe and
    // batch launchers (mvn.cmd, gradlew.bat) cannot resolve. Strip on load so
    // every downstream consumer — terminals, jdtls, the frontend — sees a plain
    // path, and the next save persists the cleaned form.
    normalize_registry_paths(&mut registry);
    Ok(registry)
}

/// Strip Windows verbatim/extended-length prefixes (`\\?\`, `\\?\UNC\`) from
/// every stored path in the registry. A no-op for already-clean paths and on
/// non-Windows hosts, so it is safe to run unconditionally on load.
pub(super) fn normalize_registry_paths(registry: &mut SdkRegistry) {
    for installation in &mut registry.installations {
        installation.location = strip_verbatim_prefix(&installation.location);
        for executable in installation.executables.values_mut() {
            *executable = strip_verbatim_prefix(executable);
        }
    }
    for binding in &mut registry.bindings {
        binding.scope_path = strip_verbatim_prefix(&binding.scope_path);
    }
}

/// Remove a Windows verbatim path prefix so the result works with cmd.exe,
/// batch scripts (`%JAVA_HOME%\bin\java.exe`), and PATH lookup — none of which
/// accept `\\?\`. Mirrors `workspace.rs::path_to_string`. Returns the input
/// unchanged when no such prefix is present (all Unix paths, clean Windows
/// paths), converting a `\\?\UNC\server\share` path back to `\\server\share`.
pub(crate) fn strip_verbatim_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = value.strip_prefix("//?/UNC/") {
        return format!(r"\\{rest}");
    }
    value
        .strip_prefix(r"\\?\")
        .or_else(|| value.strip_prefix("//?/"))
        .unwrap_or(value)
        .to_string()
}

pub(super) fn persist_registry(path: &Path, registry: &SdkRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("serialize SDK registry: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sdk.json");
    let temporary = path.with_file_name(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("create {}: {error}", temporary.display()))?;
    if let Err(error) = file
        .write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("write {}: {error}", temporary.display()));
    }
    drop(file);

    if path.exists() {
        let backup = backup_path(path);
        if backup.exists() {
            std::fs::remove_file(&backup)
                .map_err(|error| format!("remove stale {}: {error}", backup.display()))?;
        }
        std::fs::rename(path, &backup)
            .map_err(|error| format!("backup {}: {error}", path.display()))?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::rename(&backup, path);
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("commit {}: {error}", path.display()));
        }
        let _ = std::fs::remove_file(backup);
    } else {
        std::fs::rename(&temporary, path)
            .map_err(|error| format!("commit {}: {error}", path.display()))?;
    }
    Ok(())
}

pub(super) fn backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sdk.json");
    path.with_file_name(format!("{file_name}.bak"))
}
