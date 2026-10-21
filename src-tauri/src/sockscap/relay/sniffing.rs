use crate::sockscap::rules::sni::extract_hostname_from_prefix;
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;

/// Ports whose protocol has the **server** greet first.
///
/// On these the client will not send anything until it has heard from the
/// server, so waiting for a client hello cannot succeed — it only adds its full
/// budget to the latency of every such connection, and the server cannot greet
/// because we have not dialled it yet. Deliberately conservative: implicit-TLS
/// mail ports (465/993/995) are *client*-first and stay out, as do Postgres,
/// Redis, Mongo and Oracle.
pub(super) fn server_speaks_first(port: u16) -> bool {
    matches!(
        port,
        21    // FTP control
        | 22  // SSH
        | 23  // Telnet
        | 25  // SMTP
        | 110 // POP3
        | 143 // IMAP
        | 3306 // MySQL
    )
}

/// Read until we extract a hostname, TLS record is complete, or budget exhausted.
pub(super) async fn peek_for_hostname<S>(
    client: &mut S,
    dest_port: u16,
    budget: Duration,
) -> (Vec<u8>, Option<String>)
where
    S: AsyncRead + Unpin,
{
    use std::time::Instant;
    if server_speaks_first(dest_port) {
        return (Vec::new(), None);
    }
    let deadline = Instant::now() + budget;
    let mut prefix: Vec<u8> = Vec::new();
    while Instant::now() < deadline && prefix.len() < 16 * 1024 {
        if let Some(h) = extract_hostname_from_prefix(&prefix) {
            return (prefix, Some(h));
        }
        // TLS: wait for full record if we can see the length.
        if prefix.len() >= 5 && prefix[0] == 0x16 {
            let rec_len = u16::from_be_bytes([prefix[3], prefix[4]]) as usize;
            if prefix.len() >= 5 + rec_len {
                break;
            }
        } else if prefix.len() >= 32 {
            // Not TLS and no Host yet — stop waiting.
            if extract_hostname_from_prefix(&prefix).is_none()
                && !looks_like_incomplete_http(&prefix)
            {
                break;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut buf = vec![0u8; 2048];
        match tokio::time::timeout(remaining, client.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => prefix.extend_from_slice(&buf[..n]),
            _ => break,
        }
    }
    let host = extract_hostname_from_prefix(&prefix);
    (prefix, host)
}

pub(super) fn looks_like_incomplete_http(data: &[u8]) -> bool {
    if data.is_empty() || data[0] == 0x16 {
        return false;
    }
    let Ok(s) = std::str::from_utf8(data) else {
        return false;
    };
    let upper = s.to_ascii_uppercase();
    (upper.starts_with("GET ")
        || upper.starts_with("POST ")
        || upper.starts_with("HEAD ")
        || upper.starts_with("CONNECT "))
        && !s.contains("\r\n\r\n")
}
