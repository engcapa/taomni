use super::*;

pub(super) fn semantic_token_legend_from(capabilities: &Value) -> (Vec<String>, Vec<String>) {
    let legend = capabilities
        .get("semanticTokensProvider")
        .and_then(|provider| {
            if provider.is_object() {
                provider.get("legend")
            } else {
                None
            }
        });
    let token_types = legend
        .and_then(|legend| legend.get("tokenTypes"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                "namespace",
                "type",
                "class",
                "enum",
                "interface",
                "struct",
                "typeParameter",
                "parameter",
                "variable",
                "property",
                "enumMember",
                "event",
                "function",
                "method",
                "macro",
                "keyword",
                "modifier",
                "comment",
                "string",
                "number",
                "regexp",
                "operator",
                "decorator",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        });
    let token_modifiers = legend
        .and_then(|legend| legend.get("tokenModifiers"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                "declaration",
                "definition",
                "readonly",
                "static",
                "deprecated",
                "abstract",
                "async",
                "modification",
                "documentation",
                "defaultLibrary",
            ]
            .into_iter()
            .map(str::to_string)
            .collect()
        });
    (token_types, token_modifiers)
}

pub(super) fn semantic_token_delta_supported(capabilities: &Value) -> bool {
    capabilities
        .get("semanticTokensProvider")
        .and_then(|provider| provider.get("full"))
        .and_then(|full| full.get("delta"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn semantic_token_data_from_response(
    value: &Value,
) -> Option<(Vec<u64>, Option<String>)> {
    let (data, result_id) = if let Some(data) = value.get("data").and_then(Value::as_array) {
        (
            data.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()?,
            value
                .get("resultId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        )
    } else if let Some(data) = value.as_array() {
        (
            data.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()?,
            None,
        )
    } else {
        return None;
    };
    (data.len() % 5 == 0).then_some((data, result_id))
}

pub(super) fn apply_semantic_token_delta(
    previous: &SemanticTokensCache,
    value: &Value,
) -> Option<(Vec<u64>, Option<String>)> {
    let edits = value.get("edits")?.as_array()?;
    let mut parsed = edits
        .iter()
        .map(|edit| {
            let start = usize::try_from(edit.get("start")?.as_u64()?).ok()?;
            let delete_count = usize::try_from(edit.get("deleteCount")?.as_u64()?).ok()?;
            let data = match edit.get("data") {
                Some(value) => value
                    .as_array()?
                    .iter()
                    .map(Value::as_u64)
                    .collect::<Option<Vec<_>>>()?,
                None => Vec::new(),
            };
            Some((start, delete_count, data))
        })
        .collect::<Option<Vec<_>>>()?;
    parsed.sort_by(|left, right| right.0.cmp(&left.0));
    let mut data = previous.data.clone();
    for (start, delete_count, inserted) in parsed {
        let end = start.checked_add(delete_count)?;
        if start > data.len() || end > data.len() {
            return None;
        }
        data.splice(start..end, inserted);
    }
    if data.len() % 5 != 0 {
        return None;
    }
    let result_id = value
        .get("resultId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| Some(previous.result_id.clone()));
    Some((data, result_id))
}

pub(super) fn decode_semantic_token_data(
    data: &[u64],
    token_types: &[String],
    token_modifiers: &[String],
) -> Vec<LspSemanticToken> {
    let mut tokens = Vec::new();
    let mut line = 0u32;
    let mut character = 0u32;
    for chunk in data.chunks_exact(5) {
        let delta_line = chunk[0] as u32;
        let delta_start = chunk[1] as u32;
        let length = chunk[2] as u32;
        let type_index = chunk[3] as usize;
        let modifier_bits = chunk[4];
        if delta_line == 0 {
            character = character.saturating_add(delta_start);
        } else {
            line = line.saturating_add(delta_line);
            character = delta_start;
        }
        let token_type = token_types
            .get(type_index)
            .cloned()
            .unwrap_or_else(|| format!("unknown:{type_index}"));
        let mut modifiers = Vec::new();
        for (index, name) in token_modifiers.iter().enumerate() {
            if (modifier_bits >> index) & 1 == 1 {
                modifiers.push(name.clone());
            }
        }
        let end_character = character.saturating_add(length);
        tokens.push(LspSemanticToken {
            range: LspRange {
                start: LspPosition { line, character },
                end: LspPosition {
                    line,
                    character: end_character,
                },
            },
            token_type,
            modifiers,
        });
    }
    tokens
}

pub(super) fn parse_semantic_tokens(
    value: &Value,
    token_types: &[String],
    token_modifiers: &[String],
) -> Vec<LspSemanticToken> {
    semantic_token_data_from_response(value)
        .map(|(data, _)| decode_semantic_token_data(&data, token_types, token_modifiers))
        .unwrap_or_default()
}
