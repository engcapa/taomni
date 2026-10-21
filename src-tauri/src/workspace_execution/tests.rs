use super::*;

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

#[test]
fn cargo_targets_have_stable_ids_and_precise_bin_selectors() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("Cargo.toml"),
        "[package]\nname='demo'\nversion='0.1.0'\n[[bin]]\nname='worker'\npath='src/worker.rs'\n",
    );
    write(&directory.path().join("src/main.rs"), "fn main() {}\n");
    write(&directory.path().join("src/worker.rs"), "fn main() {}\n");
    let first = detect_execution_model(directory.path(), None, None).unwrap();
    let second = detect_execution_model(directory.path(), None, None).unwrap();
    assert_eq!(first.projects, second.projects);
    assert_eq!(first.run_configurations, second.run_configurations);
    assert!(first.run_configurations.iter().any(|target| {
        target
            .command
            .args
            .windows(2)
            .any(|args| args == ["--bin", "worker"])
    }));
    assert!(
        first
            .build_targets
            .iter()
            .all(|target| !target.command.executable.contains(' '))
    );
}

#[test]
fn models_modules_source_sets_language_levels_and_compile_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("rust/Cargo.toml"),
        "[package]\nname='native-app'\nversion='0.1.0'\nedition='2024'\n",
    );
    write(&directory.path().join("rust/src/main.rs"), "fn main() {}\n");
    write(
        &directory.path().join("rust/tests/smoke.rs"),
        "#[test] fn smoke() {}\n",
    );
    write(
        &directory.path().join("jvm/pom.xml"),
        "<project><properties><maven.compiler.release>${java.version}</maven.compiler.release><java.version>21</java.version></properties></project>\n",
    );
    write(
        &directory.path().join("jvm/src/main/java/App.java"),
        "class App {}\n",
    );
    write(
        &directory.path().join("jvm/src/test/java/AppTest.java"),
        "class AppTest {}\n",
    );
    write(
        &directory
            .path()
            .join("jvm/target/generated-sources/annotations/Generated.java"),
        "class Generated {}\n",
    );

    let available_tool = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let available_config = WorkspaceToolConfig {
        cargo: Some(available_tool.clone()),
        maven: Some(available_tool),
        ..Default::default()
    };
    let model = detect_execution_model(directory.path(), None, Some(&available_config)).unwrap();
    assert_eq!(model.modules.len(), model.projects.len());
    for project in &model.projects {
        let module = model
            .modules
            .iter()
            .find(|module| module.id == project.module_id)
            .expect("project module");
        assert_eq!(module.project_id, project.id);
        assert!(!module.source_set_ids.is_empty());
        assert!(module.source_set_ids.iter().all(|id| {
            model
                .source_sets
                .iter()
                .any(|source_set| source_set.id == *id && source_set.module_id == module.id)
        }));
    }

    let rust = model
        .projects
        .iter()
        .find(|project| project.provider == "cargo")
        .expect("Cargo project");
    assert_eq!(rust.language_level.as_deref(), Some("rust:2024"));
    let rust_sets = model
        .source_sets
        .iter()
        .filter(|source_set| source_set.module_id == rust.module_id)
        .collect::<Vec<_>>();
    assert!(
        rust_sets
            .iter()
            .any(|source_set| source_set.kind == "production")
    );
    assert!(rust_sets.iter().any(|source_set| source_set.kind == "test"));

    let jvm = model
        .projects
        .iter()
        .find(|project| project.provider == "maven")
        .expect("Maven project");
    assert_eq!(jvm.language_level.as_deref(), Some("java:21"));
    let jvm_sets = model
        .source_sets
        .iter()
        .filter(|source_set| source_set.module_id == jvm.module_id)
        .collect::<Vec<_>>();
    assert!(
        jvm_sets
            .iter()
            .any(|source_set| source_set.kind == "production")
    );
    assert!(jvm_sets.iter().any(|source_set| source_set.kind == "test"));
    assert!(jvm_sets.iter().any(|source_set| source_set.generated));

    for target in &model.build_targets {
        assert!(
            model
                .modules
                .iter()
                .any(|module| module.id == target.module_id)
        );
        if target.kind == "build" {
            assert_eq!(target.artifact_ids.len(), 1);
        } else {
            assert!(target.artifact_ids.is_empty());
        }
    }
    assert!(!model.compile_artifacts.is_empty());
    for artifact in &model.compile_artifacts {
        assert!(
            artifact.path.is_none(),
            "provider output must not be guessed"
        );
        assert_eq!(artifact.resolution, "pending-provider-output");
        assert!(artifact.diagnostic.is_some());
        assert!(model.build_targets.iter().any(|target| {
            target.id == artifact.target_id
                && target.module_id == artifact.module_id
                && target.artifact_ids.contains(&artifact.id)
        }));
    }

    let missing_tool = directory
        .path()
        .join("missing-build-tool")
        .to_string_lossy()
        .to_string();
    let missing_config = WorkspaceToolConfig {
        cargo: Some(missing_tool.clone()),
        maven: Some(missing_tool),
        ..Default::default()
    };
    let blocked_model =
        detect_execution_model(directory.path(), None, Some(&missing_config)).unwrap();
    assert!(!blocked_model.compile_artifacts.is_empty());
    for artifact in &blocked_model.compile_artifacts {
        assert_eq!(artifact.resolution, "blocked");
        assert!(
            artifact
                .diagnostic
                .as_deref()
                .unwrap_or_default()
                .contains("Configured executable")
        );
    }
}

#[test]
fn discovers_go_python_node_dotnet_cmake_and_swift_without_running_tools() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("go/go.mod"),
        "module example.test/demo\n",
    );
    write(
        &directory.path().join("go/cmd/demo/main.go"),
        "package main\nfunc main() {}\n",
    );
    write(
        &directory.path().join("py/pyproject.toml"),
        "[project]\nname='demo'\n[project.scripts]\nhello='demo.cli:main'\n",
    );
    write(
        &directory.path().join("py/demo/cli.py"),
        "def main(): pass\n",
    );
    write(
        &directory.path().join("web/package.json"),
        r#"{"name":"web","scripts":{"build":"tsc","dev":"vite"}}"#,
    );
    write(
        &directory.path().join("dotnet/App.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
    );
    write(
        &directory.path().join("native/CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.20)\n",
    );
    write(
        &directory.path().join("swift/Package.swift"),
        ".executableTarget(name: \"tool\")\n",
    );
    let model = detect_execution_model(
        directory.path(),
        Some(&directory.path().join("py/demo/cli.py")),
        None,
    )
    .unwrap();
    for provider in ["go", "python", "node", "dotnet", "cmake", "swiftpm"] {
        assert!(
            model
                .projects
                .iter()
                .any(|project| project.provider == provider),
            "missing {provider}"
        );
    }
    assert!(
        model
            .run_configurations
            .iter()
            .any(|target| target.label == "Entry point: hello")
    );
    assert!(
        model
            .run_configurations
            .iter()
            .any(|target| target.kind == "main-package")
    );
    assert!(
        model
            .build_targets
            .iter()
            .any(|target| target.label == "Configure (Debug)")
    );
}

#[test]
fn missing_adapters_are_reported_instead_of_falsely_enabled() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join("pyproject.toml"),
        "[project]\nname='demo'\n",
    );
    write(&directory.path().join("main.py"), "print('hello')\n");
    let config = WorkspaceToolConfig {
        debugpy: Some(
            directory
                .path()
                .join("missing-debugpy")
                .to_string_lossy()
                .to_string(),
        ),
        ..Default::default()
    };
    let model = detect_execution_model(
        directory.path(),
        Some(&directory.path().join("main.py")),
        Some(&config),
    )
    .unwrap();
    let debug = model
        .debug_configurations
        .first()
        .expect("Python debug config");
    assert!(!debug.available);
    assert!(
        debug
            .diagnostic
            .as_deref()
            .unwrap_or_default()
            .contains("Configured executable")
    );
}

#[test]
fn migrates_v1_shared_runs_and_expands_workspace_variables() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
        r#"{
              "version": 1,
              "runs": [{
                "id": "legacy",
                "name": "Legacy task",
                "executable": "cargo",
                "args": ["run", "--manifest-path", "$PROJECT_DIR$/Cargo.toml"],
                "cwd": "${workspaceRoot}",
                "env": { "WORKSPACE": "${workspaceRoot}" }
              }]
            }"#,
    );
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    let run = model
        .run_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-run:legacy")
        .expect("migrated shared run");
    assert_eq!(run.label, "Legacy task");
    assert_eq!(run.command.executable, "cargo");
    assert_eq!(run.command.cwd, path_string(directory.path()));
    assert_eq!(run.command.env["WORKSPACE"], path_string(directory.path()));
    assert_eq!(run.configuration_source.as_deref(), Some("shared"));
    assert!(run.command.args[2].ends_with("Cargo.toml"));
    assert!(
        model
            .projects
            .iter()
            .any(|project| project.id == "shared:workspace")
    );
}

#[test]
fn loads_shared_run_debug_templates_and_current_platform_overrides() {
    let directory = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let executable_string = path_string(&executable);
    write(
        &directory.path().join("Cargo.toml"),
        "[package]\nname='demo'\nversion='0.1.0'\n",
    );
    write(&directory.path().join("src/main.rs"), "fn main() {}\n");
    let initial = detect_execution_model(directory.path(), None, None).unwrap();
    let base = initial
        .run_configurations
        .iter()
        .find(|configuration| configuration.kind == "bin")
        .expect("provider run");
    let build = base.pre_launch_targets.first().expect("provider build");
    let config = json!({
        "version": 2,
        "templates": {
            "integration": {
                "run": {
                    "env": { "FROM_TEMPLATE": "yes" },
                    "runtimeOptions": ["--trace"]
                }
            }
        },
        "configurations": [{
            "id": "team",
            "name": "Team launch",
            "base": base.id,
            "template": "integration",
            "sourceFile": "src/main.rs",
            "beforeLaunch": [build],
            "run": {
                "args": ["--team"],
                "cwd": "${projectRoot}",
                "envFile": ".env.team"
            },
            "debug": {
                "adapterId": "lldb",
                "request": "attach",
                "launchConfig": {
                    "adapterCommand": executable_string,
                    "adapterCwd": "${projectRoot}",
                    "arguments": { "program": "$PROJECT_DIR$/target/demo" }
                }
            },
            "platforms": {
                shared_platform_key(): {
                    "run": { "env": { "PLATFORM": shared_platform_key() } }
                }
            }
        }]
    });
    write(
        &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
        &serde_json::to_string_pretty(&config).unwrap(),
    );

    let model = detect_execution_model(directory.path(), None, None).unwrap();
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    let run = model
        .run_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-run:team")
        .expect("shared run");
    assert_eq!(run.command.args, ["--team"]);
    assert_eq!(run.command.env["FROM_TEMPLATE"], "yes");
    assert_eq!(run.command.env["PLATFORM"], shared_platform_key());
    assert_eq!(
        run.runtime_options.as_deref(),
        Some(["--trace".to_string()].as_slice())
    );
    assert!(run.env_file.as_deref().unwrap().ends_with(".env.team"));
    assert_eq!(
        run.debug_configuration_id.as_deref(),
        Some("shared-debug:team")
    );
    assert_eq!(
        run.source_file.as_deref(),
        Some(path_string(&directory.path().join("src/main.rs")).as_str())
    );
    let debug = model
        .debug_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-debug:team")
        .expect("shared debug");
    assert_eq!(debug.request, "attach");
    assert_eq!(debug.launch_config["request"], "attach");
    assert_eq!(
        debug.launch_config["adapterCwd"],
        path_string(directory.path())
    );
    assert!(debug.available);
}

#[test]
fn invalid_shared_files_are_atomic_and_report_actionable_diagnostics() {
    let cases = [
        (
            "duplicate",
            r#"{"version":2,"configurations":[{"id":"same","run":{"executable":"cargo"}},{"id":"same","run":{"executable":"cargo"}}]}"#,
            "duplicate id",
        ),
        (
            "base",
            r#"{"version":2,"configurations":[{"id":"bad","base":"run:missing"}]}"#,
            "unknown provider base",
        ),
        (
            "debug-reference",
            r#"{"version":2,"configurations":[{"id":"bad","debugConfigurationId":"missing","run":{"executable":"cargo"}}]}"#,
            "unknown debug reference",
        ),
        (
            "env",
            r#"{"version":2,"configurations":[{"id":"bad","run":{"executable":"cargo","env":{"NOT VALID":"x"}}}]}"#,
            "invalid environment name",
        ),
        (
            "before-launch",
            r#"{"version":2,"configurations":[{"id":"bad","beforeLaunch":["build:missing"],"run":{"executable":"cargo"}}]}"#,
            "unknown Before launch target",
        ),
    ];
    for (name, contents, expected) in cases {
        let directory = tempfile::tempdir().unwrap();
        write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            contents,
        );
        let model = detect_execution_model(directory.path(), None, None).unwrap();
        assert!(
            model
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.contains(expected)),
            "{name}: {:?}",
            model.diagnostics
        );
        assert!(
            model
                .run_configurations
                .iter()
                .all(
                    |configuration| configuration.configuration_source.as_deref() != Some("shared")
                ),
            "{name} partially merged"
        );
    }
}

#[test]
fn missing_shared_file_is_silent() {
    let directory = tempfile::tempdir().unwrap();
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    assert!(model.diagnostics.is_empty());
    assert!(model.run_configurations.is_empty());
}

#[test]
fn debug_only_shared_configuration_is_exposed_without_becoming_runnable() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = path_string(&std::env::current_exe().unwrap());
    write(
        &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
        &serde_json::to_string(&json!({
            "version": 2,
            "configurations": [{
                "id": "debug-only",
                "debug": {
                    "adapterId": "lldb",
                    "request": "launch",
                    "launchConfig": { "adapterCommand": adapter }
                }
            }]
        }))
        .unwrap(),
    );
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    let run = model
        .run_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-run:debug-only")
        .expect("debug-only chooser entry");
    assert_eq!(run.kind, "debug-only");
    assert!(run.command.error.is_some());
    assert_eq!(run.configuration_source.as_deref(), Some("shared"));
    let debug = model
        .debug_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-debug:debug-only")
        .expect("debug-only debug entry");
    assert!(debug.available);
    assert_eq!(debug.configuration_source.as_deref(), Some("shared"));
}

#[test]
fn compound_run_and_debug_resolve_children_with_group_launch_semantics() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = path_string(&std::env::current_exe().unwrap());
    write(
            &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
            &serde_json::to_string(&json!({
                "version": 2,
                "configurations": [
                    {
                        "id": "one",
                        "run": {"executable": "cargo", "args": ["run"]},
                        "debug": {"adapterId": "lldb", "launchConfig": {"adapterCommand": adapter}}
                    },
                    {
                        "id": "two",
                        "run": {"executable": "cargo", "args": ["test"]},
                        "debug": {"adapterId": "lldb", "launchConfig": {"adapterCommand": adapter}}
                    },
                    {"id":"all","compound":{"configurations":["one","two"],"parallel":true,"stopOnFailure":false}}
                ]
            }))
            .unwrap(),
        );
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    let run = model
        .run_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-run:all")
        .expect("compound run");
    assert_eq!(run.kind, "compound");
    assert_eq!(
        run.compound_configuration_ids.as_deref(),
        Some(["shared-run:one".to_string(), "shared-run:two".to_string()].as_slice())
    );
    assert_eq!(run.compound_parallel, Some(true));
    assert_eq!(run.compound_stop_on_failure, Some(false));
    let debug = model
        .debug_configurations
        .iter()
        .find(|configuration| configuration.id == "shared-debug:all")
        .expect("compound debug chooser");
    assert!(debug.available, "{:?}", debug.diagnostic);
    assert_eq!(
        debug.compound_configuration_ids.as_deref(),
        Some(
            [
                "shared-debug:one".to_string(),
                "shared-debug:two".to_string()
            ]
            .as_slice()
        )
    );
    assert_eq!(debug.compound_parallel, Some(true));
    assert_eq!(debug.compound_stop_on_failure, Some(false));
}

#[test]
fn compound_debug_propagates_unavailable_leaf_diagnostics() {
    let directory = tempfile::tempdir().unwrap();
    let adapter = path_string(&std::env::current_exe().unwrap());
    write(
        &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
        &serde_json::to_string(&json!({
            "version": 2,
            "configurations": [
                {
                    "id": "disabled",
                    "debug": {
                        "adapterId": "lldb",
                        "available": false,
                        "launchConfig": {"adapterCommand": adapter}
                    }
                },
                {"id": "nested", "compound": {"configurations": ["disabled"]}},
                {"id": "all", "compound": {"configurations": ["nested"]}}
            ]
        }))
        .unwrap(),
    );
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    for id in ["shared-debug:nested", "shared-debug:all"] {
        let debug = model
            .debug_configurations
            .iter()
            .find(|configuration| configuration.id == id)
            .expect("compound debug chooser");
        assert!(!debug.available, "{id} should be unavailable");
        assert!(
            debug
                .diagnostic
                .as_deref()
                .unwrap_or_default()
                .contains("unavailable"),
            "{id}: {:?}",
            debug.diagnostic
        );
    }
}

#[test]
fn compound_invalid_child_is_atomic_and_does_not_fall_back_to_empty_plan() {
    let directory = tempfile::tempdir().unwrap();
    write(
        &directory.path().join(SHARED_RUN_CONFIG_RELATIVE_PATH),
        r#"{"version":2,"configurations":[{"id":"bad","compound":{"configurations":["missing"]}}]}"#,
    );
    let model = detect_execution_model(directory.path(), None, None).unwrap();
    assert!(
        model
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("unknown compound child")),
        "{:?}",
        model.diagnostics
    );
    assert!(
        model
            .run_configurations
            .iter()
            .all(|configuration| configuration.configuration_source.as_deref() != Some("shared"))
    );
}

#[test]
fn maven_multi_module_hierarchy_links_parent_and_children() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write(
        &root.join("pom.xml"),
        r#"<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version><packaging>pom</packaging><modules><module>core</module><module>web</module></modules></project>"#,
    );
    fs::create_dir_all(root.join("core/src/main/java")).unwrap();
    write(
        &root.join("core/pom.xml"),
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version></parent><artifactId>core</artifactId></project>"#,
    );
    fs::create_dir_all(root.join("web/src/main/java")).unwrap();
    write(
        &root.join("web/pom.xml"),
        r#"<project><modelVersion>4.0.0</modelVersion><parent><groupId>com.example</groupId><artifactId>root</artifactId><version>1.0.0</version></parent><artifactId>web</artifactId></project>"#,
    );

    let model = detect_execution_model(root, None, None).unwrap();
    let root_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(root))
        .expect("root module");
    let core_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(&root.join("core")))
        .expect("core module");
    let web_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(&root.join("web")))
        .expect("web module");

    assert_eq!(root_mod.child_module_ids.len(), 2);
    assert!(root_mod.child_module_ids.contains(&core_mod.id));
    assert!(root_mod.child_module_ids.contains(&web_mod.id));
    assert_eq!(
        core_mod.parent_module_id.as_deref(),
        Some(root_mod.id.as_str())
    );
    assert_eq!(
        web_mod.parent_module_id.as_deref(),
        Some(root_mod.id.as_str())
    );
}

#[test]
fn gradle_multi_project_hierarchy_and_dependencies() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write(
        &root.join("settings.gradle"),
        "rootProject.name = 'my-app'\ninclude 'core', 'web'\n",
    );
    write(
        &root.join("build.gradle"),
        "allprojects { repositories { mavenCentral() } }\n",
    );
    fs::create_dir_all(root.join("core/src/main/java")).unwrap();
    write(&root.join("core/build.gradle"), "plugins { id 'java' }\n");
    fs::create_dir_all(root.join("web/src/main/java")).unwrap();
    write(
        &root.join("web/build.gradle"),
        "plugins { id 'java' }\ndependencies { implementation project(':core') }\n",
    );

    let model = detect_execution_model(root, None, None).unwrap();
    let root_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(root))
        .expect("root module");
    let core_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(&root.join("core")))
        .expect("core module");
    let web_mod = model
        .modules
        .iter()
        .find(|m| m.root == path_string(&root.join("web")))
        .expect("web module");

    assert!(root_mod.child_module_ids.contains(&core_mod.id));
    assert!(root_mod.child_module_ids.contains(&web_mod.id));
    assert_eq!(
        core_mod.parent_module_id.as_deref(),
        Some(root_mod.id.as_str())
    );
    assert_eq!(
        web_mod.parent_module_id.as_deref(),
        Some(root_mod.id.as_str())
    );
    assert_eq!(web_mod.module_dependencies, vec!["core".to_string()]);
}

#[test]
fn compile_artifact_path_resolves_when_output_dir_exists() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write(
        &root.join("pom.xml"),
        r#"<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>app</artifactId><version>1.0.0</version></project>"#,
    );
    let classes_dir = root.join("target/classes");
    fs::create_dir_all(&classes_dir).unwrap();

    let model = detect_execution_model(root, None, None).unwrap();
    let artifact = model
        .compile_artifacts
        .iter()
        .find(|a| a.kind == "jvm-classes")
        .expect("classes artifact");
    assert_eq!(artifact.resolution, "resolved");
    assert_eq!(
        artifact.path.as_deref(),
        Some(path_string(&classes_dir).as_str())
    );
}
