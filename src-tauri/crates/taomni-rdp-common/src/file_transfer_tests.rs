use super::*;
use tempfile::tempdir;

#[test]
fn relative_wire_names_use_backslashes_and_keep_unicode() {
    let root = Path::new("clipboard-root");
    assert_eq!(
        clipboard_relative_name(root, &root.join("目录").join("report.txt")).unwrap(),
        "目录\\report.txt"
    );
    assert!(clipboard_relative_name(root, root).is_err());
}

#[test]
fn relative_wire_names_enforce_utf16_descriptor_limit() {
    let root = Path::new("clipboard-root");
    let accepted = format!("{}.txt", "a".repeat(255));
    assert_eq!(
        clipboard_relative_name(root, &root.join(&accepted)).unwrap(),
        accepted
    );
    assert!(clipboard_relative_name(root, &root.join("a".repeat(260))).is_err());
    // Supplementary Unicode characters consume two UTF-16 code units each.
    assert!(clipboard_relative_name(root, &root.join("😀".repeat(130))).is_err());
}

#[test]
fn remote_names_stay_beneath_staging_and_reject_parent_or_drive_components() {
    let root = Path::new("staging");
    assert_eq!(
        remote_clipboard_safe_path(root, " /folder\\ ./ child.txt ").unwrap(),
        root.join("folder").join("child.txt")
    );
    for name in [
        "../secret",
        "folder\\..\\secret",
        "C:\\secret",
        "folder:stream",
    ] {
        assert!(remote_clipboard_safe_path(root, name).is_err(), "{name}");
    }
    for name in ["", " . / "] {
        assert!(remote_clipboard_safe_path(root, name).is_err(), "{name}");
    }
}

#[test]
fn top_level_names_keep_the_first_wire_component() {
    assert_eq!(
        remote_top_level_name("./folder\\child.txt"),
        Some(PathBuf::from("folder"))
    );
    assert_eq!(remote_top_level_name("/./"), None);
}

#[test]
fn bounded_range_reads_and_positional_writes_share_file_contents() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("transfer.bin");
    fs::write(&path, b"0123456789").unwrap();
    assert_eq!(read_clipboard_file_range(&path, 3, 4).unwrap(), b"3456");
    assert!(read_clipboard_file_range(&path, 20, 4).unwrap().is_empty());
    write_remote_file_chunk(&path, 4, b"AB").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"0123AB6789");
    assert!(write_remote_file_chunk(&dir.path().join("absent"), 0, b"x").is_err());
}

#[test]
fn range_reads_cap_remote_requested_size_at_sixteen_mib() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bounded.bin");
    let file = fs::File::create(&path).unwrap();
    file.set_len(17 * 1024 * 1024).unwrap();
    drop(file);
    assert_eq!(
        read_clipboard_file_range(&path, 0, u32::MAX).unwrap().len(),
        16 * 1024 * 1024
    );
}

#[test]
fn private_staging_directory_can_be_reopened() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("private").join("nested");
    ensure_private_directory(&path).unwrap();
    ensure_private_directory(&path).unwrap();
    assert!(path.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[cfg(unix)]
#[test]
fn file_chunk_io_refuses_symlinks_without_mutating_the_target() {
    use std::os::unix::fs::symlink;

    let dir = tempdir().unwrap();
    let target = dir.path().join("target");
    let link = dir.path().join("link");
    fs::write(&target, b"preserved").unwrap();
    symlink(&target, &link).unwrap();
    assert!(read_clipboard_file_range(&link, 0, 20).is_err());
    assert!(write_remote_file_chunk(&link, 0, b"changed").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"preserved");
}
