use super::*;
#[tokio::test]
async fn returns_compact_chain_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/main/java/com/example/service")).unwrap();
    fs::write(
        dir.path()
            .join("src/main/java/com/example/service/UserService.java"),
        "class UserService {}",
    )
    .unwrap();

    let chain = workspace_compact_chain(root, "src".into(), Some(16))
        .await
        .unwrap();

    assert_eq!(chain.path, "src/main/java/com/example/service");
    assert_eq!(chain.entries.len(), 1);
    assert_eq!(
        chain.entries[0].path,
        "src/main/java/com/example/service/UserService.java"
    );
}

#[tokio::test]
async fn recursively_lists_files_with_limits_and_skips_git() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src/a")).unwrap();
    fs::create_dir_all(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join("src/a/one.ts"), "one").unwrap();
    fs::write(dir.path().join("src/two.ts"), "two").unwrap();
    fs::write(dir.path().join(".git/config"), "hidden").unwrap();

    let files = workspace_list_files_recursive(root.clone(), None, Some(10), Some(10))
        .await
        .unwrap();
    let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(paths, vec!["src/a/one.ts", "src/two.ts"]);

    let limited = workspace_list_files_recursive(root, None, Some(10), Some(1))
        .await
        .unwrap();
    assert_eq!(limited.len(), 1);
}

#[tokio::test]
async fn recursive_listing_skips_dependency_and_build_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    fs::create_dir_all(dir.path().join("target/debug")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(
        dir.path().join("node_modules/pkg/index.js"),
        "module.exports=1",
    )
    .unwrap();
    fs::write(dir.path().join("target/debug/app"), "bin").unwrap();

    let files = workspace_list_files_recursive(root, None, Some(10), Some(100))
        .await
        .unwrap();
    let paths: Vec<_> = files.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(paths, vec!["src/main.rs"]);
}

#[tokio::test]
async fn detects_git_roots_and_deduplicates_nested_roots() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    let nested = repo.join("packages/app");
    let plain = dir.path().join("plain");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&plain).unwrap();

    let repos = workspace_detect_git_roots(vec![
        WorkspaceGitRootCandidate {
            id: "repo".into(),
            active_file_path: None,
            ancestors_only: false,
            name: "repo".into(),
            path: repo.to_string_lossy().to_string(),
        },
        WorkspaceGitRootCandidate {
            id: "app".into(),
            active_file_path: None,
            ancestors_only: false,
            name: "app".into(),
            path: nested.to_string_lossy().to_string(),
        },
        WorkspaceGitRootCandidate {
            id: "plain".into(),
            active_file_path: None,
            ancestors_only: false,
            name: "plain".into(),
            path: plain.to_string_lossy().to_string(),
        },
    ])
    .await
    .unwrap();

    let repo_root = path_to_string(&fs::canonicalize(&repo).unwrap_or(repo.clone()));
    let detected = repos
        .iter()
        .find(|item| item.repo_root == repo_root || Path::new(&item.repo_root) == repo)
        .expect("target repo should be detected");
    assert!(detected.root_ids.contains(&"repo".to_string()));
    assert!(detected.root_ids.contains(&"app".to_string()));
}

#[tokio::test]
async fn detects_child_git_roots_under_plain_workspace_root() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let app = workspace.join("app");
    let service = workspace.join("service");
    fs::create_dir_all(app.join(".git")).unwrap();
    fs::create_dir_all(service.join(".git")).unwrap();
    fs::create_dir_all(workspace.join("node_modules/ignored/.git")).unwrap();

    let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
        id: "workspace".into(),
        active_file_path: None,
        ancestors_only: false,
        name: "workspace".into(),
        path: workspace.to_string_lossy().to_string(),
    }])
    .await
    .unwrap();

    let app_canon = fs::canonicalize(&app).unwrap_or(app.clone());
    let service_canon = fs::canonicalize(&service).unwrap_or(service.clone());
    let workspace_canon = fs::canonicalize(&workspace).unwrap_or(workspace.clone());
    let repo_roots: Vec<_> = repos
        .iter()
        .map(|item| PathBuf::from(&item.repo_root))
        .collect();
    assert!(repo_roots.iter().any(|root| {
        root == &app || root == &app_canon || path_to_string(root) == path_to_string(&app_canon)
    }));
    assert!(repo_roots.iter().any(|root| {
        root == &service
            || root == &service_canon
            || path_to_string(root) == path_to_string(&service_canon)
    }));
    assert!(
        !repos
            .iter()
            .any(|item| item.repo_root.contains("node_modules"))
    );
    assert_eq!(
        repo_roots
            .iter()
            .filter(|root| root.starts_with(&workspace) || root.starts_with(&workspace_canon))
            .count(),
        2
    );
}

#[tokio::test]
async fn marks_git_file_roots_as_submodules() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let submodule = workspace.join("vendor/lib");
    fs::create_dir_all(&submodule).unwrap();
    fs::write(
        submodule.join(".git"),
        "gitdir: ../../.git/modules/vendor/lib\n",
    )
    .unwrap();

    let repos = workspace_detect_git_roots(vec![WorkspaceGitRootCandidate {
        id: "workspace".into(),
        active_file_path: None,
        ancestors_only: false,
        name: "workspace".into(),
        path: workspace.to_string_lossy().to_string(),
    }])
    .await
    .unwrap();

    let submodule_canon = fs::canonicalize(&submodule).unwrap_or(submodule.clone());
    let detected = repos
        .iter()
        .find(|item| {
            let root = Path::new(&item.repo_root);
            root == submodule
                || root == submodule_canon
                || item.repo_root == path_to_string(&submodule_canon)
        })
        .expect("submodule should be detected");
    assert!(detected.is_submodule);
}

#[test]
fn rejects_dot_git_deletes() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    fs::write(dir.path().join(".git/config"), "x").unwrap();

    let err = workspace_delete_path(
        dir.path().to_string_lossy().to_string(),
        ".git/config".into(),
        None,
    )
    .unwrap_err();
    assert!(err.contains(".git"));
}
