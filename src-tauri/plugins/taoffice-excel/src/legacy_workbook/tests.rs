use std::io::Write;

use super::*;
use serde_json::Value;
use zip::{ZipWriter, write::SimpleFileOptions};

const XLS: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-orders.xls");
const XLSB: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-orders.xlsb");
const ODS: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-orders.ods");

fn cell(window: &Value, row: u32, column: u32) -> &Value {
    window["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cell| cell["row"] == row && cell["column"] == column)
        .unwrap_or_else(|| panic!("missing cell at ({row}, {column}) in {window}"))
}

#[test]
fn reads_three_real_workbooks_without_editable_cells() {
    for (format, bytes, formula) in [
        (LegacyFormat::Xls, XLS, Some("B2*3")),
        (LegacyFormat::Xlsb, XLSB, None),
        (LegacyFormat::Ods, ODS, Some("[.B2]*3")),
    ] {
        let mut workbook = LegacyWorkbook::open(bytes.to_vec(), format, || Ok(()))
            .unwrap_or_else(|error| panic!("{format:?} opening failed: {error:?}"));
        assert_eq!(workbook.sheets(), ["Orders", "Stock"]);
        let orders = workbook.sheet("Orders", 0, 0, || Ok(())).unwrap();
        let snapshot = serde_json::to_value(orders).unwrap();
        assert_eq!(snapshot["rows"], 35);
        assert_eq!(snapshot["columns"], 13);
        let amount = cell(&snapshot, 1, 2);
        assert_eq!(amount["value"], "21");
        assert_eq!(amount["formula"].as_str(), formula);
        assert!(amount.get("editType").is_none());
        assert!(cell(&snapshot, 1, 1).get("editType").is_none());

        let far = workbook.sheet("Orders", 32, 12, || Ok(())).unwrap();
        assert_eq!(
            cell(&serde_json::to_value(far).unwrap(), 34, 12)["value"],
            "Far corner"
        );
        let stock =
            serde_json::to_value(workbook.sheet("Stock", 0, 0, || Ok(())).unwrap()).unwrap();
        assert_eq!(cell(&stock, 1, 0)["value"], "上海");
        assert_eq!(cell(&stock, 1, 1)["value"], "TRUE");
        assert!(workbook.sheet("Internal", 0, 0, || Ok(())).is_err());
    }
}

#[test]
fn cancellation_and_invalid_format_leave_a_current_workbook_readable() {
    assert!(
        LegacyWorkbook::open(XLS.to_vec(), LegacyFormat::Xls, || Err(invalid(
            "Cancelled"
        )))
        .is_err()
    );
    assert!(LegacyWorkbook::open(ODS.to_vec(), LegacyFormat::Xlsb, || Ok(())).is_err());
    assert!(
        LegacyWorkbook::open(b"Damaged workbook".to_vec(), LegacyFormat::Ods, || Ok(())).is_err()
    );
    let mut workbook = LegacyWorkbook::open(XLSB.to_vec(), LegacyFormat::Xlsb, || Ok(())).unwrap();
    assert!(
        workbook
            .sheet("Orders", 0, 0, || Err(invalid("Cancelled")))
            .is_err()
    );
    assert!(workbook.sheet("Orders", 0, 0, || Ok(())).is_ok());
}

#[test]
fn rejects_ods_expansion_before_allocating_a_cell_range() {
    let content = br#"<office:document-content><table:table><table:table-row table:number-rows-repeated="500001"><table:table-cell office:value="1"/></table:table-row></table:table></office:document-content>"#;
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file("content.xml", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(content).unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let result = LegacyWorkbook::open(bytes, LegacyFormat::Ods, || Ok(()));
    assert!(matches!(result, Err(error) if error.message.contains("worksheet preview limits")));
}
