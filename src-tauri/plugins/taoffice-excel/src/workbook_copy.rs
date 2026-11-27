use crate::workbook::{Workbook, invalid};
use quick_xml::{
    NsReader, Writer, XmlVersion,
    events::{BytesStart, Event},
    name::{Namespace, ResolveResult},
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap},
    io::{Cursor, Read, Write},
};
use taomni_plugin_api::RpcError;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

mod sheet;

pub const MAX_COPY_BYTES: usize = 24 * 1024 * 1024;
const MAX_EDITS: usize = 128;
const MAX_XML_BYTES: usize = 24 * 1024 * 1024;
const CONTENT_TYPES: &str = "[Content_Types].xml";
const WORKBOOK: &str = "xl/workbook.xml";
const RELATIONSHIPS: &str = "xl/_rels/workbook.xml.rels";
const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const RID: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const XLSX_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

type Source<'a> = ZipArchive<Cursor<&'a [u8]>>;

#[derive(Deserialize)]
pub struct Edit {
    pub sheet: String,
    pub address: String,
    pub value: String,
}

fn part(archive: &mut Source<'_>, path: &str) -> Result<String, RpcError> {
    let raw = archive.by_name(path).map_err(invalid)?;
    let size = usize::try_from(raw.size()).map_err(invalid)?;
    if size > MAX_XML_BYTES {
        return Err(invalid("A workbook XML part exceeds the edit limit"));
    }
    let mut bytes = Vec::with_capacity(size);
    raw.take(size as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    if bytes.len() != size {
        return Err(invalid("A workbook XML part changed size during decoding"));
    }
    String::from_utf8(bytes).map_err(invalid)
}

fn attribute(tag: &BytesStart<'_>, name: &str) -> Result<Option<String>, RpcError> {
    tag.try_get_attribute(name)
        .map_err(invalid)?
        .map(|attr| {
            attr.normalized_value(XmlVersion::Implicit1_0)
                .map(|value| value.into_owned())
                .map_err(invalid)
        })
        .transpose()
}

fn scan(
    xml: &str,
    namespace: &str,
    mut visit: impl FnMut(
        &NsReader<&[u8]>,
        &BytesStart<'_>,
        usize,
        usize,
        bool,
        usize,
    ) -> Result<(), RpcError>,
) -> Result<usize, RpcError> {
    let mut reader = NsReader::from_str(xml);
    let mut depth = 0usize;
    let mut root_end = None;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(invalid)?;
        let end = reader.buffer_position() as usize;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                if reader.resolver().resolve_element(tag.name()).0
                    == ResolveResult::Bound(Namespace(namespace))
                {
                    visit(
                        &reader,
                        tag,
                        start,
                        end,
                        matches!(event, Event::Empty(_)),
                        depth,
                    )?;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                    if depth > 64 {
                        return Err(invalid("Workbook XML is nested too deeply"));
                    }
                } else if depth == 0 {
                    root_end = Some(start);
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("Unexpected XML end tag"))?;
                if depth == 0 {
                    root_end = Some(start);
                }
            }
            Event::DocType(_) => {
                return Err(invalid(
                    "XML document types are unsupported in editable workbooks",
                ));
            }
            Event::Eof => {
                return root_end
                    .filter(|_| depth == 0)
                    .ok_or_else(|| invalid("Incomplete workbook XML part"));
            }
            _ => {}
        }
    }
}

fn check_editable(archive: &mut Source<'_>) -> Result<(), RpcError> {
    let mut xlsx = false;
    if archive
        .file_names()
        .any(|name| name.is_ok_and(|name| name.to_ascii_lowercase().starts_with("_xmlsignatures/")))
    {
        return Err(invalid("Digitally signed workbooks are read-only"));
    }
    scan(
        &part(archive, CONTENT_TYPES)?,
        CONTENT,
        |_, tag, _, _, _, depth| {
            if depth == 1
                && tag.local_name().as_ref() == "Override"
                && attribute(tag, "PartName")?.as_deref() == Some("/xl/workbook.xml")
            {
                xlsx = attribute(tag, "ContentType")?.as_deref() == Some(XLSX_TYPE);
            }
            Ok(())
        },
    )?;
    if !xlsx {
        return Err(invalid("Editing is available for XLSX workbooks"));
    }
    Ok(())
}

fn worksheet_targets(archive: &mut Source<'_>) -> Result<HashMap<String, String>, RpcError> {
    let mut targets = HashMap::new();
    scan(
        &part(archive, RELATIONSHIPS)?,
        REL,
        |_, tag, _, _, _, depth| {
            if depth != 1
                || tag.local_name().as_ref() != "Relationship"
                || attribute(tag, "Type")?.as_deref() != Some(SHEET_REL)
                || attribute(tag, "TargetMode")?.as_deref() == Some("External")
            {
                return Ok(());
            }
            let Some(id) = attribute(tag, "Id")? else {
                return Err(invalid("Missing worksheet relationship id"));
            };
            let Some(target) = attribute(tag, "Target")? else {
                return Err(invalid("Missing worksheet relationship target"));
            };
            let path = target.strip_prefix("/xl/").unwrap_or(&target);
            if path.starts_with("worksheets/")
                && path.ends_with(".xml")
                && path
                    .split('/')
                    .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
                && !path.contains(['\\', ':', '%', '?', '#'])
                && targets.insert(id, format!("xl/{path}")).is_some()
            {
                return Err(invalid("Duplicate worksheet relationship id"));
            }
            Ok(())
        },
    )?;
    Ok(targets)
}

fn workbook_parts(
    xml: &str,
    targets: &HashMap<String, String>,
) -> Result<(HashMap<String, String>, Vec<u8>), RpcError> {
    let mut names = HashMap::new();
    let mut calc_tag = None;
    let mut insert_before = None;
    let mut calc_name = None;
    let root_end = scan(xml, MAIN, |reader, tag, start, end, empty, depth| {
        match (depth, tag.local_name().as_ref()) {
            (0, "workbook") => {
                let name = tag.name();
                calc_name = Some(match name.as_ref().rsplit_once(':') {
                    Some((prefix, _)) => format!("{prefix}:calcPr"),
                    None => "calcPr".to_owned(),
                });
            }
            (2, "sheet") => {
                let Some(name) = attribute(tag, "name")? else {
                    return Ok(());
                };
                for attr in tag.attributes() {
                    let attr = attr.map_err(invalid)?;
                    let (namespace, local) = reader.resolver().resolve_attribute(attr.key);
                    if namespace == ResolveResult::Bound(Namespace(RID)) && local.as_ref() == "id" {
                        let id = attr
                            .normalized_value(XmlVersion::Implicit1_0)
                            .map_err(invalid)?;
                        if let Some(path) = targets.get(id.as_ref())
                            && names.insert(name, path.clone()).is_some()
                        {
                            return Err(invalid("Duplicate worksheet name"));
                        }
                        break;
                    }
                }
            }
            (1, "calcPr") => {
                if calc_tag.is_some() {
                    return Err(invalid("Duplicate workbook calculation settings"));
                }
                let mut updated = tag.to_owned();
                updated.clear_attributes();
                for attr in tag.attributes() {
                    let attr = attr.map_err(invalid)?;
                    if !matches!(attr.key.as_ref(), "fullCalcOnLoad" | "forceFullCalc") {
                        updated.push_attribute(attr);
                    }
                }
                updated.push_attribute(("fullCalcOnLoad", "1"));
                updated.push_attribute(("forceFullCalc", "1"));
                let mut writer = Writer::new(Vec::new());
                writer
                    .write_event(if empty {
                        Event::Empty(updated)
                    } else {
                        Event::Start(updated)
                    })
                    .map_err(invalid)?;
                calc_tag = Some((start, end, writer.into_inner()));
            }
            (
                1,
                "oleSize"
                | "customWorkbookViews"
                | "pivotCaches"
                | "smartTagPr"
                | "smartTagTypes"
                | "webPublishing"
                | "fileRecoveryPr"
                | "webPublishObjects"
                | "extLst",
            ) => {
                insert_before.get_or_insert(start);
            }
            _ => {}
        }
        Ok(())
    })?;
    let (start, end, updated) = match calc_tag {
        Some(updated) => updated,
        None => {
            let name = calc_name.ok_or_else(|| invalid("Missing workbook element"))?;
            let offset = insert_before.unwrap_or(root_end);
            (
                offset,
                offset,
                format!(r#"<{name} fullCalcOnLoad="1" forceFullCalc="1"/>"#).into_bytes(),
            )
        }
    };
    let mut bytes = Vec::with_capacity(xml.len() + updated.len());
    bytes.extend_from_slice(&xml.as_bytes()[..start]);
    bytes.extend(updated);
    bytes.extend_from_slice(&xml.as_bytes()[end..]);
    Ok((names, bytes))
}

pub fn create(
    workbook: &Workbook,
    edits: Vec<Edit>,
    mut check_current: impl FnMut() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    if edits.len() > MAX_EDITS {
        return Err(invalid(
            "A workbook copy can include up to 128 edited cells",
        ));
    }
    if edits.is_empty() {
        return Ok(workbook.bytes().to_vec());
    }
    let mut archive = ZipArchive::new(Cursor::new(workbook.bytes())).map_err(invalid)?;
    check_editable(&mut archive)?;
    let targets = worksheet_targets(&mut archive)?;
    let (paths, recalculation) = workbook_parts(&part(&mut archive, WORKBOOK)?, &targets)?;
    let mut by_part = BTreeMap::<String, BTreeMap<String, String>>::new();
    for edit in edits {
        let target = paths
            .get(&edit.sheet)
            .filter(|_| workbook.sheets().contains(&edit.sheet))
            .ok_or_else(|| invalid("The selected worksheet is read-only"))?;
        if edit.address.len() > 10
            || edit.value.chars().count() > 960
            || edit
                .value
                .chars()
                .any(|char| char.is_control() && !matches!(char, '\t' | '\n'))
        {
            return Err(invalid(
                "A cell address or replacement value exceeds the edit limits",
            ));
        }
        if by_part
            .entry(target.clone())
            .or_default()
            .insert(edit.address, edit.value)
            .is_some()
        {
            return Err(invalid("A cell is edited more than once"));
        }
    }
    let mut replacements = BTreeMap::from([(WORKBOOK.to_owned(), recalculation)]);
    for (path, edits) in by_part {
        check_current()?;
        let xml = part(&mut archive, &path)?;
        replacements.insert(path, sheet::rewrite(&xml, edits, &mut check_current)?);
    }
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let original_comment = archive.comment();
    writer
        .set_raw_comment(original_comment.into())
        .map_err(invalid)?;
    for index in 0..archive.len() {
        check_current()?;
        let item = archive.by_index_raw(index).map_err(invalid)?;
        let name = item.name().map_err(invalid)?;
        if let Some(bytes) = replacements.remove(name.as_ref()) {
            writer
                .start_file(
                    name,
                    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
                )
                .map_err(invalid)?;
            writer.write_all(&bytes).map_err(invalid)?;
        } else {
            writer.raw_copy_file(item).map_err(invalid)?;
        }
    }
    let output = writer.finish().map_err(invalid)?.into_inner();
    if output.len() > MAX_COPY_BYTES || !replacements.is_empty() {
        return Err(invalid(
            "The workbook copy exceeds the save limit or has missing parts",
        ));
    }
    check_current()?;
    Ok(output)
}

#[cfg(test)]
mod tests;
