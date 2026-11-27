use super::*;

const FILE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../qa-ui-auto-tests/fixtures/taoffice/quarterly.xlsx"
));

#[test]
fn reads_visible_sheets_and_cached_formulas_from_the_real_workbook() {
    let mut workbook = Workbook::open(FILE.to_vec()).unwrap();
    assert_eq!(workbook.sheets(), ["Totals", "Inventory"]);
    let window = workbook.sheet("Totals", 0, 0, || Ok(())).unwrap();
    assert_eq!((window.rows, window.columns), (35, 13));
    let formula = window
        .cells
        .iter()
        .find(|cell| (cell.row, cell.column) == (1, 2))
        .unwrap();
    assert_eq!(formula.value, "24");
    assert_eq!(formula.formula.as_deref(), Some("B2*2"));
    let later = workbook.sheet("Totals", 32, 12, || Ok(())).unwrap();
    assert_eq!(later.cells[0].value, "Beyond L");
    let other = workbook.sheet("Inventory", 0, 0, || Ok(())).unwrap();
    assert!(other.cells.iter().any(|cell| cell.value == "上海"));
    assert!(other.cells.iter().any(|cell| cell.value == "TRUE"));
    assert!(
        other
            .cells
            .iter()
            .any(|cell| cell.value.starts_with("2026-11-27"))
    );
    assert!(workbook.sheet("Internal", 0, 0, || Ok(())).is_err());
}

#[test]
fn stops_a_cancelled_read_and_rejects_a_non_workbook() {
    assert!(Workbook::open(b"not an excel workbook".to_vec()).is_err());
    let mut workbook = Workbook::open(FILE.to_vec()).unwrap();
    assert!(
        workbook
            .sheet("Totals", 0, 0, || Err(invalid("Cancelled")))
            .is_err()
    );
    assert!(workbook.sheet("Totals", 0, 0, || Ok(())).is_ok());
}
