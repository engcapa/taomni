use super::calculation::CachedValue;
use super::formula_cache;
use super::{Edit, create};
use crate::workbook::Workbook;
use crate::workbook_package::{MAIN, part};
use std::{collections::BTreeMap, io::Cursor};
use zip::ZipArchive;

const FORECAST: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../qa-ui-auto-tests/fixtures/taoffice/forecast.xlsx"
));

#[test]
fn recalculates_dependent_sheets_and_reopens_typed_results() {
    let workbook = Workbook::open(FORECAST.to_vec()).unwrap();
    let edits = [Edit {
        sheet: "Totals".into(),
        address: "B2".into(),
        value: "15.5".into(),
    }];
    let copy = create(&workbook, &edits, || Ok(())).unwrap();
    assert!(copy.recalculated);
    let mut package = ZipArchive::new(Cursor::new(copy.bytes.as_slice())).unwrap();
    let sheet = part(&mut package, "xl/worksheets/sheet2.xml").unwrap();
    assert!(sheet.contains("<f>SUM(Totals!C2:C3)</f><v>47</v>"));
    assert!(sheet.contains("<v>Review</v>"));
    let mut reopened = Workbook::open(copy.bytes).unwrap();
    let window = reopened.sheet("Inventory", 0, 0, || Ok(())).unwrap();
    let grid = serde_json::to_value(window).unwrap();
    let cells = grid["cells"].as_array().unwrap();
    assert!(
        cells
            .iter()
            .any(|cell| cell["formula"] == "SUM(Totals!C2:C3)" && cell["value"] == "47")
    );
    assert!(cells.iter().any(
        |cell| cell["formula"] == "IF(D2>40,\"Review\",\"Ready\")" && cell["value"] == "Review"
    ));
}

#[test]
fn patches_only_the_result_type_and_value_for_a_prefixed_formula_with_an_extension() {
    let sheet = format!(
        r#"<s:worksheet xmlns:s="{MAIN}"><s:sheetData><s:row r="1"><s:c r="C1" s="3"><s:f>IF(A1,B1,0)</s:f><s:extLst/></s:c><s:c r="D1"><s:f>B1</s:f><s:v>2</s:v></s:c></s:row></s:sheetData></s:worksheet>"#
    );
    let values = BTreeMap::from([(
        "C1".into(),
        CachedValue {
            kind: "str",
            value: "A < B & C".into(),
        },
    )]);
    let output = formula_cache::rewrite(&sheet, values, &mut || Ok(()))
        .unwrap()
        .unwrap();
    let expected = sheet
        .replace(r#"r="C1" s="3""#, r#"r="C1" s="3" t="str""#)
        .replace("<s:extLst/>", "<s:v>A &lt; B &amp; C</s:v><s:extLst/>");
    assert_eq!(String::from_utf8(output).unwrap(), expected);
}

#[test]
fn removes_the_calculation_chain_and_retains_other_relationships() {
    use std::io::Write;
    use zip::{ZipWriter, write::SimpleFileOptions};
    let mut source = ZipArchive::new(Cursor::new(FORECAST)).unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..source.len() {
        let file = source.by_index_raw(index).unwrap();
        let name = file.name().unwrap().into_owned();
        let child = match name.as_str() {
            "xl/_rels/workbook.xml.rels" => Some((
                "</Relationships>",
                r#"<Relationship Id="rCalc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"></Relationship>"#,
            )),
            "[Content_Types].xml" => Some((
                "</Types>",
                r#"<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>"#,
            )),
            _ => None,
        };
        if let Some((close, element)) = child {
            drop(file);
            let xml = part(&mut source, &name)
                .unwrap()
                .replace(close, &format!("{element}{close}"));
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(xml.as_bytes()).unwrap();
        } else {
            writer.raw_copy_file(file).unwrap();
        }
    }
    writer
        .start_file("xl/calcChain.xml", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(format!(r#"<calcChain xmlns="{MAIN}"><c r="C2" i="1"/></calcChain>"#).as_bytes())
        .unwrap();
    let workbook = Workbook::open(writer.finish().unwrap().into_inner()).unwrap();
    let edit = Edit {
        sheet: "Totals".into(),
        address: "B2".into(),
        value: "9".into(),
    };
    let copy = create(&workbook, &[edit], || Ok(())).unwrap();
    let mut result = ZipArchive::new(Cursor::new(copy.bytes.as_slice())).unwrap();
    assert!(result.by_name("xl/calcChain.xml").is_err());
    let relationships = part(&mut result, "xl/_rels/workbook.xml.rels").unwrap();
    assert!(!relationships.contains("calcChain"));
    assert!(relationships.contains("worksheets/sheet2.xml"));
    let content_types = part(&mut result, "[Content_Types].xml").unwrap();
    assert!(!content_types.contains("calcChain"));
    assert!(content_types.contains("/xl/worksheets/sheet2.xml"));
}
