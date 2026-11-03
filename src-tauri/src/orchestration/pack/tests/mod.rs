mod binding;
mod framing;

use serde_json::{Value, json};

use super::{FrameCollector, PackManifest};
use crate::orchestration::core::model::{AgentSource, digest};

fn manifest(ids: &[&str]) -> PackManifest {
    PackManifest::new(
        "run",
        "goal",
        &[AgentSource {
            id: "src-1".into(),
            path: "spec.md".into(),
            content: "source evidence".into(),
            hash: digest(b"source evidence"),
        }],
        &ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>(),
    )
    .unwrap()
}

fn line(value: Value) -> String {
    format!("{value}\n")
}

fn start(manifest: &PackManifest) -> String {
    line(
        json!({"type":"pack_start","version":1,"pack_id":manifest.pack_id(),"input_digest":manifest.input_digest()}),
    )
}

fn header(id: &str) -> Value {
    json!({"type":"item_header","item_id":id,"group_id":"g1","source_refs":["src-1"],"format":"markdown","name":"document"})
}

fn item(id: &str, text: &str) -> String {
    [
        line(header(id)),
        line(json!({"type":"item_chunk","item_id":id,"seq":0,"text":text})),
        line(json!({"type":"item_end","item_id":id,"chunk_count":1,"status":"candidate"})),
    ]
    .concat()
}

fn ending(ids: &[&str]) -> String {
    [
        line(json!({"type":"group_end","group_id":"g1","item_ids":ids})),
        line(json!({"type":"pack_end","item_ids":ids,"blocked_ids":[]})),
    ]
    .concat()
}

fn complete(manifest: &PackManifest) -> String {
    let mut input = start(manifest);
    for id in manifest.expected_ids() {
        input.push_str(&item(id, "中文🌍\nbody"));
    }
    input.push_str(&ending(
        &manifest
            .expected_ids()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
    ));
    input
}
