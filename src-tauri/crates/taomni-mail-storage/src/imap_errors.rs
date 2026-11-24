//! Handle transport failures consistently for the client and host.

use std::panic::{AssertUnwindSafe, catch_unwind};

/// Discard a session after the IMAP library detects an out-of-sequence reply.
pub fn imap_catch_result<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(_) => Err("IMAP protocol desync".into()),
    }
}

pub fn is_imap_transport_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("connection")
        || message.contains("broken pipe")
        || message.contains("reset")
        || message.contains("timed out")
        || message.contains("timeout")
        || message.contains("eof")
        || message.contains("not connected")
        || message.contains("noop failed")
        || message.contains("tls")
        || message.contains("i/o")
        || message.contains("io error")
        || message.contains("protocol desync")
        || message.contains("desync")
}
