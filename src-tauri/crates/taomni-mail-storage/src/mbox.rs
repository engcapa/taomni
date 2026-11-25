//! mboxrd and RFC 5322 byte transformations shared by Mail import and export.

pub fn mbox_separator(internal_ts: Option<i64>) -> String {
    let when = internal_ts
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .unwrap_or_else(chrono::Utc::now);
    format!("From - {}\n", when.format("%a %b %e %H:%M:%S %Y"))
}

fn is_from_line(line: &[u8]) -> bool {
    let quoted = line.iter().take_while(|b| **b == b'>').count();
    line[quoted..].starts_with(b"From ")
}

/// mboxrd body: every line matching `^>*From ` gains one `>`; LF endings.
pub fn mboxrd_escape(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 64);
    for line in raw.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if is_from_line(line) {
            out.push(b'>');
        }
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    // `split` yields a trailing empty piece for a final newline.
    if raw.ends_with(b"\n") {
        out.pop();
    }
    out
}

pub fn is_mbox(data: &[u8]) -> bool {
    data.starts_with(b"From ")
}

/// Split an mbox into RFC 5322 messages (CRLF endings, `>From ` unquoted).
pub fn split_mbox(data: &[u8]) -> Vec<Vec<u8>> {
    let mut messages: Vec<Vec<u8>> = Vec::new();
    let mut current: Option<Vec<Vec<u8>>> = None;
    let mut previous_blank = true;
    for line in data.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if previous_blank && line.starts_with(b"From ") {
            if let Some(lines) = current.take() {
                messages.push(join_crlf(lines));
            }
            current = Some(Vec::new());
            previous_blank = false;
            continue;
        }
        previous_blank = line.is_empty();
        if let Some(lines) = current.as_mut() {
            let unquoted = if line.first() == Some(&b'>') && is_from_line(&line[1..]) {
                &line[1..]
            } else {
                line
            };
            lines.push(unquoted.to_vec());
        }
    }
    if let Some(lines) = current.take() {
        messages.push(join_crlf(lines));
    }
    messages.retain(|message| !message.iter().all(u8::is_ascii_whitespace));
    messages
}

fn join_crlf(mut lines: Vec<Vec<u8>>) -> Vec<u8> {
    // Drop the blank separator line(s) before the next `From `.
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut out = Vec::new();
    for line in lines {
        out.extend_from_slice(&line);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// A single .eml with bare LF endings, normalised for IMAP APPEND.
pub fn normalize_crlf(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 32);
    for (index, byte) in raw.iter().enumerate() {
        if *byte == b'\n' && (index == 0 || raw[index - 1] != b'\r') {
            out.push(b'\r');
        }
        out.push(*byte);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mboxrd_round_trip_keeps_from_lines() {
        let one = b"Subject: one\r\n\r\nFrom the start\r\n>From quoted\r\nend\r\n".to_vec();
        let two = b"Subject: two\n\nsecond body\n".to_vec();
        let mut mbox = Vec::new();
        for (raw, ts) in [(&one, 1_700_000_000), (&two, 1_700_000_100)] {
            mbox.extend_from_slice(mbox_separator(Some(ts)).as_bytes());
            mbox.extend_from_slice(&mboxrd_escape(raw));
            mbox.extend_from_slice(b"\n");
        }
        let text = String::from_utf8_lossy(&mbox);
        assert!(
            text.starts_with("From - Tue Nov 14 22:13:20 2023\n"),
            "{text}"
        );
        assert!(
            text.contains("\n>From the start\n>>From quoted\n"),
            "{text}"
        );

        let split = split_mbox(&mbox);
        assert_eq!(split.len(), 2);
        assert_eq!(
            split[0],
            b"Subject: one\r\n\r\nFrom the start\r\n>From quoted\r\nend\r\n".to_vec()
        );
        assert_eq!(split[1], b"Subject: two\r\n\r\nsecond body\r\n".to_vec());
        assert!(is_mbox(&mbox));
    }

    #[test]
    fn eml_is_normalised_to_crlf() {
        assert_eq!(normalize_crlf(b"a\nb\r\nc\n"), b"a\r\nb\r\nc\r\n".to_vec());
        assert!(!is_mbox(b"Subject: x\r\n\r\nbody"));
    }
}
