use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Seek, sink},
    panic::{AssertUnwindSafe, catch_unwind},
};

use calamine::{Data, DataRef, Ods, Reader, Xls, Xlsb, open_workbook_from_rs};
use serde::Deserialize;
use taomni_plugin_api::RpcError;

use crate::{
    workbook::{
        Cell, SheetWindow, WINDOW_COLUMNS, WINDOW_ROWS, check_package, excerpt, value_text,
        visible_sheets,
    },
    workbook_package::{MAX_COLUMNS, MAX_ROWS, Source, invalid},
};

mod ods_budget;
mod xls_budget;
mod xlsb_budget;

const MAX_EAGER_CELLS: usize = 500_000;
const MAX_EAGER_TEXT: usize = 16 * 1024 * 1024;
const MAX_SHEETS: usize = 256;
const OPEN_ERROR: &str =
    "This preview could not read the workbook. Check the file format, encryption or damage.";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LegacyFormat {
    Xls,
    Xlsb,
    Ods,
}

enum LegacyFile {
    Xls(Xls<Cursor<Vec<u8>>>),
    Xlsb(Xlsb<Cursor<Vec<u8>>>),
    Ods(Ods<Cursor<Vec<u8>>>),
}

pub(crate) struct LegacyWorkbook {
    file: LegacyFile,
    sheets: Vec<String>,
}

fn decode<T>(operation: impl FnOnce() -> Result<T, RpcError>) -> Result<T, RpcError> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| Err(invalid(OPEN_ERROR)))
}

fn checked_archive<'a>(
    bytes: &'a [u8],
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Source<'a>, RpcError> {
    let mut package = check_package(bytes, OPEN_ERROR)?;
    for index in 0..package.len() {
        check_current()?;
        let part = package.by_index(index).map_err(invalid)?;
        let size = part.size();
        let read = std::io::copy(&mut part.take(size + 1), &mut sink()).map_err(invalid)?;
        if read != size {
            return Err(invalid(
                "The workbook part does not match its expanded size",
            ));
        }
    }
    Ok(package)
}

impl LegacyWorkbook {
    pub(crate) fn open(
        bytes: Vec<u8>,
        format: LegacyFormat,
        check_current: impl FnMut() -> Result<(), RpcError>,
    ) -> Result<Self, RpcError> {
        let mut check_current = check_current;
        decode(|| {
            let (file, sheets) = match format {
                LegacyFormat::Xls => {
                    let bytes = xls_budget::checked_container(&bytes, &mut check_current)?;
                    let file = open_workbook_from_rs(Cursor::new(bytes)).map_err(invalid)?;
                    let sheets = visible_sheets(&file)?;
                    (LegacyFile::Xls(file), sheets)
                }
                LegacyFormat::Xlsb => {
                    let prepared = xlsb_budget::checked_parts(
                        &mut checked_archive(&bytes, &mut check_current)?,
                        &mut check_current,
                    )?;
                    let file = open_workbook_from_rs(Cursor::new(prepared.unwrap_or(bytes)))
                        .map_err(|_| invalid(OPEN_ERROR))?;
                    let sheets = visible_sheets(&file)?;
                    (LegacyFile::Xlsb(file), sheets)
                }
                LegacyFormat::Ods => {
                    ods_budget::check(
                        &mut checked_archive(&bytes, &mut check_current)?,
                        &mut check_current,
                    )?;
                    let file = open_workbook_from_rs(Cursor::new(bytes))
                        .map_err(|_| invalid(OPEN_ERROR))?;
                    let sheets = visible_sheets(&file)?;
                    (LegacyFile::Ods(file), sheets)
                }
            };
            check_current()?;
            Ok(Self { file, sheets })
        })
    }

    pub(crate) fn sheets(&self) -> &[String] {
        &self.sheets
    }

    pub(crate) fn sheet(
        &mut self,
        name: &str,
        row: u32,
        column: u32,
        mut check_current: impl FnMut() -> Result<(), RpcError>,
    ) -> Result<SheetWindow, RpcError> {
        if !self.sheets.iter().any(|sheet| sheet == name)
            || row >= MAX_ROWS
            || column >= MAX_COLUMNS
        {
            return Err(invalid(
                "The selected worksheet or cell range is unavailable",
            ));
        }
        check_current()?;
        let window = decode(|| match &mut self.file {
            LegacyFile::Xls(file) => eager_window(file, name, row, column),
            LegacyFile::Xlsb(file) => xlsb_window(file, name, row, column, &mut check_current),
            LegacyFile::Ods(file) => eager_window(file, name, row, column),
        })?;
        check_current()?;
        Ok(window)
    }
}

fn format_data(value: &Data) -> (String, bool) {
    match value {
        Data::String(value) | Data::DateTimeIso(value) | Data::DurationIso(value) => excerpt(value),
        Data::Bool(value) => value_text(&DataRef::Bool(*value)),
        Data::DateTime(value) => value_text(&DataRef::DateTime(*value)),
        _ => excerpt(&value.to_string()),
    }
}

fn eager_window<R: Read + Seek>(
    file: &mut impl Reader<R>,
    name: &str,
    start_row: u32,
    start_column: u32,
) -> Result<SheetWindow, RpcError> {
    let values = file
        .worksheet_range(name)
        .map_err(|_| invalid(OPEN_ERROR))?;
    let formulas = file
        .worksheet_formula(name)
        .map_err(|_| invalid(OPEN_ERROR))?;
    let end = values.end().into_iter().chain(formulas.end());
    let (rows, columns) = end.fold((1, 1), |(rows, columns), (row, column)| {
        (rows.max(row + 1), columns.max(column + 1))
    });
    let mut cells = Vec::new();
    for row in start_row..(start_row + WINDOW_ROWS).min(rows) {
        for column in start_column..(start_column + WINDOW_COLUMNS).min(columns) {
            let value = values
                .get_value((row, column))
                .map_or_else(|| (String::new(), false), format_data);
            let formula = formulas
                .get_value((row, column))
                .map(String::as_str)
                .map(|formula| {
                    formula
                        .strip_prefix("of:=")
                        .or_else(|| formula.strip_prefix("oooc:="))
                        .unwrap_or(formula)
                });
            cells.extend(Cell::read_only(row, column, value, formula));
        }
    }
    Ok(SheetWindow::read_only(rows, columns, cells))
}

fn xlsb_window(
    file: &mut Xlsb<Cursor<Vec<u8>>>,
    name: &str,
    start_row: u32,
    start_column: u32,
    mut check_current: impl FnMut() -> Result<(), RpcError>,
) -> Result<SheetWindow, RpcError> {
    let mut reader = file.worksheet_cells_reader(name).map_err(invalid)?;
    let end = reader.dimensions().end;
    let mut rows = end.0.saturating_add(1).clamp(1, MAX_ROWS);
    let mut columns = end.1.saturating_add(1).clamp(1, MAX_COLUMNS);
    let in_window = |row, column| {
        (start_row..start_row + WINDOW_ROWS).contains(&row)
            && (start_column..start_column + WINDOW_COLUMNS).contains(&column)
    };
    let mut cells = BTreeMap::new();
    let mut scanned = 0usize;
    while let Some(cell) = reader.next_cell().map_err(invalid)? {
        if scanned.is_multiple_of(128) {
            check_current()?;
        }
        scanned += 1;
        let (row, column) = cell.get_position();
        if row >= MAX_ROWS || column >= MAX_COLUMNS {
            return Err(invalid("Worksheet cell is outside the Excel range"));
        }
        rows = rows.max(row + 1);
        columns = columns.max(column + 1);
        if in_window(row, column)
            && cells
                .insert((row, column), (value_text(cell.get_value()), None))
                .is_some()
        {
            return Err(invalid("Worksheet contains duplicate cell entries"));
        }
    }
    drop(reader);
    let mut reader = file.worksheet_cells_reader(name).map_err(invalid)?;
    // A formula that this reader cannot decode leaves its cached cell value usable.
    while let Ok(Some(formula)) = reader.next_formula() {
        if scanned.is_multiple_of(128) {
            check_current()?;
        }
        scanned += 1;
        let (row, column) = formula.get_position();
        if in_window(row, column) {
            let entry = cells.entry((row, column)).or_default();
            entry.1 = Some(formula.get_value().clone());
        }
    }
    let cells = cells
        .into_iter()
        .filter_map(|((row, column), (value, formula))| {
            Cell::read_only(row, column, value, formula.as_deref())
        })
        .collect();
    Ok(SheetWindow::read_only(rows, columns, cells))
}

#[cfg(test)]
mod tests;
