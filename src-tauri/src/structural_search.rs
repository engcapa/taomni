use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tauri::State;
use tree_sitter::{Node, Parser};

const JAVA_PATTERN: &str = "System.out.println($arg$);";

#[derive(Default)]
pub struct StructuralSearchState {
    requests: Mutex<HashMap<String, Arc<AtomicUsize>>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchVariable {
    pub min_count: usize,
    pub max_count: Option<usize>,
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchQuery {
    pub schema_version: u32,
    pub language_id: String,
    pub pattern: String,
    pub variables: HashMap<String, StructuralSearchVariable>,
    pub scope: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchDocument {
    pub root_id: String,
    pub root_name: String,
    pub root_path: String,
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchCapture {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchResult {
    pub root_id: String,
    pub root_name: String,
    pub root_path: String,
    pub path: String,
    pub from: usize,
    pub to: usize,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub preview: String,
    pub class_name: Option<String>,
    pub method_name: Option<String>,
    pub captures: HashMap<String, StructuralSearchCapture>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StructuralSearchResponse {
    Ready {
        backend: &'static str,
        results: Vec<StructuralSearchResult>,
        files_scanned: usize,
    },
    Unavailable {
        reason: String,
        backend: &'static str,
    },
    Error {
        message: String,
    },
    Cancelled,
}

fn utf16_offset(source: &str, byte_offset: usize) -> usize {
    source[..byte_offset].encode_utf16().count()
}

fn line_position(source: &str, byte_offset: usize) -> (usize, usize) {
    let prefix = &source[..byte_offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .encode_utf16()
        .count();
    (line, column)
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    &source[node.start_byte()..node.end_byte()]
}

fn enclosing_name(mut node: Node<'_>, source: &str, kind: &str) -> Option<String> {
    while let Some(parent) = node.parent() {
        if parent.kind() == kind {
            return parent
                .child_by_field_name("name")
                .map(|name| node_text(name, source).to_string());
        }
        node = parent;
    }
    None
}

fn match_invocation(
    invocation: Node<'_>,
    document: &StructuralSearchDocument,
    text_filter: Option<&str>,
) -> Option<StructuralSearchResult> {
    let statement = invocation.parent()?;
    if statement.kind() != "expression_statement" || statement.has_error() {
        return None;
    }
    let source = &document.text;
    let receiver = invocation.child_by_field_name("object")?;
    let method = invocation.child_by_field_name("name")?;
    let arguments = invocation.child_by_field_name("arguments")?;
    if node_text(receiver, source) != "System.out"
        || node_text(method, source) != "println"
        || arguments.named_child_count() != 1
    {
        return None;
    }
    let argument = arguments.named_child(0)?;
    let argument_text = node_text(argument, source);
    if argument_text.is_empty() || text_filter.is_some_and(|filter| filter != argument_text) {
        return None;
    }
    let (line, column) = line_position(source, statement.start_byte());
    let (end_line, end_column) = line_position(source, statement.end_byte());
    let mut captures = HashMap::new();
    captures.insert(
        "arg".to_string(),
        StructuralSearchCapture {
            from: utf16_offset(source, argument.start_byte()),
            to: utf16_offset(source, argument.end_byte()),
            text: argument_text.to_string(),
        },
    );
    Some(StructuralSearchResult {
        root_id: document.root_id.clone(),
        root_name: document.root_name.clone(),
        root_path: document.root_path.clone(),
        path: document.path.clone(),
        from: utf16_offset(source, statement.start_byte()),
        to: utf16_offset(source, statement.end_byte()),
        line,
        column,
        end_line,
        end_column,
        preview: node_text(statement, source).trim().to_string(),
        class_name: enclosing_name(invocation, source, "class_declaration"),
        method_name: enclosing_name(invocation, source, "method_declaration"),
        captures,
    })
}

fn visit(
    node: Node<'_>,
    document: &StructuralSearchDocument,
    text_filter: Option<&str>,
    cancel: Option<&AtomicUsize>,
    results: &mut Vec<StructuralSearchResult>,
) {
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed) != 0) {
        return;
    }
    if node.kind() == "method_invocation" {
        if let Some(result) = match_invocation(node, document, text_filter) {
            results.push(result);
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, document, text_filter, cancel, results);
    }
}

fn search_documents(
    query: &StructuralSearchQuery,
    documents: &[StructuralSearchDocument],
    cancel: Option<&AtomicUsize>,
) -> StructuralSearchResponse {
    let unavailable = |reason: &str| StructuralSearchResponse::Unavailable {
        reason: reason.to_string(),
        backend: "tree-sitter-java",
    };
    if query.schema_version != 1 || query.language_id != "java" {
        return unavailable("Only Java structural search schema v1 is available");
    }
    if query.pattern.trim() != JAVA_PATTERN {
        return unavailable("Only the Java println template is available in this first adapter");
    }
    if !matches!(query.scope.as_str(), "file" | "workspace")
        || query.variables.len() != 1
        || !query
            .variables
            .get("arg")
            .is_some_and(|arg| arg.min_count == 1 && arg.max_count == Some(1))
    {
        return unavailable("Unsupported Java structural search scope or variable");
    }
    let mut parser = Parser::new();
    if let Err(error) = parser.set_language(&tree_sitter_java::LANGUAGE.into()) {
        return StructuralSearchResponse::Error {
            message: format!("Java parser unavailable: {error}"),
        };
    }
    // The flag outlives the parser in this function; tree-sitter checks it
    // during long parses, and the worker checks it between documents/nodes.
    unsafe {
        parser.set_cancellation_flag(cancel);
    }
    let mut results = Vec::new();
    let mut files_scanned = 0;
    let text_filter = query
        .variables
        .get("arg")
        .and_then(|arg| arg.text.as_deref());
    for document in documents
        .iter()
        .filter(|item| item.path.to_ascii_lowercase().ends_with(".java"))
    {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed) != 0) {
            return StructuralSearchResponse::Cancelled;
        }
        let Some(tree) = parser.parse(&document.text, None) else {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed) != 0) {
                return StructuralSearchResponse::Cancelled;
            }
            return StructuralSearchResponse::Error {
                message: format!("Java parser stopped for {}", document.path),
            };
        };
        files_scanned += 1;
        visit(
            tree.root_node(),
            document,
            text_filter,
            cancel,
            &mut results,
        );
    }
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed) != 0) {
        return StructuralSearchResponse::Cancelled;
    }
    StructuralSearchResponse::Ready {
        backend: "tree-sitter-java",
        results,
        files_scanned,
    }
}

#[tauri::command]
pub async fn structural_search_java(
    state: State<'_, StructuralSearchState>,
    query: StructuralSearchQuery,
    documents: Vec<StructuralSearchDocument>,
    request_id: String,
) -> Result<StructuralSearchResponse, String> {
    let cancel = Arc::new(AtomicUsize::new(0));
    {
        let mut requests = state
            .requests
            .lock()
            .map_err(|_| "Structural search state is unavailable")?;
        if requests.contains_key(&request_id) {
            return Err("A structural search with this id is already running".to_string());
        }
        requests.insert(request_id.clone(), cancel.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        search_documents(&query, &documents, Some(&cancel))
    })
    .await;
    state
        .requests
        .lock()
        .map_err(|_| "Structural search state is unavailable")?
        .remove(&request_id);
    result.map_err(|error| format!("Structural search worker failed: {error}"))
}

#[tauri::command]
pub fn structural_search_cancel(
    state: State<'_, StructuralSearchState>,
    request_id: String,
) -> Result<bool, String> {
    let requests = state
        .requests
        .lock()
        .map_err(|_| "Structural search state is unavailable")?;
    let Some(cancel) = requests.get(&request_id) else {
        return Ok(false);
    };
    cancel.store(1, Ordering::Relaxed);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: Option<&str>) -> StructuralSearchQuery {
        let mut variables = HashMap::new();
        variables.insert(
            "arg".to_string(),
            StructuralSearchVariable {
                min_count: 1,
                max_count: Some(1),
                text: text.map(str::to_string),
            },
        );
        StructuralSearchQuery {
            schema_version: 1,
            language_id: "java".to_string(),
            pattern: JAVA_PATTERN.to_string(),
            variables,
            scope: "workspace".to_string(),
        }
    }

    fn document(source: &str) -> StructuralSearchDocument {
        StructuralSearchDocument {
            root_id: "root".to_string(),
            root_name: "fixture".to_string(),
            root_path: "/tmp/fixture".to_string(),
            path: "StructuralTarget.java".to_string(),
            text: source.to_string(),
        }
    }

    #[test]
    fn matches_only_java_println_invocations() {
        let response = search_documents(
            &query(None),
            &[document(
                r#"class StructuralTarget {
  void run() {
    System.out.println("one");
    System.out.println(42);
    System.out.println(
      7
    );
    // System.out.println(99);
    String text = "System.out.println(100);";
    System.out.print(1);
    System.err.println(2);
  }
}"#,
            )],
            None,
        );
        let StructuralSearchResponse::Ready { results, .. } = response else {
            panic!("expected ready");
        };
        assert_eq!(results.len(), 3);
        assert_eq!(results[1].captures["arg"].text, "42");
        assert_eq!(results[1].class_name.as_deref(), Some("StructuralTarget"));
        assert_eq!(results[1].method_name.as_deref(), Some("run"));
    }

    #[test]
    fn applies_text_constraint_and_rejects_unknown_template() {
        let response = search_documents(
            &query(Some("42")),
            &[document(
                "class A { void x() { System.out.println(42); System.out.println(999); } }",
            )],
            None,
        );
        let StructuralSearchResponse::Ready { results, .. } = response else {
            panic!("expected ready");
        };
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].captures["arg"].text, "42");

        let mut unsupported = query(None);
        unsupported.pattern = "System.out.print($arg$);".to_string();
        assert!(matches!(
            search_documents(&unsupported, &[], None),
            StructuralSearchResponse::Unavailable { .. }
        ));
    }

    #[test]
    fn cancellation_stops_before_parsing_and_drops_results() {
        let cancel = AtomicUsize::new(1);
        let response = search_documents(
            &query(None),
            &[document("class A { void x() { System.out.println(42); } }")],
            Some(&cancel),
        );
        assert!(matches!(response, StructuralSearchResponse::Cancelled));
    }
}
