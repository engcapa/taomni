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
        board
            .clipboard
            .set_text(text)
            .context("stage folder path")?;
        anyhow::ensure!(
            board
                .clipboard
                .get_text()
                .context("read staged folder path")?
                == text,
            "OS pasteboard did not retain the requested folder path"
        );
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

impl Drop for PathPasteboard {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            log::warn!("QA path pasteboard cleanup: {error:#}");
        }
    }
}
