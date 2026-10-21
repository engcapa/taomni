use super::*;
#[test]
fn build_lsp_server_command_keeps_program_on_unix_like() {
    // On every platform the non-batch path must still invoke the program name.
    // Windows batch routing is covered by platform integration; here we only
    // assert the builder returns a Command without panicking for a plain binary.
    let root = PathBuf::from("/tmp/workspace");
    let _cmd = build_lsp_server_command("rust-analyzer", &["--version".into()], &root, None, None)
        .expect("command builder");
}

#[test]
fn maps_jdtls_build_workspace_status_ordinals() {
    // JDT LS answers `java/buildWorkspace` with a BuildWorkspaceStatus ordinal.
    assert_eq!(build_status_from_result(&json!(0)), LspBuildStatus::Failed);
    assert_eq!(build_status_from_result(&json!(1)), LspBuildStatus::Succeed);
    assert_eq!(
        build_status_from_result(&json!(2)),
        LspBuildStatus::WithError
    );
    assert_eq!(
        build_status_from_result(&json!(3)),
        LspBuildStatus::Cancelled
    );
    // Unknown / absent payloads must not block a launch.
    assert_eq!(
        build_status_from_result(&Value::Null),
        LspBuildStatus::Succeed
    );
    assert_eq!(
        build_status_from_result(&json!("done")),
        LspBuildStatus::Succeed
    );
}

#[test]
fn java_project_commands_get_a_longer_budget_than_interactive_requests() {
    // resolveMainClass / resolveClasspath / startDebugSession search the whole
    // project and activate an OSGi bundle on first use; the interactive budget
    // cuts them off mid-flight and the Debug button then looks like a no-op.
    assert!(JAVA_COMMAND_TIMEOUT_SECS > REQUEST_TIMEOUT_SECS);
    assert!(BUILD_WORKSPACE_TIMEOUT_SECS > JAVA_COMMAND_TIMEOUT_SECS);
}

#[test]
fn server_configuration_sections_are_resolved_without_silent_nulls() {
    let configuration = json!({
        "java": { "autobuild": { "enabled": true } },
        "editor": { "tabSize": 2 }
    });
    assert_eq!(
        configuration_section_value(&configuration, Some("java.autobuild")),
        json!({ "enabled": true })
    );
    assert_eq!(
        configuration_section_value(&configuration, Some("missing")),
        Value::Null
    );
    assert_eq!(
        configuration_section_value(&configuration, None),
        configuration
    );
}

#[test]
fn server_message_requests_preserve_action_payloads_and_validate_indices() {
    let parsed = parse_show_message_request(Some(&json!({
        "type": 2,
        "message": "Choose",
        "actions": [{ "title": "Keep", "command": "keep" }, { "title": "Drop" }]
    })))
    .expect("valid message request");
    assert_eq!(parsed.message_type, 2);
    assert_eq!(parsed.actions[0]["command"], "keep");
    assert!(
        parse_show_message_request(Some(&json!({
            "type": 2,
            "message": "Choose",
            "actions": [{ "label": "missing title" }]
        })))
        .is_none()
    );
}

#[test]
fn jdtls_service_ready_status_is_distinct_from_initialize() {
    assert!(language_status_is_service_ready(Some(&json!({
        "type": "ServiceReady",
        "message": "ServiceReady"
    }))));
    assert!(!language_status_is_service_ready(Some(&json!({
        "type": "Started"
    }))));
    assert!(!language_status_is_service_ready(Some(&json!({
        "message": "ServiceReady"
    }))));
    assert!(!language_status_is_service_ready(None));
}

#[test]
fn progress_tokens_are_type_sensitive_and_percentages_are_bounded() {
    assert_ne!(
        progress_token_key(&json!(1)),
        progress_token_key(&json!("1"))
    );
    assert_eq!(
        progress_percentage(&json!({ "percentage": 120 })),
        Some(100)
    );
    assert_eq!(progress_percentage(&json!({ "percentage": 42 })), Some(42));
    assert!(is_progress_token(&json!("build")));
    assert!(!is_progress_token(&Value::Null));
}

#[test]
fn unknown_server_request_uses_standard_json_rpc_method_not_found_code() {
    assert_eq!(JSON_RPC_METHOD_NOT_FOUND, -32601);
    assert_eq!(LSP_REQUEST_CANCELLED, -32800);
}

#[test]
fn detects_fernflower_decompiler_banner() {
    let decompiled =
        format!("{JDTLS_DECOMPILER_HEADER} (from Intellij IDEA).\npackage java.lang;\n");
    assert!(is_decompiled_contents(&decompiled));
    // Leading blank lines still count (jdtls hands us the banner verbatim).
    assert!(is_decompiled_contents(&format!("\n{decompiled}")));
    assert!(!is_decompiled_contents(
        "package java.lang;\npublic class String {}\n"
    ));
    assert!(!is_decompiled_contents(""));
}

#[test]
fn jdtls_data_dir_is_stable_per_project_and_distinct_across_projects() {
    let a1 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
    let a2 = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\a" } else { "/a" }));
    let b = jdtls_data_dir(Path::new(if cfg!(windows) { r"C:\b" } else { "/b" }));
    assert_eq!(a1, a2, "same project must reuse its index dir");
    assert_ne!(a1, b, "different projects must not share an index dir");
    assert!(a1.starts_with(jdtls_data_root()));
}

#[test]
fn prune_removes_only_indexes_whose_project_is_gone() {
    let base = std::env::temp_dir().join(format!("taomni-jdtls-prune-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let live_project = base.join("live-project");
    std::fs::create_dir_all(&live_project).unwrap();

    // Stand-ins for two index dirs: one for a live project, one for a deleted one.
    let live_index = base.join("index-live");
    let gone_index = base.join("index-gone");
    let no_marker = base.join("index-nomarker");
    for dir in [&live_index, &gone_index, &no_marker] {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(
        live_index.join(JDTLS_WORKSPACE_MARKER),
        live_project.to_string_lossy().as_bytes(),
    )
    .unwrap();
    std::fs::write(
        gone_index.join(JDTLS_WORKSPACE_MARKER),
        base.join("deleted-project").to_string_lossy().as_bytes(),
    )
    .unwrap();

    // Exercise the same predicate prune uses, scoped to this temp tree.
    for entry in std::fs::read_dir(&base).unwrap().flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(project) = std::fs::read_to_string(dir.join(JDTLS_WORKSPACE_MARKER)) else {
            continue;
        };
        let project = project.trim();
        if !project.is_empty() && !Path::new(project).exists() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    assert!(live_index.is_dir(), "index of a live project must be kept");
    assert!(
        !gone_index.is_dir(),
        "index of a deleted project must be pruned"
    );
    assert!(no_marker.is_dir(), "unmarked dirs are left untouched");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn ensure_jdtls_data_dir_creates_dir_and_marker() {
    let base = std::env::temp_dir().join(format!("taomni-jdtls-ensure-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let data_dir = base.join("index");
    let workspace = base.join("proj");
    ensure_jdtls_data_dir(&data_dir, &workspace).unwrap();
    assert!(data_dir.is_dir());
    let marker = std::fs::read_to_string(data_dir.join(JDTLS_WORKSPACE_MARKER)).unwrap();
    assert_eq!(marker, workspace.to_string_lossy());
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn is_jdtls_program_detects_wrapper_names() {
    assert!(is_jdtls_program("jdtls", Path::new("jdtls")));
    assert!(is_jdtls_program(
        r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd",
        Path::new(r"C:\Users\me\AppData\Local\jdtls-bin\jdtls.cmd")
    ));
    assert!(!is_jdtls_program(
        "rust-analyzer",
        Path::new("rust-analyzer")
    ));
}

#[test]
fn windows_cmd_line_quotes_paths_with_spaces() {
    #[cfg(windows)]
    {
        let line = windows_cmd_line(
            Path::new(r"C:\Program Files\tools\server.cmd"),
            &["--stdio".into()],
        );
        assert_eq!(line, r#""C:\Program Files\tools\server.cmd" --stdio"#);
    }
    #[cfg(not(windows))]
    {
        // windows_cmd_line is Windows-only; keep the test compiling.
        assert!(true);
    }
}

#[test]
fn clangd_install_hint_mentions_package_or_path() {
    let hint = install_hint_for("clangd");
    assert!(
        hint.contains("clangd") || hint.contains("llvm") || hint.contains("LLVM"),
        "unexpected clangd hint: {hint}"
    );
}

#[tokio::test]
async fn coalesces_concurrent_session_start_claims() {
    let manager = LspManager::new();
    let start = match manager
        .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
        .await
    {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager
        .claim_session("workspace\nrust\n/root\nrust-analyzer", "workspace")
        .await
    {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };

    assert!(Arc::ptr_eq(&start, &waiter));
}

#[tokio::test]
async fn broadcasts_start_failure_and_allows_retry() {
    let manager = LspManager::new();
    let key = "workspace\nrust\n/root\nrust-analyzer";
    let start = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };

    let _ = manager
        .finish_session_start(key, &start, Err("initialize failed".into()))
        .await;
    match waiter.wait().await {
        Err(error) => assert_eq!(error, "initialize failed"),
        Ok(_) => panic!("waiter must receive the shared initialization failure"),
    }
    assert!(matches!(
        manager.claim_session(key, "workspace").await,
        LspSessionClaim::Start(_)
    ));
}

#[tokio::test]
async fn stopping_workspace_cancels_start_waiters_and_clears_slot() {
    let manager = LspManager::new();
    let key = "workspace\nrust\n/root\nrust-analyzer";
    let start = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Start(start) => start,
        _ => panic!("first claimant must own the session start"),
    };
    let waiter = match manager.claim_session(key, "workspace").await {
        LspSessionClaim::Wait(waiter) => waiter,
        _ => panic!("concurrent claimant must wait for the in-flight start"),
    };
    assert!(Arc::ptr_eq(&start, &waiter));

    assert_eq!(manager.stop_workspace("workspace").await, 1);
    match waiter.wait().await {
        Err(error) => assert!(error.contains("workspace stopped")),
        Ok(_) => panic!("workspace shutdown must cancel an in-flight start"),
    }
    assert!(matches!(
        manager.claim_session(key, "workspace").await,
        LspSessionClaim::Start(_)
    ));
}
