pub(super) use taomni_mail_engine::archive::{CHUNK, CONTENT_ERROR};
pub(super) const ARCHIVE_BATCH: usize = 100;

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
