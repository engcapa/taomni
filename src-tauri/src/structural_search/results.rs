use super::matching::Matcher;
use super::model::StructuralCapture;
use super::model::StructuralContainer;
use super::model::StructuralPosition;
use super::pattern::node_text;
use tree_sitter::Node;
use tree_sitter::Tree;

pub(super) fn position_of(source: &[u8], byte: usize) -> StructuralPosition {
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

pub(super) fn line_text_at(source: &[u8], byte: usize) -> String {
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

pub(super) fn containers_of(node: Node<'_>, source: &[u8]) -> Vec<StructuralContainer> {
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
pub(super) struct FileHit {
    pub(super) start_byte: usize,
    pub(super) end_byte: usize,
    pub(super) start: StructuralPosition,
    pub(super) end: StructuralPosition,
    pub(super) line_text: String,
    pub(super) matched_text: String,
    pub(super) captures: Vec<StructuralCapture>,
    pub(super) containers: Vec<StructuralContainer>,
}

/// Pre-order walk of one parsed file; returns matches in source order.
pub(super) fn match_tree(
    matcher: &Matcher<'_>,
    tree: &Tree,
    source: &[u8],
    limit: usize,
) -> Vec<FileHit> {
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
