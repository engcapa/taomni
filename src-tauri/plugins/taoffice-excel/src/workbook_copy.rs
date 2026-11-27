use crate::workbook::Workbook;
use crate::workbook_package::{MAIN, WORKBOOK, invalid, part, scan};
use quick_xml::{Writer, events::Event};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
};
use taomni_plugin_api::RpcError;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

mod sheet;

pub const MAX_COPY_BYTES: usize = 24 * 1024 * 1024;
const MAX_EDITS: usize = 128;

#[derive(Deserialize)]
pub struct Edit {
    pub sheet: String,
    pub address: String,
    pub value: String,
}

fn recalculate_on_open(xml: &str) -> Result<Vec<u8>, RpcError> {
    let mut calc_tag = None;
    let mut insert_before = None;
    let mut calc_name = None;
    let root_end = scan(xml, MAIN, |_, tag, start, end, empty, depth| {
        match (depth, tag.local_name().as_ref()) {
            (0, "workbook") => {
                let name = tag.name();
                calc_name = Some(match name.as_ref().rsplit_once(':') {
                    Some((prefix, _)) => format!("{prefix}:calcPr"),
                    None => "calcPr".to_owned(),
                });
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
    Ok(bytes)
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
    let mut by_part = BTreeMap::<String, BTreeMap<String, String>>::new();
    for edit in edits {
        let layout = workbook
            .edit_layout(&edit.sheet)
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
        if !layout.allows_address(&edit.address) {
            return Err(invalid(
                "Table headers and totals are read-only in this viewer",
            ));
        }
        if by_part
            .entry(layout.path.clone())
            .or_default()
            .insert(edit.address, edit.value)
            .is_some()
        {
            return Err(invalid("A cell is edited more than once"));
        }
    }
    let recalculation = recalculate_on_open(&part(&mut archive, WORKBOOK)?)?;
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
