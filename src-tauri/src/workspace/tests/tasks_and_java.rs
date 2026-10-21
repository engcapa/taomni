use super::*;
#[test]
fn detects_package_cargo_and_make_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("package.json"),
        r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
    )
    .unwrap();
    fs::write(dir.path().join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
    fs::write(dir.path().join("Cargo.toml"), "[package]\nname='demo'").unwrap();
    fs::write(
        dir.path().join("Makefile"),
        "build:\n\t@echo build\n.PHONY: build\ninvalid target: ignored\n",
    )
    .unwrap();

    let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
    assert!(tasks.iter().any(|task| {
        task.source == "package.json" && task.label == "dev" && task.command == "pnpm run dev"
    }));
    assert!(tasks.iter().any(|task| {
        task.source == "Cargo.toml" && task.label == "clippy" && task.command == "cargo clippy"
    }));
    assert!(tasks.iter().any(|task| {
        task.source == "Makefile" && task.label == "build" && task.command == "make build"
    }));
    assert!(!tasks.iter().any(|task| task.label == "invalid target"));
}

#[test]
fn detects_go_gradle_maven_and_python_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("go.mod"), "module example.com/demo").unwrap();
    fs::write(dir.path().join("build.gradle.kts"), "plugins {}").unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(
        dir.path().join("pyproject.toml"),
        "[project.scripts]\nserve = 'demo:main'\n[tool.poetry.scripts]\nworker = 'demo:worker'\n",
    )
    .unwrap();
    fs::write(dir.path().join("uv.lock"), "version = 1").unwrap();

    let tasks = detect_workspace_tasks(dir.path(), None).unwrap();
    for command in [
        "go test ./...",
        "gradle build",
        "mvn package",
        "uv run serve",
        "uv run worker",
    ] {
        assert!(
            tasks.iter().any(|task| task.command == command),
            "missing {command}"
        );
    }
}

#[test]
fn parses_maven_dependency_tree_with_nesting_and_scopes() {
    let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- org.springframework:spring-core:jar:5.3.0:compile
[INFO] |  \\- org.springframework:spring-jcl:jar:5.3.0:compile
[INFO] \\- junit:junit:jar:4.13:test
[INFO]    \\- org.hamcrest:hamcrest-core:jar:1.3:test
";
    let tree = parse_maven_dependency_tree(output);
    // Root project's direct deps become the forest.
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].artifact, "spring-core");
    assert_eq!(tree[0].scope, "compile");
    assert_eq!(tree[0].children.len(), 1);
    assert_eq!(tree[0].children[0].artifact, "spring-jcl");
    assert_eq!(tree[1].artifact, "junit");
    assert_eq!(tree[1].scope, "test");
    assert_eq!(tree[1].children[0].artifact, "hamcrest-core");
    assert!(tree.iter().all(|node| node.conflict.is_none()));
}

#[test]
fn parses_maven_verbose_conflict_marker() {
    let output = "\
[INFO] com.example:demo:jar:1.0.0
[INFO] +- a:one:jar:1.0:compile
[INFO] \\- b:two:jar:2.0:compile (omitted for conflict with 3.0)
";
    let tree = parse_maven_dependency_tree(output);
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[1].artifact, "two");
    assert_eq!(
        tree[1].conflict.as_deref(),
        Some("(omitted for conflict with 3.0)")
    );
}

#[test]
fn parses_gradle_dependencies_with_arbitration() {
    let output = "\
runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.springframework:spring-core:5.3.0
|    \\--- org.springframework:spring-jcl:5.3.0
\\--- com.google.guava:guava:30.0 -> 31.0 (*)
";
    let tree = parse_gradle_dependencies(output);
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].artifact, "spring-core");
    assert_eq!(tree[0].version, "5.3.0");
    assert_eq!(tree[0].children[0].artifact, "spring-jcl");
    // Arbitration: resolved version wins, conflict note records the bump.
    assert_eq!(tree[1].artifact, "guava");
    assert_eq!(tree[1].version, "31.0");
    assert_eq!(
        tree[1].conflict.as_deref(),
        Some("com.google.guava:guava:30.0 -> 31.0")
    );
}

#[test]
fn dependency_parsers_tolerate_empty_and_noise() {
    assert!(parse_maven_dependency_tree("").is_empty());
    assert!(parse_gradle_dependencies("No dependencies\n").is_empty());
    assert!(parse_maven_dependency_tree("[INFO] Scanning for projects...\n").is_empty());
}

#[test]
fn task_tree_groups_by_source_with_full_maven_and_gradle_lifecycles() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("package.json"),
        r#"{"scripts":{"dev":"vite","test":"vitest run"}}"#,
    )
    .unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins {}").unwrap();

    let groups = build_workspace_task_tree(dir.path(), None).unwrap();
    let find = |source: &str| groups.iter().find(|group| group.source == source);

    // Maven carries the full lifecycle (not just the Run-tab package/test subset).
    let maven = find("Maven").expect("Maven group");
    for phase in ["clean", "compile", "package", "verify", "install"] {
        assert!(
            maven.tasks.iter().any(|task| task.label == phase),
            "Maven lifecycle missing {phase}"
        );
    }
    // Gradle carries the common tasks.
    let gradle = find("Gradle").expect("Gradle group");
    for task in ["clean", "build", "assemble", "check"] {
        assert!(
            gradle.tasks.iter().any(|entry| entry.label == task),
            "Gradle tasks missing {task}"
        );
    }
    // Other ecosystems still group their detected tasks.
    let npm = find("package.json").expect("package.json group");
    assert!(npm.tasks.iter().any(|task| task.label == "dev"));
    assert!(npm.tasks.iter().any(|task| task.label == "test"));

    // No duplicate labels within a group (enrichment vs detection overlap).
    for group in &groups {
        let mut labels: Vec<&str> = group.tasks.iter().map(|task| task.label.as_str()).collect();
        let count = labels.len();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), count, "duplicate label in {}", group.source);
    }
}

#[test]
fn discovers_plain_java_main_without_debug_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let source_dir = dir.path().join("src/com/example");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("App.java"),
        r#"
                package com.example;
                // public static void main(String[] ignored) {}
                public class App {
                    String example = "static void main(String[] fake)";
                    public static void main(final String[] args) {
                        System.out.println("ok");
                    }
                }
            "#,
    )
    .unwrap();

    let target = workspace_java_run_target(
        dir.path().to_string_lossy().into_owned(),
        "src/com/example/App.java".into(),
        None,
    )
    .unwrap();
    assert_eq!(target.main_class, "com.example.App");
    assert_eq!(target.build_system, "source-file");
    assert!(target.command.starts_with("java "));
    assert!(target.command.contains("App.java"));
    assert_eq!(target.module_path, ".");
}

#[test]
fn rejects_java_file_with_main_only_in_comments_or_strings() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("Example.java"),
        r#"
                /** public static void main(String[] args) {} */
                class Example {
                    String sample = "public static void main(String[] args)";
                }
            "#,
    )
    .unwrap();

    let error = workspace_java_run_target(
        dir.path().to_string_lossy().into_owned(),
        "Example.java".into(),
        None,
    )
    .unwrap_err();
    assert!(error.contains("No `static void main"));
}

#[test]
fn builds_maven_main_command_with_project_wrapper() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("pom.xml"), "<project />").unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let source_dir = dir.path().join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(dir.path(), &source_dir.join("Main.java"), None).unwrap();
    assert_eq!(target.build_system, "maven");
    assert_eq!(target.main_class, "demo.Main");
    assert_eq!(target.cwd, path_to_string(dir.path()));
    assert!(target.command.contains("mvnw"));
    assert_eq!(target.execution.source, "wrapper");
    assert!(target.execution.executable.contains("mvnw"));
    assert!(target.execution.error.is_none());
    // PowerShell splits `-Dexec.mainClass='demo.Main'` at the property-name
    // dot. Quoting the whole Maven property keeps it a single argument.
    assert!(target.command.contains("'-Dexec.mainClass=demo.Main'"));
    assert!(
        target
            .command
            .contains("'-Dexec.cleanupDaemonThreads=false'")
    );
    assert_eq!(target.execution.args[2], "-Dexec.mainClass=demo.Main");
    assert_eq!(
        target.execution.args[3],
        "-Dexec.cleanupDaemonThreads=false"
    );
    assert!(target.command.contains("exec-maven-plugin:3.5.0:java"));
}

#[test]
fn applies_maven_run_jvm_options_through_task_environment() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("pom.xml"),
        r#"
                <project>
                  <build><plugins><plugin><configuration>
                    <argLine>
                      @{argLine}
                      --add-exports java.base/sun.nio.ch=ALL-UNNAMED
                      --add-opens=java.base/java.lang.reflect=ALL-UNNAMED
                      --enable-native-access=ALL-UNNAMED
                      -javaagent:should-not-be-inherited.jar
                      -Xmx512m
                      --add-reads -Xms256m
                    </argLine>
                    <!-- <argLine>--add-opens=java.base/java.net=ALL-UNNAMED</argLine> -->
                  </configuration></plugin></plugins></build>
                </project>
            "#,
    )
    .unwrap();
    fs::write(dir.path().join("mvnw"), "#!/bin/sh").unwrap();
    let module = dir.path().join("server");
    let source_dir = module.join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(module.join("pom.xml"), "<project />").unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(
        dir.path(),
        &source_dir.join("Main.java"),
        Some(&WorkspaceToolConfig {
            maven_jvm_args: vec![
                "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into(),
                "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED".into(),
            ],
            ..WorkspaceToolConfig::default()
        }),
    )
    .unwrap();
    let maven_opts = &target.environment.unwrap()["MAVEN_OPTS"];
    assert_eq!(maven_opts.mode, "append");
    assert_eq!(
        maven_opts.value,
        "--add-exports=java.base/sun.nio.ch=ALL-UNNAMED \
             --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
             --enable-native-access=ALL-UNNAMED \
             --add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
    );
    assert!(!maven_opts.value.contains("-javaagent"));
    assert!(!maven_opts.value.contains("-Xmx"));
    assert!(!maven_opts.value.contains("java.net"));
}

#[test]
fn can_disable_maven_arg_line_inheritance() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("pom.xml"),
        "<project><argLine>--add-opens=java.base/java.io=ALL-UNNAMED</argLine></project>",
    )
    .unwrap();
    let source_dir = dir.path().join("src/main/java/demo");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("Main.java"),
        "package demo; class Main { public static void main(String... args) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(
        dir.path(),
        &source_dir.join("Main.java"),
        Some(&WorkspaceToolConfig {
            maven_jvm_args: vec!["--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into()],
            inherit_maven_arg_line: Some(false),
            ..WorkspaceToolConfig::default()
        }),
    )
    .unwrap();
    assert_eq!(
        target.environment.unwrap()["MAVEN_OPTS"].value,
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
    );
}

#[test]
fn builds_gradle_subproject_main_command_and_module_tasks() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("settings.gradle"), "include 'app'").unwrap();
    fs::write(dir.path().join("build.gradle"), "plugins { id 'base' }").unwrap();
    fs::write(dir.path().join("gradlew"), "#!/bin/sh").unwrap();
    fs::create_dir_all(dir.path().join("app/src/main/java/demo")).unwrap();
    fs::write(dir.path().join("app/build.gradle"), "plugins { id 'java' }").unwrap();
    let source = dir.path().join("app/src/main/java/demo/App.java");
    fs::write(
        &source,
        "package demo; class App { static void main(String args[]) {} }",
    )
    .unwrap();

    let target = java_run_target_for_path(dir.path(), &source, None).unwrap();
    assert_eq!(target.build_system, "gradle");
    assert_eq!(target.module_path, "app");
    assert_eq!(target.cwd, path_to_string(dir.path()));
    assert!(target.command.contains(":app:taomniRun"));
    assert!(target.command.contains("-PtaomniMainClass='demo.App'"));
    assert!(target.command.contains("java-run.init.gradle"));

    let groups = build_workspace_task_tree(dir.path(), None).unwrap();
    let gradle = groups
        .iter()
        .find(|group| group.source == "Gradle")
        .unwrap();
    let module_compile = gradle
        .tasks
        .iter()
        .find(|task| task.module_path.as_deref() == Some("app") && task.label == "classes")
        .unwrap();
    assert!(module_compile.command.contains(":app:classes"));
    assert!(module_compile.command.contains("gradlew"));
}

#[test]
fn java_target_scan_skips_test_sources() {
    let dir = tempfile::tempdir().unwrap();
    for (folder, name) in [
        ("src/main/java/demo", "App"),
        ("src/test/java/demo", "FixtureMain"),
    ] {
        let source_dir = dir.path().join(folder);
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join(format!("{name}.java")),
            format!("package demo; class {name} {{ public static void main(String[] args) {{}} }}"),
        )
        .unwrap();
    }
    let targets = detect_java_run_targets(dir.path(), None).unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].main_class, "demo.App");
}
