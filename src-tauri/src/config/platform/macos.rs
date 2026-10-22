use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeRTF, NSPasteboardTypeString,
};
use objc2_foundation::{NSData, NSString};
use std::process::Command;

use super::clipboard::ClipboardMultiFormat;

const MAX_FORMAT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

pub fn clipboard_read_multi_format() -> Result<ClipboardMultiFormat, String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let text = pasteboard
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|value| value.to_string())
        .unwrap_or_default();
    let html = pasteboard
        .stringForType(unsafe { NSPasteboardTypeHTML })
        .map(|value| value.to_string());
    let rtf = match pasteboard.dataForType(unsafe { NSPasteboardTypeRTF }) {
        Some(value) => {
            // NSData is immutable here and retained for the duration of the copy.
            let bytes = unsafe { value.as_bytes_unchecked() }.to_vec();
            Some(String::from_utf8(bytes).map_err(|_| {
                "macOS clipboard RTF is not valid UTF-8 and cannot be sent losslessly".to_string()
            })?)
        }
        None => None,
    };
    let payload = ClipboardMultiFormat { text, html, rtf };
    validate_multi_format(&payload)?;
    Ok(payload)
}

pub fn clipboard_write_multi_format(payload: &ClipboardMultiFormat) -> Result<(), String> {
    validate_multi_format(payload)?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if !pasteboard.setString_forType(&NSString::from_str(&payload.text), unsafe {
        NSPasteboardTypeString
    }) {
        return Err("macOS clipboard rejected plain text".to_string());
    }
    if let Some(html) = payload.html.as_deref() {
        if !pasteboard.setString_forType(&NSString::from_str(html), unsafe { NSPasteboardTypeHTML })
        {
            return Err("macOS clipboard rejected HTML".to_string());
        }
    }
    if let Some(rtf) = payload.rtf.as_deref() {
        let data = NSData::with_bytes(rtf.as_bytes());
        if !pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypeRTF }) {
            return Err("macOS clipboard rejected RTF".to_string());
        }
    }
    Ok(())
}

fn validate_multi_format(payload: &ClipboardMultiFormat) -> Result<(), String> {
    let mut total = 0usize;
    for value in [
        Some(payload.text.as_str()),
        payload.html.as_deref(),
        payload.rtf.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.len() > MAX_FORMAT_BYTES {
            return Err(format!(
                "macOS clipboard format exceeds {MAX_FORMAT_BYTES} byte limit"
            ));
        }
        total = total
            .checked_add(value.len())
            .ok_or_else(|| "macOS clipboard total size overflow".to_string())?;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(format!(
            "macOS clipboard payload exceeds {MAX_TOTAL_BYTES} byte limit"
        ));
    }
    Ok(())
}

pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
    run_osascript(r#"POSIX path of (choose file with prompt "Select private key")"#)
}

pub fn select_upload_file() -> Result<Vec<String>, String> {
    run_osascript_multi(
        r#"POSIX path of (choose file with prompt "Select files to send" with multiple selections allowed)"#,
    )
}

pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
    run_osascript(r#"POSIX path of (choose folder with prompt "Select save directory")"#)
}

pub fn select_folder_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
    run_osascript(r#"POSIX path of (choose folder with prompt "Select folder to open")"#)
}

pub fn select_file_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
    run_osascript(r#"POSIX path of (choose file with prompt "Select file to open")"#)
}

pub fn select_save_file_path(
    default_name: Option<&str>,
    _current_path: Option<&str>,
) -> Result<Option<String>, String> {
    let default = default_name.unwrap_or("capture.png");
    let escaped = default.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"POSIX path of (choose file name with prompt "Save as" default name "{}")"#,
        escaped
    );
    run_osascript(&script)
}

fn run_osascript_multi(script: &str) -> Result<Vec<String>, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("open file dialog: {e}"))?;

    if output.status.success() {
        let raw = String::from_utf8_lossy(&output.stdout);
        // osascript returns comma-separated paths for multiple selections
        let paths: Vec<String> = raw
            .trim_end_matches(&['\r', '\n'][..])
            .split(", ")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        return Ok(paths);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
        Ok(vec![])
    } else {
        Err(format!("open file dialog: {}", stderr.trim()))
    }
}

fn run_osascript(script: &str) -> Result<Option<String>, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("open file dialog: {e}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(&['\r', '\n'][..])
            .to_string();
        return Ok((!path.is_empty()).then_some(path));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
        Ok(None)
    } else {
        Err(format!("open file dialog: {}", stderr.trim()))
    }
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    let script = r#"
use framework "Foundation"
use framework "AppKit"
use scripting additions

set pb to current application's NSPasteboard's generalPasteboard()
set urls to pb's readObjectsForClasses:{current application's NSURL} options:(missing value)
set paths to {}
repeat with u in urls
    if (u's isFileURL()) as boolean then
        set end of paths to (u's |path|()) as text
    end if
end repeat
set AppleScript's text item delimiters to linefeed
return paths as text
"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("macOS clipboard: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("macOS clipboard: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if paths.len() > 256 {
        return Err("macOS file clipboard accepts at most 256 paths".to_string());
    }

    let canonical = paths
        .iter()
        .map(|path| {
            std::fs::canonicalize(path)
                .map_err(|error| format!("macOS file clipboard '{}': {error}", path))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("macOS file clipboard init: {error}"))?;
    clipboard
        .set()
        .file_list(&canonical)
        .map_err(|error| format!("macOS file clipboard write: {error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_clipboard_rejects_missing_and_oversized_path_lists_before_writing() {
        let missing = vec!["/definitely/not/a/taomni/clipboard/file".to_string()];
        assert!(
            super::clipboard_write_files(&missing)
                .unwrap_err()
                .contains("clipboard")
        );

        let oversized = vec!["/tmp/unused".to_string(); 257];
        assert!(
            super::clipboard_write_files(&oversized)
                .unwrap_err()
                .contains("at most 256")
        );
    }
}
