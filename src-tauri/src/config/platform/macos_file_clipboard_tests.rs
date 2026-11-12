//! NSURL format tests only; do not obtain or change NSPasteboard.generalPasteboard.

use super::*;

#[test]
fn file_clipboard_macos_file_url_preserves_spaces_unicode_and_line_breaks() {
    autoreleasepool(|_| {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(" leading 文件 🦀\r\n ");
        std::fs::write(&path, "content").unwrap();
        let original = path.to_str().unwrap();
        let url = file_url(original);
        assert!(url.isFileURL());
        assert_eq!(url.path().unwrap().to_string(), original);
    });
}

#[test]
fn file_clipboard_macos_file_url_keeps_directory_symlink_not_target() {
    autoreleasepool(|_| {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join(" directory link ");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let original = link.to_str().unwrap();
        let url = file_url(original);
        assert_eq!(url.path().unwrap().to_string(), original);
        assert_ne!(url.path().unwrap().to_string(), target.to_str().unwrap());
    });
}
