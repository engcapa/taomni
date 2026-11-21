//! RFC 1006 TPKT (Transport Protocol Data Unit) framing.
//!
//! Every RDP PDU sent over a TCP transport is wrapped in a 4-byte TPKT
//! header so X.224 (which is normally session-oriented over a network
//! that has its own framing) can ride on top of stream-oriented TCP.
//!
//! ```text
//! 0                   1                   2                   3
//! 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |  version (3)  |   reserved    |       length (incl header)    |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |                          payload …                            |
//! ```
//!
//! Maximum total length is 65535; the version byte is always 3 for X.224.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const TPKT_HEADER_LEN: usize = 4;
pub const TPKT_VERSION: u8 = 3;

/// Maximum TPKT total length (header + payload).
pub const TPKT_MAX_LEN: usize = u16::MAX as usize;

/// Encode `payload` with a TPKT header. The returned vec includes both.
pub fn encode(payload: &[u8]) -> Result<Vec<u8>, String> {
    let total = payload.len() + TPKT_HEADER_LEN;
    if total > TPKT_MAX_LEN {
        return Err(format!("TPKT payload too large: {} bytes", payload.len()));
    }
    let mut out = Vec::with_capacity(total);
    out.push(TPKT_VERSION);
    out.push(0); // reserved
    out.extend_from_slice(&(total as u16).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Parse a TPKT header. Returns the total length advertised in the header.
pub fn parse_header(buf: &[u8]) -> Result<usize, String> {
    if buf.len() < TPKT_HEADER_LEN {
        return Err("TPKT header truncated".into());
    }
    if buf[0] != TPKT_VERSION {
        return Err(format!("TPKT bad version: {}", buf[0]));
    }
    let total = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    if total < TPKT_HEADER_LEN {
        return Err(format!("TPKT length {} too small for header", total));
    }
    Ok(total)
}

/// Read one full TPKT message (header + payload) from `stream`. Returns the
/// payload bytes only (the header is consumed).
pub async fn read_message<R: AsyncRead + Unpin>(stream: &mut R) -> Result<Vec<u8>, String> {
    let mut head = [0u8; TPKT_HEADER_LEN];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("tpkt: read header: {}", e))?;
    let total = parse_header(&head)?;
    let payload_len = total - TPKT_HEADER_LEN;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        stream
            .read_exact(&mut payload)
            .await
            .map_err(|e| format!("tpkt: read payload: {}", e))?;
    }
    Ok(payload)
}

/// Write `payload` framed in a TPKT header to `stream`.
pub async fn write_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    payload: &[u8],
) -> Result<(), String> {
    let bytes = encode(payload)?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|e| format!("tpkt: write: {}", e))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("tpkt: flush: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn encode_round_trip() {
        let payload = vec![0xde, 0xad, 0xbe, 0xef];
        let framed = encode(&payload).unwrap();
        assert_eq!(framed[0], TPKT_VERSION);
        assert_eq!(framed[1], 0);
        let total = u16::from_be_bytes([framed[2], framed[3]]) as usize;
        assert_eq!(total, payload.len() + TPKT_HEADER_LEN);
        assert_eq!(&framed[TPKT_HEADER_LEN..], &payload[..]);
    }

    #[test]
    fn parse_rejects_bad_version() {
        let bad = [4, 0, 0, 4];
        assert!(parse_header(&bad).is_err());
    }

    #[test]
    fn parse_rejects_short_length() {
        let bad = [3, 0, 0, 3];
        assert!(parse_header(&bad).is_err());
    }

    #[test]
    fn encode_rejects_oversize() {
        let big = vec![0u8; TPKT_MAX_LEN]; // exceeds with header
        assert!(encode(&big).is_err());
    }

    #[tokio::test]
    async fn round_trip_through_cursor() {
        let payload = b"hello rdp".to_vec();
        let framed = encode(&payload).unwrap();
        let mut rdr = Cursor::new(framed);
        let got = read_message(&mut rdr).await.unwrap();
        assert_eq!(got, payload);
    }
}
