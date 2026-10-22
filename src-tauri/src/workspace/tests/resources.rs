use super::*;
#[test]
fn creates_renames_and_deletes_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();

    workspace_create_dir(root.clone(), "src".into()).unwrap();
    let file =
        workspace_create_file(root.clone(), "src/main.ts".into(), Some("one".into())).unwrap();
    assert_eq!(file.path, "src/main.ts");
    assert_eq!(file.text, "one");

    let renamed =
        workspace_rename_path(root.clone(), "src/main.ts".into(), "src/app.ts".into()).unwrap();
    assert_eq!(renamed.path, "src/app.ts");
    assert!(!dir.path().join("src/main.ts").exists());
    assert!(dir.path().join("src/app.ts").exists());

    workspace_delete_path(root, "src/app.ts".into(), None).unwrap();
    assert!(!dir.path().join("src/app.ts").exists());
}

#[test]
fn applies_lsp_resource_operation_options() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir(dir.path().join("src")).unwrap();

    let created = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(!created.ignored);
    fs::write(dir.path().join("src/new.ts"), "new").unwrap();

    let ignored = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: false,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert!(ignored.ignored);
    assert_eq!(
        fs::read_to_string(dir.path().join("src/new.ts")).unwrap(),
        "new"
    );

    let overwritten = workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Create {
            path: "src/new.ts".into(),
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert!(!overwritten.ignored);
    assert_eq!(
        fs::read_to_string(dir.path().join("src/new.ts")).unwrap(),
        ""
    );
    fs::write(dir.path().join("src/new.ts"), "new").unwrap();

    fs::write(dir.path().join("src/final.ts"), "old").unwrap();
    workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Rename {
            from_path: "src/new.ts".into(),
            to_path: "src/final.ts".into(),
            to_repo_root: None,
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("src/final.ts")).unwrap(),
        "new"
    );

    workspace_apply_resource_operation(
        root.clone(),
        WorkspaceResourceOperation::Delete {
            path: "src/final.ts".into(),
            recursive: false,
            ignore_if_not_exists: false,
        },
    )
    .unwrap();
    let ignored_delete = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Delete {
            path: "src/final.ts".into(),
            recursive: false,
            ignore_if_not_exists: true,
        },
    )
    .unwrap();
    assert!(ignored_delete.ignored);
}

#[test]
fn create_file_overwrite_rejects_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("generated/nested")).unwrap();
    fs::write(dir.path().join("generated/nested/keep.txt"), "keep").unwrap();

    let error = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Create {
            path: "generated".into(),
            overwrite: true,
            ignore_if_exists: true,
        },
    )
    .unwrap_err();

    assert!(error.contains("cannot overwrite directory"));
    assert_eq!(
        fs::read_to_string(dir.path().join("generated/nested/keep.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn deserializes_lsp_resource_operation_camel_case_fields() {
    let operation: WorkspaceResourceOperation = serde_json::from_value(serde_json::json!({
        "kind": "rename",
        "fromPath": "src/old.ts",
        "toPath": "src/new.ts",
        "toRepoRoot": "/workspace-two",
        "overwrite": true,
        "ignoreIfExists": false
    }))
    .unwrap();
    assert!(matches!(
        operation,
        WorkspaceResourceOperation::Rename {
            from_path,
            to_path,
            to_repo_root: Some(to_repo_root),
            overwrite: true,
            ignore_if_exists: false,
        } if from_path == "src/old.ts"
            && to_path == "src/new.ts"
            && to_repo_root == "/workspace-two"
    ));
}

#[test]
fn applies_cross_root_lsp_rename_and_protects_same_path() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("src")).unwrap();
    fs::create_dir(destination.path().join("lib")).unwrap();
    fs::write(source.path().join("src/main.ts"), "content").unwrap();
    let source_root = source.path().to_string_lossy().to_string();
    let destination_root = destination.path().to_string_lossy().to_string();

    workspace_apply_resource_operation(
        source_root.clone(),
        WorkspaceResourceOperation::Rename {
            from_path: "src/main.ts".into(),
            to_path: "lib/main.ts".into(),
            to_repo_root: Some(destination_root),
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(!source.path().join("src/main.ts").exists());
    assert_eq!(
        fs::read_to_string(destination.path().join("lib/main.ts")).unwrap(),
        "content"
    );

    let ignored = workspace_apply_resource_operation(
        source_root,
        WorkspaceResourceOperation::Rename {
            from_path: "src".into(),
            to_path: "src".into(),
            to_repo_root: None,
            overwrite: true,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(ignored.ignored);
    assert!(source.path().join("src").is_dir());
}

#[test]
fn failed_overwrite_move_restores_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.ts");
    let destination = dir.path().join("destination.ts");
    fs::write(&destination, "original destination").unwrap();

    let error = move_resource_replacing(&missing, &destination).unwrap_err();

    assert!(error.contains("replace"));
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "original destination"
    );
    let entries = fs::read_dir(dir.path())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
}

#[test]
fn rejects_moving_directory_inside_itself() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/nested")).unwrap();
    fs::write(dir.path().join("src/main.ts"), "content").unwrap();

    let error = workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Rename {
            from_path: "src".into(),
            to_path: "src/nested/moved".into(),
            to_repo_root: None,
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap_err();

    assert!(error.contains("inside itself"));
    assert!(dir.path().join("src/main.ts").is_file());
    assert!(!dir.path().join("src/nested/moved").exists());
}

#[cfg(unix)]
#[test]
fn resource_copy_and_rename_preserve_symbolic_links() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::write(dir.path().join("target.ts"), "content").unwrap();
    symlink("target.ts", dir.path().join("source-link.ts")).unwrap();

    copy_resource_target(
        &dir.path().join("source-link.ts"),
        &dir.path().join("copied-link.ts"),
    )
    .unwrap();
    assert!(
        fs::symlink_metadata(dir.path().join("copied-link.ts"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(dir.path().join("copied-link.ts")).unwrap(),
        PathBuf::from("target.ts")
    );

    workspace_apply_resource_operation(
        root,
        WorkspaceResourceOperation::Rename {
            from_path: "source-link.ts".into(),
            to_path: "renamed-link.ts".into(),
            to_repo_root: None,
            overwrite: false,
            ignore_if_exists: false,
        },
    )
    .unwrap();
    assert!(
        fs::symlink_metadata(dir.path().join("renamed-link.ts"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(dir.path().join("renamed-link.ts")).unwrap(),
        PathBuf::from("target.ts")
    );
}

#[test]
fn creates_and_deletes_directory_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();

    let entry = workspace_create_dir(root.clone(), "src".into()).unwrap();
    assert_eq!(entry.file_type, "dir");
    workspace_create_file(root.clone(), "src/main.ts".into(), None).unwrap();

    let err = workspace_delete_path(root.clone(), "src".into(), Some(false)).unwrap_err();
    assert!(err.contains("rmdir"));

    workspace_delete_path(root, "src".into(), Some(true)).unwrap();
    assert!(!dir.path().join("src").exists());
}
