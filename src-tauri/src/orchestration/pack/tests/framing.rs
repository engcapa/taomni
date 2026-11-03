use super::*;

#[test]
fn arbitrary_utf8_byte_boundaries_preserve_complete_candidates_and_digest() {
    let frozen = manifest(&["a", "b"]);
    let input = complete(&frozen);
    for split in 0..=input.len() {
        let mut parser = FrameCollector::new(&frozen);
        parser.feed_bytes(&input.as_bytes()[..split]).unwrap();
        parser.feed_bytes(&input.as_bytes()[split..]).unwrap();
        parser.finish().unwrap();
        let saved = parser.drain_saved();
        assert_eq!(saved.len(), 2, "split {split}");
        assert_eq!(saved[0].content, "中文🌍\nbody");
        assert_eq!(saved[0].hash, digest(saved[0].content.as_bytes()));
        assert_eq!(saved[1].item_id, "b");
        assert!(parser.drain_saved().is_empty());
    }
}

#[test]
fn one_byte_chunks_and_final_record_without_newline_work() {
    let frozen = manifest(&["a"]);
    let input = complete(&frozen);
    let mut parser = FrameCollector::new(&frozen);
    for byte in input.trim_end_matches('\n').as_bytes() {
        parser.feed_bytes(&[*byte]).unwrap();
    }
    parser.finish().unwrap();
    assert_eq!(parser.drain_saved().len(), 1);
    parser.finish().unwrap();
    assert!(parser.drain_saved().is_empty());
}

#[test]
fn earlier_candidate_survives_later_malformed_record_in_same_chunk() {
    let frozen = manifest(&["a", "b"]);
    let mut parser = FrameCollector::new(&frozen);
    let input = [
        start(&frozen),
        item("a", "safe prefix"),
        "not-json\n".into(),
        item("b", "must not be reached"),
    ]
    .concat();
    let error = parser.feed(&input).unwrap_err();
    let saved = parser.drain_saved();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].content, "safe prefix");
    assert_eq!(saved[0].status, "candidate");
    assert_eq!(parser.feed(&item("b", "later")).unwrap_err(), error);
    assert_eq!(parser.finish().unwrap_err(), error);
    assert!(parser.drain_saved().is_empty());
}

#[test]
fn earlier_candidate_survives_truncated_later_item_in_same_chunk() {
    let frozen = manifest(&["a", "b"]);
    let mut parser = FrameCollector::new(&frozen);
    parser
        .feed(
            &[
                start(&frozen),
                item("a", "safe prefix"),
                "{\"type\":\"item_header\"".into(),
            ]
            .concat(),
        )
        .unwrap();
    assert!(parser.finish().is_err());
    let saved = parser.drain_saved();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].item_id, "a");
}

#[test]
fn earlier_candidate_survives_invalid_utf8_later_record() {
    let frozen = manifest(&["a", "b"]);
    let mut input = [start(&frozen), item("a", "safe prefix")]
        .concat()
        .into_bytes();
    input.extend_from_slice(b"{\"bad\":\"\xff\"}\n");
    let mut parser = FrameCollector::new(&frozen);
    assert!(parser.feed_bytes(&input).unwrap_err().contains("UTF-8"));
    assert_eq!(parser.drain_saved().len(), 1);
}

#[test]
fn completed_prefix_survives_later_oversized_record_and_missing_pack_end() {
    let frozen = manifest(&["a", "b"]);
    let mut input = [start(&frozen), item("a", "safe prefix")].concat();
    input.push_str(&"x".repeat(super::super::MAX_RECORD + 1));
    let mut parser = FrameCollector::new(&frozen);
    assert!(parser.feed(&input).unwrap_err().contains("FRAME_LIMIT"));
    assert_eq!(parser.drain_saved().len(), 1);
    let mut parser = FrameCollector::new(&frozen);
    parser
        .feed(&[start(&frozen), item("a", "safe prefix")].concat())
        .unwrap();
    assert!(parser.finish().unwrap_err().contains("INCOMPLETE_PACK"));
    assert_eq!(parser.drain_saved().len(), 1);
}

#[test]
fn extra_terminal_after_valid_pack_in_same_chunk_fails_without_losing_candidates() {
    let frozen = manifest(&["a"]);
    let mut parser = FrameCollector::new(&frozen);
    let input = [
        complete(&frozen),
        line(serde_json::json!({"type":"pack_end","item_ids":["a"],"blocked_ids":[]})),
    ]
    .concat();
    assert!(parser.feed(&input).unwrap_err().contains("after pack end"));
    assert_eq!(parser.drain_saved().len(), 1);
    assert!(parser.finish().is_err());
}
