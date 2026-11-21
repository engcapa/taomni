use crate::session::StagingDirectory;
use crate::session::display;
use ironrdp::core::IntoOwned;
use std::fs;
use std::path::PathBuf;
use std::sync::Once;
use taomni_rdp_common::file_transfer::{ensure_private_directory, process_is_alive};

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %self.0.display(),
                    %error,
                    "failed to clean RDP clipboard staging directory"
                );
            }
        }
    }
}

pub(in crate::session) fn clipboard_staging_base() -> PathBuf {
    #[cfg(unix)]
    let name = format!("taomni-rdp-cliprdr-{}", unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let name = "taomni-rdp-cliprdr".to_string();
    std::env::temp_dir().join(name)
}

pub(in crate::session) fn clipboard_process_staging_root() -> PathBuf {
    clipboard_staging_base().join(format!("process-{}", std::process::id()))
}

pub(in crate::session) fn cleanup_stale_clipboard_staging() {
    static CLEANUP: Once = Once::new();
    CLEANUP.call_once(|| {
        let base = clipboard_staging_base();
        if let Err(error) = ensure_private_directory(&base) {
            tracing::warn!(path = %base.display(), %error, "failed to create RDP clipboard staging root");
            return;
        }
        if let Err(error) = ensure_private_directory(&clipboard_process_staging_root()) {
            tracing::warn!(%error, "failed to create private RDP clipboard process directory");
            return;
        }
        let Ok(entries) = fs::read_dir(&base) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == clipboard_process_staging_root() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = if let Some(pid) = name
                .strip_prefix("process-")
                .and_then(|value| value.parse::<u32>().ok())
            {
                !process_is_alive(pid)
            } else {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(24 * 60 * 60))
            };
            if stale {
                let result = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
                if let Err(error) = result {
                    tracing::warn!(path = %path.display(), %error, "failed to remove stale RDP clipboard staging path");
                }
            }
        }
    });
}
