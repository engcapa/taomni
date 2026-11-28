use super::Edit;
use crate::workbook::Workbook;
use crate::workbook_package::position;
use ironcalc::{
    base::{
        Model,
        expressions::{token::Error, utils::number_to_column},
        types::{Cell, FormulaValue},
    },
    import::load_from_xlsx_bytes,
};
use std::collections::BTreeMap;
use taomni_plugin_api::RpcError;

pub(super) struct CachedValue {
    pub(super) kind: &'static str,
    pub(super) value: String,
}

type SheetValues = BTreeMap<String, CachedValue>;
pub(super) type Calculation = BTreeMap<String, SheetValues>;

fn cache_value(value: &FormulaValue) -> Option<CachedValue> {
    let (kind, value) = match value {
        FormulaValue::Number(v) if v.is_finite() => ("n", v.to_string()),
        FormulaValue::Boolean(v) => ("b", u8::from(*v).to_string()),
        FormulaValue::Text(v) => ("str", v.clone()),
        FormulaValue::Error { ei, .. } => match ei {
            Error::REF | Error::VALUE | Error::DIV | Error::NA | Error::NUM | Error::NULL => {
                ("e", ei.to_string())
            }
            // Preserve Excel's cached results if this engine cannot evaluate the workbook.
            _ => return None,
        },
        _ => return None,
    };
    Some(CachedValue { kind, value })
}

fn apply(model: &mut Model<'_>, names: &[String], edit: &Edit) -> Option<()> {
    let index = names.iter().position(|name| name == &edit.sheet)? as u32;
    let (row, column) = position(&edit.address)?;
    let (row, column) = (row as i32 + 1, column as i32 + 1);
    let cell = model.workbook.worksheet(index).ok()?.cell(row, column)?;
    match cell.as_ref() {
        Cell::SharedString { .. } => model.update_cell_with_text(index, row, column, &edit.value),
        Cell::NumberCell { .. } => {
            model.update_cell_with_number(index, row, column, edit.value.trim().parse().ok()?)
        }
        _ => return None,
    }
    .ok()
}

/// Calculate against the original package in memory. Only cached scalar values
/// are returned to the surgical writer; the engine never serializes the workbook.
pub(super) fn calculate(
    book: &Workbook,
    edits: &[Edit],
    check_current: &mut impl FnMut() -> Result<(), RpcError>,
) -> Result<Option<Calculation>, RpcError> {
    let Ok(source) = load_from_xlsx_bytes(book.bytes(), "Workbook", "en", "UTC") else {
        return Ok(None);
    };
    let names = source.get_worksheet_names();
    let Ok(mut model) = Model::from_workbook(source, "en") else {
        return Ok(None);
    };
    for edit in edits {
        check_current()?;
        if apply(&mut model, &names, edit).is_none() {
            return Ok(None);
        }
    }
    model.evaluate();
    check_current()?;
    let mut result = Calculation::new();
    for (index, sheet) in model.workbook.worksheets.iter().enumerate() {
        let mut values = SheetValues::new();
        for (count, (row, column, cell)) in sheet.sheet_data.cells().enumerate() {
            if count % 256 == 0 {
                check_current()?
            }
            match cell.as_ref() {
                Cell::CellFormula { v, .. } => {
                    let (Some(value), Some(column)) = (cache_value(v), number_to_column(column))
                    else {
                        return Ok(None);
                    };
                    values.insert(format!("{column}{row}"), value);
                }
                Cell::ArrayFormula { .. } | Cell::SpillCell { .. } => return Ok(None),
                _ => {}
            }
        }
        if !values.is_empty() {
            let Some(layout) = book.edit_layout(&names[index]) else {
                return Ok(None);
            };
            result.insert(layout.path.clone(), values);
        }
    }
    Ok(Some(result))
}
