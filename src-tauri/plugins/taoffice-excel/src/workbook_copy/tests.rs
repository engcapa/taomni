use super::*;

const FILE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../qa-ui-auto-tests/fixtures/taoffice/quarterly.xlsx"
));

fn edit(address: &str, value: &str) -> Edit {
    Edit {
        sheet: "Totals".into(),
        address: address.into(),
        value: value.into(),
    }
}

fn read_entry(input: &mut Source<'_>, name: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    input
        .by_name(name)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    bytes
}

#[test]
fn replaces_only_targeted_cells_and_preserves_every_other_package_part() {
    let workbook = Workbook::open(FILE.to_vec()).unwrap();
    let result = create(
        &workbook,
        vec![edit("A2", " North & East "), edit("B2", "15.5")],
        || Ok(()),
    )
    .unwrap();
    let mut source = ZipArchive::new(Cursor::new(FILE)).unwrap();
    let mut copy = ZipArchive::new(Cursor::new(result.as_slice())).unwrap();
    let names: Vec<_> = source
        .file_names()
        .map(|name| name.unwrap().into_owned())
        .collect();
    assert_eq!(source.len(), copy.len());
    for name in names {
        if !matches!(name.as_str(), WORKBOOK | "xl/worksheets/sheet1.xml") {
            assert_eq!(
                read_entry(&mut source, &name),
                read_entry(&mut copy, &name),
                "{name}"
            );
        }
    }
    let sheet = part(&mut copy, "xl/worksheets/sheet1.xml").unwrap();
    assert!(sheet.contains(" North &amp; East "));
    assert!(sheet.contains("<c r=\"B2\"><v>15.5</v></c>"));
    assert!(sheet.contains("<c r=\"C2\"><f>B2*2</f><v>24</v></c>"));
    let workbook_xml = part(&mut copy, WORKBOOK).unwrap();
    assert!(workbook_xml.contains("fullCalcOnLoad=\"1\" forceFullCalc=\"1\""));
    let mut reopened = Workbook::open(result).unwrap();
    let result = serde_json::to_value(reopened.sheet("Totals", 0, 0, || Ok(())).unwrap()).unwrap();
    let cells = result["cells"].as_array().unwrap();
    assert!(cells.iter().any(|cell| cell["value"] == " North & East "));
    assert!(cells.iter().any(|cell| cell["value"] == "15.5"));
}

#[test]
fn rejects_formula_blank_duplicate_and_invalid_numeric_updates() {
    let workbook = Workbook::open(FILE.to_vec()).unwrap();
    for edits in [
        vec![edit("C2", "=1")],
        vec![edit("D2", "missing")],
        vec![edit("B2", "NaN")],
        vec![edit("A2", "Same"), edit("A2", "Other")],
    ] {
        assert!(create(&workbook, edits, || Ok(())).is_err());
    }
}

#[test]
fn adds_calculation_settings_in_schema_order_when_the_workbook_omits_them() {
    let xml = format!(
        r#"<m:workbook xmlns:m="{MAIN}" xmlns:r="{RID}"><m:sheets><m:sheet r:id="rId1" name="Sheet1"/></m:sheets><m:extLst/></m:workbook><!-- trailing comment </other> -->"#
    );
    let targets = HashMap::from([("rId1".into(), "xl/worksheets/sheet1.xml".into())]);
    let (sheets, rewritten) = workbook_parts(&xml, &targets).unwrap();
    assert_eq!(
        sheets,
        HashMap::from([("Sheet1".into(), "xl/worksheets/sheet1.xml".into())])
    );
    let rewritten = String::from_utf8(rewritten).unwrap();
    assert_eq!(
        rewritten,
        xml.replace(
            "<m:extLst/>",
            r#"<m:calcPr fullCalcOnLoad="1" forceFullCalc="1"/><m:extLst/>"#
        )
    );
    let xml = xml.replace("<m:extLst/>", "");
    let (_, rewritten) = workbook_parts(&xml, &targets).unwrap();
    assert_eq!(
        String::from_utf8(rewritten).unwrap(),
        xml.replace(
            "</m:workbook>",
            r#"<m:calcPr fullCalcOnLoad="1" forceFullCalc="1"/></m:workbook>"#
        )
    );
}

#[test]
fn preserves_excel_escapes_and_refuses_an_edit_to_a_protected_sheet() {
    let xml = format!(
        r#"<worksheet xmlns="{MAIN}"><sheetData><row><c r="A1" t="inlineStr"><is><t>original</t></is></c></row></sheetData>"#
    );
    let edit = || BTreeMap::from([("A1".into(), "_x000A_".into())]);
    assert!(
        sheet::rewrite(
            &format!("{xml}<sheetProtection/></worksheet>"),
            edit(),
            &mut || Ok(())
        )
        .is_err()
    );
    let out = sheet::rewrite(&format!("{xml}</worksheet>"), edit(), &mut || Ok(())).unwrap();
    assert!(String::from_utf8(out).unwrap().contains("_x005F_x000A_"));
}
