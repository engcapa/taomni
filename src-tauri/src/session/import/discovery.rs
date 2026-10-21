use super::filesystem::decode_command_output;
use super::filesystem::dedup_files_by_path_case_insensitive;
use super::filesystem::home_dir;
use super::filesystem::push_file;
use super::filesystem::scan_dir_for_ext;
use super::filesystem::scan_dir_for_names;
use super::model::LocalSessionFile;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

pub(super) fn scan_tabby(files: &mut Vec<LocalSessionFile>) {
    for path in tabby_config_candidates() {
        push_file(
            "tabby",
            &path,
            path.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("config.yaml"),
            files,
        );
    }
}

pub(super) fn scan_windterm(files: &mut Vec<LocalSessionFile>) {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("WINDTERM_PROFILE_DIR").map(PathBuf::from) {
        roots.push(path);
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".wind"));
        roots.push(home.join("WindTerm"));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local.join("WindTerm"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("WindTerm"));
        }
    }

    for root in roots {
        scan_dir_for_names(
            "windterm",
            &root,
            &["user.sessions", "user.sessions.json"],
            files,
        );
    }
}

pub(super) fn scan_dbeaver(files: &mut Vec<LocalSessionFile>) {
    let mut roots = Vec::new();
    if let Some(workspace) = std::env::var_os("DBEAVER_WORKSPACE").map(PathBuf::from) {
        roots.push(workspace);
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".dbeaver4"));
        roots.push(home.join(".local").join("share").join("DBeaverData"));
        roots.push(home.join(".config").join("DBeaverData"));
        roots.push(
            home.join("snap")
                .join("dbeaver-ce")
                .join("current")
                .join(".local")
                .join("share")
                .join("DBeaverData"),
        );

        #[cfg(target_os = "macos")]
        {
            roots.push(home.join("Library").join("DBeaverData"));
            roots.push(
                home.join("Library")
                    .join("Application Support")
                    .join("DBeaverData"),
            );
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            roots.push(appdata.join("DBeaverData"));
            roots.push(appdata.join("DBeaver"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local.join("DBeaverData"));
            roots.push(local.join("DBeaver"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            roots.push(profile.join(".dbeaver4"));
        }
    }

    let names = [
        "data-sources.json",
        "data-sources.xml",
        ".dbeaver-data-sources.xml",
    ];
    for root in roots {
        scan_dir_for_names("dbeaver", &root, &names, files);
    }
    dedup_files_by_path_case_insensitive(files);
}

pub(super) fn scan_iterm2(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let root = home
            .join("Library")
            .join("Application Support")
            .join("iTerm2")
            .join("DynamicProfiles");
        scan_dir_for_ext("iterm2", &root, "json", _files);
        scan_dir_for_ext("iterm2", &root, "plist", _files);
    }
}

pub(super) fn scan_terminal_app(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let pref = home
            .join("Library")
            .join("Preferences")
            .join("com.apple.Terminal.plist");
        if pref.is_file() {
            if let Ok(output) = Command::new("plutil")
                .args(["-convert", "xml1", "-o", "-", &pref.to_string_lossy()])
                .output()
            {
                if output.status.success() {
                    let text = decode_command_output(&output.stdout);
                    _files.push(LocalSessionFile {
                        source: "terminal".to_string(),
                        path: pref.to_string_lossy().into_owned(),
                        relative_path: "com.apple.Terminal.plist".to_string(),
                        text,
                    });
                }
            }
        }
    }
}

pub(super) fn scan_termius_exports(files: &mut Vec<LocalSessionFile>) {
    if let Some(home) = home_dir() {
        for rel in [
            ".termius/ssh_config",
            ".termius/exported_ssh_config",
            "termius-ssh-config",
            "Downloads/termius-ssh-config",
        ] {
            push_file("termius", &home.join(rel), rel, files);
        }
    }
}

pub(super) fn scan_mremote(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        push_file(
            "mremote",
            &appdata.join("mRemoteNG").join("confCons.xml"),
            "confCons.xml",
            _files,
        );
    }
}

pub(super) fn scan_securecrt(_files: &mut Vec<LocalSessionFile>) {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        scan_dir_for_ext(
            "securecrt",
            &appdata.join("VanDyke").join("Config").join("Sessions"),
            "ini",
            _files,
        );
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        scan_dir_for_ext(
            "securecrt",
            &home
                .join("Library")
                .join("Application Support")
                .join("VanDyke")
                .join("Config")
                .join("Sessions"),
            "ini",
            _files,
        );
    }
}

pub(super) fn tabby_config_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        out.push(appdata.join("tabby").join("config.yaml"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("tabby")
                .join("config.yaml"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = home_dir() {
        out.push(home.join(".config").join("tabby").join("config.yaml"));
    }
    if let Some(home) = home_dir() {
        out.push(home.join(".tabby").join("config.yaml"));
    }
    out
}
