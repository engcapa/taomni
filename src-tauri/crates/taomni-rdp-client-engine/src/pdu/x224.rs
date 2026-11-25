//! ITU-T X.224 Class 0 connection PDUs as carried inside TPKT.
//!
//! Used during the RDP handshake:
//!
//! - **Connection Request** (TPDU code 0xE0) — client → server. Carries
//!   the optional `Cookie: mstshash=…` ASCII routing token plus the RDP
//!   Negotiation Request structure.
//! - **Connection Confirm** (TPDU code 0xD0) — server → client. Carries
//!   the RDP Negotiation Response or Negotiation Failure.
//! - **Data PDU** (TPDU code 0xF0) — both directions, used after the
//!   handshake to wrap MCS / data payloads.
//!
//! See ITU-T Rec. X.224 §13.3 and MS-RDPBCGR §2.2.1.1.

const TPDU_CR: u8 = 0xE0; // Connection Request
const TPDU_CC: u8 = 0xD0; // Connection Confirm
const TPDU_DT: u8 = 0xF0; // Data
const TPDU_ER: u8 = 0xC0; // Error / Disconnect

/// Header length octet for a Class 0 CR/CC TPDU, *not counting* this byte
/// or the routing/negotiation payload.
const FIXED_HEADER_LEN: u8 = 6;

/// Build an X.224 Connection Request TPDU (without the TPKT header).
///
/// `cookie` may be a `mstshash=<user>` style routing token. RDP Negotiation
/// data (if any) follows the cookie + `\r\n`.
pub fn build_connection_request(cookie: Option<&str>, nego_data: &[u8]) -> Vec<u8> {
    let mut variable: Vec<u8> = Vec::new();
    if let Some(c) = cookie {
        variable.extend_from_slice(b"Cookie: ");
        variable.extend_from_slice(c.as_bytes());
        variable.extend_from_slice(b"\r\n");
    }
    variable.extend_from_slice(nego_data);

    let mut out = Vec::with_capacity(7 + variable.len());
    let li = (FIXED_HEADER_LEN as usize + variable.len()) as u8;
    out.push(li);
    out.push(TPDU_CR);
    out.extend_from_slice(&[0, 0]); // dst-ref
    out.extend_from_slice(&[0, 0]); // src-ref
    out.push(0); // class option
    out.extend_from_slice(&variable);
    out
}

/// Parsed X.224 Connection Confirm payload — only the variable part is
/// returned. The caller will typically pass it on to
/// [`super::nego::parse_negotiation_response`].
#[derive(Debug)]
pub struct ConnectionConfirm<'a> {
    pub variable: &'a [u8],
}

/// Parse a Connection Confirm TPDU (the bytes *after* the TPKT header).
pub fn parse_connection_confirm(buf: &[u8]) -> Result<ConnectionConfirm<'_>, String> {
    if buf.len() < 7 {
        return Err("X.224 CC truncated".into());
    }
    let li = buf[0] as usize;
    if li + 1 > buf.len() {
        return Err(format!(
            "X.224 CC: length-indicator {} exceeds buffer ({})",
            li,
            buf.len()
        ));
    }
    if buf[1] != TPDU_CC {
        return Err(format!("X.224 CC: unexpected TPDU code 0x{:02x}", buf[1]));
    }
    // li counts the bytes following the LI byte itself, so total header
    // length = li + 1. The variable part starts after the 7-byte fixed
    // header, but the LI accounts for everything past byte 0.
    let header_total = li + 1;
    if header_total < 7 {
        return Err("X.224 CC: header too short".into());
    }
    let variable_start = 7usize;
    let variable_end = header_total.max(variable_start);
    if variable_end > buf.len() {
        return Err("X.224 CC: variable section past buffer".into());
    }
    Ok(ConnectionConfirm {
        variable: &buf[variable_start..variable_end],
    })
}

/// Build the 3-byte Data TPDU header used after the handshake. The MCS or
/// security payload follows directly. Header layout:
///   LI=02  TPDU=0xF0  EOT=0x80
pub fn build_data_header() -> [u8; 3] {
    [0x02, TPDU_DT, 0x80]
}

/// Parse a Data TPDU header. Returns the offset within `buf` at which the
/// payload begins.
pub fn parse_data_header(buf: &[u8]) -> Result<usize, String> {
    if buf.len() < 3 {
        return Err("X.224 DT truncated".into());
    }
    if buf[1] != TPDU_DT {
        return Err(format!("X.224 DT: unexpected TPDU code 0x{:02x}", buf[1]));
    }
    let li = buf[0] as usize;
    Ok(li + 1)
}

/// True when the byte immediately after the TPKT header announces an
/// X.224 Error / Disconnect TPDU.
pub fn is_error_tpdu(buf: &[u8]) -> bool {
    buf.get(1).copied() == Some(TPDU_ER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cr_with_cookie_round_trip() {
        let nego = vec![0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00];
        let cr = build_connection_request(Some("mstshash=alice"), &nego);
        assert_eq!(cr[1], TPDU_CR);
        // length-indicator = total - 1
        assert_eq!(cr[0] as usize, cr.len() - 1);
        // Cookie must precede the negotiation bytes.
        let s = std::str::from_utf8(&cr[7..]).unwrap();
        assert!(s.starts_with("Cookie: mstshash=alice\r\n"));
        assert!(cr.ends_with(&nego[..]));
    }

    #[test]
    fn cr_without_cookie_carries_only_nego() {
        let nego = vec![0xff; 8];
        let cr = build_connection_request(None, &nego);
        assert_eq!(&cr[7..], &nego[..]);
    }

    #[test]
    fn cc_parse_extracts_variable() {
        // Fixed header is 7 bytes; LI counts everything after byte 0, so
        // for a 7-byte header + 8-byte variable: LI = 7 + 8 - 1 = 14.
        let mut cc = vec![0x0e, TPDU_CC];
        cc.extend_from_slice(&[0, 0, 0x12, 0x34, 0]); // dst, src, class
        cc.extend_from_slice(&[0x02, 0x00, 0x08, 0x00, 1, 0, 0, 0]); // 8-byte response
        let parsed = parse_connection_confirm(&cc).unwrap();
        assert_eq!(parsed.variable.len(), 8);
        assert_eq!(parsed.variable[0], 0x02);
    }

    #[test]
    fn cc_parse_rejects_wrong_tpdu() {
        let bad = vec![0x06, 0xAA, 0, 0, 0, 0, 0];
        assert!(parse_connection_confirm(&bad).is_err());
    }

    #[test]
    fn data_header_round_trip() {
        let h = build_data_header();
        assert_eq!(h, [0x02, TPDU_DT, 0x80]);
        let off = parse_data_header(&h).unwrap();
        assert_eq!(off, 3);
    }

    #[test]
    fn error_tpdu_detected() {
        let buf = [0x05, TPDU_ER, 0, 0, 0, 0];
        assert!(is_error_tpdu(&buf));
        let buf2 = [0x06, TPDU_CC, 0, 0, 0, 0];
        assert!(!is_error_tpdu(&buf2));
    }
}
