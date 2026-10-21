use super::paths::initial_dir_from;
use std::path::Path;
use std::process::{Command, Output, Stdio};

pub fn select_private_key_file(current_path: Option<&str>) -> Result<Option<String>, String> {
    let initial = initial_dir_from(current_path);
    open_file_dialog("Select private key", initial.as_deref())
}

pub fn select_upload_file() -> Result<Vec<String>, String> {
    open_file_dialog_multi("Select files to send", dirs::home_dir().as_deref())
}

pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
    let initial = dirs::download_dir().or_else(dirs::home_dir);
    open_dir_dialog("Select save directory", initial.as_deref())
}

pub fn select_folder_path(current_path: Option<&str>) -> Result<Option<String>, String> {
    let initial = initial_dir_from(current_path).or_else(dirs::home_dir);
    open_dir_dialog("Select folder to open", initial.as_deref())
}

pub fn select_file_path(current_path: Option<&str>) -> Result<Option<String>, String> {
    let initial = initial_dir_from(current_path);
    open_file_dialog("Select file to open", initial.as_deref())
}

pub fn select_save_file_path(
    default_name: Option<&str>,
    current_path: Option<&str>,
) -> Result<Option<String>, String> {
    let initial_dir = initial_dir_from(current_path)
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir);
    let initial_path = initial_dir.map(|dir| {
        let mut path = dir;
        if let Some(name) = default_name {
            path.push(name);
        }
        path
    });
    open_save_dialog("Save as", initial_path.as_deref())
}

/// Best-effort text fallback for environments where arboard cannot answer
/// an X11 selection request (or where only a Wayland helper is available).
/// A missing owner is reported as `None`, allowing the WebKit clipboard
/// API or the caller's normal empty-clipboard handling to decide next.
pub fn clipboard_read_text_fallback() -> Result<Option<String>, String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        if let Some(text) = run_clipboard_reader("wl-paste", &["--no-newline"])? {
            return Ok(Some(text));
        }
    }
    if std::env::var_os("DISPLAY").is_some() {
        if let Ok(Some(text)) = run_clipboard_reader("xclip", &["-selection", "clipboard", "-o"]) {
            return Ok(Some(text));
        }
        if let Ok(Some(text)) = run_clipboard_reader("xsel", &["--clipboard", "--output"]) {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

/// `wl-copy` exits after handing ownership to the compositor. X11 owners
/// are deliberately not spawned here: a synchronous xclip/xsel fallback
/// would either block forever or lose ownership as soon as the helper is
/// killed. arboard remains the authoritative X11 writer.
pub fn clipboard_write_text_fallback(text: &str) -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Err("no Wayland clipboard helper available".into());
    }
    let mut child = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wl-copy: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        std::io::Write::write_all(&mut stdin, text.as_bytes())
            .map_err(|e| format!("wl-copy stdin: {}", e))?;
    }
    let status = child.wait().map_err(|e| format!("wl-copy: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("wl-copy exited with {}", status))
    }
}

fn open_file_dialog_multi(title: &str, initial_dir: Option<&Path>) -> Result<Vec<String>, String> {
    match run_zenity_multi(title, initial_dir) {
        Ok(result) => return result,
        Err(DialogAttempt::NotFound) => {}
        Err(DialogAttempt::Failed(err)) => return Err(err),
    }

    match run_kdialog_multi(title, initial_dir) {
        Ok(result) => result,
        Err(DialogAttempt::NotFound) => {
            Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
        }
        Err(DialogAttempt::Failed(err)) => Err(err),
    }
}

fn run_zenity_multi(
    title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Vec<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("zenity");
    cmd.arg("--file-selection")
        .arg("--multiple")
        .arg("--separator=\n")
        .arg(format!("--title={}", title));
    if let Some(dir) = initial_dir {
        cmd.arg(format!("--filename={}", dir_with_separator(dir)));
    }
    handle_output_multi(cmd.output(), "zenity")
}

fn run_kdialog_multi(
    _title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Vec<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("kdialog");
    cmd.arg("--getopenfilenames")
        .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
    handle_output_multi(cmd.output(), "kdialog")
}

fn handle_output_multi(
    result: std::io::Result<Output>,
    helper: &str,
) -> Result<Result<Vec<String>, String>, DialogAttempt> {
    match result {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(DialogAttempt::NotFound),
        Err(err) => Err(DialogAttempt::Failed(format!("{helper}: {err}"))),
        Ok(output) if output.status.success() => {
            let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(Ok(paths))
        }
        Ok(output) if output.status.code() == Some(1) => Ok(Ok(vec![])),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(DialogAttempt::Failed(format!(
                "{helper}: {}",
                stderr.trim()
            )))
        }
    }
}

fn open_file_dialog(title: &str, initial_dir: Option<&Path>) -> Result<Option<String>, String> {
    match run_zenity(title, initial_dir) {
        Ok(result) => return result,
        Err(DialogAttempt::NotFound) => {}
        Err(DialogAttempt::Failed(err)) => return Err(err),
    }

    match run_kdialog(title, initial_dir) {
        Ok(result) => result,
        Err(DialogAttempt::NotFound) => {
            Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
        }
        Err(DialogAttempt::Failed(err)) => Err(err),
    }
}

enum DialogAttempt {
    NotFound,
    Failed(String),
}

fn run_zenity(
    title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("zenity");
    cmd.arg("--file-selection")
        .arg(format!("--title={}", title));
    if let Some(dir) = initial_dir {
        cmd.arg(format!("--filename={}", dir_with_separator(dir)));
    }
    handle_output(cmd.output(), "zenity")
}

fn run_kdialog(
    _title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("kdialog");
    cmd.arg("--getopenfilename")
        .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
    handle_output(cmd.output(), "kdialog")
}

fn handle_output(
    result: std::io::Result<Output>,
    helper: &str,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    match result {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(DialogAttempt::NotFound),
        Err(err) => Err(DialogAttempt::Failed(format!("{helper}: {err}"))),
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(&['\r', '\n'][..])
                .to_string();
            Ok(Ok((!path.is_empty()).then_some(path)))
        }
        Ok(output) if output.status.code() == Some(1) => Ok(Ok(None)),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(DialogAttempt::Failed(format!(
                "{helper}: {}",
                stderr.trim()
            )))
        }
    }
}

fn dir_with_separator(path: &Path) -> String {
    let mut value = path.to_string_lossy().into_owned();
    if !value.ends_with(std::path::MAIN_SEPARATOR) {
        value.push(std::path::MAIN_SEPARATOR);
    }
    value
}

fn open_dir_dialog(title: &str, initial_dir: Option<&Path>) -> Result<Option<String>, String> {
    match run_zenity_dir(title, initial_dir) {
        Ok(result) => return result,
        Err(DialogAttempt::NotFound) => {}
        Err(DialogAttempt::Failed(err)) => return Err(err),
    }

    match run_kdialog_dir(title, initial_dir) {
        Ok(result) => result,
        Err(DialogAttempt::NotFound) => {
            Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
        }
        Err(DialogAttempt::Failed(err)) => Err(err),
    }
}

fn run_zenity_dir(
    title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("zenity");
    cmd.arg("--file-selection")
        .arg("--directory")
        .arg(format!("--title={}", title));
    if let Some(dir) = initial_dir {
        cmd.arg(format!("--filename={}", dir_with_separator(dir)));
    }
    handle_output(cmd.output(), "zenity")
}

fn run_kdialog_dir(
    _title: &str,
    initial_dir: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("kdialog");
    cmd.arg("--getexistingdirectory")
        .arg(initial_dir.unwrap_or_else(|| Path::new("~")));
    handle_output(cmd.output(), "kdialog")
}

fn open_save_dialog(title: &str, initial_path: Option<&Path>) -> Result<Option<String>, String> {
    match run_zenity_save(title, initial_path) {
        Ok(result) => return result,
        Err(DialogAttempt::NotFound) => {}
        Err(DialogAttempt::Failed(err)) => return Err(err),
    }

    match run_kdialog_save(title, initial_path) {
        Ok(result) => result,
        Err(DialogAttempt::NotFound) => {
            Err("No native file dialog helper found. Install zenity or kdialog.".to_string())
        }
        Err(DialogAttempt::Failed(err)) => Err(err),
    }
}

fn run_zenity_save(
    title: &str,
    initial_path: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("zenity");
    cmd.arg("--file-selection")
        .arg("--save")
        .arg("--confirm-overwrite")
        .arg(format!("--title={}", title));
    if let Some(path) = initial_path {
        cmd.arg(format!("--filename={}", path.to_string_lossy()));
    }
    handle_output(cmd.output(), "zenity")
}

fn run_kdialog_save(
    _title: &str,
    initial_path: Option<&Path>,
) -> Result<Result<Option<String>, String>, DialogAttempt> {
    let mut cmd = Command::new("kdialog");
    cmd.arg("--getsavefilename")
        .arg(initial_path.unwrap_or_else(|| Path::new("~")));
    handle_output(cmd.output(), "kdialog")
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    const MIME_TYPES: &[&str] = &["x-special/gnome-copied-files", "text/uri-list"];
    for mime in MIME_TYPES {
        if let Some(payload) = run_clipboard_reader("wl-paste", &["--no-newline", "--type", mime])?
        {
            let paths = super::paths::clipboard_paths_from_uri_text(&payload);
            if !paths.is_empty() {
                return Ok(paths);
            }
        }
    }
    for mime in MIME_TYPES {
        if let Some(payload) =
            run_clipboard_reader("xclip", &["-selection", "clipboard", "-t", mime, "-o"])?
        {
            let paths = super::paths::clipboard_paths_from_uri_text(&payload);
            if !paths.is_empty() {
                return Ok(paths);
            }
        }
    }
    if let Some(payload) = run_clipboard_reader("xsel", &["--clipboard", "--output"])? {
        let paths = super::paths::clipboard_paths_from_uri_text(&payload);
        if !paths.is_empty() {
            return Ok(paths);
        }
    }
    Ok(Vec::new())
}

fn run_clipboard_reader(program: &str, args: &[&str]) -> Result<Option<String>, String> {
    match Command::new(program).args(args).output() {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("{program}: {err}")),
        Ok(output) if output.status.success() => {
            super::clipboard_text::decode_payload(program, output.stdout)
        }
        Ok(_) => Ok(None),
    }
}

pub fn clipboard_write_files(_paths: &[String]) -> Result<(), String> {
    Err("native file clipboard is not implemented on this Linux desktop".to_string())
}
