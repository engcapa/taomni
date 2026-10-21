use super::*;

pub(super) fn request_document_uri(params: &Value) -> Option<&str> {
    params
        .pointer("/textDocument/uri")
        .or_else(|| params.pointer("/item/uri"))
        .and_then(Value::as_str)
}

pub(super) fn take_pending_for_document(
    pending: &mut HashMap<u64, PendingResponse>,
    uri: &str,
) -> Vec<(u64, PendingResponse)> {
    let ids = pending
        .iter()
        .filter_map(|(id, response)| (response.document_uri.as_deref() == Some(uri)).then_some(*id))
        .collect::<Vec<_>>();
    ids.into_iter()
        .filter_map(|id| pending.remove(&id).map(|response| (id, response)))
        .collect()
}

pub(super) fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()?.try_into().ok()?,
        character: value.get("character")?.as_u64()?.try_into().ok()?,
    })
}

pub(super) fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}
