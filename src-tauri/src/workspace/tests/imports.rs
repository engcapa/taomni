use super::*;

fn import(
    root: &Path,
    directory: &str,
    paths: &[PathBuf],
) -> Result<WorkspaceImportResult, String> {
    let sources = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    super::super::import_paths::import_workspace_paths(root.to_str().unwrap(), directory, &sources)
}

#[test]
fn imports_nested_binary_files_and_empty_directories_without_touching_sources() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    fs::create_dir(workspace.path().join("dest")).unwrap();
    fs::create_dir_all(external.path().join("bundle/nested/empty")).unwrap();
    let text_path = external.path().join("说明 note.txt");
    fs::write(&text_path, b"external note").unwrap();
    let binary = [0, 255, 128, 1, 65, 66];
    fs::write(external.path().join("bundle/nested/data.bin"), binary).unwrap();
    let result = import(
        workspace.path(),
        "dest",
        &[text_path.clone(), external.path().join("bundle")],
    )
    .unwrap();
    assert!(result.failures.is_empty());
    assert_eq!(result.imported.len(), 2);
    assert_eq!(result.imported[0].path, "dest/说明 note.txt");
    assert_eq!(result.imported[1].path, "dest/bundle");
    assert_eq!(result.imported[1].file_type, "dir");
    assert_eq!(
        fs::read(workspace.path().join("dest/说明 note.txt")).unwrap(),
        b"external note"
    );
    assert_eq!(
        fs::read(workspace.path().join("dest/bundle/nested/data.bin")).unwrap(),
        binary
    );
    assert!(workspace.path().join("dest/bundle/nested/empty").is_dir());
    assert_eq!(fs::read(&text_path).unwrap(), b"external note");
    assert_eq!(
        fs::read(external.path().join("bundle/nested/data.bin")).unwrap(),
        binary
    );
}

#[test]
fn preflights_conflicts_before_any_copy_and_allows_retry() {
    let workspace = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::create_dir(workspace.path().join("dest")).unwrap();
    fs::write(workspace.path().join("dest/existing.txt"), "keep").unwrap();
    fs::write(source.path().join("new.txt"), "new").unwrap();
    fs::write(source.path().join("existing.txt"), "replacement").unwrap();
    let paths = [
        source.path().join("new.txt"),
        source.path().join("existing.txt"),
    ];
    let error = import(workspace.path(), "dest", &paths).unwrap_err();
    assert!(error.contains("Path already exists"));
    assert_eq!(
        fs::read_to_string(workspace.path().join("dest/existing.txt")).unwrap(),
        "keep"
    );
    assert!(!workspace.path().join("dest/new.txt").exists());
    assert_eq!(fs::read_to_string(&paths[1]).unwrap(), "replacement");
    let result = import(workspace.path(), "dest", &paths[..1]).unwrap();
    assert_eq!(result.imported.len(), 1);
    assert_eq!(
        fs::read_to_string(workspace.path().join("dest/new.txt")).unwrap(),
        "new"
    );
}

#[test]
fn rejects_duplicate_basenames_and_existing_directories() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join("one")).unwrap();
    fs::create_dir_all(source.path().join("two")).unwrap();
    let a = source.path().join("one/note.txt");
    let b = source.path().join("two/note.txt");
    fs::write(&a, "a").unwrap();
    fs::write(&b, "b").unwrap();
    assert!(
        import(root.path(), "", &[a.clone(), b])
            .unwrap_err()
            .contains("already exists")
    );
    assert!(!root.path().join("note.txt").exists());
    fs::create_dir(root.path().join("note.txt")).unwrap();
    fs::write(root.path().join("note.txt/keep"), "keep").unwrap();
    assert!(
        import(root.path(), "", &[a])
            .unwrap_err()
            .contains("already exists")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("note.txt/keep")).unwrap(),
        "keep"
    );
}

#[test]
fn rejects_self_copy_and_traversal_without_creating_destinations() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("src/nested")).unwrap();
    let source = root.path().join("src");
    let error = import(root.path(), "src/nested", &[source.clone()]).unwrap_err();
    assert!(error.contains("inside itself"));
    assert!(!root.path().join("src/nested/src").exists());
    assert!(
        import(root.path(), "../outside", &[source.clone()])
            .unwrap_err()
            .contains("'..'")
    );
    assert!(
        import(root.path(), root.path().to_str().unwrap(), &[source])
            .unwrap_err()
            .contains("relative")
    );
    assert!(
        import(root.path(), "", &[PathBuf::from("relative.txt")])
            .unwrap_err()
            .contains("absolute")
    );
    assert!(
        import(root.path(), "", &[])
            .unwrap_err()
            .contains("Nothing to import")
    );
}

#[test]
fn selects_only_the_requested_workspace_root() {
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("note.txt"), "external").unwrap();
    let result = import(two.path(), "", &[source.path().join("note.txt")]).unwrap();
    assert!(result.failures.is_empty());
    assert!(!one.path().join("note.txt").exists());
    assert_eq!(
        fs::read_to_string(two.path().join("note.txt")).unwrap(),
        "external"
    );
}

#[test]
fn protects_git_and_cleans_failed_recursive_items_but_reports_other_successes() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::create_dir_all(source.path().join("bundle/.git")).unwrap();
    fs::write(source.path().join("bundle/keep.txt"), "source").unwrap();
    fs::write(source.path().join("bundle/.git/config"), "private").unwrap();
    fs::write(source.path().join("next.txt"), "next").unwrap();
    let result = import(
        root.path(),
        "",
        &[source.path().join("bundle"), source.path().join("next.txt")],
    )
    .unwrap();
    assert_eq!(result.failures.len(), 1);
    assert!(result.failures[0].message.contains(".git"));
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].path, "next.txt");
    assert!(!root.path().join("bundle").exists());
    assert_eq!(
        fs::read_to_string(source.path().join("bundle/keep.txt")).unwrap(),
        "source"
    );
    let error = import(root.path(), "", &[source.path().join("bundle/.git")]).unwrap_err();
    assert!(error.contains(".git"));
    fs::create_dir(root.path().join(".git")).unwrap();
    assert!(
        import(root.path(), ".git", &[source.path().join("next.txt")])
            .unwrap_err()
            .contains(".git")
    );
}

#[cfg(unix)]
#[test]
fn preserves_exact_destination_whitespace_instead_of_redirecting_to_another_directory() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("notes")).unwrap();
    fs::create_dir(root.path().join(" notes ")).unwrap();
    fs::create_dir(root.path().join("notes ")).unwrap();
    let file = source.path().join("note.txt");
    fs::write(&file, "exact").unwrap();
    for directory in [" notes ", "notes "] {
        let result = import(root.path(), directory, &[file.clone()]).unwrap();
        assert!(result.failures.is_empty());
        assert_eq!(result.imported[0].path, format!("{directory}/note.txt"));
        assert_eq!(
            fs::read_to_string(root.path().join(directory).join("note.txt")).unwrap(),
            "exact"
        );
    }
    assert!(!root.path().join("notes/note.txt").exists());
}

#[cfg(unix)]
#[test]
fn rollback_removes_read_only_copied_children_without_changing_source_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let protected = source.path().join("readonly");
    fs::create_dir(&protected).unwrap();
    fs::write(protected.join("file.txt"), "read only source").unwrap();
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o555)).unwrap();
    let owned = root.path().join("failed-copy");
    fs::create_dir(&owned).unwrap();
    super::super::import_paths::copy_import_node(&protected, &owned.join("readonly")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep.txt"), "outside").unwrap();
    fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o555)).unwrap();
    symlink(outside.path(), owned.join("external-link")).unwrap();
    let error = super::super::import_paths::cleanup_failed_copy(
        Err("later copy failed".into()),
        &owned,
        true,
    )
    .unwrap_err();
    assert_eq!(error, "later copy failed");
    assert!(!owned.exists());
    assert_eq!(
        fs::metadata(&protected).unwrap().permissions().mode() & 0o777,
        0o555
    );
    assert_eq!(
        fs::metadata(outside.path()).unwrap().permissions().mode() & 0o777,
        0o555
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
        "outside"
    );
    fs::set_permissions(&protected, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn preserves_links_without_following_loops_and_rejects_destination_link_escape() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("bundle")).unwrap();
    symlink(".", source.path().join("bundle/loop")).unwrap();
    let result = import(root.path(), "", &[source.path().join("bundle")]).unwrap();
    assert!(result.failures.is_empty());
    assert_eq!(
        fs::read_link(root.path().join("bundle/loop")).unwrap(),
        PathBuf::from(".")
    );
    symlink(outside.path(), root.path().join("escape")).unwrap();
    assert!(
        import(root.path(), "escape", &[source.path().join("bundle")])
            .unwrap_err()
            .contains("outside")
    );
    assert!(!outside.path().join("bundle").exists());
    symlink("missing", root.path().join("dangling")).unwrap();
    fs::write(source.path().join("dangling"), "do not follow").unwrap();
    assert!(
        import(root.path(), "", &[source.path().join("dangling")])
            .unwrap_err()
            .contains("already exists")
    );
    assert_eq!(
        fs::read_link(root.path().join("dangling")).unwrap(),
        PathBuf::from("missing")
    );
}
