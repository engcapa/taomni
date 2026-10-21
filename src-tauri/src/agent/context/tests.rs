use super::database::AgentDbSelectedObject;
use super::database::normalize_selected_objects;
use super::workspace_model::AgentCodeWorkspace;
use super::workspace_model::AgentCodeWorkspaceFile;
use super::workspace_model::AgentCodeWorkspaceLooseFile;
use super::workspace_model::AgentCodeWorkspaceRoot;

#[test]
fn selected_object_normalized_accepts_cross_object_selection() {
    let selected = AgentDbSelectedObject {
        catalog: Some("  hive  ".into()),
        schema: Some(" default ".into()),
        name: " orders ".into(),
        kind: "table".into(),
    }
    .normalized()
    .unwrap();

    assert_eq!(selected.catalog.as_deref(), Some("hive"));
    assert_eq!(selected.schema.as_deref(), Some("default"));
    assert_eq!(selected.name, "orders");
    assert!(selected.is_selectable());
    assert_eq!(selected.display_name(), "hive.default.orders");

    let procedure = AgentDbSelectedObject {
        catalog: None,
        schema: Some("public".into()),
        name: "sp_sync".into(),
        kind: "procedure".into(),
    }
    .normalized()
    .unwrap();
    assert!(!procedure.is_selectable());
    assert!(
        AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: " ".into(),
            kind: "table".into(),
        }
        .normalized()
        .is_none()
    );
    assert!(
        AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "orders".into(),
            kind: "unknown".into(),
        }
        .normalized()
        .is_none()
    );
}

#[test]
fn selected_objects_normalized_dedupes_and_caps() {
    let objects = vec![
        AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "orders".into(),
            kind: "table".into(),
        },
        AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "orders".into(),
            kind: "table".into(),
        },
        AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "sp_sync".into(),
            kind: "procedure".into(),
        },
    ];
    let normalized = normalize_selected_objects(&objects);
    assert_eq!(normalized.len(), 2);
    assert_eq!(normalized[0].name, "orders");
    assert_eq!(normalized[1].kind, "procedure");
}

#[test]
fn code_workspace_normalized_keeps_repo_relative_paths() {
    let workspace = AgentCodeWorkspace {
        repo_root: "  /repo/app  ".into(),
        active_path: Some(" src/main.ts ".into()),
        open_paths: vec![
            "src/main.ts".into(),
            "src/main.ts".into(),
            "../secret".into(),
            "/tmp/file".into(),
            "src/lib.rs".into(),
        ],
        dirty_paths: vec!["src/lib.rs".into(), "C:/absolute/file.rs".into()],
        roots: vec![],
        loose_files: vec![],
        active_file: None,
        open_files: vec![],
        dirty_files: vec![],
        lsp: None,
    }
    .normalized()
    .unwrap();

    assert_eq!(workspace.repo_root, "/repo/app");
    assert_eq!(workspace.active_path.as_deref(), Some("src/main.ts"));
    assert_eq!(workspace.open_paths, vec!["src/main.ts", "src/lib.rs"]);
    assert_eq!(workspace.dirty_paths, vec!["src/lib.rs"]);
    assert_eq!(workspace.roots.len(), 1);
    assert_eq!(workspace.open_files.len(), 2);
    assert_eq!(workspace.open_files[0].root_id.as_deref(), Some("root-1"));
}

#[test]
fn code_workspace_normalized_rejects_empty_repo() {
    let workspace = AgentCodeWorkspace {
        repo_root: " ".into(),
        active_path: Some("src/main.ts".into()),
        open_paths: vec![],
        dirty_paths: vec![],
        roots: vec![],
        loose_files: vec![],
        active_file: None,
        open_files: vec![],
        dirty_files: vec![],
        lsp: None,
    };

    assert!(workspace.normalized().is_none());
}

#[test]
fn code_workspace_normalized_accepts_roots_and_loose_files() {
    let workspace = AgentCodeWorkspace {
        repo_root: "".into(),
        active_path: None,
        open_paths: vec![],
        dirty_paths: vec![],
        roots: vec![
            AgentCodeWorkspaceRoot {
                id: "app".into(),
                name: " App ".into(),
                path: " /repo/app ".into(),
                kind: Some("git".into()),
            },
            AgentCodeWorkspaceRoot {
                id: "lib".into(),
                name: "Lib".into(),
                path: "/repo/lib".into(),
                kind: Some("folder".into()),
            },
        ],
        loose_files: vec![AgentCodeWorkspaceLooseFile {
            id: "scratch".into(),
            name: Some("scratch.md".into()),
            path: "/tmp/scratch.md".into(),
        }],
        active_file: Some(AgentCodeWorkspaceFile {
            kind: "loose".into(),
            root_id: None,
            root_name: None,
            root_path: None,
            id: Some("scratch".into()),
            name: None,
            path: Some("/tmp/scratch.md".into()),
        }),
        open_files: vec![
            AgentCodeWorkspaceFile {
                kind: "root".into(),
                root_id: Some("app".into()),
                root_name: None,
                root_path: None,
                id: None,
                name: None,
                path: Some("src/main.ts".into()),
            },
            AgentCodeWorkspaceFile {
                kind: "loose".into(),
                root_id: None,
                root_name: None,
                root_path: None,
                id: Some("scratch".into()),
                name: None,
                path: Some("/tmp/scratch.md".into()),
            },
        ],
        dirty_files: vec![AgentCodeWorkspaceFile {
            kind: "root".into(),
            root_id: Some("lib".into()),
            root_name: None,
            root_path: None,
            id: None,
            name: None,
            path: Some("README.md".into()),
        }],
        lsp: None,
    }
    .normalized()
    .unwrap();

    assert_eq!(workspace.repo_root, "/repo/app");
    assert_eq!(workspace.roots.len(), 2);
    assert_eq!(workspace.loose_files.len(), 1);
    assert_eq!(workspace.active_file.unwrap().kind, "loose");
    assert_eq!(workspace.open_files.len(), 2);
    assert_eq!(workspace.dirty_files[0].root_id.as_deref(), Some("lib"));
}
