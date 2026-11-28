use office_oxide::{Document, DocumentFormat, create, options::ParseOptions};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_BYTES: usize = 24 * 1024 * 1024;
const COMPOUND_FILE_HEADER: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";

#[wasm_bindgen]
pub fn convert_ppt(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
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
        Document::from_reader_with(Cursor::new(bytes.to_vec()), DocumentFormat::Ppt, &options)
            .map_err(|_| "format")?;
    let slide_count = source.as_ppt().ok_or("format")?.slides.len();
    if slide_count == 0 {
        return Err("format");
    }
    if slide_count > 300 {
        return Err("limits");
    }
    let mut output = Cursor::new(Vec::new());
    create::create_from_ir_to_writer(&source.to_ir(), DocumentFormat::Pptx, &mut output)
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
    fn exports_both_binary_slides_to_an_editable_presentation() {
        let original =
            include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/legacy-review.ppt");
        let converted = convert(original).unwrap();
        let deck = Document::from_reader(Cursor::new(converted), DocumentFormat::Pptx).unwrap();
        let text = deck.plain_text();
        assert!(text.contains("Quarterly review"), "{text}");
        assert!(text.contains("Delivery appendix"), "{text}");
        assert!(text.contains("Pilot moves"), "{text}");
        assert_eq!(deck.as_pptx().unwrap().slides.len(), 2);
    }

    #[test]
    fn rejects_invalid_and_over_limit_input() {
        assert_eq!(convert(b"ordinary text"), Err("format"));
        assert_eq!(convert(COMPOUND_FILE_HEADER), Err("format"));
        assert_eq!(convert(&vec![0; MAX_BYTES + 1]), Err("limits"));
    }
}
