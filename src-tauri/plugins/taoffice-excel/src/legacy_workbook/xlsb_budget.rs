use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
};

use taomni_plugin_api::RpcError;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use super::{MAX_SHEETS, OPEN_ERROR};
use crate::{
    workbook::{MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES},
    workbook_package::{MAX_COLUMNS, Source, invalid},
};

const BEGIN_SHEET_DATA: usize = 0x0091;
const END_SHEET_DATA: usize = 0x0092;
const ROW_HEADER: usize = 0x0000;
const BUNDLE_SHEET: usize = 0x009C;

pub(super) fn checked_parts(
    package: &mut Source<'_>,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Option<Vec<u8>>, RpcError> {
    let mut workbook_found = false;
    let mut normalized = HashMap::new();
    let mut expanded = 0;
    for index in 0..package.len() {
        check_current()?;
        let entry = package.by_index(index).map_err(invalid)?;
        let name = entry.name().map_err(invalid)?.to_ascii_lowercase();
        let workbook = name == "xl/workbook.bin";
        let worksheet =
            name.starts_with("xl/worksheets/") && !name.ends_with(".rels") && !entry.is_dir();
        workbook_found |= workbook;
        expanded += entry.size();
        if workbook || worksheet || name == "xl/sharedstrings.bin" || name == "xl/styles.bin" {
            let mut records = Vec::new();
            entry
                .take(MAX_ENTRY_BYTES + 1)
                .read_to_end(&mut records)
                .map_err(invalid)?;
            if records.len() as u64 > MAX_ENTRY_BYTES {
                return Err(expansion_error());
            }
            if let Some(data) = check_records(&records, workbook, worksheet, check_current)? {
                expanded += (data.len() - records.len()) as u64;
                normalized.insert(index, data);
            }
        }
        if expanded > MAX_EXPANDED_BYTES {
            return Err(expansion_error());
        }
    }
    if !workbook_found {
        return Err(invalid(OPEN_ERROR));
    }
    if normalized.is_empty() {
        return Ok(None);
    }

    let mut output = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..package.len() {
        check_current()?;
        let entry = package.by_index_raw(index).map_err(invalid)?;
        if let Some(sheet) = normalized.remove(&index) {
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            output
                .start_file(entry.name().map_err(invalid)?, options)
                .map_err(invalid)?;
            output.write_all(&sheet).map_err(invalid)?;
        } else {
            output.raw_copy_file(entry).map_err(invalid)?;
        }
    }
    Ok(Some(output.finish().map_err(invalid)?.into_inner()))
}

fn expansion_error() -> RpcError {
    invalid("The workbook exceeds the expanded preview limit")
}

fn varint(input: &mut &[u8], limit: usize) -> Result<usize, RpcError> {
    let mut output = 0;
    for shift in 0..limit {
        let (&byte, tail) = input.split_first().ok_or_else(|| invalid(OPEN_ERROR))?;
        *input = tail;
        output |= usize::from(byte & 0x7f) << (7 * shift);
        if byte < 0x80 {
            return Ok(output);
        }
    }
    Err(invalid(OPEN_ERROR))
}

fn write_varint(out: &mut Vec<u8>, mut value: usize) {
    while value >= 128 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn check_records(
    records: &[u8],
    workbook: bool,
    worksheet: bool,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Option<Vec<u8>>, RpcError> {
    let mut input = records;
    let mut count = 0usize;
    let mut sheets = 0usize;
    let mut in_sheet_data = false;
    let mut next_column = 0u32;
    let mut normalized = None::<Vec<u8>>;
    while !input.is_empty() {
        if count.is_multiple_of(128) {
            check_current()?;
        }
        count += 1;
        let offset = records.len() - input.len();
        let kind = varint(&mut input, 2)?;
        let size = varint(&mut input, 4)?;
        let (value, remaining) = input
            .split_at_checked(size)
            .ok_or_else(|| invalid(OPEN_ERROR))?;
        input = remaining;
        if workbook && kind == BUNDLE_SHEET {
            sheets += 1;
            if sheets > MAX_SHEETS {
                return Err(invalid("This workbook contains too many worksheets"));
            }
        }
        let replacement = if worksheet {
            match kind {
                BEGIN_SHEET_DATA => {
                    in_sheet_data = true;
                    None
                }
                END_SHEET_DATA => {
                    in_sheet_data = false;
                    None
                }
                ROW_HEADER if in_sheet_data => {
                    next_column = 0;
                    None
                }
                0x0001..=0x000B if in_sheet_data => {
                    let bytes = value.get(..4).ok_or_else(|| invalid(OPEN_ERROR))?;
                    let column = u32::from_le_bytes(bytes.try_into().unwrap());
                    if column >= MAX_COLUMNS {
                        return Err(invalid("Worksheet cell is outside the Excel range"));
                    }
                    next_column = column + 1;
                    None
                }
                // BrtShort cells omit the column when consecutive cells share a row.
                0x000C..=0x0012 if in_sheet_data => {
                    if next_column >= MAX_COLUMNS || value.len() < 4 {
                        return Err(invalid(OPEN_ERROR));
                    }
                    let column = next_column;
                    next_column += 1;
                    Some((kind - 0x000B, column))
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some((kind, column)) = replacement {
            let out = normalized.get_or_insert_with(|| records[..offset].to_vec());
            write_varint(out, kind);
            write_varint(out, size + 4);
            out.extend_from_slice(&column.to_le_bytes());
            out.extend_from_slice(value);
        } else if let Some(out) = normalized.as_mut() {
            out.extend_from_slice(&records[offset..records.len() - input.len()]);
        }
        if normalized
            .as_ref()
            .is_some_and(|bytes| bytes.len() as u64 > MAX_ENTRY_BYTES)
        {
            return Err(expansion_error());
        }
    }
    Ok(normalized)
}
