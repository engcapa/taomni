use calamine::Dimensions;
use quick_xml::{
    NsReader, XmlVersion,
    events::{BytesStart, Event},
    name::{Namespace, ResolveResult},
};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
};
use taomni_plugin_api::{ErrorCode, RpcError};
use zip::ZipArchive;

mod tables;

pub(crate) const MAX_ROWS: u32 = 1_048_576;
pub(crate) const MAX_COLUMNS: u32 = 16_384;
const MAX_XML_BYTES: usize = 24 * 1024 * 1024;
const CONTENT_TYPES: &str = "[Content_Types].xml";
pub(crate) const WORKBOOK: &str = "xl/workbook.xml";
const RELATIONSHIPS: &str = "xl/_rels/workbook.xml.rels";
pub(crate) const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const RID: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_REL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const XLSX_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

pub(crate) type Source<'a> = ZipArchive<Cursor<&'a [u8]>>;

pub(crate) fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message.to_string())
}

pub(crate) fn part(archive: &mut Source<'_>, path: &str) -> Result<String, RpcError> {
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

pub(crate) fn attribute(tag: &BytesStart<'_>, name: &str) -> Result<Option<String>, RpcError> {
    tag.try_get_attribute(name)
        .map_err(invalid)?
        .map(|attr| {
            attr.normalized_value(XmlVersion::Implicit1_0)
                .map(|value| value.into_owned())
                .map_err(invalid)
        })
        .transpose()
}

pub(crate) fn scan(
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

pub(crate) struct WorksheetLayout {
    pub(crate) path: String,
    table_rows: Vec<Dimensions>,
}

impl WorksheetLayout {
    pub(crate) fn allows_cell(&self, row: u32, column: u32) -> bool {
        !self
            .table_rows
            .iter()
            .any(|range| range.contains(row, column))
    }

    pub(crate) fn allows_address(&self, address: &str) -> bool {
        tables::position(address).is_some_and(|(row, column)| self.allows_cell(row, column))
    }
}

pub(crate) fn editable_worksheets(
    archive: &mut Source<'_>,
) -> Result<HashMap<String, WorksheetLayout>, RpcError> {
    check_editable(archive)?;
    let targets = worksheet_targets(archive)?;
    let xml = part(archive, WORKBOOK)?;
    let mut names = HashMap::new();
    scan(&xml, MAIN, |reader, tag, _, _, _, depth| {
        if depth != 2 || tag.local_name().as_ref() != "sheet" {
            return Ok(());
        }
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
        Ok(())
    })?;
    let mut table_parts = HashMap::new();
    Ok(names
        .into_iter()
        .filter_map(|(name, path)| {
            // A sheet whose table parts cannot be resolved is still available to read.
            let table_rows = tables::reserved_rows(archive, &path, &mut table_parts).ok()?;
            Some((name, WorksheetLayout { path, table_rows }))
        })
        .collect())
}
