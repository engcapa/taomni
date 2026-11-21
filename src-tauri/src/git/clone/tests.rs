use super::*;
use std::sync::Mutex as StdMutex;
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    run_git_in(Some(root), args.iter().copied()).expect("git command")
}

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, contents).expect("write fixture");
}

fn create_source_repository(parent: &Path) -> PathBuf {
    let source = parent.join("source-repo");
    fs::create_dir_all(&source).expect("source dir");
    if run_git_in(Some(&source), ["init", "-b", "main"]).is_err() {
        git(&source, &["init"]);
        git(&source, &["checkout", "-b", "main"]);
    }
    git(&source, &["config", "user.name", "Clone Fixture"]);
    git(
        &source,
        &["config", "user.email", "clone-fixture@example.invalid"],
    );
    git(&source, &["config", "core.autocrlf", "false"]);
    git(&source, &["config", "commit.gpgsign", "false"]);
    write(&source.join("README.md"), "# clone fixture\nmain branch\n");
    write(&source.join("src/main.ts"), "export const value = 1;\n");
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "--no-gpg-sign", "-m", "fixture main"]);
    git(&source, &["checkout", "-b", "develop"]);
    write(&source.join("branch-only.txt"), "develop-only\n");
    git(&source, &["add", "-A"]);
    git(
        &source,
        &["commit", "--no-gpg-sign", "-m", "fixture develop"],
    );
    git(&source, &["checkout", "main"]);
    source
}

fn request(destination: &Path, source: &Path, branch: Option<&str>) -> GitCloneRequest {
    GitCloneRequest {
        task_id: format!("qa-task-{}", uuid::Uuid::new_v4()),
        url: source.to_string_lossy().into_owned(),
        destination: destination.to_string_lossy().into_owned(),
        workspace_name: "Clone Fixture".into(),
        branch: branch.map(str::to_string),
        user_name: Some("QA Clone User".into()),
        user_email: Some("qa-clone@example.invalid".into()),
        proxy_mode: "custom".into(),
        http_proxy: None,
        https_proxy: None,
        token: None,
        token_username: None,
        use_saved_token: false,
        remember_token: false,
    }
}

fn runtime_with_events() -> (CloneRuntime, Arc<StdMutex<Vec<GitCloneProgress>>>) {
    let events = Arc::new(StdMutex::new(Vec::new()));
    let sink = events.clone();
    let runtime = CloneRuntime {
        emit: Box::new(move |progress| {
            sink.lock().expect("events").push(progress);
        }),
        cancel: Arc::new(AtomicBool::new(false)),
        vault: None,
    };
    (runtime, events)
}

fn config(root: &Path, key: &str) -> Option<String> {
    get_config(root, key)
}

#[test]
fn clones_local_repository_with_branch_identity_and_proxy_configuration() {
    let temp = TempDir::new().expect("temp");
    let source = create_source_repository(temp.path());
    let destination = temp.path().join("cloned-repo");
    let expected_head = git(&source, &["rev-parse", "develop"]);
    let (runtime, events) = runtime_with_events();

    let result = run_clone(
        request(&destination, &source, Some("develop")),
        (
            Some("http://127.0.0.1:9".into()),
            Some("http://127.0.0.1:9".into()),
        ),
        None,
        runtime,
    )
    .expect("clone succeeds");

    assert_eq!(result.branch.as_deref(), Some("develop"));
    assert_eq!(result.default_branch.as_deref(), Some("main"));
    assert_eq!(result.head_oid.as_deref(), Some(expected_head.as_str()));
    assert!(destination.join("branch-only.txt").is_file());
    assert_eq!(
        config(&destination, "user.name").as_deref(),
        Some("QA Clone User")
    );
    assert_eq!(
        config(&destination, "user.email").as_deref(),
        Some("qa-clone@example.invalid")
    );
    assert_eq!(
        config(&destination, "http.proxy").as_deref(),
        Some("http://127.0.0.1:9")
    );
    assert_eq!(
        config(&destination, "https.proxy").as_deref(),
        Some("http://127.0.0.1:9")
    );

    let events = events.lock().expect("events");
    assert_eq!(
        events.first().map(|event| event.phase.as_str()),
        Some("preparing")
    );
    let completed = events.last().expect("completed event");
    assert_eq!(completed.phase, "completed");
    assert_eq!(completed.percent, Some(100.0));
    assert_eq!(completed.indeterminate, false);
}

#[test]
fn stores_token_in_the_vault_without_writing_it_to_git_config() {
    let temp = TempDir::new().expect("temp");
    let source = create_source_repository(temp.path());
    let destination = temp.path().join("token-repo");
    let vault = Arc::new(Vault::open(&temp.path().join("vault.db")).expect("vault"));
    vault.init("correct horse battery").expect("vault init");
    let events = Arc::new(StdMutex::new(Vec::new()));
    let sink = events.clone();
    let runtime = CloneRuntime {
        emit: Box::new(move |progress| {
            sink.lock().expect("events").push(progress);
        }),
        cancel: Arc::new(AtomicBool::new(false)),
        vault: Some(vault.clone()),
    };
    let mut clone_request = request(&destination, &source, None);
    clone_request.remember_token = true;

    let result = run_clone(
        clone_request,
        (None, None),
        Some((
            "x-access-token".into(),
            Zeroizing::new("qa-super-secret-token".into()),
        )),
        runtime,
    )
    .expect("clone with token");

    assert!(result.token_remembered);
    assert_eq!(
        config(&destination, "taomni-auth.origin.tokenRef").as_deref(),
        Some("vault:git-clone-token-v1")
    );
    assert_eq!(
        config(&destination, "taomni-auth.origin.username").as_deref(),
        Some("x-access-token")
    );
    let stored = vault
        .get_fixed(GIT_CLONE_TOKEN_ID)
        .expect("vault read")
        .expect("stored token");
    assert_eq!(stored.as_str(), "qa-super-secret-token");
    let git_config = fs::read_to_string(destination.join(".git/config")).expect("git config");
    assert!(!git_config.contains("qa-super-secret-token"));
    assert!(!git_config.contains("tokenRef = qa-super-secret-token"));
}

#[test]
fn failed_clone_removes_only_a_directory_it_created() {
    let temp = TempDir::new().expect("temp");
    let missing_source = temp.path().join("missing-source");
    let destination = temp.path().join("new-destination");
    let (runtime, _) = runtime_with_events();

    let error = run_clone(
        request(&destination, &missing_source, None),
        (None, None),
        None,
        runtime,
    )
    .expect_err("missing source must fail");
    assert!(!error.trim().is_empty());
    assert!(
        !destination.exists(),
        "a failed clone must remove its own fresh destination"
    );
}

#[test]
fn failed_clone_keeps_a_pre_existing_empty_destination_and_reports_it() {
    let temp = TempDir::new().expect("temp");
    let missing_source = temp.path().join("missing-source");
    let destination = temp.path().join("pre-existing-empty");
    fs::create_dir_all(&destination).expect("destination");
    let (runtime, _) = runtime_with_events();

    let error = run_clone(
        request(&destination, &missing_source, None),
        (None, None),
        None,
        runtime,
    )
    .expect_err("missing source must fail");
    assert!(
        destination.exists(),
        "a pre-existing directory must be kept"
    );
    assert!(
        error.contains("pre-existing directory"),
        "failure must explain the retained directory: {error}"
    );
}

#[test]
fn refuses_to_overwrite_a_non_empty_destination() {
    let temp = TempDir::new().expect("temp");
    let source = create_source_repository(temp.path());
    let destination = temp.path().join("occupied");
    fs::create_dir_all(&destination).expect("destination");
    fs::write(destination.join("keep.txt"), "keep me").expect("existing file");
    let (runtime, _) = runtime_with_events();

    let error = run_clone(
        request(&destination, &source, None),
        (None, None),
        None,
        runtime,
    )
    .expect_err("non-empty destination must fail");
    assert!(error.contains("not empty"), "{error}");
    assert_eq!(
        fs::read_to_string(destination.join("keep.txt")).expect("kept file"),
        "keep me"
    );
}

#[test]
fn registry_rejects_duplicate_task_and_destination_then_releases_them() {
    let temp = TempDir::new().expect("temp");
    let destination = temp.path().join("registry-target");
    let first = register_task("registry-a", &destination).expect("first task");
    assert!(register_task("registry-b", &destination).is_err());
    assert!(register_task("registry-a", &destination).is_err());
    assert!(cancel_task("registry-a"));
    first.store(false, Ordering::SeqCst);
    unregister_task("registry-a");
    assert!(register_task("registry-b", &destination).is_ok());
    unregister_task("registry-b");
}

#[test]
fn validates_urls_branches_and_destinations() {
    assert_eq!(
        normalized_url("https://github.com/engcapa/taomni.git").unwrap(),
        "https://github.com/engcapa/taomni.git"
    );
    assert_eq!(
        normalized_url("git@github.com:engcapa/taomni.git").unwrap(),
        "git@github.com:engcapa/taomni.git"
    );
    assert_eq!(
        normalized_url("ssh://git@example.test/org/repo.git").unwrap(),
        "ssh://git@example.test/org/repo.git"
    );
    assert!(normalized_url("https://token@github.com/org/repo.git").is_err());
    assert!(normalized_url("https://user:pass@github.com/org/repo.git").is_err());
    assert!(normalized_url("-u https://example.test/repo.git").is_err());
    assert!(normalized_url("https://example.test/repo with space.git").is_err());
    assert!(normalized_url("ftp://example.test/repo.git").is_err());
    assert!(normalized_url("").is_err());

    assert_eq!(
        normalized_branch(Some("feature/clone-import"))
            .unwrap()
            .as_deref(),
        Some("feature/clone-import")
    );
    assert!(normalized_branch(Some("-bad")).is_err());
    assert!(normalized_branch(Some("a..b")).is_err());
    assert!(normalized_branch(Some("a b")).is_err());
    assert!(normalized_branch(Some("a@{b")).is_err());
    assert_eq!(normalized_branch(None).unwrap(), None);

    assert!(normalized_name("my-workspace").is_ok());
    assert!(normalized_name("a/b").is_err());
    assert!(normalized_name("..").is_err());
    assert!(normalized_name("  ").is_err());

    assert!(normalized_destination("relative/path").is_err());
    assert!(
        normalized_destination(&temp_path_string()).is_ok(),
        "absolute temp path is accepted"
    );
}

fn temp_path_string() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}
