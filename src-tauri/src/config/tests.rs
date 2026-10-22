use super::paths::clipboard_paths_from_uri_text;

#[test]
fn clipboard_uri_text_parses_uri_list() {
    let parsed = clipboard_paths_from_uri_text(
        "# copied from a file manager\nfile:///tmp/alpha%20one.txt\r\nfile:///tmp/beta\n",
    );

    assert_eq!(
        parsed,
        vec!["/tmp/alpha one.txt".to_string(), "/tmp/beta".to_string()]
    );
}

#[test]
fn clipboard_uri_text_parses_gnome_copied_files() {
    let parsed = clipboard_paths_from_uri_text(
        "copy\nfile:///home/me/project\nfile:///home/me/project/src\n",
    );

    assert_eq!(
        parsed,
        vec![
            "/home/me/project".to_string(),
            "/home/me/project/src".to_string()
        ]
    );
}

#[test]
fn clipboard_uri_text_deduplicates_paths() {
    let parsed =
        clipboard_paths_from_uri_text("file:///tmp/same\nfile:///tmp/same\nfile:///tmp/other\n");

    assert_eq!(
        parsed,
        vec!["/tmp/same".to_string(), "/tmp/other".to_string()]
    );
}

#[test]
fn clipboard_uri_text_parses_plain_absolute_paths() {
    let parsed = clipboard_paths_from_uri_text(
        "copy\n/home/me/plain file.txt\n/home/me/plain file.txt\n/home/me/dir\n",
    );

    assert_eq!(
        parsed,
        vec![
            "/home/me/plain file.txt".to_string(),
            "/home/me/dir".to_string()
        ]
    );
}

#[test]
fn clipboard_uri_text_parses_quoted_paths() {
    let single_quoted = clipboard_paths_from_uri_text("'/home/zhyhang/图片/2026-08-27_23-08.png'");
    assert_eq!(
        single_quoted,
        vec!["/home/zhyhang/图片/2026-08-27_23-08.png".to_string()]
    );

    let double_quoted = clipboard_paths_from_uri_text("\"/tmp/screenshot.png\"");
    assert_eq!(double_quoted, vec!["/tmp/screenshot.png".to_string()]);
}
