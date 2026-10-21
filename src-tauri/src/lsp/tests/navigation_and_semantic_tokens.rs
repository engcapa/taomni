use super::*;
#[test]
fn parses_hierarchy_items_and_preserves_opaque_data() {
    let items = parse_hierarchy_items(&json!([{
        "name": "renderEditor",
        "detail": "CodeWorkspaceTab",
        "kind": 12,
        "uri": "file:///repo/src/editor.ts",
        "range": {
            "start": { "line": 8, "character": 0 },
            "end": { "line": 20, "character": 1 }
        },
        "selectionRange": {
            "start": { "line": 8, "character": 9 },
            "end": { "line": 8, "character": 21 }
        },
        "data": { "serverId": 42 }
    }]));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "renderEditor");
    assert_eq!(items[0].detail.as_deref(), Some("CodeWorkspaceTab"));
    assert_eq!(items[0].selection_range.start.character, 9);
    assert_eq!(items[0].raw["data"]["serverId"], 42);
}

#[test]
fn parses_incoming_and_outgoing_call_entries() {
    let item = json!({
        "name": "caller",
        "kind": 12,
        "uri": "file:///repo/src/caller.ts",
        "range": {
            "start": { "line": 1, "character": 0 },
            "end": { "line": 4, "character": 1 }
        },
        "selectionRange": {
            "start": { "line": 1, "character": 9 },
            "end": { "line": 1, "character": 15 }
        }
    });
    let range = json!({
        "start": { "line": 3, "character": 2 },
        "end": { "line": 3, "character": 8 }
    });
    let incoming = parse_call_hierarchy_entries(
        &json!([{ "from": item.clone(), "fromRanges": [range.clone()] }]),
        "from",
    );
    let outgoing =
        parse_call_hierarchy_entries(&json!([{ "to": item, "fromRanges": [range] }]), "to");
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].item.name, "caller");
    assert_eq!(incoming[0].from_ranges[0].start.line, 3);
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].item.name, "caller");
}

#[test]
fn reference_cancellation_registry_rejects_stale_sequences() {
    let key = format!("__ed_query_001_{:?}", std::thread::current().id());
    let first = begin_reference_request(&key, 1);
    let second = begin_reference_request(&key, 2);

    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    assert!(!cancel_reference_request(&key, Some(1)));
    assert!(!second.is_cancelled());

    finish_reference_request(Some(&key), Some(1));
    assert!(!second.is_cancelled());
    assert!(cancel_reference_request(&key, Some(2)));
    assert!(second.is_cancelled());
}

#[test]
fn parses_highlights_inlay_hints_and_selection_ranges() {
    let highlights = parse_document_highlights(&json!([
        {
            "range": {
                "start": { "line": 1, "character": 2 },
                "end": { "line": 1, "character": 5 }
            },
            "kind": 3
        },
        { "invalid": true }
    ]));
    assert_eq!(highlights.len(), 1);
    assert_eq!(highlights[0].kind, Some(3));

    let hints = parse_inlay_hints(&json!([
        {
            "position": { "line": 2, "character": 8 },
            "label": [{ "value": "value" }, { "value": ": number" }],
            "kind": 1,
            "tooltip": { "kind": "markdown", "value": "inferred type" },
            "paddingLeft": true
        }
    ]));
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].label, "value: number");
    assert_eq!(hints[0].tooltip.as_deref(), Some("inferred type"));
    assert!(hints[0].padding_left);

    let ranges = parse_selection_ranges(&json!([{
        "range": {
            "start": { "line": 3, "character": 4 },
            "end": { "line": 3, "character": 8 }
        },
        "parent": {
            "range": {
                "start": { "line": 3, "character": 0 },
                "end": { "line": 3, "character": 10 }
            }
        }
    }]));
    assert_eq!(ranges.len(), 2);
    assert_eq!(ranges[0].start.character, 4);
    assert_eq!(ranges[1].start.character, 0);
}

#[test]
fn parses_semantic_tokens_relative_data() {
    let (types, modifiers) = semantic_token_legend_from(&json!({
        "semanticTokensProvider": {
            "legend": {
                "tokenTypes": ["variable", "function", "class"],
                "tokenModifiers": ["declaration", "readonly"]
            }
        }
    }));
    assert_eq!(types, vec!["variable", "function", "class"]);
    assert_eq!(modifiers, vec!["declaration", "readonly"]);

    // Token A at 0:0 len 3 type variable+declaration
    // Token B same line start+4 len 5 type function
    let tokens = parse_semantic_tokens(
        &json!({ "data": [0, 0, 3, 0, 1, 0, 4, 5, 1, 0] }),
        &types,
        &modifiers,
    );
    assert_eq!(tokens.len(), 2);
    assert_eq!(tokens[0].token_type, "variable");
    assert_eq!(tokens[0].modifiers, vec!["declaration"]);
    assert_eq!(tokens[0].range.start.character, 0);
    assert_eq!(tokens[0].range.end.character, 3);
    assert_eq!(tokens[1].token_type, "function");
    assert_eq!(tokens[1].range.start.character, 4);
    assert_eq!(tokens[1].range.end.character, 9);
}

#[test]
fn applies_semantic_token_delta_edits_and_detects_capability() {
    let capabilities = json!({
        "semanticTokensProvider": {
            "legend": { "tokenTypes": ["variable"], "tokenModifiers": [] },
            "full": { "delta": true }
        }
    });
    assert!(semantic_token_delta_supported(&capabilities));
    let previous = SemanticTokensCache {
        result_id: "one".into(),
        data: vec![0, 0, 3, 0, 0, 0, 4, 2, 0, 0],
    };
    let (data, result_id) = apply_semantic_token_delta(
        &previous,
        &json!({
            "resultId": "two",
            "edits": [{ "start": 5, "deleteCount": 5, "data": [1, 1, 4, 0, 0] }]
        }),
    )
    .unwrap();
    assert_eq!(result_id.as_deref(), Some("two"));
    assert_eq!(data, vec![0, 0, 3, 0, 0, 1, 1, 4, 0, 0]);
    assert!(
        apply_semantic_token_delta(
            &previous,
            &json!({ "edits": [{ "start": 99, "deleteCount": 1 }] }),
        )
        .is_none()
    );
}

#[test]
fn path_from_uri_maps_file_uris_and_rejects_class_uris() {
    #[cfg(windows)]
    {
        let path = path_from_uri("file:///C:/Users/test/Project/Main.java").unwrap();
        assert!(
            path.replace('\\', "/")
                .ends_with("Users/test/Project/Main.java")
        );
    }
    #[cfg(not(windows))]
    {
        assert_eq!(
            path_from_uri("file:///home/test/Project/Main.java").as_deref(),
            Some("/home/test/Project/Main.java")
        );
    }
    assert!(path_from_uri("jdt://contents/java.base/java.lang/String.class?=x").is_none());
    assert!(path_from_uri("jar:file:///lib/foo.jar!/com/Foo.class").is_none());
    assert!(is_virtual_class_uri(
        "jdt://contents/java.base/java.lang/String.class?=x"
    ));
    assert_eq!(
        title_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x"),
        "String.java"
    );
}

#[test]
fn reads_percent_encoded_source_from_archive_uri() {
    use std::io::Write as _;

    let directory = tempfile::tempdir().unwrap();
    let archive_path = directory.path().join("demo sources.jar");
    let file = std::fs::File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    archive
        .start_file(
            "com/acme/Hello World.kt",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    archive
        .write_all(b"package com.acme\nclass HelloWorld\n")
        .unwrap();
    archive.finish().unwrap();

    let file_uri = url::Url::from_file_path(&archive_path).unwrap();
    let uri = format!("jar:{file_uri}!/com/acme/Hello%20World.kt");
    let parsed = archive_document_uri(&uri).expect("archive URI");
    assert_eq!(parsed.archive_path, archive_path);
    assert_eq!(parsed.entry_path, "com/acme/Hello World.kt");

    let contents = read_archive_source_contents(&uri)
        .unwrap()
        .expect("archive source");
    assert_eq!(contents.title, "Hello World.kt");
    assert_eq!(contents.container.as_deref(), Some("demo sources.jar"));
    assert_eq!(contents.language_id, "kotlin");
    assert!(contents.text.contains("class HelloWorld"));
}

#[test]
fn binary_archive_locations_fall_through_to_language_server() {
    let uri = if cfg!(windows) {
        "kls:file:///C:/sdk/kotlin.jar!/kotlin/String.class?source=false"
    } else {
        "kls:file:///sdk/kotlin.jar!/kotlin/String.class?source=false"
    };
    let parsed = archive_document_uri(uri).expect("kls URI");
    assert_eq!(parsed.entry_path, "kotlin/String.class");
    assert!(read_archive_source_contents(uri).unwrap().is_none());
}

#[test]
fn maps_library_source_extensions_to_editor_languages() {
    for (uri, expected) in [
        ("file:///sdk/lib.d.ts", "typescript"),
        ("file:///sdk/lib.mjs", "javascript"),
        ("file:///sdk/types.pyi", "python"),
        ("file:///sdk/runtime.go", "go"),
        ("file:///sdk/System.String.cs", "csharp"),
        ("file:///sdk/UIKit.swiftinterface", "swift"),
        ("file:///sdk/vector.hpp", "cpp"),
    ] {
        assert_eq!(language_id_from_uri(uri), expected, "{uri}");
    }
}

#[test]
fn csharp_ls_preset_enables_metadata_uris() {
    let csharp = find_preset("csharp").expect("csharp preset");
    let server = csharp
        .commands
        .iter()
        .find(|command| command.id == "csharp-ls")
        .expect("csharp-ls command");
    assert_eq!(server.args, ["--features", "metadata-uris"]);
}

#[test]
fn container_from_class_uri_labels_package_and_archive() {
    assert_eq!(
        container_from_class_uri("jdt://contents/java.base/java.lang/String.class?=x").as_deref(),
        Some("java.lang · java.base")
    );
    let jar_class = concat!(
        "jdt://contents/commons-lang3-3.12.0.jar/",
        "org.apache.commons.lang3/StringUtils.class?=y"
    );
    assert_eq!(
        container_from_class_uri(jar_class).as_deref(),
        Some("org.apache.commons.lang3 · commons-lang3-3.12.0.jar")
    );
    assert_eq!(
        container_from_class_uri("jar:file:///libs/foo.jar!/com/acme/Bar.class").as_deref(),
        Some("com.acme · foo.jar")
    );
    assert!(container_from_class_uri("jdt://contents/String.class").is_none());
}

#[test]
fn with_document_uri_overrides_only_when_present() {
    let document = ResolvedDocument {
        path: PathBuf::from(if cfg!(windows) {
            r"C:\repo\src\Main.java"
        } else {
            "/repo/src/Main.java"
        }),
        uri: "file:///repo/src/Main.java".to_string(),
        root_path: PathBuf::from(if cfg!(windows) { r"C:\repo" } else { "/repo" }),
        workspace_id: "workspace".to_string(),
        preset: find_preset("java"),
        language_id: Some("java".to_string()),
        version: 0,
    };
    let untouched = with_document_uri(document.clone(), Some("   ".to_string()));
    assert_eq!(untouched.uri, "file:///repo/src/Main.java");
    let library = with_document_uri(
        document,
        Some("jdt://contents/java.base/java.lang/String.class?=x".to_string()),
    );
    assert_eq!(
        library.uri,
        "jdt://contents/java.base/java.lang/String.class?=x"
    );
    // Session / SDK resolution still keys off the origin project file.
    assert!(library.path.ends_with("Main.java"));
}
