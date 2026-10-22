use super::model::StructuralQuery;
use super::pattern::CompiledPattern;
use super::pattern::PatternError;
use super::pattern::PatternNode;
use super::pattern::node_text;
use super::pattern::significant_children;
use regex::Regex;
use regex::RegexBuilder;
use std::collections::HashMap;
use tree_sitter::Node;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

pub(super) struct VariableFilter {
    pub(super) regex: Regex,
    pub(super) invert: bool,
}

pub(super) struct Matcher<'p> {
    pub(super) pattern: &'p CompiledPattern,
    pub(super) filters: HashMap<String, VariableFilter>,
    pub(super) match_case: bool,
}

pub(super) struct Binding<'t> {
    pub(super) name: String,
    pub(super) node: Node<'t>,
    pub(super) text: String,
}

impl Matcher<'_> {
    pub(super) fn leaf_equal(&self, a: &str, b: &str) -> bool {
        if self.match_case {
            a == b
        } else {
            a.eq_ignore_ascii_case(b)
        }
    }

    pub(super) fn match_node<'t>(
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

    pub(super) fn filters_pass(&self, bindings: &[Binding<'_>]) -> bool {
        self.filters.iter().all(|(name, filter)| {
            bindings
                .iter()
                .find(|binding| &binding.name == name)
                .is_none_or(|binding| filter.regex.is_match(&binding.text) != filter.invert)
        })
    }

    pub(super) fn root_kind(&self) -> &str {
        match &self.pattern.root {
            PatternNode::Node { kind, .. } => kind,
            PatternNode::Var(_) => "",
        }
    }
}

pub(super) fn build_filters(
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
