//! Preserve complete candidate tails without converting provider failure to success.
use crate::llm::invocation::{InvocationReceipt, InvocationStatus};
use crate::orchestration::{core::model::AgentArtifact, pack::FrameCollector};

pub(super) struct CollectionOutcome {
    pub candidates: Vec<AgentArtifact>,
    pub result: Result<(), String>,
}

pub(super) fn finish(
    collector: &mut FrameCollector,
    receipt: Result<InvocationReceipt, String>,
    user_cancelled: bool,
) -> CollectionOutcome {
    if user_cancelled {
        // No late publication after a human stop. Previously persisted items
        // remain visible; buffered output does not acquire publication rights.
        collector.drain_saved();
        return CollectionOutcome {
            candidates: Vec::new(),
            result: Err("CANCELLED".into()),
        };
    }
    // finish() validates a no-LF final JSON record before checking pack_end.
    // Always drain even on Err so item_end survives an incomplete provider stop.
    let pack_result = collector.finish();
    let candidates = collector.drain_saved();
    let provider_result = receipt.and_then(|receipt| {
        if receipt.status == InvocationStatus::Complete {
            Ok(())
        } else {
            Err(format!(
                "INCOMPLETE_PACK: provider stopped with {}",
                receipt.stop_reason
            ))
        }
    });
    CollectionOutcome {
        candidates,
        result: provider_result.and(pack_result),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::invocation::InvocationStatus;
    use crate::orchestration::pack::PackManifest;
    use serde_json::json;

    fn collector(tail: &str) -> FrameCollector {
        let manifest = PackManifest::new("run", "goal", &[], &["review".into()]).unwrap();
        let mut parser = FrameCollector::new(&manifest);
        let frames = [
            json!({"type":"pack_start","version":1,"pack_id":"run","input_digest":manifest.input_digest()}),
            json!({"type":"item_header","item_id":"review","group_id":"g1","source_refs":[],"format":"markdown"}),
            json!({"type":"item_chunk","item_id":"review","seq":0,"text":"Saved candidate"}),
        ];
        for frame in frames {
            parser.feed(&format!("{frame}\n")).unwrap();
        }
        parser.feed(tail).unwrap();
        parser
    }
    const ITEM_END: &str =
        r#"{"type":"item_end","item_id":"review","chunk_count":1,"status":"candidate"}"#;

    #[test]
    fn final_item_without_newline_survives_provider_truncation() {
        let mut parser = collector(ITEM_END);
        let receipt = InvocationReceipt {
            model: "fixture".into(),
            stop_reason: "max_tokens".into(),
            status: InvocationStatus::Truncated,
            usage: None,
        };
        let outcome = finish(&mut parser, Ok(receipt), false);
        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(outcome.candidates[0].content, "Saved candidate");
        assert!(outcome.result.unwrap_err().contains("max_tokens"));
        assert!(parser.drain_saved().is_empty());
    }
    #[test]
    fn final_item_without_newline_survives_http_stream_failure_without_hiding_error() {
        let mut parser = collector(ITEM_END);
        let outcome = finish(
            &mut parser,
            Err("protocol stream ended without terminal".into()),
            false,
        );
        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(
            outcome.result,
            Err("protocol stream ended without terminal".into())
        );
    }
    #[test]
    fn incomplete_json_tail_is_never_published() {
        let mut parser = collector("{\"type\":\"item_end\"");
        let outcome = finish(&mut parser, Err("truncated".into()), false);
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.result, Err("truncated".into()));
    }
    #[test]
    fn human_cancel_never_publishes_a_late_complete_tail() {
        let mut parser = collector(ITEM_END);
        let outcome = finish(&mut parser, Err("cancelled".into()), true);
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.result, Err("CANCELLED".into()));
    }
}
