use std::time::Duration;

/// Messages downloaded per sync call; the tab repeats while `more`.
pub(in crate::mail) const POP3_FETCH_BATCH: usize = 50;
pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Local folders every POP3 account has, with their SPECIAL-USE attribute.
pub(super) const LOCAL_FOLDERS: [(&str, &str); 5] = [
    ("INBOX", ""),
    ("Sent", "\\Sent"),
    ("Drafts", "\\Drafts"),
    ("Trash", "\\Trash"),
    ("Junk", "\\Junk"),
];
