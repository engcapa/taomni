use super::*;

pub(super) fn parse_workspace_symbol(value: &Value) -> Option<LspWorkspaceSymbol> {
    let name = value.get("name")?.as_str()?.to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_u64)
        .and_then(|kind| u32::try_from(kind).ok())
        .unwrap_or(0);
    // SymbolInformation: location.uri + location.range
    // WorkspaceSymbol (3.17): location may be { uri } only; range optional.
    let (uri, range, resolved) = if let Some(location) = value.get("location") {
        let uri = location.get("uri").and_then(Value::as_str)?;
        let parsed_range = location
            .get("range")
            .and_then(parse_range)
            .or_else(|| value.get("range").and_then(parse_range));
        let resolved = parsed_range.is_some();
        let range = parsed_range.unwrap_or(LspRange {
            start: LspPosition {
                line: 0,
                character: 0,
            },
            end: LspPosition {
                line: 0,
                character: 0,
            },
        });
        (uri.to_string(), range, resolved)
    } else {
        return None;
    };
    let selection_range = value
        .get("selectionRange")
        .and_then(parse_range)
        .unwrap_or_else(|| range.clone());
    let path = path_from_uri(&uri);
    Some(LspWorkspaceSymbol {
        name,
        kind,
        container_name: value
            .get("containerName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string),
        uri,
        path,
        range,
        selection_range,
        resolved,
        resolve_token: None,
        raw: None,
        provider_session_key: None,
    })
}

pub(super) fn parse_workspace_symbols(value: &Value) -> Vec<LspWorkspaceSymbol> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_workspace_symbol).collect())
        .unwrap_or_default()
}

/// Flattens a `textDocument/documentSymbol` response. Servers reply with
/// either hierarchical `DocumentSymbol[]` (has `selectionRange`/`children`)
/// or flat `SymbolInformation[]` (has `location`); both collapse into the
/// same depth-annotated list.
pub(super) fn collect_document_symbols(
    value: &Value,
    depth: u32,
    out: &mut Vec<LspDocumentSymbol>,
) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok())
            .unwrap_or(0);
        if item.get("selectionRange").is_some() {
            let Some(range) = item.get("range").and_then(parse_range) else {
                continue;
            };
            let Some(selection_range) = item.get("selectionRange").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("detail")
                    .and_then(Value::as_str)
                    .filter(|detail| !detail.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range,
                selection_range,
            });
            if let Some(children) = item.get("children") {
                collect_document_symbols(children, depth + 1, out);
            }
        } else if let Some(location) = item.get("location") {
            let Some(range) = location.get("range").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("containerName")
                    .and_then(Value::as_str)
                    .filter(|container| !container.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range: range.clone(),
                selection_range: range,
            });
        }
    }
}

pub(super) fn parse_locations(value: &Value) -> Vec<LspLocation> {
    if value.is_null() {
        return Vec::new();
    }
    if let Some(array) = value.as_array() {
        return array.iter().filter_map(parse_location).collect();
    }
    parse_location(value).into_iter().collect()
}

pub(super) fn parse_hierarchy_item(value: &Value) -> Option<LspHierarchyItem> {
    let uri = value.get("uri")?.as_str()?.to_string();
    Some(LspHierarchyItem {
        name: value.get("name")?.as_str()?.to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        kind: value.get("kind")?.as_u64()?.try_into().ok()?,
        path: path_from_uri(&uri),
        uri,
        range: value.get("range").and_then(parse_range)?,
        selection_range: value.get("selectionRange").and_then(parse_range)?,
        raw: value.clone(),
    })
}

pub(super) fn parse_hierarchy_items(value: &Value) -> Vec<LspHierarchyItem> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_hierarchy_item).collect())
        .unwrap_or_default()
}

pub(super) fn parse_call_hierarchy_entries(
    value: &Value,
    item_key: &str,
) -> Vec<LspCallHierarchyEntry> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let item = entry.get(item_key).and_then(parse_hierarchy_item)?;
                    let from_ranges = entry
                        .get("fromRanges")
                        .and_then(Value::as_array)
                        .map(|ranges| ranges.iter().filter_map(parse_range).collect())
                        .unwrap_or_default();
                    Some(LspCallHierarchyEntry { item, from_ranges })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_document_highlights(value: &Value) -> Vec<LspDocumentHighlight> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(LspDocumentHighlight {
                        range: item.get("range").and_then(parse_range)?,
                        kind: item
                            .get("kind")
                            .and_then(Value::as_u64)
                            .and_then(|kind| kind.try_into().ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn inlay_hint_label(value: &Value) -> Option<String> {
    if let Some(label) = value.as_str() {
        return Some(label.to_string());
    }
    let parts = value.as_array()?.iter().filter_map(|part| {
        part.get("value")
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    let label = parts.collect::<String>();
    (!label.is_empty()).then_some(label)
}

pub(super) fn parse_inlay_hints(value: &Value) -> Vec<LspInlayHint> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(LspInlayHint {
                        position: item.get("position").and_then(parse_position)?,
                        label: item.get("label").and_then(inlay_hint_label)?,
                        kind: item
                            .get("kind")
                            .and_then(Value::as_u64)
                            .and_then(|kind| kind.try_into().ok()),
                        tooltip: item.get("tooltip").and_then(markup_to_string),
                        padding_left: item
                            .get("paddingLeft")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        padding_right: item
                            .get("paddingRight")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_selection_ranges(value: &Value) -> Vec<LspRange> {
    let Some(mut current) = value.as_array().and_then(|items| items.first()) else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    for _ in 0..64 {
        let Some(range) = current.get("range").and_then(parse_range) else {
            break;
        };
        ranges.push(range);
        let Some(parent) = current.get("parent").filter(|parent| parent.is_object()) else {
            break;
        };
        current = parent;
    }
    ranges
}

pub(super) fn parse_location(value: &Value) -> Option<LspLocation> {
    let (uri, range) = if let Some(uri) = value.get("uri").and_then(Value::as_str) {
        (uri, parse_range(value.get("range")?)?)
    } else {
        let uri = value.get("targetUri").and_then(Value::as_str)?;
        let range = value
            .get("targetSelectionRange")
            .or_else(|| value.get("targetRange"))
            .and_then(parse_range)?;
        (uri, range)
    };
    Some(LspLocation {
        uri: uri.to_string(),
        path: path_from_uri(uri),
        range,
    })
}
