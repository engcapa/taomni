use super::*;
use tempfile::TempDir;

#[test]
fn run_git_strings_rejects_missing_cwd_with_stable_message() {
    let missing = std::env::temp_dir().join(format!(
        "taomni-missing-git-cwd-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let err = run_git_strings(Some(&missing), vec!["status".into()]).unwrap_err();
    assert!(
        err.contains("Repository path no longer exists"),
        "unexpected error: {err}"
    );
}

#[cfg(windows)]
#[test]
fn maps_windows_shell_paths_for_git_cwd() {
    assert_eq!(
        git_cwd_path("/D:/code/person/taomni"),
        PathBuf::from(r"D:\code\person\taomni")
    );
    assert_eq!(
        git_cwd_path("/d/code/person/taomni"),
        PathBuf::from(r"D:\code\person\taomni")
    );
    assert_eq!(git_cwd_path("/c"), PathBuf::from(r"C:\"));
    assert_eq!(git_cwd_path("/C:"), PathBuf::from(r"C:\"));
    assert_eq!(
        git_cwd_path("/cygdrive/e/work/repo"),
        PathBuf::from(r"E:\work\repo")
    );
    assert_eq!(
        git_cwd_path("/home/user/repo"),
        PathBuf::from("/home/user/repo")
    );
}

#[cfg(windows)]
#[test]
fn probes_repo_from_msys_drive_path() {
    if !git_available() {
        return;
    }

    let tmp = TempDir::new().unwrap();
    run_git_in(Some(tmp.path()), ["init"]).unwrap();

    let native = tmp.path().to_string_lossy();
    let bytes = native.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' {
        return;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = native[2..].replace('\\', "/");
    let msys_path = format!("/{drive}/{}", rest.trim_start_matches('/'));

    let probe = probe_path(&msys_path).unwrap();
    assert!(probe.is_repo, "{probe:?}");
    assert!(probe.repo_root.is_some(), "{probe:?}");
}

/// ED-PARITY-008-A3: viewing Changes must not write Git state. A plain
/// `git status` opportunistically rewrites `.git/index` when an entry's
/// stat data is stale (unchanged content, newer mtime).
#[test]
fn snapshot_does_not_rewrite_index_for_stale_stat_entries() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Parity Fixture"]).unwrap();
    run_git_in(
        Some(root),
        ["config", "user.email", "fixture@example.invalid"],
    )
    .unwrap();
    run_git_in(Some(root), ["config", "commit.gpgsign", "false"]).unwrap();
    fs::write(root.join("stable.txt"), "stable\n").unwrap();
    run_git_in(Some(root), ["add", "stable.txt"]).unwrap();
    run_git_in(Some(root), ["commit", "-m", "baseline"]).unwrap();
    let index = root.join(".git").join("index");
    let before = fs::read(&index).unwrap();
    // Same bytes, newer mtime: the index stat cache is now stale.
    std::thread::sleep(std::time::Duration::from_millis(1_100));
    fs::write(root.join("stable.txt"), "stable\n").unwrap();

    let snapshot = snapshot(root).unwrap();
    assert!(snapshot.changes.is_empty(), "{:?}", snapshot.changes);
    // The Git panel's per-refresh operation/conflict probe.
    assert!(conflicted_paths(root).is_empty());

    assert_eq!(
        fs::read(&index).unwrap(),
        before,
        ".git/index was rewritten by a read-only Git view"
    );
    // Explicit index writes still work under the optional-lock setting.
    fs::write(root.join("stable.txt"), "changed\n").unwrap();
    run_git_in(Some(root), ["add", "stable.txt"]).unwrap();
    assert_ne!(
        fs::read(&index).unwrap(),
        before,
        "git add must still update the index"
    );
}

#[test]
fn normalizes_and_escapes_literal_gitignore_targets() {
    assert_eq!(
        normalize_git_ignore_target("./build/output.log").unwrap(),
        "build/output.log"
    );
    assert!(normalize_git_ignore_target("../secret").is_err());
    assert!(normalize_git_ignore_target("build//output").is_err());
    assert_eq!(
        escape_git_ignore_literal("build output/[draft]#1?.log"),
        "build\\ output/\\[draft\\]\\#1\\?.log"
    );
}

#[test]
fn adds_gitignore_rules_idempotently_and_rejects_tracked_files() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    fs::write(root.join("scratch.log"), "scratch").unwrap();

    let added = add_git_ignore_rule(root, "scratch.log", false).unwrap();
    assert!(added.added);
    assert_eq!(added.rule, "/scratch.log");
    assert_eq!(
        fs::read_to_string(root.join(".gitignore")).unwrap(),
        "/scratch.log\n"
    );

    let duplicate = add_git_ignore_rule(root, "scratch.log", false).unwrap();
    assert!(!duplicate.added);
    assert_eq!(
        fs::read_to_string(root.join(".gitignore")).unwrap(),
        "/scratch.log\n"
    );

    fs::write(root.join("tracked.txt"), "tracked").unwrap();
    run_git_in(Some(root), ["add", "tracked.txt"]).unwrap();
    let error = add_git_ignore_rule(root, "tracked.txt", false).unwrap_err();
    assert!(error.contains("Tracked path cannot be ignored"), "{error}");
}

#[test]
fn parses_status_with_branch_and_changes() {
    let raw = "## main...origin/main [ahead 1]\n M src/a.ts\nA  src/b.ts\n?? notes.txt\nUU conflicted.txt\nR  old.txt -> new.txt\n";
    let (branch, detached, changes) = parse_status(raw);
    assert_eq!(branch.as_deref(), Some("main"));
    assert!(!detached);
    assert_eq!(changes.len(), 5);
    assert_eq!(changes[0].status, "modified");
    assert_eq!(changes[1].status, "added");
    assert_eq!(changes[2].status, "untracked");
    assert_eq!(changes[3].status, "conflicted");
    assert_eq!(changes[4].old_path.as_deref(), Some("old.txt"));
    assert_eq!(changes[4].path, "new.txt");
}

#[test]
fn parses_unborn_branch_status() {
    let (branch, detached, changes) = parse_status("## No commits yet on main\n?? file.txt\n");
    assert_eq!(branch.as_deref(), Some("main"));
    assert!(!detached);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].status, "untracked");
}

#[test]
fn remote_auth_key_sanitizes_remote_names() {
    assert_eq!(
        remote_auth_key("origin/private", "tokenRef"),
        "taomni-auth.origin-private.tokenRef"
    );
}

#[test]
fn pull_args_add_current_branch_for_selected_remote() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();

    let args = build_pull_args(root, Some("origin"), None, false).unwrap();
    assert_eq!(args, vec!["pull", "origin", "main"]);
}

#[test]
fn pull_args_prefer_upstream_branch_for_selected_remote() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "feature/local"]).unwrap();
    run_git_in(
        Some(root),
        ["config", "branch.feature/local.remote", "origin"],
    )
    .unwrap();
    run_git_in(
        Some(root),
        ["config", "branch.feature/local.merge", "refs/heads/main"],
    )
    .unwrap();

    let args = build_pull_args(root, Some("origin"), None, true).unwrap();
    assert_eq!(args, vec!["pull", "--rebase", "origin", "main"]);
}

#[test]
fn snapshots_real_repo_status_and_log() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
    run_git_in(Some(root), ["config", "user.email", "taomni@example.test"]).unwrap();

    fs::write(root.join("readme.md"), "hello\n").unwrap();
    let initial = snapshot(root).unwrap();
    assert_eq!(initial.current_branch.as_deref(), Some("main"));
    assert_eq!(initial.changes.len(), 1);
    assert_eq!(initial.changes[0].status, "untracked");

    run_git_in(Some(root), ["add", "readme.md"]).unwrap();
    let staged = snapshot(root).unwrap();
    assert!(staged.changes[0].staged);

    run_git_in(Some(root), ["commit", "-m", "initial commit"]).unwrap();
    let clean = snapshot(root).unwrap();
    assert!(clean.changes.is_empty());
    let log = list_log(
        root,
        &GitLogFilter {
            limit: Some(10),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(log[0].subject, "initial commit");

    fs::write(root.join("readme.md"), "hello\nworld\n").unwrap();
    let modified = snapshot(root).unwrap();
    assert_eq!(modified.changes.len(), 1);
    assert_eq!(modified.changes[0].status, "modified");
    assert!(modified.changes[0].unstaged);
}

#[test]
fn reads_real_repo_remotes_and_local_settings() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(
        Some(root),
        ["remote", "add", "origin", "https://example.test/repo.git"],
    )
    .unwrap();
    set_optional_config(root, "user.name", Some("Repo User".to_string())).unwrap();
    set_optional_config(root, "user.email", Some("repo@example.test".to_string())).unwrap();
    set_optional_config(
        root,
        "http.proxy",
        Some("http://127.0.0.1:8080".to_string()),
    )
    .unwrap();
    set_optional_config(
        root,
        &remote_auth_key("origin", "username"),
        Some("octo".to_string()),
    )
    .unwrap();
    set_optional_config(
        root,
        &remote_auth_key("origin", "tokenRef"),
        Some("vault:test-token".to_string()),
    )
    .unwrap();

    let remotes = list_remotes(root).unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(remotes[0].fetch_url, "https://example.test/repo.git");
    assert_eq!(remotes[0].username.as_deref(), Some("octo"));
    assert_eq!(remotes[0].token_ref.as_deref(), Some("vault:test-token"));

    let settings = load_settings(root);
    assert_eq!(settings.user_name.as_deref(), Some("Repo User"));
    assert_eq!(settings.user_email.as_deref(), Some("repo@example.test"));
    assert_eq!(
        settings.http_proxy.as_deref(),
        Some("http://127.0.0.1:8080")
    );
}

#[test]
fn detects_image_and_binary_content() {
    assert!(is_image_path("assets/logo.PNG"));
    assert!(is_image_path("a/b/c.jpeg"));
    assert!(!is_image_path("diagram.drawio"));
    assert!(!is_image_path("src/main.rs"));
    assert!(is_binary(Some(&[0x00, 0x01, 0x02])));
    assert!(!is_binary(Some(b"plain text\n")));
    assert!(!is_binary(None));
}

#[test]
fn blob_pair_handles_untracked_added_side() {
    // No old side (empty ref) + new working-tree side => added file shown in full.
    let pair = build_blob_pair(
        "notes.txt".into(),
        None,
        BlobSide::absent(),
        BlobSide::from_bytes(b"line one\nline two\n".to_vec()),
    );
    assert!(!pair.old_exists);
    assert!(pair.new_exists);
    assert!(!pair.binary);
    assert_eq!(pair.old_text, None);
    assert_eq!(pair.new_text.as_deref(), Some("line one\nline two\n"));
}

#[test]
fn blob_pair_marks_images_with_base64() {
    let pair = build_blob_pair(
        "logo.png".into(),
        None,
        BlobSide::absent(),
        BlobSide::from_bytes(vec![0x89, 0x50, 0x4e, 0x47]),
    );
    assert!(pair.image);
    assert!(pair.binary);
    assert_eq!(pair.new_text, None);
    assert_eq!(pair.new_image_b64.as_deref(), Some("iVBORw=="));
}

#[test]
fn reads_worktree_and_head_blobs() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
    run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
    fs::write(root.join("a.txt"), "v1\n").unwrap();
    run_git_in(Some(root), ["add", "a.txt"]).unwrap();
    run_git_in(Some(root), ["commit", "-m", "init"]).unwrap();
    fs::write(root.join("a.txt"), "v2\n").unwrap();

    let head = read_blob(root, "HEAD", "a.txt").unwrap();
    assert!(head.exists);
    assert_eq!(head.bytes.as_deref(), Some(b"v1\n".as_ref()));
    let worktree = read_blob(root, ":WORKTREE", "a.txt").unwrap();
    assert!(worktree.exists);
    assert_eq!(worktree.bytes.as_deref(), Some(b"v2\n".as_ref()));
    // Missing path at a ref is absent, not an error.
    assert!(!read_blob(root, "HEAD", "missing.txt").unwrap().exists);
    assert!(!read_blob(root, "", "a.txt").unwrap().exists);
}

#[test]
fn skips_oversized_worktree_blob_body() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let path = root.join("large.txt");
    fs::write(&path, vec![b'a'; MAX_DIFF_BYTES + 1]).unwrap();

    let blob = read_blob(root, ":WORKTREE", "large.txt").unwrap();
    assert!(blob.exists);
    assert_eq!(blob.size, (MAX_DIFF_BYTES + 1) as u64);
    assert!(blob.bytes.is_none());

    let pair = build_blob_pair("large.txt".into(), None, BlobSide::absent(), blob);
    assert!(pair.oversize);
    assert!(pair.new_exists);
    assert_eq!(pair.new_size, (MAX_DIFF_BYTES + 1) as u64);
    assert_eq!(pair.new_text, None);
}

#[test]
fn selective_commit_only_includes_chosen_paths() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
    run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
    fs::write(root.join("seed.txt"), "seed\n").unwrap();
    run_git_in(Some(root), ["add", "seed.txt"]).unwrap();
    run_git_in(Some(root), ["commit", "-m", "seed"]).unwrap();

    // One untracked file we want, one staged file we do NOT want in this commit.
    fs::write(root.join("wanted.txt"), "wanted\n").unwrap();
    fs::write(root.join("other.txt"), "other\n").unwrap();
    run_git_in(Some(root), ["add", "other.txt"]).unwrap();

    commit_changes(
        root,
        "add wanted only",
        false,
        Some(vec!["wanted.txt".into()]),
    )
    .unwrap();

    // wanted.txt is committed; other.txt remains staged (uncommitted).
    let committed = run_git_in(Some(root), ["show", "--name-only", "--format=", "HEAD"]).unwrap();
    assert!(committed.contains("wanted.txt"));
    assert!(!committed.contains("other.txt"));
    let snap = snapshot(root).unwrap();
    let other = snap.changes.iter().find(|c| c.path == "other.txt").unwrap();
    assert!(other.staged);
}

#[test]
fn detects_merge_conflict_operation() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
    run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
    fs::write(root.join("f.txt"), "base\n").unwrap();
    run_git_in(Some(root), ["add", "f.txt"]).unwrap();
    run_git_in(Some(root), ["commit", "-m", "base"]).unwrap();
    assert_eq!(detect_operation(root), "none");

    run_git_in(Some(root), ["checkout", "-b", "feature"]).unwrap();
    fs::write(root.join("f.txt"), "feature\n").unwrap();
    run_git_in(Some(root), ["commit", "-am", "feature"]).unwrap();
    run_git_in(Some(root), ["checkout", "main"]).unwrap();
    fs::write(root.join("f.txt"), "mainline\n").unwrap();
    run_git_in(Some(root), ["commit", "-am", "mainline"]).unwrap();

    // Conflicting merge leaves MERGE_HEAD + an unmerged path.
    let _ = run_git_in(Some(root), ["merge", "feature"]);
    assert_eq!(detect_operation(root), "merge");
    assert_eq!(conflicted_paths(root), vec!["f.txt".to_string()]);
    assert_eq!(operation_command("merge").unwrap(), "merge");
    assert!(operation_command("bogus").is_err());
}

#[test]
fn parses_decoration_refs() {
    assert_eq!(
        parse_refs("HEAD -> main, origin/main, tag: v1.0"),
        vec![
            "main".to_string(),
            "origin/main".to_string(),
            "v1.0".to_string()
        ]
    );
    assert!(parse_refs("").is_empty());
}

#[test]
fn parses_log_entries_with_multiline_body() {
    let raw = concat!(
        "\x1eabcdef0123456789\x1fabcdef0\x1f1234567 7654321\x1fAda\x1fada@example.test\x1f",
        "2026-07-04T10:00:00Z\x1ffeat: show commit message\x1fHEAD -> main, tag: v1.0\x1f",
        "Body line one\n\nBody line two\n",
        "\x1e1234567890abcdef\x1f1234567\x1f\x1fBen\x1fben@example.test\x1f",
        "2026-07-04T11:00:00Z\x1ffix: compact row\x1f\x1f",
    );

    let entries = parse_log_entries(raw);

    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].subject, "feat: show commit message");
    assert_eq!(entries[0].body, "Body line one\n\nBody line two");
    assert_eq!(
        entries[0].refs,
        vec!["main".to_string(), "v1.0".to_string()]
    );
    assert_eq!(
        entries[0].parents,
        vec!["1234567".to_string(), "7654321".to_string()]
    );
    assert_eq!(entries[1].subject, "fix: compact row");
    assert!(entries[1].body.is_empty());
}

#[test]
fn parses_name_status_with_renames() {
    let changes =
        parse_name_status("M\tsrc/a.ts\nA\tnew.txt\nD\tgone.txt\nR100\told.txt\tnew.txt\n");
    assert_eq!(changes.len(), 4);
    assert_eq!(changes[0].status, "modified");
    assert_eq!(changes[1].status, "added");
    assert_eq!(changes[2].status, "deleted");
    assert_eq!(changes[3].status, "renamed");
    assert_eq!(changes[3].old_path.as_deref(), Some("old.txt"));
    assert_eq!(changes[3].path, "new.txt");
}

#[test]
fn parses_line_porcelain_blame() {
    let raw = concat!(
        "0123456789abcdef0123456789abcdef01234567 3 7 1\n",
        "author Ada Lovelace\n",
        "author-mail <ada@example.test>\n",
        "author-time 1783814400\n",
        "author-tz +0800\n",
        "summary feat: add outline\n",
        "filename src/main.ts\n",
        "\tconst value = 1;\n",
        "0000000000000000000000000000000000000000 4 8 1\n",
        "author Not Committed Yet\n",
        "author-mail <not.committed.yet>\n",
        "author-time 1783814500\n",
        "summary Version of src/main.ts from src/main.ts\n",
        "filename src/main.ts\n",
        "\tconst draft = 2;\n",
    );

    let lines = parse_blame_porcelain(raw);

    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].line, 7);
    assert_eq!(lines[0].author, "Ada Lovelace");
    assert_eq!(lines[0].author_mail.as_deref(), Some("ada@example.test"));
    assert_eq!(lines[0].summary, "feat: add outline");
    assert_eq!(lines[1].line, 8);
    assert!(lines[1].commit.chars().all(|character| character == '0'));
}

#[test]
fn lists_lightweight_and_annotated_tags() {
    if !git_available() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    run_git_in(Some(root), ["init"]).unwrap();
    run_git_in(Some(root), ["checkout", "-b", "main"]).unwrap();
    run_git_in(Some(root), ["config", "user.name", "Taomni Test"]).unwrap();
    run_git_in(Some(root), ["config", "user.email", "t@example.test"]).unwrap();
    fs::write(root.join("f.txt"), "x\n").unwrap();
    run_git_in(Some(root), ["add", "f.txt"]).unwrap();
    run_git_in(Some(root), ["commit", "-m", "c1"]).unwrap();
    run_git_in(Some(root), ["tag", "v1"]).unwrap();
    run_git_in(Some(root), ["tag", "-a", "v2", "-m", "release two"]).unwrap();

    let tags = list_tags(root).unwrap();
    let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"v1"));
    assert!(names.contains(&"v2"));
    let v2 = tags.iter().find(|t| t.name == "v2").unwrap();
    assert!(v2.annotated);
    assert_eq!(v2.subject.as_deref(), Some("release two"));
    let v1 = tags.iter().find(|t| t.name == "v1").unwrap();
    assert!(!v1.annotated);
}
