//! Read-only TLS ClientHello SNI extraction (no MITM).

/// Extract SNI hostname from a TLS record that begins with a ClientHello.
///
/// Expects `data` to start at the TLS record header (`0x16 0x03 …`).
/// Returns `None` if the buffer is incomplete or not a ClientHello with SNI.
pub fn extract_sni(data: &[u8]) -> Option<String> {
    // TLS record: type(1)=22, version(2), length(2), handshake…
    if data.len() < 5 || data[0] != 0x16 {
        return None;
    }
    let rec_len = u16::from_be_bytes([data[3], data[4]]) as usize;
    if data.len() < 5 + rec_len {
        // Allow partial if we still have handshake header.
        if data.len() < 9 {
            return None;
        }
    }
    let hs = &data[5..];
    // HandshakeType client_hello = 1, length u24
    if hs.len() < 4 || hs[0] != 0x01 {
        return None;
    }
    let hs_len = ((hs[1] as usize) << 16) | ((hs[2] as usize) << 8) | (hs[3] as usize);
    if hs.len() < 4 + hs_len.min(hs.len().saturating_sub(4)) {
        // Continue with what we have.
    }
    let mut i = 4;
    // client_version(2) + random(32)
    if hs.len() < i + 34 {
        return None;
    }
    i += 34;
    // session_id
    if hs.len() < i + 1 {
        return None;
    }
    let sid_len = hs[i] as usize;
    i += 1 + sid_len;
    // cipher_suites
    if hs.len() < i + 2 {
        return None;
    }
    let cs_len = u16::from_be_bytes([hs[i], hs[i + 1]]) as usize;
    i += 2 + cs_len;
    // compression
    if hs.len() < i + 1 {
        return None;
    }
    let comp_len = hs[i] as usize;
    i += 1 + comp_len;
    // extensions
    if hs.len() < i + 2 {
        return None;
    }
    let ext_total = u16::from_be_bytes([hs[i], hs[i + 1]]) as usize;
    i += 2;
    let ext_end = (i + ext_total).min(hs.len());
    while i + 4 <= ext_end {
        let ext_type = u16::from_be_bytes([hs[i], hs[i + 1]]);
        let ext_len = u16::from_be_bytes([hs[i + 2], hs[i + 3]]) as usize;
        i += 4;
        if i + ext_len > ext_end {
            break;
        }
        if ext_type == 0 {
            // server_name
            return parse_sni_extension(&hs[i..i + ext_len]);
        }
        i += ext_len;
    }
    None
}

fn parse_sni_extension(ext: &[u8]) -> Option<String> {
    if ext.len() < 2 {
        return None;
    }
    let list_len = u16::from_be_bytes([ext[0], ext[1]]) as usize;
    let mut i = 2;
    let end = (2 + list_len).min(ext.len());
    while i + 3 <= end {
        let name_type = ext[i];
        let name_len = u16::from_be_bytes([ext[i + 1], ext[i + 2]]) as usize;
        i += 3;
        if i + name_len > end {
            break;
        }
        if name_type == 0 {
            let name = std::str::from_utf8(&ext[i..i + name_len]).ok()?;
            let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
            if !name.is_empty() {
                return Some(name);
            }
        }
        i += name_len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal synthetic ClientHello with SNI = "example.com"
    fn client_hello_with_sni(host: &str) -> Vec<u8> {
        let host_b = host.as_bytes();
        // server_name extension body: list_len + type0 + name_len + name
        let mut sni_body = Vec::new();
        let name_entry_len = 1 + 2 + host_b.len();
        sni_body.extend_from_slice(&(name_entry_len as u16).to_be_bytes());
        sni_body.push(0); // host_name
        sni_body.extend_from_slice(&(host_b.len() as u16).to_be_bytes());
        sni_body.extend_from_slice(host_b);

        let mut exts = Vec::new();
        exts.extend_from_slice(&0u16.to_be_bytes()); // type server_name
        exts.extend_from_slice(&(sni_body.len() as u16).to_be_bytes());
        exts.extend_from_slice(&sni_body);

        let mut hs = Vec::new();
        hs.push(0x01); // client_hello
        // length placeholder
        hs.extend_from_slice(&[0, 0, 0]);
        hs.extend_from_slice(&[0x03, 0x03]); // version
        hs.extend_from_slice(&[0u8; 32]); // random
        hs.push(0); // session id len
        hs.extend_from_slice(&2u16.to_be_bytes()); // cipher len
        hs.extend_from_slice(&[0x00, 0x2f]); // TLS_RSA_WITH_AES_128_CBC_SHA
        hs.push(1); // compression len
        hs.push(0);
        hs.extend_from_slice(&(exts.len() as u16).to_be_bytes());
        hs.extend_from_slice(&exts);
        let hs_body_len = hs.len() - 4;
        hs[1] = ((hs_body_len >> 16) & 0xff) as u8;
        hs[2] = ((hs_body_len >> 8) & 0xff) as u8;
        hs[3] = (hs_body_len & 0xff) as u8;

        let mut rec = Vec::new();
        rec.push(0x16);
        rec.extend_from_slice(&[0x03, 0x01]);
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn extracts_example_com() {
        let pkt = client_hello_with_sni("example.com");
        assert_eq!(extract_sni(&pkt).as_deref(), Some("example.com"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(extract_sni(b"hello").is_none());
        assert!(extract_sni(&[0x16, 0x03, 0x01, 0, 1, 0]).is_none());
    }
}
