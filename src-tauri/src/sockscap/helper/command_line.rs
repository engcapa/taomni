/// Quote one argument for the Windows command line passed to the helper.
pub(super) fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            backslashes = backslashes * 2 + 1;
        }
        result.extend(std::iter::repeat_n('\\', backslashes));
        result.push(character);
        backslashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', backslashes * 2));
    result.push('"');
    result
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn preserves_spaces_quote_characters_and_trailing_backslashes() {
        assert_eq!(
            quote(r"C:\Taomni QA\ready.json"),
            r#""C:\Taomni QA\ready.json""#
        );
        assert_eq!(quote(r"C:\Taomni QA\"), r#""C:\Taomni QA\\""#);
        assert_eq!(quote(r#"a"b"#), r#""a\"b""#);
    }
}
