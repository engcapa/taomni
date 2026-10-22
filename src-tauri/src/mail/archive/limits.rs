pub(super) const CHUNK: usize = 256 * 1024;
pub(super) const ARCHIVE_BATCH: usize = 100;
pub(super) const CONTENT_ERROR: &str = "MAIL_ARCHIVE_CONTENT: ";

#[derive(Default)]
pub(super) struct ContentFailures {
    pub(super) count: usize,
    pub(super) first: Option<String>,
}

impl ContentFailures {
    pub(super) fn message(&self) -> String {
        format!(
            "{} email(s) could not be saved; other readable messages were processed. First failure: {}. Retry to retry incomplete originals",
            self.count,
            self.first.as_deref().unwrap_or("unknown")
        )
    }
}
