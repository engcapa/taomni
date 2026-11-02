use anyhow::Context;

/// Native save fields can consume separate Unicode events while Shell
/// autocomplete updates. Paste one complete path through real OS input, then
/// restore the image already copied and checked by the scenario.
pub(super) struct PathPasteboard {
    clipboard: arboard::Clipboard,
    original: Option<arboard::ImageData<'static>>,
}

impl PathPasteboard {
    pub(super) fn new(text: &str) -> anyhow::Result<Self> {
        let mut clipboard = arboard::Clipboard::new().context("open path pasteboard")?;
        let original = clipboard.get_image().context("preserve copied pin image")?;
        let mut board = Self {
            clipboard,
            original: Some(original),
        };
        // Clipboard managers can restore the copied image immediately after
        // staging text. Observe actual readback before sending a single paste;
        // never type into another window or accept a truncated destination.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        #[cfg(target_os = "windows")]
        let mut observations = Vec::new();
        loop {
            board
                .clipboard
                .set_text(text)
                .context("stage folder path")?;
            #[cfg(target_os = "windows")]
            observations.push(windows_clipboard_facts());
            match board.clipboard.get_text() {
                Ok(actual) if actual == text => break,
                result if std::time::Instant::now() >= deadline => {
                    #[cfg(target_os = "windows")]
                    let _ = super::keep_json(
                        &serde_json::json!({"observations":observations,
                        "readback":format!("{result:?}"), "textBytes":text.len()}),
                        "path-pasteboard-failure.json",
                    );
                    anyhow::bail!("OS pasteboard did not retain the exact folder path: {result:?}");
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        }
        Ok(board)
    }

    pub(super) fn restore(&mut self) -> anyhow::Result<()> {
        if let Some(image) = self.original.as_ref() {
            self.clipboard
                .set_image(image.clone())
                .context("restore copied pin image")?;
            self.original = None;
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn windows_clipboard_facts() -> serde_json::Value {
    use winapi::um::winuser::{
        CountClipboardFormats, GetClipboardOwner, GetClipboardSequenceNumber,
        GetOpenClipboardWindow, GetWindowThreadProcessId, IsClipboardFormatAvailable,
    };
    unsafe {
        let owner = GetClipboardOwner();
        let opened = GetOpenClipboardWindow();
        let mut owner_pid = 0;
        let mut opened_pid = 0;
        GetWindowThreadProcessId(owner, &mut owner_pid);
        GetWindowThreadProcessId(opened, &mut opened_pid);
        serde_json::json!({"sequence":GetClipboardSequenceNumber(),"formats":CountClipboardFormats(),
            "unicodeTextAvailable":IsClipboardFormatAvailable(13), "ownerPid":owner_pid,
            "openedPid":opened_pid,"ownPid":std::process::id()})
    }
}

impl Drop for PathPasteboard {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            log::warn!("QA path pasteboard cleanup: {error:#}");
        }
    }
}
