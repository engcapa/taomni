use super::model::StructuralErrorCode;
use super::model::VAR_PREFIX;
use tree_sitter::Node;
use tree_sitter::Parser;

// ---------------------------------------------------------------------------
// Template compilation
// ---------------------------------------------------------------------------

/// Owned pattern tree compiled from the template's own parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PatternNode {
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
pub(super) struct CompiledPattern {
    pub(super) root: PatternNode,
    pub(super) variables: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct PatternError {
    pub(super) code: StructuralErrorCode,
    pub(super) message: String,
}

impl PatternError {
    pub(super) fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: StructuralErrorCode::InvalidPattern,
            message: message.into(),
        }
    }
    pub(super) fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: StructuralErrorCode::UnsupportedConstraint,
            message: message.into(),
        }
    }
}

pub(super) fn java_parser() -> Result<Parser, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .map_err(|error| format!("Load Java grammar: {error}"))?;
    Ok(parser)
}

/// Replace `$name$` placeholders with parseable identifiers.
pub(super) fn substitute_placeholders(
    pattern: &str,
) -> Result<(String, Vec<String>), PatternError> {
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
pub(super) fn significant_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
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

pub(super) fn node_text<'s>(node: Node<'_>, source: &'s [u8]) -> &'s str {
    node.utf8_text(source).unwrap_or("")
}

pub(super) fn variable_name(node: Node<'_>, source: &[u8]) -> Option<String> {
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

pub(super) fn to_pattern(node: Node<'_>, source: &[u8]) -> PatternNode {
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

pub(super) fn named_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    significant_children(node)
        .into_iter()
        .filter(|child| child.is_named())
        .collect()
}

pub(super) fn single_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let named = named_children(node);
    (named.len() == 1).then(|| named[0])
}

pub(super) fn child_of_kind<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    named_children(node)
        .into_iter()
        .find(|child| child.kind() == kind)
}

pub(super) fn wrapper_class_body(root: Node<'_>) -> Option<Node<'_>> {
    child_of_kind(root, "class_declaration")?.child_by_field_name("body")
}

pub(super) fn locate_statement(root: Node<'_>) -> Option<Node<'_>> {
    let method = child_of_kind(wrapper_class_body(root)?, "method_declaration")?;
    single_named_child(method.child_by_field_name("body")?)
}

pub(super) fn locate_expression(root: Node<'_>) -> Option<Node<'_>> {
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

pub(super) fn locate_member(root: Node<'_>) -> Option<Node<'_>> {
    single_named_child(wrapper_class_body(root)?)
}

pub(super) type Locator = for<'t> fn(Node<'t>) -> Option<Node<'t>>;

pub(super) const TEMPLATE_WRAPPERS: [(&str, &str, Locator); 3] = [
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
pub(super) fn compile_pattern(pattern: &str) -> Result<CompiledPattern, PatternError> {
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
