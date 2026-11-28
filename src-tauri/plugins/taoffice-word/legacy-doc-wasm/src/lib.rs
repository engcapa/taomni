use office_oxide::{Document, DocumentFormat, create, options::ParseOptions};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const COMPOUND_FILE_HEADER: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";

#[wasm_bindgen]
pub fn convert_doc(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    convert(bytes).map_err(JsError::new)
}

fn convert(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("limits");
    }
    if !bytes.starts_with(COMPOUND_FILE_HEADER) {
        return Err("format");
    }
    let options = ParseOptions::strict();
    let source =
        Document::from_reader_with(Cursor::new(bytes.to_vec()), DocumentFormat::Doc, &options)
            .map_err(|_| "format")?;
    let mut output = Cursor::new(Vec::new());
    create::create_from_ir_to_writer(&source.to_ir(), DocumentFormat::Docx, &mut output)
        .map_err(|_| "format")?;
    let output = output.into_inner();
    if output.len() > MAX_BYTES {
        return Err("limits");
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_word_97_paragraphs_and_table_to_docx() {
        let original =
            include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-notes.doc");
        let copy = convert(original).unwrap();
        let docx = Document::from_reader(Cursor::new(copy), DocumentFormat::Docx).unwrap();
        let text = docx.plain_text();
        assert!(text.contains("Baseline plan & owners"));
        assert!(text.contains("Pilot"));
        assert!(text.contains("Ready"));
        assert!(text.contains("Keep the next page unchanged."));
    }

    #[test]
    fn rejects_truncated_and_unrelated_documents() {
        assert_eq!(convert(b""), Err("format"));
        assert_eq!(convert(COMPOUND_FILE_HEADER), Err("format"));
    }
}
