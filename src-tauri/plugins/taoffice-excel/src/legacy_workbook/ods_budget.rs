use std::io::BufReader;

use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use taomni_plugin_api::RpcError;

use super::{MAX_EAGER_CELLS, MAX_EAGER_TEXT, MAX_SHEETS, OPEN_ERROR};
use crate::workbook_package::{MAX_COLUMNS, MAX_ROWS, Source, invalid};

#[derive(Default)]
struct Table {
    rows: usize,
    used_rows: usize,
    columns: usize,
}

struct Row {
    repeats: usize,
    columns: usize,
    pending_empty: usize,
    text: usize,
}

struct Cell {
    repeats: usize,
    start: u64,
    has_value: bool,
    spaces: usize,
}

fn limit() -> RpcError {
    invalid("This ODS workbook exceeds the worksheet preview limits")
}

fn repeat(element: &BytesStart<'_>, key: &str, maximum: usize) -> Result<usize, RpcError> {
    let Some(attribute) = element.try_get_attribute(key).map_err(invalid)? else {
        return Ok(1);
    };
    let value = attribute.value.parse::<usize>().map_err(invalid)?;
    if (1..=maximum).contains(&value) {
        Ok(value)
    } else {
        Err(limit())
    }
}

fn occupied(element: &BytesStart<'_>) -> Result<bool, RpcError> {
    for attribute in element.attributes() {
        let attribute = attribute.map_err(invalid)?;
        match attribute.key.as_ref() {
            "office:value"
            | "office:string-value"
            | "office:boolean-value"
            | "office:date-value"
            | "office:time-value"
            | "table:formula" => return Ok(true),
            "office:value-type" if attribute.value.as_ref() == "string" => return Ok(true),
            _ => (),
        }
    }
    Ok(false)
}

pub(super) fn check(
    package: &mut Source<'_>,
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<(), RpcError> {
    let entry = package
        .by_name("content.xml")
        .map_err(|_| invalid(OPEN_ERROR))?;
    let mut xml = Reader::from_reader(BufReader::new(entry));
    xml.config_mut().expand_empty_elements = true;
    let mut buffer = Vec::new();
    let mut table = None::<Table>;
    let mut row = None::<Row>;
    let mut cell = None::<Cell>;
    let (mut tables, mut dense_total, mut text_total) = (0usize, 0usize, 0usize);
    for index in 0.. {
        if index % 128 == 0 {
            check_current()?;
        }
        let position = xml.buffer_position();
        match xml.read_event_into(&mut buffer).map_err(invalid)? {
            Event::Start(e) if cell.is_some() => {
                if e.name().as_ref() == "text:s" {
                    let active = cell.as_mut().unwrap();
                    active.spaces =
                        active
                            .spaces
                            .saturating_add(repeat(&e, "text:c", MAX_EAGER_TEXT)?);
                    if active.spaces > MAX_EAGER_TEXT {
                        return Err(limit());
                    }
                } else if matches!(
                    e.name().as_ref(),
                    "table:table-cell" | "table:covered-table-cell"
                ) {
                    return Err(invalid(OPEN_ERROR));
                }
            }
            Event::Start(e) if e.name().as_ref() == "table:table" => {
                tables += 1;
                if tables > MAX_SHEETS || table.replace(Table::default()).is_some() {
                    return Err(limit());
                }
            }
            Event::Start(e) if table.is_some() && e.name().as_ref() == "table:table-row" => {
                let repeats = repeat(&e, "table:number-rows-repeated", MAX_ROWS as usize)?;
                if row
                    .replace(Row {
                        repeats,
                        columns: 0,
                        pending_empty: 0,
                        text: 0,
                    })
                    .is_some()
                {
                    return Err(invalid(OPEN_ERROR));
                }
            }
            Event::Start(e)
                if row.is_some()
                    && matches!(
                        e.name().as_ref(),
                        "table:table-cell" | "table:covered-table-cell"
                    ) =>
            {
                let repeats = repeat(&e, "table:number-columns-repeated", MAX_COLUMNS as usize)?;
                cell = Some(Cell {
                    repeats,
                    start: position,
                    has_value: occupied(&e)?,
                    spaces: 0,
                });
            }
            Event::End(e)
                if matches!(
                    e.name().as_ref(),
                    "table:table-cell" | "table:covered-table-cell"
                ) =>
            {
                if let (Some(cell), Some(row)) = (cell.take(), row.as_mut()) {
                    row.columns += row.pending_empty;
                    row.pending_empty = 0;
                    if cell.has_value {
                        row.columns += cell.repeats;
                        let encoded_bytes = (xml.buffer_position() - cell.start) as usize;
                        row.text = row.text.saturating_add(
                            encoded_bytes
                                .saturating_add(cell.spaces)
                                .saturating_mul(cell.repeats),
                        );
                    } else {
                        row.pending_empty = cell.repeats;
                    }
                    if row.columns + row.pending_empty > MAX_COLUMNS as usize
                        || row.text > MAX_EAGER_TEXT
                    {
                        return Err(limit());
                    }
                }
            }
            Event::End(e) if e.name().as_ref() == "table:table-row" => {
                if let (Some(row), Some(table)) = (row.take(), table.as_mut()) {
                    table.rows += row.repeats;
                    if table.rows > MAX_ROWS as usize {
                        return Err(limit());
                    }
                    if row.columns != 0 {
                        table.used_rows = table.rows;
                        table.columns = table.columns.max(row.columns);
                    }
                    text_total = text_total.saturating_add(row.text.saturating_mul(row.repeats));
                    if text_total > MAX_EAGER_TEXT {
                        return Err(limit());
                    }
                }
            }
            Event::End(e) if e.name().as_ref() == "table:table" => {
                if let Some(table) = table.take() {
                    dense_total =
                        dense_total.saturating_add(table.used_rows.saturating_mul(table.columns));
                    if dense_total > MAX_EAGER_CELLS {
                        return Err(limit());
                    }
                }
            }
            Event::DocType(_) => return Err(invalid(OPEN_ERROR)),
            Event::Eof => {
                if table.is_some() || row.is_some() || cell.is_some() || tables == 0 {
                    return Err(invalid(OPEN_ERROR));
                }
                return Ok(());
            }
            _ => (),
        }
        buffer.clear();
    }
    unreachable!()
}
