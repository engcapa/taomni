use super::*;

// Unix-style absolute URIs retain their leading slash on every platform,
// including clipboard content received on Windows from Unix/WSL sources.
fn uri_path(path: &str) -> PathBuf {
    PathBuf::from(path)
}

#[test]
fn uri_list_round_trip_simple() {
    let paths = vec![
        uri_path("/tmp/file with space.txt"),
        uri_path("/tmp/中文.txt"),
    ];
    let s = paths_to_uri_list(&paths);
    let parsed = uri_list_to_paths(&s);
    assert_eq!(parsed, paths);
}

#[test]
fn uri_list_drops_blank_and_comment_lines() {
    let s = "# comment\n\nfile:///tmp/a.txt\n";
    let parsed = uri_list_to_paths(s);
    assert_eq!(parsed, vec![uri_path("/tmp/a.txt")]);
}

#[test]
fn uri_list_skips_unknown_schemes() {
    let s = "https://example.com/x\nfile:///etc/hostname\n";
    let parsed = uri_list_to_paths(s);
    assert_eq!(parsed, vec![uri_path("/etc/hostname")]);
}

#[test]
fn percent_encoding_specific_chars() {
    let s = paths_to_uri_list(&[PathBuf::from("/a b.txt")]);
    assert!(s.contains("%20"));
    assert!(!s.contains(" "));
}

#[test]
fn uri_list_uses_crlf_and_encodes_reserved_and_unicode_bytes() {
    let encoded = paths_to_uri_list(&[PathBuf::from("/tmp/雪 #%.txt")]);
    assert_eq!(encoded, "file:///tmp/%E9%9B%AA%20%23%25.txt\r\n");
    assert_eq!(
        uri_list_to_paths(&encoded),
        vec![uri_path("/tmp/雪 #%.txt")]
    );
}

#[test]
fn malformed_percent_sequences_keep_existing_best_effort_decoding() {
    let text = "file:///tmp/partial%\nfile:///tmp/invalid%0G\nfile:///tmp/space%20ok\n";
    assert_eq!(
        uri_list_to_paths(text),
        vec![
            uri_path("/tmp/partial%"),
            uri_path("/tmp/invalid%0G"),
            uri_path("/tmp/space ok"),
        ]
    );
}

#[test]
fn invalid_utf8_percent_bytes_are_replaced_without_rejecting_the_path() {
    assert_eq!(
        uri_list_to_paths("file:///tmp/value%FF"),
        vec![uri_path("/tmp/value\u{fffd}")]
    );
}

#[test]
fn windows_drive_uri_preserves_drive_and_platform_anchoring() {
    let decoded = uri_list_to_paths("file:///C:/Users/test/file%20name.txt");
    #[cfg(windows)]
    let expected = PathBuf::from("C:/Users/test/file name.txt");
    #[cfg(not(windows))]
    let expected = PathBuf::from("/C:/Users/test/file name.txt");
    assert_eq!(decoded, vec![expected]);
}
