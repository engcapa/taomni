//! Structural Search (ED-PARITY-009): Java AST template matching.
//!
//! A template such as `System.out.println($arg$);` is parsed with the same
//! tree-sitter Java grammar as the searched sources; `$name$` placeholders
//! become variables that match exactly one AST node. Matching compares node
//! kinds and leaf token text, so comments, string contents and similarly named
//! calls (`print`, `System.err`) never match. There is intentionally no
//! regex/text fallback: an unsupported language or pattern returns a typed
//! `unavailable`/`error` response instead of an empty or approximate result.

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;
use tauri::State;
use tree_sitter::{Node, Parser, Tree};

pub const BACKEND_ID: &str = "tree-sitter-java";
pub const PARSER_VERSION: &str = "tree-sitter 0.25.10";
pub const GRAMMAR_VERSION: &str = "tree-sitter-java 0.23.5";
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MATCHES: usize = 5_000;
const VAR_PREFIX: &str = "__ssr_var_";

#[derive(Default)]
pub struct StructuralSearchState {
    requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl StructuralSearchState {
    pub fn active_request_count(&self) -> usize {
        self.requests.lock().map(|active| active.len()).unwrap_or(0)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StructuralQueryVariable {
    pub min_count: u32,
    pub max_count: Option<u32>,
    pub text: Option<String>,
    #[serde(rename = "type")]
    pub type_constraint: Option<String>,
    pub reference: Option<String>,
    pub invert: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralQuery {
    pub schema_version: u32,
    pub language_id: String,
    pub pattern: String,
    #[serde(default)]
    pub variables: BTreeMap<String, StructuralQueryVariable>,
    pub scope: String,
    #[serde(default)]
    pub match_case: bool,
    /// Structural Replace payload. Only its presence is inspected: Replace is
    /// a later card and is rejected as an unsupported constraint.
    #[serde(default)]
    pub replacement: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchRoot {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralActiveFile {
    pub root_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchRequest {
    pub request_id: String,
    pub query: StructuralQuery,
    pub roots: Vec<StructuralSearchRoot>,
    #[serde(default)]
    pub active_file: Option<StructuralActiveFile>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralBackendInfo {
    pub id: &'static str,
    pub parser: &'static str,
    pub grammar: &'static str,
}

fn backend_info() -> StructuralBackendInfo {
    StructuralBackendInfo {
        id: BACKEND_ID,
        parser: PARSER_VERSION,
        grammar: GRAMMAR_VERSION,
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralPosition {
    /// Zero-based line.
    pub line: usize,
    /// Zero-based UTF-16 column (the editor/LSP convention).
    pub character: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralCapture {
    pub name: String,
    pub text: String,
    pub start: StructuralPosition,
    pub end: StructuralPosition,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralContainer {
    /// `class`, `interface`, `enum`, `record`, `method` or `constructor`.
    pub kind: &'static str,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralMatch {
    pub root_id: String,
    pub root_name: String,
    pub path: String,
    pub start: StructuralPosition,
    pub end: StructuralPosition,
    pub start_byte: usize,
    pub end_byte: usize,
    /// Full text of the first matched line, for the result row preview.
    pub line_text: String,
    pub matched_text: String,
    pub captures: Vec<StructuralCapture>,
    /// Outermost first, e.g. `[class StructuralTarget, method run]`.
    pub containers: Vec<StructuralContainer>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchStats {
    pub files_scanned: usize,
    pub files_with_parse_errors: usize,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralUnavailableReason {
    UnsupportedLanguage,
    BackendMissing,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralErrorCode {
    InvalidPattern,
    UnsupportedConstraint,
    InvalidScope,
    InvalidRequest,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum StructuralSearchResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        request_id: String,
        backend: StructuralBackendInfo,
        matches: Vec<StructuralMatch>,
        truncated: bool,
        stats: StructuralSearchStats,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        request_id: String,
        reason: StructuralUnavailableReason,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        request_id: String,
        code: StructuralErrorCode,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Cancelled {
        request_id: String,
        stats: StructuralSearchStats,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralSearchCapabilities {
    pub available: bool,
    pub backend: StructuralBackendInfo,
    pub languages: Vec<&'static str>,
    pub scopes: Vec<&'static str>,
    pub active_requests: usize,
}

// ---------------------------------------------------------------------------
// Template compilation
// ---------------------------------------------------------------------------

/// Owned pattern tree compiled from the template's own parse.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PatternNode {
    /// `$name$`: matches exactly one named node (count [1,1]).
    Var(String),
    Node {
        kind: String,
        /// Leaf token text; `None` for interior nodes.
        text: Option<String>,
        children: Vec<PatternNode>,
    },
}

#[derive(Debug)]
struct CompiledPattern {
    root: PatternNode,
    variables: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct PatternError {
    code: StructuralErrorCode,
    message: String,
}

impl PatternError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: StructuralErrorCode::InvalidPattern,
            message: message.into(),
        }
    }
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: StructuralErrorCode::UnsupportedConstraint,
            message: message.into(),
        }
    }
}

fn java_parser() -> Result<Parser, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .map_err(|error| format!("Load Java grammar: {error}"))?;
    Ok(parser)
}

/// Replace `$name$` placeholders with parseable identifiers.
fn substitute_placeholders(pattern: &str) -> Result<(String, Vec<String>), PatternError> {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut variables: Vec<String> = Vec::new();
    let mut rest = pattern;
    while let Some(start) = rest.find('$') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('$') else {
            return Err(PatternError::invalid(
                "Unterminated template variable: expected a closing '$'",
            ));
        };
        let name = &after[..end];
        let valid = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(PatternError::invalid(format!(
                "Invalid template variable name '${name}$'"
            )));
        }
        if !variables.iter().any(|existing| existing == name) {
            variables.push(name.to_string());
        }
        out.push_str(VAR_PREFIX);
        out.push_str(name);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok((out, variables))
}

/// Non-extra children (comments are extras and never participate).
fn significant_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    let mut children = Vec::new();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            if !child.is_extra() {
                children.push(child);
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    children
}

fn node_text<'s>(node: Node<'_>, source: &'s [u8]) -> &'s str {
    node.utf8_text(source).unwrap_or("")
}

fn variable_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let leafish = matches!(
        node.kind(),
        "identifier" | "type_identifier" | "string_fragment"
    );
    if !leafish {
        return None;
    }
    node_text(node, source)
        .strip_prefix(VAR_PREFIX)
        .map(str::to_string)
}

fn to_pattern(node: Node<'_>, source: &[u8]) -> PatternNode {
    if let Some(name) = variable_name(node, source) {
        return PatternNode::Var(name);
    }
    let children: Vec<PatternNode> = significant_children(node)
        .into_iter()
        .map(|child| to_pattern(child, source))
        .collect();
    let text = children
        .is_empty()
        .then(|| node_text(node, source).to_string());
    PatternNode::Node {
        kind: node.kind().to_string(),
        text,
        children,
    }
}

fn named_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    significant_children(node)
        .into_iter()
        .filter(|child| child.is_named())
        .collect()
}

fn single_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let named = named_children(node);
    (named.len() == 1).then(|| named[0])
}

fn child_of_kind<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    named_children(node)
        .into_iter()
        .find(|child| child.kind() == kind)
}

fn wrapper_class_body(root: Node<'_>) -> Option<Node<'_>> {
    child_of_kind(root, "class_declaration")?.child_by_field_name("body")
}

fn locate_statement(root: Node<'_>) -> Option<Node<'_>> {
    let method = child_of_kind(wrapper_class_body(root)?, "method_declaration")?;
    single_named_child(method.child_by_field_name("body")?)
}

fn locate_expression(root: Node<'_>) -> Option<Node<'_>> {
    let field = child_of_kind(wrapper_class_body(root)?, "field_declaration")?;
    let value = field
        .child_by_field_name("declarator")?
        .child_by_field_name("value")?;
    // Unwrap the parentheses the wrapper introduced.
    if value.kind() != "parenthesized_expression" {
        return None;
    }
    single_named_child(value)
}

fn locate_member(root: Node<'_>) -> Option<Node<'_>> {
    single_named_child(wrapper_class_body(root)?)
}

type Locator = for<'t> fn(Node<'t>) -> Option<Node<'t>>;

const TEMPLATE_WRAPPERS: [(&str, &str, Locator); 3] = [
    (
        "class __SsrT { void __ssrM() {\n",
        "\n} }",
        locate_statement,
    ),
    (
        "class __SsrT { Object __ssrF = (\n",
        "\n); }",
        locate_expression,
    ),
    ("class __SsrT {\n", "\n}", locate_member),
];

/// Try the template as a statement, then an expression, then a class member.
fn compile_pattern(pattern: &str) -> Result<CompiledPattern, PatternError> {
    if pattern.trim().is_empty() {
        return Err(PatternError::invalid("Search template must not be empty"));
    }
    let (substituted, variables) = substitute_placeholders(pattern)?;
    let mut parser = java_parser().map_err(PatternError::invalid)?;
    for (prefix, suffix, locate) in TEMPLATE_WRAPPERS {
        let source = format!("{prefix}{substituted}{suffix}");
        let Some(tree) = parser.parse(source.as_bytes(), None) else {
            continue;
        };
        if tree.root_node().has_error() {
            continue;
        }
        let Some(node) = locate(tree.root_node()) else {
            continue;
        };
        let root = to_pattern(node, source.as_bytes());
        if matches!(root, PatternNode::Var(_)) {
            return Err(PatternError::invalid(
                "Search template must contain Java code, not only a variable",
            ));
        }
        return Ok(CompiledPattern { root, variables });
    }
    Err(PatternError::invalid(
        "Search template is not a single Java statement, expression or class member",
    ))
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

struct VariableFilter {
    regex: Regex,
    invert: bool,
}

struct Matcher<'p> {
    pattern: &'p CompiledPattern,
    filters: HashMap<String, VariableFilter>,
    match_case: bool,
}

struct Binding<'t> {
    name: String,
    node: Node<'t>,
    text: String,
}

impl Matcher<'_> {
    fn leaf_equal(&self, a: &str, b: &str) -> bool {
        if self.match_case {
            a == b
        } else {
            a.eq_ignore_ascii_case(b)
        }
    }

    fn match_node<'t>(
        &self,
        pattern: &PatternNode,
        node: Node<'t>,
        source: &[u8],
        bindings: &mut Vec<Binding<'t>>,
    ) -> bool {
        if node.is_error() || node.is_missing() {
            return false;
        }
        match pattern {
            PatternNode::Var(name) => {
                if !node.is_named() {
                    return false;
                }
                let text = node_text(node, source).to_string();
                if let Some(previous) = bindings.iter().find(|binding| &binding.name == name) {
                    // A repeated variable must bind the same text each time.
                    return self.leaf_equal(&previous.text, &text);
                }
                bindings.push(Binding {
                    name: name.clone(),
                    node,
                    text,
                });
                true
            }
            PatternNode::Node {
                kind,
                text,
                children,
            } => {
                if node.kind() != kind {
                    return false;
                }
                let targets = significant_children(node);
                if children.is_empty() || targets.is_empty() {
                    return children.is_empty()
                        && targets.is_empty()
                        && self.leaf_equal(text.as_deref().unwrap_or(""), node_text(node, source));
                }
                targets.len() == children.len()
                    && children
                        .iter()
                        .zip(targets)
                        .all(|(child, target)| self.match_node(child, target, source, bindings))
            }
        }
    }

    fn filters_pass(&self, bindings: &[Binding<'_>]) -> bool {
        self.filters.iter().all(|(name, filter)| {
            bindings
                .iter()
                .find(|binding| &binding.name == name)
                .is_none_or(|binding| filter.regex.is_match(&binding.text) != filter.invert)
        })
    }

    fn root_kind(&self) -> &str {
        match &self.pattern.root {
            PatternNode::Node { kind, .. } => kind,
            PatternNode::Var(_) => "",
        }
    }
}

fn build_filters(
    query: &StructuralQuery,
    variables: &[String],
) -> Result<HashMap<String, VariableFilter>, PatternError> {
    let mut filters = HashMap::new();
    for (name, variable) in &query.variables {
        if !variables.iter().any(|known| known == name) {
            // Like IDEA, constraints for variables no longer in the template
            // are kept by the caller but do not participate.
            continue;
        }
        if variable.min_count != 1 || variable.max_count != Some(1) {
            return Err(PatternError::unsupported(format!(
                "Variable ${name}$: only Count [1,1] is supported by this backend"
            )));
        }
        let non_empty =
            |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
        if non_empty(&variable.type_constraint) {
            return Err(PatternError::unsupported(format!(
                "Variable ${name}$: the Type modifier needs semantic resolution and is not supported"
            )));
        }
        if non_empty(&variable.reference) {
            return Err(PatternError::unsupported(format!(
                "Variable ${name}$: the Reference modifier is not supported"
            )));
        }
        let Some(text) = variable.text.as_deref().filter(|text| !text.is_empty()) else {
            continue;
        };
        // IDEA's Text modifier is a regular expression over the whole capture.
        let regex = RegexBuilder::new(&format!("^(?:{text})$"))
            .case_insensitive(!query.match_case)
            .build()
            .map_err(|error| PatternError::invalid(format!("Variable ${name}$ Text: {error}")))?;
        filters.insert(
            name.clone(),
            VariableFilter {
                regex,
                invert: variable.invert,
            },
        );
    }
    Ok(filters)
}

fn position_of(source: &[u8], byte: usize) -> StructuralPosition {
    let byte = byte.min(source.len());
    let line_start = source[..byte]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |index| index + 1);
    let line = source[..line_start].iter().filter(|b| **b == b'\n').count();
    let prefix = String::from_utf8_lossy(&source[line_start..byte]);
    StructuralPosition {
        line,
        character: prefix.encode_utf16().count(),
    }
}

fn line_text_at(source: &[u8], byte: usize) -> String {
    let byte = byte.min(source.len());
    let start = source[..byte]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |index| index + 1);
    let end = source[byte..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(source.len(), |index| byte + index);
    String::from_utf8_lossy(&source[start..end])
        .trim_end_matches('\r')
        .to_string()
}

fn containers_of(node: Node<'_>, source: &[u8]) -> Vec<StructuralContainer> {
    let mut containers = Vec::new();
    let mut current = node.parent();
    while let Some(parent) = current {
        let kind = match parent.kind() {
            "class_declaration" => Some("class"),
            "interface_declaration" => Some("interface"),
            "enum_declaration" => Some("enum"),
            "record_declaration" => Some("record"),
            "method_declaration" => Some("method"),
            "constructor_declaration" => Some("constructor"),
            _ => None,
        };
        if let Some(kind) = kind {
            let name = parent
                .child_by_field_name("name")
                .map(|name| node_text(name, source).to_string())
                .unwrap_or_default();
            containers.push(StructuralContainer { kind, name });
        }
        current = parent.parent();
    }
    containers.reverse();
    containers
}

/// One structural match inside a single file, independent of root metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileHit {
    start_byte: usize,
    end_byte: usize,
    start: StructuralPosition,
    end: StructuralPosition,
    line_text: String,
    matched_text: String,
    captures: Vec<StructuralCapture>,
    containers: Vec<StructuralContainer>,
}

/// Pre-order walk of one parsed file; returns matches in source order.
fn match_tree(matcher: &Matcher<'_>, tree: &Tree, source: &[u8], limit: usize) -> Vec<FileHit> {
    let root_kind = matcher.root_kind();
    let mut hits = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        if node.kind() == root_kind && hits.len() < limit {
            let mut bindings = Vec::new();
            if matcher.match_node(&matcher.pattern.root, node, source, &mut bindings)
                && matcher.filters_pass(&bindings)
            {
                let captures = matcher
                    .pattern
                    .variables
                    .iter()
                    .filter_map(|name| bindings.iter().find(|binding| &binding.name == name))
                    .map(|binding| StructuralCapture {
                        name: binding.name.clone(),
                        text: binding.text.clone(),
                        start: position_of(source, binding.node.start_byte()),
                        end: position_of(source, binding.node.end_byte()),
                    })
                    .collect();
                hits.push(FileHit {
                    start_byte: node.start_byte(),
                    end_byte: node.end_byte(),
                    start: position_of(source, node.start_byte()),
                    end: position_of(source, node.end_byte()),
                    line_text: line_text_at(source, node.start_byte()),
                    matched_text: node_text(node, source).to_string(),
                    captures,
                    containers: containers_of(node, source),
                });
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return hits;
            }
        }
    }
}

struct SearchFile {
    root_index: usize,
    relative: String,
    absolute: PathBuf,
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_java_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("java"))
}

fn scope_error(message: impl Into<String>) -> PatternError {
    PatternError {
        code: StructuralErrorCode::InvalidScope,
        message: message.into(),
    }
}

/// Resolve `workspace` / `module` / `file` into an ordered Java file list.
/// `module` is the workspace root containing the active file, the closest
/// Taomni equivalent of an IDEA module until project models expose modules.
fn collect_files(
    roots: &[StructuralSearchRoot],
    scope: &str,
    active: Option<&StructuralActiveFile>,
    cancelled: &AtomicBool,
) -> Result<Vec<SearchFile>, PatternError> {
    let active_root = || {
        let active =
            active.ok_or_else(|| scope_error(format!("Scope '{scope}' needs an active file")))?;
        roots
            .iter()
            .position(|root| root.id == active.root_id)
            .map(|index| (index, active))
            .ok_or_else(|| scope_error("The active file is not inside a workspace root"))
    };
    let root_indexes: Vec<usize> = match scope {
        "workspace" => (0..roots.len()).collect(),
        "module" => vec![active_root()?.0],
        "file" => {
            let (index, active) = active_root()?;
            let root = std::fs::canonicalize(&roots[index].path).map_err(|error| {
                scope_error(format!("Resolve root {}: {error}", roots[index].path))
            })?;
            let absolute = std::fs::canonicalize(root.join(&active.path)).map_err(|error| {
                scope_error(format!("Resolve active file {}: {error}", active.path))
            })?;
            if !absolute.starts_with(&root) || !is_java_file(&absolute) {
                return Err(scope_error(
                    "Scope 'file' needs an active Java file inside the workspace",
                ));
            }
            return Ok(vec![SearchFile {
                root_index: index,
                relative: relative_path(&root, &absolute),
                absolute,
            }]);
        }
        other => return Err(scope_error(format!("Unknown scope '{other}'"))),
    };

    let mut files = Vec::new();
    for index in root_indexes {
        let root = std::fs::canonicalize(&roots[index].path)
            .map_err(|error| scope_error(format!("Resolve root {}: {error}", roots[index].path)))?;
        let mut walk = WalkBuilder::new(&root);
        walk.follow_links(false).require_git(false);
        let mut root_files = Vec::new();
        for entry in walk.build() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(files);
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) || !is_java_file(entry.path())
            {
                continue;
            }
            if entry
                .metadata()
                .map(|meta| meta.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let absolute = entry.into_path();
            root_files.push(SearchFile {
                root_index: index,
                relative: relative_path(&root, &absolute),
                absolute,
            });
        }
        root_files.sort_by(|a, b| a.relative.cmp(&b.relative));
        files.extend(root_files);
    }
    Ok(files)
}

fn error_response(request_id: &str, error: PatternError) -> StructuralSearchResponse {
    StructuralSearchResponse::Error {
        request_id: request_id.to_string(),
        code: error.code,
        message: error.message,
    }
}

/// Run one request to completion (or cancellation). Pure with respect to Tauri
/// state so it can be unit-tested against real files.
pub fn run_structural_search(
    request: &StructuralSearchRequest,
    cancelled: &AtomicBool,
) -> StructuralSearchResponse {
    let started = Instant::now();
    let request_id = request.request_id.as_str();
    let query = &request.query;
    if query.schema_version != 1 {
        return error_response(
            request_id,
            PatternError {
                code: StructuralErrorCode::InvalidRequest,
                message: format!(
                    "Unsupported structural query schema version {}",
                    query.schema_version
                ),
            },
        );
    }
    if query.language_id != "java" {
        return StructuralSearchResponse::Unavailable {
            request_id: request_id.to_string(),
            reason: StructuralUnavailableReason::UnsupportedLanguage,
            message: format!(
                "Structural Search has no parser backend for '{}'; only Java is available",
                query.language_id
            ),
        };
    }
    if query.replacement.is_some() {
        return error_response(
            request_id,
            PatternError::unsupported("Structural Replace is not supported by this backend"),
        );
    }
    if request.roots.is_empty() {
        return error_response(
            request_id,
            PatternError {
                code: StructuralErrorCode::InvalidRequest,
                message: "At least one workspace root is required".to_string(),
            },
        );
    }
    let pattern = match compile_pattern(&query.pattern) {
        Ok(pattern) => pattern,
        Err(error) => return error_response(request_id, error),
    };
    let filters = match build_filters(query, &pattern.variables) {
        Ok(filters) => filters,
        Err(error) => return error_response(request_id, error),
    };
    let matcher = Matcher {
        pattern: &pattern,
        filters,
        match_case: query.match_case,
    };
    let files = match collect_files(
        &request.roots,
        &query.scope,
        request.active_file.as_ref(),
        cancelled,
    ) {
        Ok(files) => files,
        Err(error) => return error_response(request_id, error),
    };
    let mut parser = match java_parser() {
        Ok(parser) => parser,
        Err(message) => {
            return StructuralSearchResponse::Unavailable {
                request_id: request_id.to_string(),
                reason: StructuralUnavailableReason::BackendMissing,
                message,
            };
        }
    };

    let mut stats = StructuralSearchStats {
        files_scanned: 0,
        files_with_parse_errors: 0,
        elapsed_ms: 0,
    };
    let mut matches = Vec::new();
    let mut truncated = false;
    for file in &files {
        if cancelled.load(Ordering::Relaxed) {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return StructuralSearchResponse::Cancelled {
                request_id: request_id.to_string(),
                stats,
            };
        }
        let Ok(bytes) = std::fs::read(&file.absolute) else {
            continue;
        };
        if std::str::from_utf8(&bytes).is_err() {
            continue;
        }
        let Some(tree) = parser.parse(&bytes, None) else {
            continue;
        };
        stats.files_scanned += 1;
        if tree.root_node().has_error() {
            stats.files_with_parse_errors += 1;
        }
        let remaining = MAX_MATCHES.saturating_sub(matches.len());
        let root = &request.roots[file.root_index];
        for hit in match_tree(&matcher, &tree, &bytes, remaining + 1) {
            if matches.len() >= MAX_MATCHES {
                truncated = true;
                break;
            }
            matches.push(StructuralMatch {
                root_id: root.id.clone(),
                root_name: root.name.clone(),
                path: file.relative.clone(),
                start: hit.start,
                end: hit.end,
                start_byte: hit.start_byte,
                end_byte: hit.end_byte,
                line_text: hit.line_text,
                matched_text: hit.matched_text,
                captures: hit.captures,
                containers: hit.containers,
            });
        }
        if truncated {
            break;
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        stats.elapsed_ms = started.elapsed().as_millis() as u64;
        return StructuralSearchResponse::Cancelled {
            request_id: request_id.to_string(),
            stats,
        };
    }
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    StructuralSearchResponse::Ok {
        request_id: request_id.to_string(),
        backend: backend_info(),
        matches,
        truncated,
        stats,
    }
}

fn validate_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 64
        && request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Removes the request's cancel flag when the search finishes, fails or panics,
/// so `active_requests` returns to zero (ED-PARITY-009-A3 resource release).
struct ActiveRequestGuard {
    requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    request_id: String,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.requests.lock() {
            active.remove(&self.request_id);
        }
    }
}

#[tauri::command]
pub fn structural_search_capabilities(
    state: State<'_, StructuralSearchState>,
) -> StructuralSearchCapabilities {
    StructuralSearchCapabilities {
        available: java_parser().is_ok(),
        backend: backend_info(),
        languages: vec!["java"],
        scopes: vec!["workspace", "module", "file"],
        active_requests: state.active_request_count(),
    }
}

#[tauri::command]
pub async fn structural_search_run(
    state: State<'_, StructuralSearchState>,
    request: StructuralSearchRequest,
) -> Result<StructuralSearchResponse, String> {
    if !validate_request_id(&request.request_id) {
        return Err("Invalid structural search request id".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state
            .requests
            .lock()
            .map_err(|_| "Structural search state is unavailable".to_string())?;
        if active.contains_key(&request.request_id) {
            return Err("A structural search with this id is already running".to_string());
        }
        active.insert(request.request_id.clone(), cancel.clone());
    }
    let guard = ActiveRequestGuard {
        requests: state.requests.clone(),
        request_id: request.request_id.clone(),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_structural_search(&request, &cancel)
    })
    .await;
    result.map_err(|error| format!("Structural search task failed: {error}"))
}

#[tauri::command]
pub fn structural_search_cancel(
    state: State<'_, StructuralSearchState>,
    request_id: String,
) -> Result<bool, String> {
    let active = state
        .requests
        .lock()
        .map_err(|_| "Structural search state is unavailable".to_string())?;
    let Some(cancel) = active.get(&request_id) else {
        return Ok(false);
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(
            matches!(&none, StructuralSearchResponse::Ok { matches, .. } if matches.is_empty())
        );
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
}
