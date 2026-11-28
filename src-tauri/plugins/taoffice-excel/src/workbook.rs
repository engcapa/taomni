use crate::workbook_package::{
    MAX_COLUMNS, MAX_ROWS, Source, WorksheetLayout, editable_worksheets, invalid,
};
use calamine::{Data, DataRef, Reader, SheetType, SheetVisible, Xlsx, open_workbook_from_rs};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::{io::Cursor, sync::Arc};
use taomni_plugin_api::RpcError;
use zip::ZipArchive;

pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const WINDOW_ROWS: u32 = 32;
pub const WINDOW_COLUMNS: u32 = 12;
const MAX_ENTRY_BYTES: u64 = 24 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PARTS: usize = 4096;
const MAX_SHEETS: usize = 256;
const MAX_CELL_CHARS: usize = 960;

pub struct Workbook {
    file: Xlsx<Cursor<Arc<[u8]>>>,
    sheets: Vec<String>,
    bytes: Arc<[u8]>,
    editable_sheets: HashMap<String, WorksheetLayout>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recalculated: Option<bool>,
    rows: u32,
    columns: u32,
    cells: Vec<Cell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cell {
    row: u32,
    column: u32,
    value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    formula: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit_type: Option<&'static str>,
    #[serde(skip_serializing_if = "is_false")]
    table_metadata: bool,
}

impl SheetWindow {
    pub fn apply_formula_values(&mut self, calculated: SheetWindow) {
        let values: HashMap<_, _> = calculated
            .cells
            .into_iter()
            .filter(|cell| cell.formula.is_some())
            .map(|cell| ((cell.row, cell.column), cell))
            .collect();
        for cell in self.cells.iter_mut().filter(|cell| cell.formula.is_some()) {
            if let Some(result) = values.get(&(cell.row, cell.column)) {
                cell.value.clone_from(&result.value);
                cell.truncated = result.truncated;
            }
        }
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

fn check_package(bytes: &[u8]) -> Result<Source<'_>, RpcError> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|_| {
        invalid("This workbook could not be opened as XLSX or XLSM. Check for encryption or file damage.")
    })?;
    let mut compressed_total = 0u64;
    let mut expanded_total = 0u64;
    if zip.len() > MAX_PARTS {
        return Err(invalid("The workbook contains too many parts"));
    }
    let mut names = HashSet::new();
    for index in 0..zip.len() {
        let part = zip.by_index_raw(index).map_err(invalid)?;
        let name = part.name().map_err(invalid)?.into_owned();
        if part.encrypted() || !names.insert(name) {
            return Err(invalid(
                "The workbook contains an encrypted or duplicate part",
            ));
        }
        let size = part.size();
        let compressed = part.compressed_size();
        compressed_total = compressed_total.saturating_add(compressed);
        expanded_total = expanded_total.saturating_add(size);
        if size > MAX_ENTRY_BYTES
            || expanded_total > MAX_EXPANDED_BYTES
            || compressed_total > bytes.len() as u64
        {
            return Err(invalid("The workbook exceeds the expanded preview limit"));
        }
    }
    Ok(zip)
}

fn excerpt(text: &str) -> (String, bool) {
    let Some((end, _)) = text.char_indices().nth(MAX_CELL_CHARS) else {
        return (text.to_owned(), false);
    };
    (format!("{}…", &text[..end]), true)
}

fn value_text(value: DataRef<'_>) -> (String, bool) {
    match value {
        DataRef::String(text) => excerpt(&text),
        DataRef::SharedString(text) => excerpt(text),
        DataRef::Bool(value) => (if value { "TRUE" } else { "FALSE" }.into(), false),
        DataRef::DateTime(value) => (
            value
                .as_datetime()
                .map_or_else(|| value.to_string(), |date| date.to_string()),
            false,
        ),
        _ => excerpt(&Data::from(value).to_string()),
    }
}

impl Workbook {
    pub fn open(bytes: Vec<u8>) -> Result<Self, RpcError> {
        let editable_sheets = editable_worksheets(&mut check_package(&bytes)?).unwrap_or_default();
        let bytes: Arc<[u8]> = bytes.into();
        let file: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes.clone())).map_err(invalid)?;
        let sheets: Vec<String> = file
            .sheets_metadata()
            .iter()
            .filter(|sheet| {
                sheet.typ == SheetType::WorkSheet && sheet.visible == SheetVisible::Visible
            })
            .map(|sheet| sheet.name.clone())
            .collect();
        if sheets.is_empty()
            || sheets.len() > MAX_SHEETS
            || sheets.iter().any(|name| name.len() > 256)
        {
            return Err(invalid("The workbook has no supported visible worksheets"));
        }
        Ok(Self {
            file,
            sheets,
            bytes,
            editable_sheets,
        })
    }

    pub fn sheets(&self) -> &[String] {
        &self.sheets
    }

    pub fn shared_bytes(&self) -> Arc<[u8]> {
        self.bytes.clone()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn edit_layout(&self, name: &str) -> Option<&WorksheetLayout> {
        self.editable_sheets.get(name)
    }

    pub fn sheet(
        &mut self,
        name: &str,
        start_row: u32,
        start_column: u32,
        mut check_current: impl FnMut() -> Result<(), RpcError>,
    ) -> Result<SheetWindow, RpcError> {
        if !self.sheets.iter().any(|sheet| sheet == name)
            || start_row >= MAX_ROWS
            || start_column >= MAX_COLUMNS
        {
            return Err(invalid(
                "The selected worksheet or cell range is unavailable",
            ));
        }
        let layout = self.editable_sheets.get(name);
        let mut reader = self.file.worksheet_cells_reader(name).map_err(invalid)?;
        let declared = reader.dimensions().end;
        let mut rows = declared.0.saturating_add(1).clamp(1, MAX_ROWS);
        let mut columns = declared.1.saturating_add(1).clamp(1, MAX_COLUMNS);
        let mut cells = Vec::new();
        let mut scanned = 0usize;
        while let Some(cell) = reader.next_cell_with_formula().map_err(invalid)? {
            scanned += 1;
            if scanned % 128 == 0 {
                check_current()?;
            }
            let (row, column) = cell.pos;
            if row >= MAX_ROWS || column >= MAX_COLUMNS {
                return Err(invalid("Worksheet cell is outside the Excel range"));
            }
            rows = rows.max(row + 1);
            columns = columns.max(column + 1);
            if (start_row..start_row + WINDOW_ROWS).contains(&row)
                && (start_column..start_column + WINDOW_COLUMNS).contains(&column)
            {
                let edit_type = match &cell.value {
                    DataRef::String(_) | DataRef::SharedString(_) => Some("text"),
                    DataRef::Int(_) | DataRef::Float(_) => Some("number"),
                    _ => None,
                };
                let (value, value_truncated) = value_text(cell.value);
                let table_metadata = layout.is_some_and(|sheet| !sheet.allows_cell(row, column));
                let edit_type = edit_type.filter(|_| {
                    layout.is_some()
                        && !table_metadata
                        && !value_truncated
                        && cell.formula.is_none()
                });
                let (formula, formula_truncated) = match cell.formula {
                    Some(formula) => {
                        let (formula, truncated) = excerpt(&formula);
                        (Some(formula), truncated)
                    }
                    None => (None, false),
                };
                if !value.is_empty() || formula.is_some() {
                    cells.push(Cell {
                        row,
                        column,
                        value,
                        formula,
                        truncated: value_truncated || formula_truncated,
                        edit_type,
                        table_metadata,
                    });
                }
            }
            if cells.len() > (WINDOW_ROWS * WINDOW_COLUMNS) as usize {
                return Err(invalid("Worksheet contains duplicate cell entries"));
            }
        }
        check_current()?;
        Ok(SheetWindow {
            recalculated: None,
            rows,
            columns,
            cells,
        })
    }
}

#[cfg(test)]
mod tests;
