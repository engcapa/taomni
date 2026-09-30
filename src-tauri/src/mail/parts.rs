//! Large-message handling via BODYSTRUCTURE (TASK-15).
//!
//! When a message is larger than the partial-body limit, the reader fetches
//! BODYSTRUCTURE and then only the text/plain and text/html sections (whole,
//! never truncated), and lists every attachment with its IMAP section so a
//! download fetches just that part (`BODY.PEEK[<section>]`) instead of the
//! whole message. Downloaded attachments can be kept in an on-disk cache
//! (`cache.attachmentCache`) so reopening one needs no server round trip.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use imap_proto::types::{BodyStructure, MessageSection, SectionPath};
use mail_parser::MessageParser;

use super::MailAttachmentInfo;

/// Upper bound for one decoded text section shown in the reader.
const TEXT_SECTION_MAX: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PartRef {
    /// Dotted IMAP section ("1", "1.2", ...).
    pub section: String,
    pub content_type: String,
    pub name: Option<String>,
    pub octets: u32,
    pub inline: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct PartPlan {
    pub text: Option<PartRef>,
    pub html: Option<PartRef>,
    pub attachments: Vec<PartRef>,
}

fn param<'a>(params: &'a Option<Vec<(&'a str, &'a str)>>, key: &str) -> Option<&'a str> {
    params
        .as_ref()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| *v)
}

fn section_name(path: &[u32]) -> String {
    path.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn leaf(
    common: &imap_proto::types::BodyContentCommon<'_>,
    octets: u32,
    path: &[u32],
) -> (PartRef, bool) {
    let disposition = common.disposition.as_ref();
    let attachment = disposition.is_some_and(|d| d.ty.eq_ignore_ascii_case("attachment"));
    let name = disposition
        .and_then(|d| param(&d.params, "filename"))
        .or_else(|| param(&common.ty.params, "name"))
        .map(decode_words);
    let part = PartRef {
        section: section_name(path),
        content_type: format!("{}/{}", common.ty.ty, common.ty.subtype).to_ascii_lowercase(),
        name,
        octets,
        inline: disposition.is_some_and(|d| d.ty.eq_ignore_ascii_case("inline")),
    };
    (part, attachment)
}

fn walk(structure: &BodyStructure<'_>, path: &mut Vec<u32>, plan: &mut PartPlan) {
    match structure {
        BodyStructure::Multipart { bodies, .. } => {
            for (index, body) in bodies.iter().enumerate() {
                path.push(index as u32 + 1);
                walk(body, path, plan);
                path.pop();
            }
        }
        BodyStructure::Text { common, other, .. } => {
            let section: Vec<u32> = if path.is_empty() {
                vec![1]
            } else {
                path.clone()
            };
            let (part, attachment) = leaf(common, other.octets, &section);
            let subtype = common.ty.subtype.to_ascii_lowercase();
            if !attachment && part.name.is_none() && subtype == "plain" && plan.text.is_none() {
                plan.text = Some(part);
            } else if !attachment && part.name.is_none() && subtype == "html" && plan.html.is_none()
            {
                plan.html = Some(part);
            } else {
                plan.attachments.push(part);
            }
        }
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Message { common, other, .. } => {
            let section: Vec<u32> = if path.is_empty() {
                vec![1]
            } else {
                path.clone()
            };
            plan.attachments
                .push(leaf(common, other.octets, &section).0);
        }
    }
}

pub(super) fn plan_parts(structure: &BodyStructure<'_>) -> PartPlan {
    let mut plan = PartPlan::default();
    walk(structure, &mut Vec::new(), &mut plan);
    plan
}

/// RFC 2047 encoded-words in BODYSTRUCTURE names (`=?utf-8?B?...?=`).
fn decode_words(value: &str) -> String {
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
pub(super) fn decode_section(mime_header: &[u8], data: &[u8]) -> Option<Vec<u8>> {
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

pub(super) fn decode_text_section(mime_header: &[u8], data: &[u8], html: bool) -> Option<String> {
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
    Some(super::truncate_utf8_bytes(&text, TEXT_SECTION_MAX))
}

fn section_path(section: &str, mime: bool) -> Option<SectionPath> {
    let parts = section
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    Some(SectionPath::Part(
        parts,
        if mime {
            Some(MessageSection::Mime)
        } else {
            None
        },
    ))
}

/// Text/HTML bodies and the attachment list of a large message.
pub(super) struct LargeBody {
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<MailAttachmentInfo>,
}

/// Fetch BODYSTRUCTURE, then the text sections of `uid` (folder selected).
pub(super) fn imap_fetch_large_body<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid: u32,
) -> Result<LargeBody, String> {
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODYSTRUCTURE)")
        .map_err(|e| format!("IMAP FETCH BODYSTRUCTURE failed: {e}"))?;
    let plan = fetches
        .iter()
        .find_map(|fetch| fetch.bodystructure().map(plan_parts))
        .ok_or_else(|| format!("message UID {uid} returned no BODYSTRUCTURE"))?;
    let wanted: Vec<(&PartRef, bool)> = plan
        .text
        .iter()
        .map(|part| (part, false))
        .chain(plan.html.iter().map(|part| (part, true)))
        .collect();
    let mut body = LargeBody {
        text: None,
        html: None,
        attachments: plan
            .attachments
            .iter()
            .map(|part| MailAttachmentInfo {
                name: part.name.clone(),
                content_type: Some(part.content_type.clone()),
                size: Some(part.octets as usize),
                section: Some(part.section.clone()),
            })
            .collect(),
    };
    if wanted.is_empty() {
        return Ok(body);
    }
    let items = wanted
        .iter()
        .map(|(part, _)| format!("BODY.PEEK[{0}.MIME] BODY.PEEK[{0}]", part.section))
        .collect::<Vec<_>>()
        .join(" ");
    let fetches = session
        .uid_fetch(uid.to_string(), format!("(UID {items})"))
        .map_err(|e| format!("IMAP FETCH text sections failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} returned no sections"))?;
    for (part, html) in wanted {
        let (Some(mime_path), Some(data_path)) = (
            section_path(&part.section, true),
            section_path(&part.section, false),
        ) else {
            continue;
        };
        let mime = fetch.section(&mime_path).unwrap_or_default();
        let Some(data) = fetch.section(&data_path) else {
            continue;
        };
        let decoded = decode_text_section(mime, data, html);
        if html {
            body.html = decoded;
        } else {
            body.text = decoded;
        }
    }
    Ok(body)
}

/// Fetch and decode one attachment section (folder selected).
pub(super) fn imap_fetch_section<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid: u32,
    section: &str,
) -> Result<Vec<u8>, String> {
    let (Some(mime_path), Some(data_path)) =
        (section_path(section, true), section_path(section, false))
    else {
        return Err(format!("invalid attachment section {section}"));
    };
    let fetches = session
        .uid_fetch(
            uid.to_string(),
            format!("(UID BODY.PEEK[{section}.MIME] BODY.PEEK[{section}])"),
        )
        .map_err(|e| format!("IMAP FETCH attachment section failed: {e}"))?;
    let fetch = fetches
        .iter()
        .next()
        .ok_or_else(|| format!("message UID {uid} not found"))?;
    let data = fetch
        .section(&data_path)
        .ok_or_else(|| format!("section {section} of UID {uid} is empty"))?;
    let mime = fetch.section(&mime_path).unwrap_or_default();
    decode_section(mime, data).ok_or_else(|| format!("could not decode section {section}"))
}

/// On-disk attachment cache path: `<root>/<uid>-<key>.bin` under a folder dir.
pub(super) fn attachment_cache_path(
    root: &Path,
    account_stem: &str,
    folder: &str,
    uid: u32,
    key: &str,
) -> PathBuf {
    let safe = |value: &str| -> String {
        value
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    root.join("attachments")
        .join(safe(account_stem))
        .join(safe(folder))
        .join(format!("{uid}-{}.bin", safe(key)))
}

pub(super) fn write_cache_file(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    // Best effort: a failed cache write never fails the download.
    let tmp = path.with_extension("part");
    if std::fs::File::create(&tmp)
        .and_then(|mut file| file.write_all(bytes))
        .is_ok()
    {
        let _ = std::fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn structure_of(response: &[u8], check: impl FnOnce(&BodyStructure<'_>)) {
        let (_, parsed) = imap_proto::parse_response(response).expect("parse");
        let imap_proto::types::Response::Fetch(_, attrs) = parsed else {
            panic!("not a fetch");
        };
        let structure = attrs
            .iter()
            .find_map(|attr| match attr {
                imap_proto::types::AttributeValue::BodyStructure(bs) => Some(bs),
                _ => None,
            })
            .expect("bodystructure");
        check(structure);
    }

    #[test]
    fn plans_alternative_bodies_and_attachments() {
        let response = b"* 1 FETCH (UID 7 BODYSTRUCTURE (((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 12 1 NIL NIL NIL)(\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"BASE64\" 40 1 NIL NIL NIL) \"ALTERNATIVE\" (\"BOUNDARY\" \"b1\") NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"big.pdf\") NIL NIL \"BASE64\" 31457280 NIL (\"ATTACHMENT\" (\"FILENAME\" \"big.pdf\")) NIL) \"MIXED\" (\"BOUNDARY\" \"b0\") NIL NIL))\r\n";
        structure_of(response, |structure| {
            let plan = plan_parts(structure);
            assert_eq!(plan.text.as_ref().unwrap().section, "1.1");
            assert_eq!(plan.html.as_ref().unwrap().section, "1.2");
            assert_eq!(plan.attachments.len(), 1);
            let pdf = &plan.attachments[0];
            assert_eq!(pdf.section, "2");
            assert_eq!(pdf.name.as_deref(), Some("big.pdf"));
            assert_eq!(pdf.content_type, "application/pdf");
            assert_eq!(pdf.octets, 31_457_280);
        });
    }

    #[test]
    fn single_part_text_is_section_one() {
        let response = b"* 1 FETCH (UID 3 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"us-ascii\") NIL NIL \"7BIT\" 5 1 NIL NIL NIL))\r\n";
        structure_of(response, |structure| {
            let plan = plan_parts(structure);
            assert_eq!(plan.text.unwrap().section, "1");
            assert!(plan.html.is_none() && plan.attachments.is_empty());
        });
    }

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

    #[test]
    fn large_message_reads_text_sections_and_one_attachment() {
        let fake = super::super::fake_imap::FakeImap::start(false);
        let uid = fake.deliver_raw("INBOX", vec![b'x'; 4096]);
        let structure = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 9 1 NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"big.pdf\") NIL NIL \"BASE64\" 4 NIL (\"ATTACHMENT\" (\"FILENAME\" \"big.pdf\")) NIL) \"MIXED\" (\"BOUNDARY\" \"b0\") NIL NIL)";
        fake.set_structure(
            "INBOX",
            uid,
            structure,
            &[
                ("1.MIME", b"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"),
                ("1", b"caf=C3=A9 ok"),
                ("2.MIME", b"Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n"),
                ("2", b"JVBE"),
            ],
        );
        let mut session = fake.session();
        session.examine("INBOX").unwrap();
        let large = imap_fetch_large_body(&mut session, uid).unwrap();
        assert_eq!(large.text.as_deref(), Some("caf\u{e9} ok"));
        assert!(large.html.is_none());
        assert_eq!(large.attachments.len(), 1);
        assert_eq!(large.attachments[0].section.as_deref(), Some("2"));
        assert_eq!(large.attachments[0].name.as_deref(), Some("big.pdf"));
        let pdf = imap_fetch_section(&mut session, uid, "2").unwrap();
        assert_eq!(pdf, b"%PD".to_vec());
        assert!(
            !fake
                .log()
                .iter()
                .any(|line| line.to_ascii_uppercase().contains("BODY.PEEK[]")),
            "never fetched the whole message: {:?}",
            fake.log()
        );
    }

    #[test]
    fn cache_paths_are_sanitised() {
        let path = attachment_cache_path(Path::new("/c"), "acct", "INBOX/Sub", 7, "1.2");
        assert!(
            path.ends_with("attachments/acct/INBOX_Sub/7-1.2.bin"),
            "{path:?}"
        );
    }
}
