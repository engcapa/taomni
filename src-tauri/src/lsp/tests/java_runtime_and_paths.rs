use super::*;
#[test]
fn jdtls_initialization_uses_project_java_runtimes() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let mut environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
    environment.java_runtimes = vec![JavaRuntimeConfiguration {
        name: "JavaSE-17".to_string(),
        path: "/sdk/jdk-17".to_string(),
        default: true,
    }];

    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    let java = find_preset("java").expect("java preset");
    let options = lsp_initialization_options(&java, &java.commands[0], &environment);

    assert_eq!(
        options["settings"]["java"]["configuration"]["runtimes"][0],
        json!({ "name": "JavaSE-17", "path": "/sdk/jdk-17", "default": true })
    );
    // Required for jdt:// definitions into the JDK and dependency JARs.
    assert_eq!(
        options["extendedClientCapabilities"]["classFileContentsSupport"],
        json!(true)
    );
    // Default settings widen jdtls beyond bare runtimes (M6-A): autobuild on,
    // completion + format + import + code generation present.
    assert_eq!(
        options["settings"]["java"]["autobuild"]["enabled"],
        json!(true)
    );
    assert_eq!(
        options["settings"]["java"]["completion"]["guessMethodArguments"],
        json!(true)
    );
    assert!(
        options["settings"]["java"]["completion"]["favoriteStaticMembers"]
            .as_array()
            .is_some_and(|members| members
                .iter()
                .any(|m| m == "org.junit.jupiter.api.Assertions.*")),
        "JUnit 5 assertions should be a favorite static member by default"
    );
    assert_eq!(
        options["settings"]["java"]["saveActions"]["organizeImports"],
        json!(false)
    );
    let rust = find_preset("rust").expect("rust preset");
    assert_eq!(
        lsp_initialization_options(&rust, &rust.commands[0], &environment),
        Value::Null
    );
}

#[test]
fn metals_initialization_enables_virtual_documents() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let environment = WorkspaceSdkEnvironment::passthrough(&root, &root);
    let scala = find_preset("scala").expect("scala preset");
    assert_eq!(
        lsp_initialization_options(&scala, &scala.commands[0], &environment),
        json!({ "isVirtualDocumentSupported": true })
    );
}

#[test]
fn java_settings_default_and_round_trip() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    let defaults = get_configured_java_settings();
    assert!(defaults.autobuild_enabled);
    assert!(!defaults.lombok_enabled);
    assert!(!defaults.save_actions_organize_imports);

    // A partial JSON payload from the frontend fills omitted fields from Default.
    let partial: JavaLanguageSettings = serde_json::from_value(json!({
        "lombokEnabled": true,
        "saveActionsOrganizeImports": true
    }))
    .expect("partial settings deserialize");
    assert!(partial.lombok_enabled);
    assert!(partial.save_actions_organize_imports);
    // Untouched fields keep their defaults.
    assert!(partial.autobuild_enabled);
    assert!(partial.guess_method_arguments);

    set_configured_java_settings(Some(partial.clone()));
    assert_eq!(get_configured_java_settings(), partial);
    set_configured_java_settings(None);
}

#[test]
fn lombok_javaagent_only_when_enabled_with_jar() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    assert!(lombok_javaagent_arg().is_none());

    set_configured_java_settings(Some(JavaLanguageSettings {
        lombok_enabled: true,
        lombok_jar_path: Some("  ".into()),
        ..Default::default()
    }));
    assert!(
        lombok_javaagent_arg().is_none(),
        "blank jar path must not produce a -javaagent"
    );

    let jar = if cfg!(windows) {
        r"C:\tools\lombok.jar"
    } else {
        "/opt/lombok.jar"
    };
    set_configured_java_settings(Some(JavaLanguageSettings {
        lombok_enabled: true,
        lombok_jar_path: Some(jar.into()),
        ..Default::default()
    }));
    assert_eq!(lombok_javaagent_arg(), Some(format!("-javaagent:{jar}")));
    assert!(
        jdtls_vmargs()
            .iter()
            .any(|arg| arg == &format!("-javaagent:{jar}")),
        "vmargs should carry the Lombok agent so both launch paths pick it up"
    );
    set_configured_java_settings(None);
}

#[test]
fn file_path_from_uri_maps_file_and_skips_virtual() {
    let (uri, expected_suffix) = if cfg!(windows) {
        ("file:///C:/repo/src/Main.java", "Main.java")
    } else {
        ("file:///repo/src/Main.java", "Main.java")
    };
    let path = file_path_from_uri(uri).expect("file uri maps to a path");
    assert!(path.ends_with(expected_suffix), "got {path}");
    // Virtual / non-file URIs are skipped (library sources must not clutter Problems).
    assert!(file_path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
    assert!(file_path_from_uri("not a uri").is_none());
}

#[test]
fn parses_java_modules_from_project_uris() {
    let (root_a, root_b) = if cfg!(windows) {
        ("file:///C:/repo/app", "file:///C:/repo/lib")
    } else {
        ("file:///repo/app", "file:///repo/lib")
    };
    // Out of order + a duplicate + a non-file URI that must be skipped.
    let value = json!([root_b, root_a, root_b, "jdt://contents/foo"]);
    let modules = parse_java_modules(&value);
    assert_eq!(modules.len(), 2, "dedup + skip non-file, got {modules:?}");
    // Sorted by name: app before lib.
    assert_eq!(modules[0].name, "app");
    assert_eq!(modules[1].name, "lib");
    assert_eq!(modules[0].uri, root_a);
    assert!(modules[0].path.ends_with("app"));

    assert!(parse_java_modules(&json!(null)).is_empty());
    assert!(parse_java_modules(&json!([])).is_empty());
}

#[test]
fn hot_update_settings_omit_runtimes() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_configured_java_settings(None);
    // A live didChangeConfiguration push must not send an empty runtimes array
    // (that would clobber the JDK config jdtls resolved at initialize).
    let java = get_configured_java_settings().to_java_settings(&[]);
    assert!(
        java["configuration"].get("runtimes").is_none(),
        "empty runtimes must be omitted, got: {java:#}"
    );
    assert_eq!(
        java["configuration"]["updateBuildConfiguration"],
        json!("interactive")
    );

    // Whereas initialize carries them.
    let with_runtimes =
        get_configured_java_settings().to_java_settings(&[JavaRuntimeConfiguration {
            name: "JavaSE-21".into(),
            path: "/sdk/jdk-21".into(),
            default: true,
        }]);
    assert_eq!(
        with_runtimes["configuration"]["runtimes"][0]["name"],
        json!("JavaSE-21")
    );
}

#[test]
fn session_key_changes_with_sdk_fingerprint_and_project_scope() {
    let root = PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" });
    let document = ResolvedDocument {
        path: root.join("module/src/Main.kt"),
        uri: "file:///repo/module/src/Main.kt".to_string(),
        root_path: root.clone(),
        workspace_id: "workspace".to_string(),
        preset: find_preset("kotlin"),
        language_id: Some("kotlin".to_string()),
        version: 1,
    };
    let preset = document.preset.as_ref().expect("kotlin preset");
    let command = &preset.commands[0];
    let mut first = WorkspaceSdkEnvironment::passthrough(&root, &root);
    first.project_scope_path = root.join("module").to_string_lossy().into_owned();
    first.fingerprint = "jdk-17".to_string();
    let mut second = first.clone();
    second.fingerprint = "jdk-21".to_string();

    let first_key = session_key(&document, preset, command, &first);
    let second_key = session_key(&document, preset, command, &second);

    assert_ne!(first_key.map_key(), second_key.map_key());
    assert_eq!(first_key.root_path, first.project_scope_path);
}

#[test]
fn lsp_session_root_is_a_noop_without_symlinks() {
    // A plain (already-canonical) root that equals the scope is returned as-is.
    let root = std::env::temp_dir().join(format!("taomni_ra_plain_{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let canonical = std::fs::canonicalize(&root).unwrap();
    let scope = canonical.to_string_lossy().into_owned();

    let session_root = lsp_session_root(&canonical, &scope);
    assert_eq!(session_root, canonical);

    std::fs::remove_dir_all(&root).ok();
}

// The regression: the workspace is opened through a symlink, but the SDK
// resolver canonicalizes the scope. The launch root must stay in the opened
// (symlink) namespace so it shares a path prefix with the document URIs the
// frontend sends — otherwise rust-analyzer treats every file as detached and
// serves no intelligence while the session still reports "active".
#[cfg(unix)]
#[test]
fn lsp_session_root_stays_in_opened_symlink_namespace() {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let unique = format!("taomni_ra_symlink_{}", std::process::id());
    let real = base.join(format!("{unique}_real"));
    let link = base.join(format!("{unique}_link"));
    std::fs::create_dir_all(&real).unwrap();
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // What the SDK resolver produces: the canonicalized real path.
    let scope = std::fs::canonicalize(&link)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(scope, real.to_string_lossy());

    // Opened via the symlink → launch root must be the symlink path, not `real`,
    // so it prefixes `file://<link>/src/main.rs`.
    let session_root = lsp_session_root(&link, &scope);
    assert_eq!(session_root, link);
    assert_ne!(session_root, real);

    std::fs::remove_file(&link).ok();
    std::fs::remove_dir_all(&real).ok();
}

// A nested SDK subproject scope (e.g. a Java module) under a symlinked root
// must be rebased onto the opened path, preserving the nesting while keeping
// the opened namespace.
#[cfg(unix)]
#[test]
fn lsp_session_root_rebases_nested_scope_onto_symlink() {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    let unique = format!("taomni_ra_nested_{}", std::process::id());
    let real = base.join(format!("{unique}_real"));
    let link = base.join(format!("{unique}_link"));
    std::fs::create_dir_all(real.join("module")).unwrap();
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // Scope points at the canonical nested module.
    let scope = std::fs::canonicalize(link.join("module"))
        .unwrap()
        .to_string_lossy()
        .into_owned();

    let session_root = lsp_session_root(&link, &scope);
    assert_eq!(session_root, link.join("module"));

    std::fs::remove_file(&link).ok();
    std::fs::remove_dir_all(&real).ok();
}

#[test]
fn kotlin_prefers_official_lsp_and_keeps_community_fallback() {
    let kotlin = find_preset("kotlin").expect("kotlin preset");
    assert_eq!(kotlin.commands[0].id, "kotlin-lsp");
    assert!(!kotlin.commands[0].fallback);
    assert_eq!(kotlin.commands[1].id, "kotlin-language-server");
    assert!(kotlin.commands[1].fallback);
}

#[test]
fn parses_java_major_versions_from_minus_version_output() {
    assert_eq!(
        parse_java_major_from_version_output(
            r#"openjdk version "21.0.2" 2024-01-16
OpenJDK Runtime Environment (build 21.0.2+13)
"#
        ),
        Some(21)
    );
    assert_eq!(
        parse_java_major_from_version_output(
            r#"java version "17.0.4" 2022-07-19 LTS
Java(TM) SE Runtime Environment (build 17.0.4+11-LTS-179)
"#
        ),
        Some(17)
    );
    assert_eq!(
        parse_java_major_from_version_output(r#"java version "1.8.0_392""#),
        Some(8)
    );
    assert_eq!(JDTLS_MIN_JAVA_MAJOR, 21);
}

#[test]
fn jdtls_runtime_probe_labels_insufficient_java_message() {
    // Shape of the error string used to derive Settings runtimeStatus.
    let err = format!(
        "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java 17 at C:\\\\jdk-17\\\\bin\\\\java.exe"
    );
    let major = err
        .split("found Java ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|s| s.parse::<u32>().ok());
    assert_eq!(major, Some(17));
    let java = find_preset("java").expect("java preset");
    assert!(preset_uses_jdtls(&java, java.commands.first()));
    assert!(command_is_jdtls(&java.commands[0]));
}

#[test]
fn resolve_java_binary_from_user_path_accepts_home_or_binary_shape() {
    let temp = std::env::temp_dir().join(format!("taomni-jdtls-java-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    let bin_dir = temp.join("bin");
    std::fs::create_dir_all(&bin_dir).expect("mkdir");
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    let java_bin = bin_dir.join(bin_name);
    std::fs::write(&java_bin, b"stub").expect("write stub java");

    assert_eq!(
        resolve_java_binary_from_user_path(&temp),
        Some(java_bin.clone())
    );
    assert_eq!(
        resolve_java_binary_from_user_path(&bin_dir),
        Some(java_bin.clone())
    );
    assert_eq!(
        resolve_java_binary_from_user_path(&java_bin),
        Some(java_bin.clone())
    );
    assert_eq!(
        java_home_from_binary(&java_bin).as_deref(),
        Some(temp.as_path())
    );

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn configured_java_home_round_trips_and_rejects_missing_path() {
    set_configured_java_home(None);
    assert!(get_configured_java_home().is_none());

    let missing = PathBuf::from("/definitely/missing/jdk-for-taomni-test");
    set_configured_java_home(Some(missing.to_string_lossy().as_ref()));
    assert_eq!(get_configured_java_home(), Some(missing.clone()));
    let err = resolve_java_for_jdtls().expect_err("missing configured path must fail");
    assert!(
        err.contains("invalid") || err.contains("not found") || err.contains("configured"),
        "unexpected error: {err}"
    );

    set_configured_java_home(None);
    assert!(get_configured_java_home().is_none());
}

#[test]
fn configured_java_vmargs_defaults_and_round_trips() {
    let _guard = JAVA_GLOBALS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Lombok can append a -javaagent to jdtls_vmargs(); keep it off here so the
    // vec assertion below sees only the configured args.
    set_configured_java_settings(None);
    set_configured_java_vmargs(None);
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
    assert!(get_configured_java_vmargs().is_none());

    set_configured_java_vmargs(Some("   "));
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);

    set_configured_java_vmargs(Some("-Xmx2G -XX:+UseG1GC -Dfoo=bar"));
    assert_eq!(jdtls_vmargs_string(), "-Xmx2G -XX:+UseG1GC -Dfoo=bar");
    assert_eq!(
        jdtls_vmargs(),
        vec![
            "-Xmx2G".to_string(),
            "-XX:+UseG1GC".to_string(),
            "-Dfoo=bar".to_string(),
        ]
    );

    set_configured_java_vmargs(None);
    assert_eq!(jdtls_vmargs_string(), DEFAULT_JDTLS_VMARGS);
}

#[test]
fn split_jvm_args_honors_quotes() {
    let args = split_jvm_args(r#"-Xmx2G -Dpath="/opt/my jdk" -Dname='a b'"#);
    assert_eq!(
        args,
        vec![
            "-Xmx2G".to_string(),
            "-Dpath=/opt/my jdk".to_string(),
            "-Dname=a b".to_string(),
        ]
    );
}
