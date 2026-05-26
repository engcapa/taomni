//! MCS (Multipoint Communication Service, T.125) layer used after
//! the X.224 + Negotiation handshake completes.
//!
//! What's implemented and unit-tested:
//!
//! - The minimal subset of PER encoding helpers needed for MCS PDUs.
//! - `Erect Domain Request`, `Attach User Request/Confirm`,
//!   `Channel Join Request/Confirm`, `Send Data Request/Indication`.
//!
//! Higher-level PDUs (Connect-Initial, Confirm Active, capability sets)
//! land in [`crate::rdp::session`] when the IronRDP integration replaces
//! the placeholder driver.

/// MCS PDU choice tags (top 6 bits of the first PER byte).
pub const PDU_ERECT_DOMAIN_REQUEST: u8 = 1;
pub const PDU_DISCONNECT_PROVIDER_ULTIMATUM: u8 = 8;
pub const PDU_ATTACH_USER_REQUEST: u8 = 10;
pub const PDU_ATTACH_USER_CONFIRM: u8 = 11;
pub const PDU_CHANNEL_JOIN_REQUEST: u8 = 14;
pub const PDU_CHANNEL_JOIN_CONFIRM: u8 = 15;
pub const PDU_SEND_DATA_REQUEST: u8 = 25;
pub const PDU_SEND_DATA_INDICATION: u8 = 26;

pub fn encode_choice(pdu: u8) -> u8 {
    pdu << 2
}

pub fn decode_choice(byte: u8) -> u8 {
    byte >> 2
}

pub fn build_attach_user_request() -> Vec<u8> {
    vec![encode_choice(PDU_ATTACH_USER_REQUEST)]
}

pub fn build_erect_domain_request(sub_height: u32, sub_interval: u32) -> Vec<u8> {
    let mut out = vec![encode_choice(PDU_ERECT_DOMAIN_REQUEST)];
    encode_per_int(&mut out, sub_height);
    encode_per_int(&mut out, sub_interval);
    out
}

pub fn build_channel_join_request(initiator: u16, channel_id: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(5);
    out.push(encode_choice(PDU_CHANNEL_JOIN_REQUEST));
    out.extend_from_slice(&initiator.to_be_bytes());
    out.extend_from_slice(&channel_id.to_be_bytes());
    out
}

pub fn parse_attach_user_confirm(buf: &[u8]) -> Result<u16, String> {
    if buf.len() < 4 {
        return Err(format!("AUC: {} bytes < 4", buf.len()));
    }
    if decode_choice(buf[0]) != PDU_ATTACH_USER_CONFIRM {
        return Err(format!("AUC: unexpected choice 0x{:02x}", buf[0] >> 2));
    }
    if buf[1] != 0 {
        return Err(format!("AUC: result {} != 0 (rt-successful)", buf[1]));
    }
    Ok(u16::from_be_bytes([buf[2], buf[3]]))
}

pub fn parse_channel_join_confirm(buf: &[u8]) -> Result<u16, String> {
    if buf.len() < 6 {
        return Err(format!("CJC: {} bytes < 6", buf.len()));
    }
    if decode_choice(buf[0]) != PDU_CHANNEL_JOIN_CONFIRM {
        return Err(format!("CJC: unexpected choice 0x{:02x}", buf[0] >> 2));
    }
    if buf[1] != 0 {
        return Err(format!("CJC: result {} != 0", buf[1]));
    }
    Ok(u16::from_be_bytes([buf[4], buf[5]]))
}

pub fn build_send_data_request_header(
    initiator: u16,
    channel_id: u16,
    payload_len: usize,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(8);
    out.push(encode_choice(PDU_SEND_DATA_REQUEST));
    out.extend_from_slice(&initiator.to_be_bytes());
    out.extend_from_slice(&channel_id.to_be_bytes());
    out.push(0x70); // priority=high (0b01), segmentation last|first (0b11)
    encode_per_length(&mut out, payload_len);
    out
}

pub fn parse_send_data_indication(buf: &[u8]) -> Result<(u16, u16, usize), String> {
    if buf.len() < 7 {
        return Err(format!("SDI: {} bytes < 7", buf.len()));
    }
    if decode_choice(buf[0]) != PDU_SEND_DATA_INDICATION {
        return Err(format!("SDI: unexpected choice 0x{:02x}", buf[0] >> 2));
    }
    let initiator = u16::from_be_bytes([buf[1], buf[2]]);
    let channel_id = u16::from_be_bytes([buf[3], buf[4]]);
    let (length, consumed) = decode_per_length(&buf[6..])?;
    let payload_off = 6 + consumed;
    if payload_off + length > buf.len() {
        return Err(format!(
            "SDI: declared length {} > remaining {}",
            length,
            buf.len().saturating_sub(payload_off),
        ));
    }
    Ok((initiator, channel_id, payload_off))
}

fn encode_per_int(out: &mut Vec<u8>, value: u32) {
    if value <= 0xff {
        out.push(0x01);
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(0x02);
        out.extend_from_slice(&(value as u16).to_be_bytes());
    } else {
        out.push(0x04);
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn encode_per_length(out: &mut Vec<u8>, length: usize) {
    if length < 0x80 {
        out.push(length as u8);
    } else if length < 0x4000 {
        let high = ((length >> 8) as u8) | 0x80;
        out.push(high);
        out.push((length & 0xff) as u8);
    } else {
        out.push(0xC2);
        out.extend_from_slice(&((length as u16).to_be_bytes()));
    }
}

fn decode_per_length(buf: &[u8]) -> Result<(usize, usize), String> {
    if buf.is_empty() {
        return Err("PER length: empty buffer".into());
    }
    let first = buf[0];
    if first & 0x80 == 0 {
        Ok((first as usize, 1))
    } else if first & 0xC0 == 0x80 {
        if buf.len() < 2 {
            return Err("PER length: 2-byte form truncated".into());
        }
        let len = (((first & 0x3f) as usize) << 8) | buf[1] as usize;
        Ok((len, 2))
    } else {
        Err(format!("PER length: unsupported initial byte 0x{:02x}", first))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_round_trip() {
        for tag in [
            PDU_ATTACH_USER_REQUEST,
            PDU_CHANNEL_JOIN_REQUEST,
            PDU_SEND_DATA_REQUEST,
            PDU_DISCONNECT_PROVIDER_ULTIMATUM,
        ] {
            assert_eq!(decode_choice(encode_choice(tag)), tag);
        }
    }

    #[test]
    fn attach_user_request_is_single_byte() {
        let buf = build_attach_user_request();
        assert_eq!(buf.len(), 1);
        assert_eq!(decode_choice(buf[0]), PDU_ATTACH_USER_REQUEST);
    }

    #[test]
    fn erect_domain_request_round_trip() {
        let buf = build_erect_domain_request(0, 0);
        assert_eq!(buf[0] >> 2, PDU_ERECT_DOMAIN_REQUEST);
        assert_eq!(&buf[1..], &[0x01, 0, 0x01, 0]);
    }

    #[test]
    fn channel_join_request_layout() {
        let buf = build_channel_join_request(1001, 1003);
        assert_eq!(buf.len(), 5);
        assert_eq!(decode_choice(buf[0]), PDU_CHANNEL_JOIN_REQUEST);
        assert_eq!(u16::from_be_bytes([buf[1], buf[2]]), 1001);
        assert_eq!(u16::from_be_bytes([buf[3], buf[4]]), 1003);
    }

    #[test]
    fn parse_attach_user_confirm_extracts_user_id() {
        let buf = [encode_choice(PDU_ATTACH_USER_CONFIRM), 0x00, 0x03, 0xE9];
        assert_eq!(parse_attach_user_confirm(&buf).unwrap(), 1001);
    }

    #[test]
    fn parse_attach_user_confirm_rejects_failure_result() {
        let buf = [encode_choice(PDU_ATTACH_USER_CONFIRM), 0x05, 0, 0];
        assert!(parse_attach_user_confirm(&buf).is_err());
    }

    #[test]
    fn parse_channel_join_confirm_returns_granted_channel() {
        let buf = [
            encode_choice(PDU_CHANNEL_JOIN_CONFIRM),
            0,
            0x03, 0xE9,
            0x03, 0xEB,
        ];
        assert_eq!(parse_channel_join_confirm(&buf).unwrap(), 1003);
    }

    #[test]
    fn send_data_request_header_round_trip() {
        let header = build_send_data_request_header(1001, 1003, 0x10);
        // 1 (choice) + 2 (initiator) + 2 (channel) + 1 (priority) + 1 (PER short-length) = 7
        assert_eq!(header.len(), 7);
        assert_eq!(decode_choice(header[0]), PDU_SEND_DATA_REQUEST);
        assert_eq!(u16::from_be_bytes([header[1], header[2]]), 1001);
        assert_eq!(u16::from_be_bytes([header[3], header[4]]), 1003);
        assert_eq!(header[5], 0x70);
        assert_eq!(header[6], 0x10);
    }

    #[test]
    fn send_data_indication_parser() {
        let mut buf = vec![encode_choice(PDU_SEND_DATA_INDICATION)];
        buf.extend_from_slice(&1001u16.to_be_bytes());
        buf.extend_from_slice(&1003u16.to_be_bytes());
        buf.push(0x70);
        buf.push(0x05);
        buf.extend_from_slice(&[1, 2, 3, 4, 5]);
        let (init, ch, off) = parse_send_data_indication(&buf).unwrap();
        assert_eq!(init, 1001);
        assert_eq!(ch, 1003);
        assert_eq!(&buf[off..], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn send_data_indication_rejects_truncated_payload() {
        let mut buf = vec![encode_choice(PDU_SEND_DATA_INDICATION)];
        buf.extend_from_slice(&1001u16.to_be_bytes());
        buf.extend_from_slice(&1003u16.to_be_bytes());
        buf.push(0x70);
        buf.push(0xFF);
        buf.extend_from_slice(&[1, 2, 3]);
        assert!(parse_send_data_indication(&buf).is_err());
    }

    #[test]
    fn per_length_short_form() {
        let mut out = Vec::new();
        encode_per_length(&mut out, 100);
        assert_eq!(out, vec![100]);
        let (len, consumed) = decode_per_length(&[100]).unwrap();
        assert_eq!((len, consumed), (100, 1));
    }

    #[test]
    fn per_length_two_byte_form() {
        let mut out = Vec::new();
        encode_per_length(&mut out, 0x100);
        assert_eq!(out, vec![0x81, 0x00]);
        let (len, consumed) = decode_per_length(&[0x81, 0x00]).unwrap();
        assert_eq!((len, consumed), (0x100, 2));
    }

    #[test]
    fn per_length_decoder_rejects_invalid() {
        assert!(decode_per_length(&[]).is_err());
        assert!(decode_per_length(&[0xC2, 0, 0]).is_err());
    }
}
