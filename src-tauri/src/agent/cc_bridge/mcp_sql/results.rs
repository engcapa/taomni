use super::formatting::text;
use super::parameters::ReadResultParams;
use crate::agent::capture::reduce::ReduceOp;
use crate::agent::capture::reduce::ReduceResult;

/// Managed directory captured results are exported into — the user's Downloads
/// dir (falling back to the system temp dir), never a path CC chooses. Created
/// on demand.
pub(super) fn exports_dir() -> std::path::PathBuf {
    let base = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    base.join("taomni-exports")
}

/// Map `read_result` params onto a reduction op (line-oriented over the CSV
/// capture). No `jq` — the capture is CSV, not JSON.
pub(super) fn parse_read_op(p: &ReadResultParams) -> Result<ReduceOp, String> {
    match p.op.as_str() {
        "head" => Ok(ReduceOp::Head {
            n: p.n.unwrap_or(50) as usize,
        }),
        "tail" => Ok(ReduceOp::Tail {
            n: p.n.unwrap_or(50) as usize,
        }),
        "range" => {
            let start = p.start.ok_or("range requires `start`")? as usize;
            let end = p.end.ok_or("range requires `end`")? as usize;
            Ok(ReduceOp::Range { start, end })
        }
        "grep" => Ok(ReduceOp::Grep {
            pattern: p.pattern.clone().ok_or("grep requires `pattern`")?,
            context: p.context.unwrap_or(0) as usize,
        }),
        "stats" => Ok(ReduceOp::Stats),
        other => Err(format!(
            "unknown op '{other}' (expected head|tail|range|grep|stats)"
        )),
    }
}

/// Append a reduction's note / truncation receipt to its text.
pub(super) fn annotate(r: ReduceResult) -> String {
    let mut text = r.text;
    if let Some(note) = r.note {
        text.push_str(&format!("\n[{note}]"));
    }
    if r.truncated {
        text.push_str("\n[output clipped by read_result cap — narrow with grep/range]");
    }
    text
}

pub(super) fn selected_object_value(
    object: &crate::agent::context::AgentDbSelectedObject,
) -> serde_json::Value {
    serde_json::json!({
        "catalog": object.catalog.clone(),
        "schema": object.schema.clone(),
        "name": object.name.clone(),
        "kind": object.kind.clone(),
        "displayName": object.display_name(),
        "isSelectable": object.is_selectable(),
    })
}
