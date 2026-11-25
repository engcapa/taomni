use super::*;

#[test]
fn future_targets_normalize_dot_and_missing_ancestors() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("./nested/file.part");
    let expected = std::fs::canonicalize(root.path())
        .unwrap()
        .join("nested/file.part");
    assert_eq!(canonical_candidate(&path).unwrap(), expected);
    assert!(canonical_candidate(Path::new("relative.part")).is_err());
    assert!(canonical_candidate(&root.path().join("../outside.part")).is_err());
    assert!(canonical_candidate(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn parent_aliases_deduplicate_and_final_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("staging");
    let alias = root.path().join("alias");
    std::fs::create_dir(&staging).unwrap();
    symlink(&staging, &alias).unwrap();
    let canonical = canonical_candidate(&staging.join("nested/file.part")).unwrap();
    assert_eq!(
        canonical_candidate(&alias.join("nested/file.part")).unwrap(),
        canonical
    );
    validate_download_paths_within_root(&alias.join("new.part"), &alias.join("new.pkg"), &staging)
        .unwrap();
    symlink(root.path().join("missing"), staging.join("dangling.part")).unwrap();
    assert!(canonical_candidate(&staging.join("dangling.part")).is_err());
    assert!(
        validate_download_paths_within_root(
            &alias.join("new.part"),
            &staging.join("new.part"),
            &staging
        )
        .is_err()
    );
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    symlink(&outside, staging.join("escape")).unwrap();
    assert!(
        validate_download_paths_within_root(
            &staging.join("escape/new.part"),
            &staging.join("new.pkg"),
            &staging
        )
        .is_err()
    );
}
