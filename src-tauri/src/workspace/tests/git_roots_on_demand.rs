use super::*;

fn candidate(path: &Path, active: Option<&str>) -> WorkspaceGitRootCandidate {
    WorkspaceGitRootCandidate {
        id: "explorer".into(),
        name: "Explorer".into(),
        path: path_to_string(path),
        active_file_path: active.map(str::to_string),
        ancestors_only: active.is_some(),
    }
}

#[test]
fn home_without_git_never_discovers_unrelated_child_repositories() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join("unrelated/.git")).unwrap();
    let repos =
        detect_workspace_git_roots(vec![candidate(home.path(), None)], Some(home.path())).unwrap();
    assert!(repos.is_empty());
}

#[test]
fn active_file_finds_only_its_nearest_git_root_including_git_files() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join("project/.git")).unwrap();
    fs::create_dir_all(home.path().join("project/nested/src")).unwrap();
    fs::write(home.path().join("project/nested/.git"), "gitdir: elsewhere").unwrap();
    fs::write(
        home.path().join("project/nested/src/main.rs"),
        "fn main() {}",
    )
    .unwrap();
    fs::create_dir_all(home.path().join("unrelated/.git")).unwrap();
    let repos = detect_workspace_git_roots(
        vec![candidate(home.path(), Some("project/nested/src/main.rs"))],
        Some(home.path()),
    )
    .unwrap();
    assert_eq!(repos.len(), 1);
    assert_eq!(
        Path::new(&repos[0].repo_root),
        fs::canonicalize(home.path().join("project/nested")).unwrap()
    );
    assert_eq!(repos[0].root_ids, vec!["explorer"]);
    assert!(repos[0].is_submodule);
}

#[test]
fn large_non_project_root_uses_active_files_instead_of_nested_scanning() {
    let dir = tempfile::tempdir().unwrap();
    for index in 0..=256 {
        fs::create_dir(dir.path().join(format!("folder-{index}"))).unwrap();
    }
    fs::create_dir_all(dir.path().join("project/.git")).unwrap();
    fs::write(dir.path().join("project/notes.txt"), "Public notes").unwrap();
    assert!(
        detect_workspace_git_roots(vec![candidate(dir.path(), None)], None)
            .unwrap()
            .is_empty()
    );
    let repos =
        detect_workspace_git_roots(vec![candidate(dir.path(), Some("project/notes.txt"))], None)
            .unwrap();
    assert_eq!(repos.len(), 1);
    assert_eq!(
        Path::new(&repos[0].repo_root),
        fs::canonicalize(dir.path().join("project")).unwrap()
    );
}

#[test]
fn home_that_is_itself_a_repository_retains_nested_project_discovery() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join(".git")).unwrap();
    fs::create_dir_all(home.path().join("child/.git")).unwrap();
    let repos =
        detect_workspace_git_roots(vec![candidate(home.path(), None)], Some(home.path())).unwrap();
    assert_eq!(repos.len(), 2);
}

#[test]
fn active_file_lookup_rejects_workspace_escape_and_reports_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(dir.path().join("outside.txt"), "public").unwrap();
    for path in ["../outside.txt", "missing.txt"] {
        assert!(detect_workspace_git_roots(vec![candidate(&root, Some(path))], None).is_err());
    }
}

#[test]
fn legacy_candidates_keep_the_existing_wire_format_defaults() {
    let candidate: WorkspaceGitRootCandidate = serde_json::from_value(serde_json::json!({
        "id": "root", "name": "Root", "path": "/root"
    }))
    .unwrap();
    assert!(candidate.active_file_path.is_none());
    assert!(!candidate.ancestors_only);
}
