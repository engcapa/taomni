//! Decode fetched MIME sections and attachment names without an IMAP connection.

use mail_parser::MessageParser;

/// Upper bound for one decoded text section shown in the reader.
const TEXT_SECTION_MAX: usize = 8 * 1024 * 1024;

/// RFC 2047 encoded-words in BODYSTRUCTURE names (`=?utf-8?B?...?=`).
pub fn decode_words(value: &str) -> String {
    if !value.contains("=?") {
        return value.to_string();
    }
    let raw = format!("Subject: {value}\r\n\r\n");
    MessageParser::default()
        .parse(raw.as_bytes())
        .and_then(|message| message.subject().map(str::to_string))
        .unwrap_or_else(|| value.to_string())
}

/// Decode one fetched section using its `.MIME` header (charset and
/// transfer encoding) by parsing it as a single-part message.
pub fn decode_section(mime_header: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let mut raw = Vec::with_capacity(mime_header.len() + data.len() + 4);
    raw.extend_from_slice(mime_header);
    if !mime_header.ends_with(b"\r\n\r\n") && !mime_header.ends_with(b"\n\n") {
        raw.extend_from_slice(b"\r\n");
    }
    raw.extend_from_slice(data);
    let message = MessageParser::default().parse(&raw)?;
    let part = message.parts.first()?;
    Some(part.contents().to_vec())
}

pub fn decode_text_section(mime_header: &[u8], data: &[u8], html: bool) -> Option<String> {
    let mut raw = Vec::with_capacity(mime_header.len() + data.len() + 4);
    raw.extend_from_slice(mime_header);
    if !mime_header.ends_with(b"\r\n\r\n") && !mime_header.ends_with(b"\n\n") {
        raw.extend_from_slice(b"\r\n");
    }
    raw.extend_from_slice(data);
    let message = MessageParser::default().parse(&raw)?;
    let text = if html {
        message.body_html(0)?.to_string()
    } else {
        message.body_text(0)?.to_string()
    };
    Some(crate::truncate_utf8_bytes(&text, TEXT_SECTION_MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_sections_with_their_mime_header() {
        let mime =
            b"Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n";
        let html = decode_text_section(mime, b"PGI+aGk8L2I+", true).unwrap();
        assert_eq!(html, "<b>hi</b>");
        let qp = b"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n";
        assert_eq!(
            decode_text_section(qp, b"caf=C3=A9", false).unwrap(),
            "caf\u{e9}"
        );
        let bin =
            b"Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n";
        assert_eq!(decode_section(bin, b"AAEC").unwrap(), vec![0, 1, 2]);
    }
}
