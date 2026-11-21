use super::NotepadSaveAsResult;
use crate::viewer::{HARD_TEXT_BYTES, display_path, is_owned_temp, normalize_eol, path_io_error};
use crate::workspace::viewer_io::encode_text_bytes;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

struct TempCleanup(PathBuf);
impl Drop for TempCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn validate_existing_regular_target(raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("permission: Elevated save requires an absolute path without '..'".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| path_io_error("resolve target file", e))?;
    if is_owned_temp(&canonical) {
        return Err("permission: Temporary read-only copies cannot be saved with elevation".into());
    }
    let meta =
        fs::symlink_metadata(&canonical).map_err(|e| path_io_error("stat target file", e))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("permission: Elevated save only supports regular non-symlink files".into());
    }
    if meta.len() > HARD_TEXT_BYTES {
        return Err("too_large: Existing file exceeds 20 MiB editing limit".into());
    }
    Ok(canonical)
}

#[cfg(unix)]
fn write_private_temp(bytes: &[u8]) -> Result<TempCleanup, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let temp_path =
        std::env::temp_dir().join(format!("taomni-elev-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp_path)
        .map_err(|e| path_io_error("create elevated staging temp file", e))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| path_io_error("write elevated staging temp file", e))?;
    Ok(TempCleanup(temp_path))
}

#[cfg(not(unix))]
fn write_private_temp(bytes: &[u8]) -> Result<TempCleanup, String> {
    let temp_path =
        std::env::temp_dir().join(format!("taomni-elev-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|e| path_io_error("create elevated staging temp file", e))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| path_io_error("write elevated staging temp file", e))?;
    Ok(TempCleanup(temp_path))
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn write_text_elevated(
    path: &str,
    content: &str,
    encoding: &str,
    bom: bool,
    eol: &str,
) -> Result<NotepadSaveAsResult, String> {
    if content.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Text exceeds the 20 MiB editing limit".into());
    }
    let target = validate_existing_regular_target(path)?;
    let normalized = normalize_eol(content, eol)?;
    let bytes =
        encode_text_bytes(&normalized, encoding, bom).map_err(|e| format!("binary: {e}"))?;
    if bytes.len() as u64 > HARD_TEXT_BYTES {
        return Err("too_large: Encoded text exceeds the 20 MiB editing limit".into());
    }
    let staged = write_private_temp(&bytes)?;
    run_elevated_copy(&staged.0, &target)?;
    let meta = fs::metadata(&target).map_err(|e| path_io_error("stat saved file", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(NotepadSaveAsResult {
        path: display_path(&target),
        hash: hex::encode(Sha256::digest(&bytes)),
        size: bytes.len() as u64,
        mtime,
    })
}

#[cfg(target_os = "windows")]
fn run_elevated_copy(src: &Path, dest: &Path) -> Result<(), String> {
    let ps_quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let inner = format!(
        "Copy-Item -LiteralPath '{}' -Destination '{}' -Force",
        ps_quote(src),
        ps_quote(dest),
    );
    let inner_escaped = inner.replace('\'', "''");
    let script = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-Command','{inner_escaped}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("unsupported: Unable to launch elevated PowerShell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.to_lowercase().contains("canceled") || stderr.to_lowercase().contains("cancelled")
        {
            return Err("cancelled: UAC elevation prompt was cancelled".into());
        }
        return Err(format!("permission: UAC elevated copy failed: {stderr}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_elevated_copy(src: &Path, dest: &Path) -> Result<(), String> {
    let shell_cmd = format!(
        "cat {} > {}",
        shell_quote(&src.to_string_lossy()),
        shell_quote(&dest.to_string_lossy()),
    );
    let escaped_apple = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped_apple}\" with administrator privileges");
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("unsupported: Unable to run osascript: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") || stderr.to_lowercase().contains("cancel") {
            return Err("cancelled: Administrator authorization was cancelled".into());
        }
        return Err(format!("permission: Elevated copy failed: {stderr}"));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_elevated_copy(src: &Path, dest: &Path) -> Result<(), String> {
    let output = Command::new("pkexec")
        .args([
            "dd",
            &format!("if={}", src.to_string_lossy()),
            &format!("of={}", dest.to_string_lossy()),
            "bs=65536",
            "status=none",
        ])
        .output()
        .map_err(|e| {
            format!("unsupported: pkexec elevation tool is unavailable on this Linux host: {e}")
        })?;
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if code == 126 || stderr.to_lowercase().contains("dismiss") {
            return Err("cancelled: Polkit authorization was cancelled".into());
        }
        return Err(format!(
            "permission: Elevated save failed (exit {code}): {stderr}"
        ));
    }
    Ok(())
}
