//! Receive and validate a resumable byte range from IMAP.

use std::io::{Read, Write};

use super::{CHUNK, CONTENT_ERROR};

fn parse_chunk(mut response: &[u8], uid: u32, offset: u64) -> Result<(u64, Vec<u8>), String> {
    use imap_proto::types::{AttributeValue, Response};
    let invalid = |message: String| format!("{CONTENT_ERROR}{message}");
    let mut found = false;
    let mut size = None;
    let mut chunk = None;
    while !response.is_empty() {
        let (rest, value) = imap_proto::parse_response(response)
            .map_err(|e| invalid(format!("Invalid partial FETCH response: {e}")))?;
        response = rest;
        if let Response::Fetch(_, attrs) = value {
            if !attrs
                .iter()
                .any(|v| matches!(v,AttributeValue::Uid(n) if *n==uid))
            {
                continue;
            }
            found = true;
            // Unsolicited flags for the same UID may precede the requested
            // FETCH, and a server may split the requested attributes.
            for attr in attrs {
                match attr {
                    AttributeValue::Rfc822Size(n) => {
                        if size.is_some_and(|old| old != n as u64) {
                            return Err(invalid("IMAP returned conflicting email sizes".into()));
                        }
                        size = Some(n as u64);
                    }
                    AttributeValue::BodySection {
                        section: None,
                        index,
                        data,
                    } => {
                        if chunk.replace((index, data)).is_some() {
                            return Err(invalid("IMAP returned multiple full email chunks".into()));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if !found {
        return Err(format!("MAIL_ARCHIVE_GONE: Email UID {uid} disappeared"));
    }
    let size = size.ok_or_else(|| invalid("IMAP server omitted full email size".into()))?;
    let (origin, data) =
        chunk.ok_or_else(|| invalid("IMAP server omitted full email chunk".into()))?;
    let bytes = data.unwrap_or_default();
    // Some servers omit <0> when the whole message fits, or return NIL at EOF.
    let implicit_origin = origin.is_none() && (offset == 0 || data.is_none());
    if (!implicit_origin && origin.map(u64::from) != Some(offset)) || bytes.len() > CHUNK {
        return Err(invalid(format!(
            "IMAP returned a different byte range at offset {offset}; partial email was preserved without appending"
        )));
    }
    if bytes.is_empty() && offset == 0 {
        return Err(invalid(format!(
            "IMAP returned an empty full email chunk at offset 0 (declared size {size}); no original was saved"
        )));
    }
    // RFC822.SIZE is a progress hint. Some providers calculate it before MIME
    // transformations; the literal/range and an explicit EOF determine length.
    Ok((size, bytes.to_vec()))
}

pub fn fetch_imap_chunk<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    uid: u32,
    offset: u64,
) -> Result<(u32, u64, Vec<u8>), String> {
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder}: {e}"))?;
    let validity = mailbox
        .uid_validity
        .ok_or("IMAP server omitted UIDVALIDITY")?;
    let values = session
        .run_command_and_read_response(format!(
            "UID FETCH {uid} (UID RFC822.SIZE BODY.PEEK[]<{offset}.{CHUNK}>)"
        ))
        .map_err(|e| format!("IMAP full email chunk failed: {e}"))?;
    let (size, bytes) = parse_chunk(&values, uid, offset)?;
    Ok((validity, size, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_fetch_checks_origin_uid_size_and_literal() {
        let ok = b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<3> {3}\r\ndef)\r\n";
        assert_eq!(parse_chunk(ok, 7, 3).unwrap(), (6, b"def".to_vec()));
        assert!(parse_chunk(ok, 7, 0).is_err());
        assert!(parse_chunk(ok, 8, 3).is_err());
        assert!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[] {3}\r\nabc)\r\n",
                7,
                3
            )
            .is_err()
        );
        assert_eq!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<5> {3}\r\nabc)\r\n",
                7,
                5
            )
            .unwrap(),
            (6, b"abc".to_vec())
        );
        assert_eq!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 6 BODY[]<6> {0}\r\n)\r\n",
                7,
                6
            )
            .unwrap(),
            (6, vec![])
        );
        assert_eq!(parse_chunk(b"* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n* 1 FETCH (UID 7 RFC822.SIZE 9)\r\n* 1 FETCH (UID 7 BODY[]<3> {3}\r\ndef)\r\n", 7, 3).unwrap(), (9, b"def".to_vec()));
        assert_eq!(
            parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[] NIL)\r\n", 7, 6).unwrap(),
            (8, vec![])
        );
        assert!(
            parse_chunk(
                b"* 1 FETCH (UID 7 RFC822.SIZE 8 BODY[]<0> {0}\r\n)\r\n",
                7,
                0
            )
            .unwrap_err()
            .contains("offset 0")
        );
        assert!(parse_chunk(b"* 1 FETCH (UID 7 RFC822.SIZE 0 BODY[] NIL)\r\n", 7, 0).is_err());
    }
}
