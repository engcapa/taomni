//! vCard 2.1/3.0/4.0 (RFC 2426 / RFC 6350) for the address book (TASK-19).
//!
//! Only the fields the address book edits are modelled; everything else in a
//! card (photos, addresses, custom X- properties) is kept verbatim in `raw`
//! and written back unchanged, so CardDAV round-trips do not lose data.

use serde::{Deserialize, Serialize};

use super::calendar::{escape, fold, param, split_property, unescape, unfold};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailContactCard {
    pub uid: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub phones: Vec<String>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// The card as last read (unmodelled properties survive edits).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Properties the address book owns; every other line of `raw` is kept.
const MANAGED: &[&str] = &[
    "VERSION", "UID", "FN", "N", "EMAIL", "TEL", "ORG", "NOTE", "REV", "PRODID",
];

fn decode_quoted_printable(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' {
            let hex = value
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Property name without an Apple-style group prefix (`item1.EMAIL`).
fn bare_name(name: &str) -> &str {
    name.rsplit_once('.').map_or(name, |(_, bare)| bare)
}

fn value_of(params: &[(String, String)], value: &str) -> String {
    let decoded =
        if param(params, "ENCODING").is_some_and(|e| e.eq_ignore_ascii_case("QUOTED-PRINTABLE")) {
            decode_quoted_printable(value)
        } else {
            value.to_string()
        };
    unescape(decoded.trim())
}

/// vCard 2.1 soft line breaks (`=` at line end) in quoted-printable values.
fn join_qp_soft_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut lines = text.split('\n').peekable();
    while let Some(line) = lines.next() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.to_ascii_uppercase().contains("QUOTED-PRINTABLE") && line.ends_with('=') {
            let mut joined = line.trim_end_matches('=').to_string();
            while let Some(next) = lines.next() {
                let next = next.strip_suffix('\r').unwrap_or(next);
                if let Some(rest) = next.strip_suffix('=') {
                    joined.push_str(rest);
                } else {
                    joined.push_str(next);
                    break;
                }
            }
            out.push_str(&joined);
        } else {
            out.push_str(line);
        }
        out.push_str("\r\n");
    }
    out
}

fn parse_card(lines: &[String]) -> Option<MailContactCard> {
    let mut card = MailContactCard::default();
    let mut structured_name = String::new();
    for line in lines {
        let (name, params, value) = split_property(line);
        match bare_name(&name) {
            "UID" => card.uid = value.trim().trim_start_matches("urn:uuid:").to_string(),
            "FN" => card.display_name = value_of(&params, &value),
            "N" => {
                // Family;Given;Additional;Prefix;Suffix
                let qp = param(&params, "ENCODING")
                    .is_some_and(|e| e.eq_ignore_ascii_case("QUOTED-PRINTABLE"));
                let parts: Vec<String> = value
                    .split(';')
                    .map(|p| {
                        let p = if qp {
                            decode_quoted_printable(p)
                        } else {
                            p.to_string()
                        };
                        unescape(p.trim())
                    })
                    .collect();
                let given = parts.get(1).cloned().unwrap_or_default();
                let family = parts.first().cloned().unwrap_or_default();
                structured_name = format!("{given} {family}").trim().to_string();
            }
            "EMAIL" => {
                let email = value_of(&params, &value)
                    .trim_start_matches("mailto:")
                    .to_string();
                if !email.is_empty() && !card.emails.contains(&email) {
                    card.emails.push(email);
                }
            }
            "TEL" => {
                let phone = value_of(&params, &value)
                    .trim_start_matches("tel:")
                    .to_string();
                if !phone.is_empty() {
                    card.phones.push(phone);
                }
            }
            "ORG" => {
                let org = value_of(&params, value.split(';').next().unwrap_or(""));
                card.org = Some(org).filter(|o| !o.is_empty());
            }
            "NOTE" => card.note = Some(value_of(&params, &value)).filter(|n| !n.is_empty()),
            _ => {}
        }
    }
    if card.display_name.is_empty() {
        card.display_name = structured_name;
    }
    if card.display_name.is_empty() {
        card.display_name = card.emails.first().cloned().unwrap_or_default();
    }
    if card.display_name.is_empty() && card.emails.is_empty() && card.phones.is_empty() {
        return None;
    }
    Some(card)
}

/// Every `BEGIN:VCARD … END:VCARD` in `text` (one .vcf may hold many).
pub(super) fn parse_vcards(text: &str) -> Vec<MailContactCard> {
    let lines = unfold(&join_qp_soft_breaks(text));
    let mut cards = Vec::new();
    let mut current: Option<Vec<String>> = None;
    let mut depth = 0usize;
    for line in lines {
        let (name, _, value) = split_property(&line);
        if name == "BEGIN" && value.trim().eq_ignore_ascii_case("VCARD") {
            depth += 1;
            if depth == 1 {
                current = Some(vec![line]);
                continue;
            }
        }
        if name == "END" && value.trim().eq_ignore_ascii_case("VCARD") && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(mut body) = current.take() {
                    body.push(line);
                    if let Some(mut card) = parse_card(&body) {
                        card.raw = Some(body.join("\r\n") + "\r\n");
                        cards.push(card);
                    }
                }
                continue;
            }
        }
        if let Some(body) = current.as_mut() {
            body.push(line);
        }
    }
    cards
}

/// vCard 3.0 text of `card`, keeping unmodelled lines of `card.raw`.
pub(super) fn serialize_vcard(card: &MailContactCard, rev: i64) -> String {
    let mut lines = vec!["BEGIN:VCARD".to_string(), "VERSION:3.0".to_string()];
    lines.push("PRODID:-//Taomni//Mail//EN".to_string());
    lines.push(format!("UID:{}", card.uid));
    lines.push(format!("FN:{}", escape(&card.display_name)));
    // N is required by vCard 3.0; derive it from the display name.
    let (given, family) = match card.display_name.trim().rsplit_once(' ') {
        Some((given, family)) => (given.to_string(), family.to_string()),
        None => (card.display_name.trim().to_string(), String::new()),
    };
    lines.push(format!("N:{};{};;;", escape(&family), escape(&given)));
    for email in &card.emails {
        lines.push(format!("EMAIL;TYPE=INTERNET:{}", escape(email)));
    }
    for phone in &card.phones {
        lines.push(format!("TEL:{}", escape(phone)));
    }
    if let Some(org) = card.org.as_deref().filter(|o| !o.is_empty()) {
        lines.push(format!("ORG:{}", escape(org)));
    }
    if let Some(note) = card.note.as_deref().filter(|n| !n.is_empty()) {
        lines.push(format!("NOTE:{}", escape(note)));
    }
    if let Some(raw) = &card.raw {
        let mut depth = 0usize;
        for line in unfold(raw) {
            let (name, _, value) = split_property(&line);
            let is_card = value.trim().eq_ignore_ascii_case("VCARD");
            if name == "BEGIN" && is_card {
                depth += 1;
                continue;
            }
            if name == "END" && is_card {
                depth = depth.saturating_sub(1);
                continue;
            }
            if depth == 1 && !MANAGED.contains(&bare_name(&name)) {
                lines.push(line);
            }
        }
    }
    let stamp = chrono::DateTime::from_timestamp(rev, 0)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ");
    lines.push(format!("REV:{stamp}"));
    lines.push("END:VCARD".to_string());
    lines
        .iter()
        .map(|line| fold(line))
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPLE: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//iPhone OS 17.0//EN\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nORG:Acme\\, Inc.;Sales\r\nitem1.EMAIL;type=INTERNET;type=pref:jane@\r\n example.com\r\nitem1.X-ABLabel:work\r\nEMAIL;type=INTERNET:jd@home.example\r\nTEL;type=CELL:+1 555 0100\r\nPHOTO;ENCODING=b;TYPE=JPEG:AAAA\r\nUID:ABC-123\r\nEND:VCARD\r\n";

    #[test]
    fn parses_apple_cards_and_keeps_unknown_lines() {
        let cards = parse_vcards(APPLE);
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!(card.uid, "ABC-123");
        assert_eq!(card.display_name, "Jane Doe");
        assert_eq!(card.emails, vec!["jane@example.com", "jd@home.example"]);
        assert_eq!(card.phones, vec!["+1 555 0100"]);
        assert_eq!(card.org.as_deref(), Some("Acme, Inc."));

        let mut edited = card.clone();
        edited.emails = vec!["jane@new.example".into()];
        edited.note = Some("met at, the fair".into());
        let text = serialize_vcard(&edited, 1_700_000_000);
        assert!(text.contains("EMAIL;TYPE=INTERNET:jane@new.example\r\n"));
        assert!(!text.contains("jd@home.example"), "removed emails are gone");
        assert!(text.contains("NOTE:met at\\, the fair\r\n"));
        assert!(
            text.contains("PHOTO;ENCODING=b;TYPE=JPEG:AAAA\r\n"),
            "photo survives"
        );
        assert!(text.contains("item1.X-ABLabel:work\r\n"));
        assert!(text.contains("REV:20231114T221320Z\r\n"));
        assert_eq!(text.matches("BEGIN:VCARD").count(), 1);
        let reparsed = parse_vcards(&text);
        assert_eq!(reparsed[0].emails, vec!["jane@new.example"]);
        assert_eq!(reparsed[0].note.as_deref(), Some("met at, the fair"));
    }

    #[test]
    fn parses_multiple_and_legacy_cards() {
        let text = "BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0;=E4=B8=89\nEMAIL;PREF;INTERNET:zhang@example.cn\nNOTE;ENCODING=QUOTED-PRINTABLE:line one=\n line two\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nFN:No Mail\nTEL;VALUE=uri:tel:+86-10-1234\nUID:urn:uuid:42\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nEND:VCARD\n";
        let cards = parse_vcards(text);
        assert_eq!(cards.len(), 2, "empty cards are skipped");
        assert_eq!(cards[0].emails, vec!["zhang@example.cn"]);
        assert_eq!(cards[0].display_name, "\u{4e09} \u{5f20}");
        assert_eq!(cards[1].uid, "42");
        assert_eq!(cards[1].phones, vec!["+86-10-1234"]);
    }
}
