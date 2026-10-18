//! Bounded MIME header inspection alongside streaming compression.
use mail_parser::{MessageParser, MimeHeaders};

pub(super) struct AttachmentScan {
    line: Vec<u8>,
    headers: Vec<u8>,
    boundaries: Vec<Vec<u8>>,
    in_headers: bool,
    overflow: bool,
    pub found: bool,
}
impl Default for AttachmentScan {
    fn default() -> Self {
        Self {
            line: Vec::new(),
            headers: Vec::new(),
            boundaries: Vec::new(),
            in_headers: true,
            overflow: false,
            found: false,
        }
    }
}
impl AttachmentScan {
    pub fn feed(&mut self, bytes: &[u8]) {
        if self.found {
            return;
        }
        for &byte in bytes {
            if byte == b'\n' {
                self.finish_line();
                self.line.clear();
                self.overflow = false;
                if self.found {
                    return;
                }
            } else if self.line.len() < 65536 {
                self.line.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }
    fn finish_line(&mut self) {
        let line = self.line.strip_suffix(b"\r").unwrap_or(&self.line);
        if !self.overflow && self.boundaries.iter().any(|b| line == b.as_slice()) {
            self.in_headers = true;
            self.headers.clear();
            return;
        }
        if !self.in_headers {
            return;
        }
        if line.is_empty() {
            self.headers.extend_from_slice(b"\r\n");
            if let Some(message) = MessageParser::default().parse_headers(&self.headers) {
                self.found = message.attachment_name().is_some()
                    || message
                        .content_disposition()
                        .is_some_and(|d| d.c_type.eq_ignore_ascii_case("attachment"));
                if let Some(boundary) = message
                    .content_type()
                    .filter(|c| c.c_type.eq_ignore_ascii_case("multipart"))
                    .and_then(|c| c.attribute("boundary"))
                {
                    if boundary.len() <= 1000 && self.boundaries.len() < 100 {
                        self.boundaries.push(format!("--{boundary}").into_bytes());
                    }
                }
            }
            self.in_headers = false;
            self.headers.clear();
        } else if !self.overflow && self.headers.len() + line.len() < 256 * 1024 {
            self.headers.extend_from_slice(line);
            self.headers.extend_from_slice(b"\r\n");
        } else {
            self.in_headers = false;
            self.headers.clear();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_nested_folded_attachment_headers_without_matching_body_text() {
        let raw=b"Content-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\nContent-Type: text/plain\r\n\r\nContent-Disposition: attachment; filename=fake\r\n--outer\r\nContent-Type: multipart/mixed; boundary=inner\r\n\r\n--inner\r\nContent-Disposition: inline;\r\n filename*=utf-8''report.pdf\r\n\r\nbytes";
        let mut scan = AttachmentScan::default();
        for bytes in raw.chunks(7) {
            scan.feed(bytes);
        }
        assert!(scan.found);
        let mut scan = AttachmentScan::default();
        scan.feed(b"Content-Type: text/plain\r\n\r\nContent-Disposition: attachment; filename=fake\r\n\r\n");
        assert!(!scan.found);
    }
}
