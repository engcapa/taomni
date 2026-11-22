use std::{
    io::{Read, Write},
    time::Duration,
};

use imap::{
    Session,
    extensions::idle::{SetReadTimeout, WaitOutcome},
};

use crate::{imap_sync::imap_has_capability, imap_transport::ImapSession};

// Re-issue IDLE inside the 30-minute server timeout (RFC 2177).
const REFRESH: Duration = Duration::from_secs(25 * 60);

pub fn prepare<T: Read + Write>(session: &mut Session<T>, folder: &str) -> Result<bool, String> {
    if !imap_has_capability(session, "IDLE") {
        return Ok(false);
    }
    session
        .examine(folder)
        .map_err(|error| format!("IMAP EXAMINE {folder} failed: {error}"))?;
    Ok(true)
}

pub fn wait<T: Read + Write + SetReadTimeout>(session: &mut Session<T>) -> Result<bool, String> {
    let mut handle = session
        .idle()
        .map_err(|error| format!("IMAP IDLE failed: {error}"))?;
    handle.set_keepalive(REFRESH);
    handle
        .wait_with_timeout(REFRESH)
        .map(|result| matches!(result, WaitOutcome::MailboxChanged))
        .map_err(|error| format!("IMAP IDLE wait failed: {error}"))
}

impl ImapSession {
    pub fn prepare_idle(&mut self, folder: &str) -> Result<bool, String> {
        match self {
            Self::Plain(session) => prepare(session, folder),
            Self::Tls(session) => prepare(session, folder),
        }
    }

    pub fn idle_changed(&mut self) -> Result<bool, String> {
        match self {
            Self::Plain(session) => wait(session),
            Self::Tls(session) => wait(session),
        }
    }
}
