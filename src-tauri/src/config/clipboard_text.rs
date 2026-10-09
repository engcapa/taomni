//! Validate text supplied by an external clipboard owner without replacing bytes.

pub(super) fn decode_payload(program: &str, bytes: Vec<u8>) -> Result<Option<String>, String> {
    let text = String::from_utf8(bytes)
        .map_err(|error| format!("{program}: clipboard text is not valid UTF-8: {error}"))?;
    Ok((!text.trim().is_empty()).then_some(text))
}

#[cfg(test)]
mod tests {
    use super::decode_payload;

    #[test]
    fn preserves_unicode_and_trailing_newlines() {
        let original = "中文\nexternal-owner-payload\n";
        assert_eq!(
            decode_payload("wl-paste", original.as_bytes().to_vec()),
            Ok(Some(original.into()))
        );
    }

    #[test]
    fn rejects_invalid_owner_bytes_instead_of_returning_replacement_text() {
        let error = decode_payload("wl-paste", vec![0xff]).unwrap_err();
        assert!(error.contains("wl-paste"));
        assert!(error.contains("UTF-8"));
    }

    #[test]
    fn retains_empty_selection_handling() {
        assert_eq!(decode_payload("wl-paste", Vec::new()), Ok(None));
        assert_eq!(decode_payload("xclip", b" \n".to_vec()), Ok(None));
    }
}
