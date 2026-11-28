use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
};

use cfb::{CompoundFile, Version};
use taomni_plugin_api::RpcError;

use super::{MAX_EAGER_CELLS, MAX_EAGER_TEXT, MAX_SHEETS, OPEN_ERROR};
use crate::{workbook::MAX_INPUT_BYTES, workbook_package::invalid};

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const FILE_PASS: u16 = 0x002F;
const SHEET: u16 = 0x0085;
const SHARED_STRINGS: u16 = 0x00FC;
const CONTINUE: u16 = 0x003C;
const DIMENSIONS: u16 = 0x0200;
const FORMULA: u16 = 0x0006;
const SHARED_STRING_CELL: u16 = 0x00FD;

pub(super) fn checked_container(
    bytes: &[u8],
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let mut container = CompoundFile::open(Cursor::new(bytes)).map_err(|_| damaged())?;
    let path = if container.is_stream("/Workbook") {
        "/Workbook"
    } else {
        "/Book"
    };
    let stream = container.open_stream(path).map_err(|_| damaged())?;
    if stream.len() > bytes.len() as u64 {
        return Err(damaged());
    }
    let mut workbook = Vec::new();
    stream
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut workbook)
        .map_err(invalid)?;
    check_biff(&workbook, check_current)?;
    check_current()?;

    // Calamine receives a canonical compound file containing only the validated workbook stream.
    let mut output =
        CompoundFile::create_with_version(Version::V3, Cursor::new(Vec::new())).map_err(invalid)?;
    {
        let mut stream = output.create_stream(path).map_err(invalid)?;
        stream.write_all(&workbook).map_err(invalid)?;
        stream.flush().map_err(invalid)?;
    }
    output.flush().map_err(invalid)?;
    Ok(output.into_inner().into_inner())
}

fn damaged() -> RpcError {
    invalid(OPEN_ERROR)
}

fn budget() -> RpcError {
    invalid("This XLS workbook exceeds the worksheet preview limits")
}

fn u16_at(bytes: &[u8], index: usize) -> Result<u16, RpcError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(index..index + 2)
            .ok_or_else(damaged)?
            .try_into()
            .unwrap(),
    ))
}

fn u32_at(bytes: &[u8], index: usize) -> Result<u32, RpcError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(index..index + 4)
            .ok_or_else(damaged)?
            .try_into()
            .unwrap(),
    ))
}

fn take<'a>(input: &mut &'a [u8], count: usize) -> Result<&'a [u8], RpcError> {
    let (part, remaining) = input.split_at_checked(count).ok_or_else(damaged)?;
    *input = remaining;
    Ok(part)
}

fn record<'a>(input: &mut &'a [u8]) -> Result<(u16, &'a [u8]), RpcError> {
    let header = take(input, 4)?;
    Ok((
        u16_at(header, 0)?,
        take(input, u16_at(header, 2)? as usize)?,
    ))
}

fn check_biff(
    bytes: &[u8],
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<(), RpcError> {
    let mut input = bytes;
    let mut sheets = HashSet::new();
    let mut strings = Vec::new();
    let mut text = 0usize;
    for index in 0.. {
        if index % 128 == 0 {
            check_current()?;
        }
        let (kind, value) = record(&mut input)?;
        match kind {
            SHEET => {
                if sheets.len() == MAX_SHEETS {
                    return Err(budget());
                }
                if value.len() < 7 || !sheets.insert(u32_at(value, 0)? as usize) {
                    return Err(damaged());
                }
            }
            FILE_PASS => return Err(damaged()),
            SHARED_STRINGS => strings = string_lengths(value, &mut input, check_current)?,
            EOF => break,
            _ => (),
        }
    }
    let globals_end = bytes.len() - input.len();
    let mut dense_total = 0usize;
    for offset in sheets {
        if offset < globals_end {
            return Err(damaged());
        }
        let sheet = bytes.get(offset..).ok_or_else(damaged)?;
        dense_total += check_sheet(sheet, &strings, &mut text, check_current)?;
        if dense_total > MAX_EAGER_CELLS {
            return Err(budget());
        }
    }
    Ok(())
}

fn string_lengths(
    table: &[u8],
    input: &mut &[u8],
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Vec<usize>, RpcError> {
    let mut fragments = vec![table.get(8..).ok_or_else(damaged)?];
    while input.len() > 4 && u16_at(input, 0)? == CONTINUE {
        fragments.push(record(input)?.1);
    }
    let mut parts = fragments
        .into_iter()
        .filter(|fragment| !fragment.is_empty());
    let mut value = parts.next().unwrap_or_default();
    let mut lengths = Vec::new();
    let mut text_bytes = 0usize;
    while !value.is_empty() {
        if lengths.len().is_multiple_of(128) {
            check_current()?;
        }
        if lengths.len() == MAX_EAGER_CELLS {
            return Err(budget());
        }
        let count = u16_at(value, 0)? as usize;
        let flags = take(&mut value, 3)?[2];
        let rich = if flags & 8 != 0 {
            u16_at(take(&mut value, 2)?, 0)? as usize * 4
        } else {
            0
        };
        let extension = if flags & 4 != 0 {
            u32_at(take(&mut value, 4)?, 0)? as usize
        } else {
            0
        };
        let mut width = 1 + usize::from(flags & 1);
        let mut left = count;
        while left != 0 {
            let consume = left.min(value.len() / width);
            take(&mut value, consume * width)?;
            left -= consume;
            if left != 0 {
                value = parts.next().ok_or_else(damaged)?;
                width = 1 + usize::from(take(&mut value, 1)?[0] & 1);
            }
        }
        let mut metadata = rich.saturating_add(extension);
        while metadata != 0 {
            let consume = metadata.min(value.len());
            take(&mut value, consume)?;
            metadata -= consume;
            if value.is_empty() {
                value = parts.next().unwrap_or_default();
                if value.is_empty() && metadata != 0 {
                    return Err(damaged());
                }
            }
        }
        let text_size = count * 4;
        text_bytes += text_size;
        if text_bytes > MAX_EAGER_TEXT {
            return Err(budget());
        }
        lengths.push(text_size);
        if value.is_empty() {
            value = parts.next().unwrap_or_default();
        }
    }
    Ok(lengths)
}

fn dimensions(value: &[u8]) -> Result<usize, RpcError> {
    let (first_row, end_row, first_column, end_column) = match value.len() {
        10 => (
            u16_at(value, 0)? as u32,
            u16_at(value, 2)? as u32,
            u16_at(value, 4)?,
            u16_at(value, 6)?,
        ),
        14 | 16 => (
            u32_at(value, 0)?,
            u32_at(value, 4)?,
            u16_at(value, 8)?,
            u16_at(value, 10)?,
        ),
        _ => return Err(damaged()),
    };
    if first_row >= 65_536 || end_row > 65_536 || first_column > 255 || end_column > 256 {
        return Err(budget());
    }
    let rows = end_row.saturating_sub(first_row).max(1) as usize;
    let columns = end_column.saturating_sub(first_column).max(1) as usize;
    if (end_row != 0 && end_row <= first_row) || (end_column != 0 && end_column <= first_column) {
        return Err(damaged());
    }
    Ok(rows * columns)
}

fn check_sheet(
    mut input: &[u8],
    strings: &[usize],
    text: &mut usize,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<usize, RpcError> {
    if record(&mut input)?.0 != BOF {
        return Err(damaged());
    }
    let (mut row_min, mut row_max, mut col_min, mut col_max) = (u16::MAX, 0, u16::MAX, 0);
    let mut declared = 0;
    let mut stored = 0usize;
    let mut nested = 0usize;
    for index in 0.. {
        if index % 128 == 0 {
            check_current()?;
        }
        let (kind, value) = record(&mut input)?;
        match kind {
            BOF => nested += 1,
            EOF if nested == 0 => break,
            EOF => nested -= 1,
            _ if nested != 0 => (),
            DIMENSIONS => {
                declared = declared.max(dimensions(value)?);
                if declared > MAX_EAGER_CELLS {
                    return Err(budget());
                }
            }
            0x0203 | 0x0204 | 0x00D6 | 0x0205 | 0x027E | 0x00BD | SHARED_STRING_CELL | FORMULA => {
                let row = u16_at(value, 0)?;
                let column = u16_at(value, 2)?;
                let end_column = if kind == 0x00BD && value.len() >= 6 {
                    u16_at(value, value.len() - 2)?
                } else {
                    column
                };
                if column > end_column || end_column > 255 {
                    return Err(damaged());
                }
                stored += usize::from(end_column - column) + 1;
                if stored > MAX_EAGER_CELLS {
                    return Err(budget());
                }
                row_min = row_min.min(row);
                row_max = row_max.max(row);
                col_min = col_min.min(column);
                col_max = col_max.max(end_column);
                let size = match kind {
                    SHARED_STRING_CELL => *strings
                        .get(u32_at(value, 6)? as usize)
                        .ok_or_else(damaged)?,
                    FORMULA => value.len().saturating_sub(20) * 64,
                    0x0204 | 0x00D6 => value.len() * 4,
                    _ => 0,
                };
                *text = text.saturating_add(size);
            }
            0x0207 => *text = text.saturating_add(value.len() * 4),
            _ => (),
        }
        if *text > MAX_EAGER_TEXT {
            return Err(budget());
        }
    }
    let actual = if row_min > row_max {
        0
    } else {
        (usize::from(row_max - row_min) + 1) * (usize::from(col_max - col_min) + 1)
    };
    Ok(actual.max(declared).max(stored))
}
