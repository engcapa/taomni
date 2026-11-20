//! Large-message handling via BODYSTRUCTURE (TASK-15).
//!
//! When a message is larger than the partial-body limit, the reader fetches
//! BODYSTRUCTURE and then only the text/plain and text/html sections (whole,
//! never truncated), and lists every attachment with its IMAP section so a
//! download fetches just that part (`BODY.PEEK[<section>]`) instead of the
//! whole message.

use std::io::{Read, Write};

use crate::mime_sections::{decode_section, decode_text_section, decode_words};
use imap_proto::types::{BodyStructure, MessageSection, SectionPath};

use crate::MailAttachmentInfo;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PartRef {
    /// Dotted IMAP section ("1", "1.2", ...).
    pub section: String,
    pub content_type: String,
    pub name: Option<String>,
    pub octets: u32,
    pub inline: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PartPlan {
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

fn plan_parts(structure: &BodyStructure<'_>) -> PartPlan {
    let mut plan = PartPlan::default();
    walk(structure, &mut Vec::new(), &mut plan);
    plan
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
pub fn imap_fetch_section<T: Read + Write>(
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
}
