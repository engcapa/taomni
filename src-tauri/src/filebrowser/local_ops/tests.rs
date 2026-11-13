use super::{inspection, operation, paths, transfer, trash};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn op() -> operation::Operation {
    operation::Operation::register(None, None).unwrap()
}

fn transfer(sources: &[PathBuf], destination: &Path, moving: bool) -> super::EntryOperationResult {
    transfer::transfer_entries(
        sources
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        destination,
        moving,
        &mut op(),
    )
}

#[test]
fn copy_preserves_source_and_never_overwrites_collisions() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("document.txt");
    fs::write(&source, "original").unwrap();
    let result = transfer(&[source.clone()], root.path(), false);
    assert!(result.failed.is_empty());
    assert_eq!(
        Path::new(&result.done[0].to).file_name().unwrap(),
        "document - 副本.txt"
    );
    let result = transfer(&[source.clone()], root.path(), false);
    assert_eq!(
        Path::new(&result.done[0].to).file_name().unwrap(),
        "document - 副本 (2).txt"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    assert_eq!(
        fs::read_to_string(root.path().join("document - 副本.txt")).unwrap(),
        "original"
    );
}

#[test]
fn copying_dotted_directory_retains_whole_directory_name() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("release.v1");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("readme"), "hello").unwrap();
    let result = transfer(&[directory], root.path(), false);
    assert!(result.failed.is_empty());
    assert!(root.path().join("release.v1 - 副本/readme").is_file());
}

#[test]
fn move_same_volume_moves_and_same_folder_cut_is_noop() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("destination");
    fs::create_dir(&destination).unwrap();
    let source = root.path().join("source");
    fs::write(&source, "bytes").unwrap();
    assert!(paths::same_volume(&source, &destination).unwrap());
    let noop = transfer(&[source.clone()], root.path(), true);
    assert_eq!(noop.done[0].to, source.to_string_lossy());
    let result = transfer(&[source.clone()], &destination, true);
    assert!(result.failed.is_empty());
    assert!(!source.exists());
    assert_eq!(fs::read(destination.join("source")).unwrap(), b"bytes");
}

#[test]
fn cross_device_fallback_copies_tree_before_removing_source() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("nested/payload"), "payload").unwrap();
    // Exercise exactly the copy/delete fallback used after EXDEV, without
    // requiring privileged mounts or assuming a second device exists on CI.
    transfer::copy_then_remove(&source, &destination, true, &mut op()).unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(destination.join("nested/payload")).unwrap(),
        "payload"
    );
}

#[test]
fn failed_cross_device_copy_keeps_source_and_existing_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination");
    fs::write(&source, "source bytes").unwrap();
    fs::write(&destination, "existing bytes").unwrap();
    let error = transfer::copy_then_remove(&source, &destination, true, &mut op()).unwrap_err();
    assert_eq!(error.code, "already_exists");
    assert_eq!(fs::read_to_string(source).unwrap(), "source bytes");
    assert_eq!(fs::read_to_string(destination).unwrap(), "existing bytes");
}

#[test]
fn self_and_descendant_targets_are_rejected_with_partial_success_results() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = source.join("child");
    fs::create_dir_all(&destination).unwrap();
    let good = root.path().join("good");
    fs::write(&good, "good").unwrap();
    let result = transfer(
        &[good.clone(), source.clone(), root.path().join("gone")],
        &destination,
        false,
    );
    assert_eq!(result.done.len(), 1);
    assert_eq!(result.failed.len(), 2);
    assert_eq!(result.failed[0].code, "invalid_target");
    assert_eq!(result.failed[1].code, "not_found");
    assert!(source.is_dir());
    assert!(good.is_file());
    assert_eq!(
        fs::read_to_string(destination.join("good")).unwrap(),
        "good"
    );
    let result = transfer(&[source.clone()], &source, true);
    assert_eq!(result.failed[0].code, "invalid_target");
}

#[cfg(unix)]
#[test]
fn symlinks_are_copied_as_links_and_directory_alias_cannot_bypass_descendant_guard() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let tree = root.path().join("tree");
    fs::create_dir_all(tree.join("child")).unwrap();
    fs::write(tree.join("data"), "data").unwrap();
    symlink("data", tree.join("link")).unwrap();
    symlink("missing", tree.join("dangling")).unwrap();
    let result = transfer(&[tree.clone()], root.path(), false);
    assert!(result.failed.is_empty());
    let copied = root.path().join("tree - 副本");
    assert_eq!(
        fs::read_link(copied.join("link")).unwrap(),
        Path::new("data")
    );
    assert_eq!(
        fs::read_link(copied.join("dangling")).unwrap(),
        Path::new("missing")
    );
    symlink(tree.join("child"), root.path().join("alias")).unwrap();
    let result = transfer(&[tree], &root.path().join("alias"), true);
    assert_eq!(result.failed[0].code, "invalid_target");
}

#[cfg(unix)]
#[test]
fn special_files_fail_without_reading_or_removing_source() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let pipe = root.path().join("pipe");
    let name = std::ffi::CString::new(pipe.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let destination = root.path().join("destination");
    fs::create_dir(&destination).unwrap();
    let result = transfer(&[pipe.clone()], &destination, false);
    assert_eq!(result.failed[0].code, "unsupported_type");
    assert!(fs::symlink_metadata(&pipe).is_ok());
    assert!(inspection::preview_text(&pipe).is_err());
}

#[test]
fn rename_is_no_replace_and_names_are_portably_validated() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.txt");
    fs::write(&source, "source").unwrap();
    fs::write(root.path().join("exists.txt"), "existing").unwrap();
    assert_eq!(
        transfer::rename_entry(&source, "exists.txt")
            .unwrap_err()
            .code,
        "already_exists"
    );
    for name in [
        "CON",
        "con.txt",
        "LPT9.log",
        "COM1",
        "bad/name",
        "bad\\name",
        "..",
        "bad.",
        "bad ",
        "",
        "a:b",
    ] {
        assert_eq!(
            transfer::rename_entry(&source, name).unwrap_err().code,
            "invalid_name",
            "{name}"
        );
    }
    let renamed = transfer::rename_entry(&source, "renamed.txt").unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read_to_string(renamed).unwrap(), "source");
    assert_eq!(
        fs::read_to_string(root.path().join("exists.txt")).unwrap(),
        "existing"
    );
}

#[test]
fn create_entry_atomically_numbers_conflicts_preserving_extension() {
    let root = tempfile::tempdir().unwrap();
    let first = transfer::create_entry(root.path(), "New file.txt", false).unwrap();
    fs::write(&first, "keep").unwrap();
    let second = transfer::create_entry(root.path(), "New file.txt", false).unwrap();
    assert_eq!(Path::new(&second).file_name().unwrap(), "New file (2).txt");
    assert_eq!(fs::read_to_string(first).unwrap(), "keep");
    assert_eq!(fs::read(second).unwrap().len(), 0);
    transfer::create_entry(root.path(), "folder.ext", true).unwrap();
    let second_folder = transfer::create_entry(root.path(), "folder.ext", true).unwrap();
    assert_eq!(
        Path::new(&second_folder).file_name().unwrap(),
        "folder.ext (2)"
    );
}

#[cfg(unix)]
#[test]
fn create_and_rename_preserve_the_listing_parent_spelling() {
    let root = tempfile::tempdir().unwrap();
    let actual = root.path().join("actual");
    let alias = root.path().join("alias");
    fs::create_dir(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, &alias).unwrap();
    let created = transfer::create_entry(&alias, "file.txt", false).unwrap();
    assert_eq!(created, alias.join("file.txt").to_string_lossy());
    let renamed = transfer::rename_entry(Path::new(&created), "renamed.txt").unwrap();
    assert_eq!(renamed, alias.join("renamed.txt").to_string_lossy());
    assert!(actual.join("renamed.txt").is_file());
}

#[test]
fn canonical_paths_resolve_directory_aliases_and_reject_files() {
    let root = tempfile::tempdir().unwrap();
    let child = root.path().join("child");
    fs::create_dir(&child).unwrap();
    fs::write(root.path().join("file"), "data").unwrap();
    assert_eq!(
        paths::canonical_key(root.path()).unwrap(),
        paths::canonical_key(&child.join("..")).unwrap()
    );
    assert_eq!(
        paths::canonical_key(&root.path().join("file"))
            .unwrap_err()
            .code,
        "not_directory"
    );
}

#[test]
fn cancellation_has_owned_lifetime_and_duplicate_operation_ids_are_rejected() {
    let id = uuid::Uuid::new_v4().to_string();
    let mut operation = operation::Operation::register(Some(id.clone()), None).unwrap();
    assert!(operation::Operation::register(Some(id.clone()), None).is_err());
    operation::cancel(&id).unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::write(&source, "data").unwrap();
    let result = transfer::transfer_entries(
        vec![source.to_string_lossy().into_owned()],
        root.path(),
        true,
        &mut operation,
    );
    assert_eq!(result.failed[0].code, "cancelled");
    assert!(source.exists());
    drop(operation);
    assert!(operation::Operation::register(Some(id), None).is_ok());
}

#[test]
fn text_preview_reads_a_bounded_prefix_and_detects_binary() {
    let root = tempfile::tempdir().unwrap();
    let text = root.path().join("text.txt");
    fs::write(&text, "a".repeat(256 * 1024 - 1) + "中文").unwrap();
    let preview = inspection::preview_text(&text).unwrap();
    assert!(preview.truncated);
    assert!(!preview.binary);
    assert_eq!(preview.text.len(), 256 * 1024 - 1);
    fs::write(&text, b"this is\0binary").unwrap();
    let preview = inspection::preview_text(&text).unwrap();
    assert!(preview.binary);
    assert!(preview.text.is_empty());
    fs::write(&text, [0xff, 0xfe]).unwrap();
    assert!(inspection::preview_text(&text).unwrap().binary);
}

#[test]
fn image_preview_is_header_checked_and_cannot_raise_hard_size_cap() {
    let root = tempfile::tempdir().unwrap();
    let image = root.path().join("image.png");
    fs::write(&image, b"\x89PNG\r\n\x1a\ncontent").unwrap();
    let preview = inspection::preview_bytes(&image, 1024).unwrap();
    assert_eq!(preview.mime, "image/png");
    assert_eq!(preview.bytes, fs::read(&image).unwrap());
    assert_eq!(
        inspection::preview_bytes(&image, 1).unwrap_err().code,
        "too_large"
    );
    fs::File::create(&image)
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        inspection::preview_bytes(&image, u64::MAX)
            .unwrap_err()
            .code,
        "too_large"
    );
    fs::write(&image, "not an image").unwrap();
    assert_eq!(
        inspection::preview_bytes(&image, 1024).unwrap_err().code,
        "unsupported_type"
    );
}

#[test]
fn properties_count_descendants_with_a_bounded_traversal() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("nested")).unwrap();
    fs::write(root.path().join("one"), "abc").unwrap();
    fs::write(root.path().join("nested/two"), "12345").unwrap();
    let properties = inspection::properties(root.path(), &mut op()).unwrap();
    assert_eq!(properties.size, 8);
    assert_eq!(properties.item_count, 3);
    assert!(!properties.truncated);
    let properties =
        inspection::properties_bounded(root.path(), &mut op(), 1, Duration::from_secs(10)).unwrap();
    assert_eq!(properties.item_count, 1);
    assert!(properties.truncated);
    let properties =
        inspection::properties_bounded(root.path(), &mut op(), 1000, Duration::ZERO).unwrap();
    assert!(properties.truncated);
}

// Real trash tests run in an isolated subprocess: mutating XDG_DATA_HOME in a
// multithreaded test process is unsafe and could redirect unrelated tests.
#[cfg(target_os = "linux")]
#[test]
fn real_freedesktop_trash_restores_files_links_and_rejects_unavailable() {
    let fixture = tempfile::tempdir().unwrap();
    let data = fixture.path().join("data");
    fs::create_dir(&data).unwrap();
    for mode in ["roundtrip", "unavailable"] {
        let data_home = if mode == "roundtrip" {
            data.clone()
        } else {
            let blocked = fixture.path().join("blocked");
            fs::write(&blocked, "not a directory").unwrap();
            blocked
        };
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "filebrowser::local_ops::tests::trash_child_roundtrip",
                "--nocapture",
            ])
            .env("TAOMNI_EXPLORER_TRASH_FIXTURE", fixture.path())
            .env("TAOMNI_EXPLORER_TRASH_MODE", mode)
            .env("XDG_DATA_HOME", data_home)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mode {mode}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn trash_child_roundtrip() {
    let Some(root) = std::env::var_os("TAOMNI_EXPLORER_TRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let path = root.join("trash source 文本.txt");
    fs::write(&path, "restore these bytes").unwrap();
    let result = trash::trash_entries(vec![path.to_string_lossy().into_owned()]);
    if std::env::var("TAOMNI_EXPLORER_TRASH_MODE").unwrap() == "unavailable" {
        assert_eq!(result.failed[0].code, "trash_unavailable");
        assert!(path.exists());
        fs::remove_file(path).unwrap();
        return;
    }
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(result.trashed.len(), 1);
    assert!(!path.exists());
    // Collision must leave both the replacement and the recoverable trash item.
    fs::write(&path, "replacement").unwrap();
    let collision = trash::restore_entries(result.trashed.clone());
    assert_eq!(collision.failed[0].code, "already_exists");
    assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    fs::remove_file(&path).unwrap();
    let restored = trash::restore_entries(result.trashed);
    assert!(restored.failed.is_empty(), "{:?}", restored.failed);
    assert_eq!(fs::read_to_string(&path).unwrap(), "restore these bytes");
    let target = root.join("target");
    fs::write(&target, "must remain").unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let result = trash::trash_entries(vec![
        link.to_string_lossy().into_owned(),
        root.join("absent").to_string_lossy().into_owned(),
    ]);
    assert_eq!(result.trashed.len(), 1);
    assert_eq!(result.failed.len(), 1);
    assert!(target.exists());
    assert!(fs::symlink_metadata(&link).is_err());
    let restored = trash::restore_entries(result.trashed);
    assert!(restored.failed.is_empty());
    assert_eq!(fs::read_link(link).unwrap(), target);
}
