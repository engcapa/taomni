use super::filesystem::scan_dir_for_ext;
use super::model::LocalSessionFile;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn scan_xshell(files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    {
        let mut roots: Vec<PathBuf> = Vec::new();

        // Modern Xshell (6/7) stores sessions under the user's Documents folder:
        //   <Documents>\NetSarang Computer\<version>\Xshell\Sessions
        // The Documents folder is frequently redirected (e.g. OneDrive Known
        // Folder Move), so resolve it from the shell-folders registry and probe
        // the common fallbacks before walking the version subdirectories.
        for documents in windows_documents_dirs() {
            collect_xshell_session_dirs(&documents.join("NetSarang Computer"), &mut roots);
        }

        // The user-data folder can be relocated from within Xshell; that path is
        // recorded in the registry. Probe both the bare Sessions folder and the
        // versioned NetSarang Computer layout under it.
        for user_data in xshell_user_data_paths() {
            roots.push(user_data.join("Xshell").join("Sessions"));
            collect_xshell_session_dirs(&user_data.join("NetSarang Computer"), &mut roots);
        }

        // Legacy location used by older builds.
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("NetSarang").join("Xshell").join("Sessions"));
        }

        let mut seen_roots = HashSet::new();
        for root in roots {
            if !seen_roots.insert(root.to_string_lossy().to_ascii_lowercase()) {
                continue;
            }
            scan_dir_for_ext("xshell", &root, "xsh", files);
        }

        dedup_files_by_path(files);
    }
    #[cfg(not(windows))]
    {
        let _ = files;
    }
}

/// Walks a `NetSarang Computer` directory and collects every
/// `<version>\Xshell\Sessions` folder that exists under it.
#[cfg(windows)]
pub(super) fn collect_xshell_session_dirs(netsarang_computer: &Path, roots: &mut Vec<PathBuf>) {
    if !netsarang_computer.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(netsarang_computer) else {
        return;
    };
    for entry in entries.flatten() {
        let version_dir = entry.path();
        if version_dir.is_dir() {
            let sessions = version_dir.join("Xshell").join("Sessions");
            if sessions.is_dir() {
                roots.push(sessions);
            }
        }
    }
}

/// Candidate Documents directories, accounting for OneDrive folder redirection.
#[cfg(windows)]
pub(super) fn windows_documents_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(personal) = shell_folder_personal() {
        out.push(personal);
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        out.push(profile.join("Documents"));
        out.push(profile.join("OneDrive").join("Documents"));
    }
    for var in ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] {
        if let Some(onedrive) = std::env::var_os(var).map(PathBuf::from) {
            out.push(onedrive.join("Documents"));
        }
    }
    out
}

/// Reads the (already env-expanded) Documents path from the Shell Folders key.
#[cfg(windows)]
pub(super) fn shell_folder_personal() -> Option<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders")
        .ok()?;
    let personal: String = key.get_value("Personal").ok()?;
    if personal.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(personal.trim()))
    }
}

/// User-data paths configured by Xshell, read from `UserDataPath` in the
/// per-version NetSarang registry keys.
#[cfg(windows)]
pub(super) fn xshell_user_data_paths() -> Vec<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut out = Vec::new();
    for version in ["8", "7", "6", "5"] {
        let subkey = format!("Software\\NetSarang\\Common\\{}\\UserData", version);
        if let Ok(key) = hkcu.open_subkey(&subkey) {
            if let Ok(path) = key.get_value::<String, _>("UserDataPath") {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    out.push(PathBuf::from(trimmed));
                }
            }
        }
    }
    out
}

/// Removes duplicate files that the same `.xsh` resolved to via several roots
/// (Documents, registry user-data, OneDrive mirror), keeping the first hit.
#[cfg(windows)]
pub(super) fn dedup_files_by_path(files: &mut Vec<LocalSessionFile>) {
    let mut seen = HashSet::new();
    files.retain(|file| seen.insert(file.path.to_ascii_lowercase()));
}
