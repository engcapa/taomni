use super::files::read_search_source;
use super::model::BACKEND_ID;
use super::model::MAX_FILE_BYTES;
use super::model::StructuralActiveFile;
use super::model::StructuralContainer;
use super::model::StructuralErrorCode;
use super::model::StructuralMatch;
use super::model::StructuralQuery;
use super::model::StructuralQueryVariable;
use super::model::StructuralSearchBuffer;
use super::model::StructuralSearchRequest;
use super::model::StructuralSearchResponse;
use super::model::StructuralSearchRoot;
use super::model::StructuralUnavailableReason;
use super::search::run_structural_search;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use std::fs;
use tempfile::tempdir;

/// Byte-identical to the IDEA F2 reference fixture `StructuralTarget.java`
/// (sha256 8fea975f…ec23, see references/ed-parity-008-009-reference.md).
const TARGET: &str = "public class StructuralTarget {\n  void run() {\n    System.out.println(\"alpha\");\n    System.out.println(42);\n    System.out.println(\n        \"beta\");\n    System.out.print(\"not println\");\n    // System.out.println(\"comment\");\n    String text = \"System.out.println(\\\"string\\\");\";\n    System.err.println(\"stderr\");\n  }\n}\n";
const TEMPLATE: &str = "System.out.println($arg$);";

fn fixture() -> tempfile::TempDir {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/StructuralTarget.java"), TARGET).unwrap();
    dir
}

fn query(pattern: &str, text: Option<&str>) -> StructuralQuery {
    let mut variables = BTreeMap::new();
    if let Some(text) = text {
        variables.insert(
            "arg".to_string(),
            StructuralQueryVariable {
                min_count: 1,
                max_count: Some(1),
                text: Some(text.to_string()),
                ..Default::default()
            },
        );
    }
    StructuralQuery {
        schema_version: 1,
        language_id: "java".to_string(),
        pattern: pattern.to_string(),
        variables,
        scope: "workspace".to_string(),
        match_case: false,
        replacement: None,
    }
}

fn request(dir: &Path, query: StructuralQuery) -> StructuralSearchRequest {
    StructuralSearchRequest {
        request_id: "req-1".to_string(),
        query,
        roots: vec![StructuralSearchRoot {
            id: "root".to_string(),
            name: "parity009".to_string(),
            path: dir.to_string_lossy().to_string(),
        }],
        active_file: Some(StructuralActiveFile {
            root_id: "root".to_string(),
            path: "src/StructuralTarget.java".to_string(),
        }),
        buffers: Vec::new(),
    }
}

fn run(dir: &Path, query: StructuralQuery) -> StructuralSearchResponse {
    run_structural_search(&request(dir, query), &AtomicBool::new(false))
}

fn ok_matches(response: StructuralSearchResponse) -> Vec<StructuralMatch> {
    match response {
        StructuralSearchResponse::Ok {
            matches, backend, ..
        } => {
            assert_eq!(backend.id, BACKEND_ID);
            matches
        }
        other => panic!("expected ok, got {other:?}"),
    }
}

#[test]
fn editor_snapshots_override_disk_and_include_inactive_files_without_writes() {
    let dir = fixture();
    let target = dir.path().join("src/StructuralTarget.java");
    let before = fs::read(&target).unwrap();
    let mut req = request(dir.path(), query(TEMPLATE, Some("999")));
    req.buffers = vec![
        StructuralSearchBuffer {
            root_id: "root".into(),
            path: "src/StructuralTarget.java".into(),
            text: "".into(),
        },
        StructuralSearchBuffer {
            root_id: "root".into(),
            path: "src/Inactive.java".into(),
            text: TARGET.replace("42", "999"),
        },
    ];
    for scope in ["workspace", "module"] {
        req.query.scope = scope.into();
        let hits = ok_matches(run_structural_search(&req, &AtomicBool::new(false)));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/Inactive.java");
        assert_eq!(hits[0].captures[0].text, "999");
    }
    req.query.scope = "file".into();
    assert!(ok_matches(run_structural_search(&req, &AtomicBool::new(false))).is_empty());
    req.active_file.as_mut().unwrap().path = "src/Inactive.java".into();
    assert_eq!(
        ok_matches(run_structural_search(&req, &AtomicBool::new(false))).len(),
        1
    );
    assert_eq!(fs::read(&target).unwrap(), before);
    assert!(!dir.path().join("src/Inactive.java").exists());
}

#[test]
fn editor_buffers_respect_module_root_and_reject_path_escape() {
    let dir = fixture();
    let other = fixture();
    let mut req = request(dir.path(), query(TEMPLATE, Some("999")));
    req.roots.push(StructuralSearchRoot {
        id: "other".into(),
        name: "other".into(),
        path: other.path().to_string_lossy().into(),
    });
    req.buffers.push(StructuralSearchBuffer {
        root_id: "other".into(),
        path: "src/StructuralTarget.java".into(),
        text: TARGET.replace("42", "999"),
    });
    assert_eq!(
        ok_matches(run_structural_search(&req, &AtomicBool::new(false))).len(),
        1
    );
    req.query.scope = "module".into();
    assert!(ok_matches(run_structural_search(&req, &AtomicBool::new(false))).is_empty());
    req.buffers[0].path = "../Outside.java".into();
    assert!(matches!(
        run_structural_search(&req, &AtomicBool::new(false)),
        StructuralSearchResponse::Error {
            code: StructuralErrorCode::InvalidScope,
            ..
        }
    ));
}

#[test]
fn unsupported_encoding_is_a_typed_error_in_every_scope_and_buffer_can_recover() {
    let dir = fixture();
    let path = dir.path().join("src/StructuralTarget.java");
    let bytes: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(TARGET.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    fs::write(&path, &bytes).unwrap();
    for scope in ["workspace", "module", "file"] {
        let mut req = request(dir.path(), query(TEMPLATE, None));
        req.query.scope = scope.into();
        let response = run_structural_search(&req, &AtomicBool::new(false));
        match response {
            StructuralSearchResponse::Error {
                code: StructuralErrorCode::UnsupportedEncoding,
                message,
                ..
            } => assert!(message.contains("StructuralTarget.java")),
            other => panic!("must not report successful empty results: {other:?}"),
        }
        req.buffers.push(StructuralSearchBuffer {
            root_id: "root".into(),
            path: "src/StructuralTarget.java".into(),
            text: TARGET.into(),
        });
        assert_eq!(
            ok_matches(run_structural_search(&req, &AtomicBool::new(false))).len(),
            3
        );
    }
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn oversized_files_fail_explicitly_in_both_disk_and_buffer_searches() {
    let dir = fixture();
    let oversized = " ".repeat(MAX_FILE_BYTES as usize + 1);
    let path = dir.path().join("src/StructuralTarget.java");
    fs::write(&path, &oversized).unwrap();
    for scope in ["workspace", "file"] {
        let mut req = request(dir.path(), query(TEMPLATE, None));
        req.query.scope = scope.into();
        assert!(matches!(
            run_structural_search(&req, &AtomicBool::new(false)),
            StructuralSearchResponse::Error {
                code: StructuralErrorCode::FileTooLarge,
                ..
            }
        ));
        fs::write(&path, TARGET).unwrap();
        req.buffers.push(StructuralSearchBuffer {
            root_id: "root".into(),
            path: "src/StructuralTarget.java".into(),
            text: oversized.clone(),
        });
        assert!(matches!(
            run_structural_search(&req, &AtomicBool::new(false)),
            StructuralSearchResponse::Error {
                code: StructuralErrorCode::FileTooLarge,
                ..
            }
        ));
        fs::write(&path, &oversized).unwrap();
    }
}

#[test]
fn missing_or_unreadable_source_is_not_an_empty_search() {
    let dir = fixture();
    let path = dir.path().join("Missing.java");
    let err = read_search_source(&path, None).unwrap_err();
    assert_eq!(err.code, StructuralErrorCode::FileRead);
    assert!(err.message.contains("Missing.java"));
    assert_eq!(
        read_search_source(dir.path(), None).unwrap_err().code,
        StructuralErrorCode::FileRead
    );
}

fn error_code(response: StructuralSearchResponse) -> StructuralErrorCode {
    match response {
        StructuralSearchResponse::Error { code, .. } => code,
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn template_matches_exactly_the_three_real_println_calls() {
    let dir = fixture();
    let matches = ok_matches(run(dir.path(), query(TEMPLATE, None)));
    let lines: Vec<(usize, usize, usize, usize)> = matches
        .iter()
        .map(|m| (m.start.line, m.start.character, m.end.line, m.end.character))
        .collect();
    // Lines are zero-based: IDEA shows 3, 4 and 5–6.
    assert_eq!(lines, vec![(2, 4, 2, 32), (3, 4, 3, 27), (4, 4, 5, 16)]);
    let args: Vec<&str> = matches
        .iter()
        .map(|m| m.captures[0].text.as_str())
        .collect();
    assert_eq!(args, vec!["\"alpha\"", "42", "\"beta\""]);
    assert!(matches.iter().all(|m| m.captures[0].name == "arg"));
    assert_eq!(matches[1].matched_text, "System.out.println(42);");
    assert_eq!(matches[1].line_text, "    System.out.println(42);");
    assert_eq!(
        matches[0].containers,
        vec![
            StructuralContainer {
                kind: "class",
                name: "StructuralTarget".to_string()
            },
            StructuralContainer {
                kind: "method",
                name: "run".to_string()
            },
        ]
    );
    assert_eq!(matches[0].path, "src/StructuralTarget.java");
    // Comment, string contents, print(...) and System.err never match.
    assert!(matches.iter().all(|m| !m.line_text.contains("//")));
    assert!(matches.iter().all(|m| !m.line_text.contains("String text")));
    assert!(matches.iter().all(|m| !m.line_text.contains("stderr")));
}

#[test]
fn text_modifier_filters_to_one_and_zero_matches() {
    let dir = fixture();
    let one = ok_matches(run(dir.path(), query(TEMPLATE, Some("42"))));
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].start.line, 3);
    assert_eq!(one[0].captures[0].text, "42");
    let none = run(dir.path(), query(TEMPLATE, Some("999")));
    // Zero hits is an ordinary ok response, not unavailable/error.
    assert!(matches!(&none, StructuralSearchResponse::Ok { matches, .. } if matches.is_empty()));
}

#[test]
fn inverted_text_modifier_excludes_the_filtered_capture() {
    let dir = fixture();
    let mut q = query(TEMPLATE, Some("42"));
    q.variables.get_mut("arg").unwrap().invert = true;
    let matches = ok_matches(run(dir.path(), q));
    assert_eq!(matches.len(), 2);
    assert!(matches.iter().all(|m| m.captures[0].text != "42"));
}

#[test]
fn expression_template_without_semicolon_matches_invocations() {
    let dir = fixture();
    let matches = ok_matches(run(dir.path(), query("System.out.println($arg$)", None)));
    assert_eq!(matches.len(), 3);
    let printish = ok_matches(run(
        dir.path(),
        query("System.$stream$.println($arg$)", None),
    ));
    assert_eq!(
        printish.len(),
        4,
        "System.err.println joins when the stream is a variable"
    );
}

#[test]
fn repeated_variable_requires_identical_text() {
    let dir = tempdir().unwrap();
    fs::write(
        dir.path().join("Same.java"),
        "class Same { void f(int a, int b) { g(a, a); g(a, b); } void g(int x, int y) {} }\n",
    )
    .unwrap();
    let mut q = query("g($x$, $x$)", None);
    q.scope = "workspace".to_string();
    let mut req = request(dir.path(), q);
    req.active_file = None;
    let matches = ok_matches(run_structural_search(&req, &AtomicBool::new(false)));
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].matched_text, "g(a, a)");
}

#[test]
fn unsupported_language_is_typed_unavailable_not_an_empty_result() {
    let dir = fixture();
    let mut q = query(TEMPLATE, None);
    q.language_id = "kotlin".to_string();
    match run(dir.path(), q) {
        StructuralSearchResponse::Unavailable {
            reason, request_id, ..
        } => {
            assert_eq!(reason, StructuralUnavailableReason::UnsupportedLanguage);
            assert_eq!(request_id, "req-1");
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[test]
fn invalid_templates_and_constraints_are_typed_errors() {
    let dir = fixture();
    for pattern in [
        "System.out.println($arg$",
        "System.out.println($arg);",
        "$9x$;",
        "",
        "$arg$",
        "class {",
    ] {
        assert_eq!(
            error_code(run(dir.path(), query(pattern, None))),
            StructuralErrorCode::InvalidPattern,
            "pattern {pattern:?}"
        );
    }
    let mut unbounded = query(TEMPLATE, None);
    unbounded.variables.insert(
        "arg".to_string(),
        StructuralQueryVariable {
            min_count: 0,
            max_count: None,
            ..Default::default()
        },
    );
    assert_eq!(
        error_code(run(dir.path(), unbounded)),
        StructuralErrorCode::UnsupportedConstraint
    );
    let mut typed = query(TEMPLATE, None);
    typed.variables.insert(
        "arg".to_string(),
        StructuralQueryVariable {
            min_count: 1,
            max_count: Some(1),
            type_constraint: Some("int".to_string()),
            ..Default::default()
        },
    );
    assert_eq!(
        error_code(run(dir.path(), typed)),
        StructuralErrorCode::UnsupportedConstraint
    );
    let mut bad_regex = query(TEMPLATE, Some("("));
    bad_regex.variables.get_mut("arg").unwrap().invert = false;
    assert_eq!(
        error_code(run(dir.path(), bad_regex)),
        StructuralErrorCode::InvalidPattern
    );
    let mut replace = query(TEMPLATE, None);
    replace.replacement = Some(serde_json::json!({"template": "x();"}));
    assert_eq!(
        error_code(run(dir.path(), replace)),
        StructuralErrorCode::UnsupportedConstraint
    );
}

#[test]
fn file_and_module_scopes_follow_the_active_file() {
    let dir = fixture();
    fs::write(
        dir.path().join("src/Other.java"),
        "class Other { void f() { System.out.println(7); } }\n",
    )
    .unwrap();
    fs::write(dir.path().join("notes.txt"), "System.out.println(1);\n").unwrap();
    assert_eq!(ok_matches(run(dir.path(), query(TEMPLATE, None))).len(), 4);
    let mut file = query(TEMPLATE, None);
    file.scope = "file".to_string();
    assert_eq!(ok_matches(run(dir.path(), file)).len(), 3);
    let mut module = query(TEMPLATE, None);
    module.scope = "module".to_string();
    assert_eq!(ok_matches(run(dir.path(), module)).len(), 4);
    let mut missing = request(dir.path(), query(TEMPLATE, None));
    missing.query.scope = "file".to_string();
    missing.active_file = None;
    assert_eq!(
        error_code(run_structural_search(&missing, &AtomicBool::new(false))),
        StructuralErrorCode::InvalidScope
    );
}

#[test]
fn cancellation_returns_cancelled_without_matches() {
    let dir = fixture();
    let response = run_structural_search(
        &request(dir.path(), query(TEMPLATE, None)),
        &AtomicBool::new(true),
    );
    assert!(
        matches!(response, StructuralSearchResponse::Cancelled { .. }),
        "{response:?}"
    );
}

#[test]
fn columns_are_utf16_and_the_source_is_never_written() {
    let dir = tempdir().unwrap();
    let text = "class U { void f() { String s = \"\u{1F600}\"; System.out.println(s); } }\n";
    let path = dir.path().join("U.java");
    fs::write(&path, text).unwrap();
    let before = fs::read(&path).unwrap();
    let mut req = request(dir.path(), query(TEMPLATE, None));
    req.active_file = None;
    let matches = ok_matches(run_structural_search(&req, &AtomicBool::new(false)));
    assert_eq!(matches.len(), 1);
    let prefix = &text[..text.find("System").unwrap()];
    assert_eq!(matches[0].start.character, prefix.encode_utf16().count());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn response_serializes_with_status_tag_and_camel_case_fields() {
    let dir = fixture();
    let json = serde_json::to_value(run(dir.path(), query(TEMPLATE, Some("42")))).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["requestId"], "req-1");
    assert_eq!(json["matches"][0]["start"]["line"], 3);
    assert_eq!(json["matches"][0]["captures"][0]["name"], "arg");
    assert_eq!(json["stats"]["filesScanned"], 1);
    let mut kotlin = query(TEMPLATE, None);
    kotlin.language_id = "kotlin".to_string();
    let json = serde_json::to_value(run(dir.path(), kotlin)).unwrap();
    assert_eq!(json["status"], "unavailable");
    assert_eq!(json["reason"], "unsupported-language");
    let request: StructuralSearchRequest = serde_json::from_value(serde_json::json!({
            "requestId": "r", "roots": [],
            "query": {"schemaVersion": 1, "languageId": "java", "pattern": "a();", "scope": "workspace",
                      "variables": {"arg": {"minCount": 1, "maxCount": 1, "text": "42", "invert": false}}}
        }))
        .unwrap();
    assert_eq!(request.query.variables["arg"].text.as_deref(), Some("42"));
}
