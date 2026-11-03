use serde_json::json;

use super::*;

#[test]
fn pack_start_requires_frozen_digest_identity_and_version() {
    let frozen = manifest(&["a"]);
    for (field, replacement) in [
        ("pack_id", json!("foreign")),
        ("input_digest", json!("foreign digest")),
        ("input_digest", serde_json::Value::Null),
        ("version", json!(2)),
    ] {
        let mut frame: Value = serde_json::from_str(start(&frozen).trim()).unwrap();
        frame[field] = replacement;
        let mut parser = FrameCollector::new(&frozen);
        assert!(parser.feed(&line(frame)).is_err());
        assert!(parser.drain_saved().is_empty());
    }
}

#[test]
fn source_refs_are_required_unique_known_ids_not_paths_or_untyped_values() {
    let frozen = manifest(&["a"]);
    for refs in [
        json!(["foreign"]),
        json!(["spec.md"]),
        json!(["src-1", "src-1"]),
        json!([1]),
        json!(null),
    ] {
        let mut parser = FrameCollector::new(&frozen);
        parser.feed(&start(&frozen)).unwrap();
        let mut frame = header("a");
        frame["source_refs"] = refs;
        assert!(parser.feed(&line(frame)).is_err());
    }
    let mut parser = FrameCollector::new(&frozen);
    parser.feed(&start(&frozen)).unwrap();
    let mut frame = header("a");
    frame.as_object_mut().unwrap().remove("source_refs");
    assert!(parser.feed(&line(frame)).is_err());
    let mut parser = FrameCollector::new(&frozen);
    parser.feed(&start(&frozen)).unwrap();
    let mut frame = header("a");
    frame["source_refs"] = json!([]);
    parser.feed(&line(frame)).unwrap();
}

#[test]
fn duplicate_start_item_group_and_pack_are_rejected_without_duplicate_candidates() {
    let frozen = manifest(&["a"]);
    for input in [
        [start(&frozen), start(&frozen)].concat(),
        [start(&frozen), item("a", "first"), item("a", "duplicate")].concat(),
        [
            start(&frozen),
            item("a", "first"),
            line(json!({"type":"group_end","group_id":"g1","item_ids":["a"]})),
            line(json!({"type":"group_end","group_id":"g1","item_ids":["a"]})),
        ]
        .concat(),
        [
            complete(&frozen),
            line(json!({"type":"pack_end","item_ids":["a"],"blocked_ids":[]})),
        ]
        .concat(),
    ] {
        let mut parser = FrameCollector::new(&frozen);
        assert!(parser.feed(&input).is_err());
        assert!(parser.drain_saved().len() <= 1);
        assert!(parser.finish().is_err());
    }
}

#[test]
fn terminal_sets_must_cover_exact_unique_completed_members() {
    let frozen = manifest(&["a", "b"]);
    for ids in [
        json!(["a"]),
        json!(["a", "a"]),
        json!(["a", "foreign"]),
        json!(["a", 1]),
        json!(["a", "b", "foreign"]),
    ] {
        let mut parser = FrameCollector::new(&frozen);
        parser
            .feed(&[start(&frozen), item("a", "one"), item("b", "two")].concat())
            .unwrap();
        assert!(
            parser
                .feed(&line(
                    json!({"type":"group_end","group_id":"g1","item_ids":ids})
                ))
                .is_err()
        );
        assert_eq!(parser.drain_saved().len(), 2);
    }
    let mut parser = FrameCollector::new(&frozen);
    parser
        .feed(&[start(&frozen), item("a", "one")].concat())
        .unwrap();
    assert!(
        parser
            .feed(&line(
                json!({"type":"group_end","group_id":"g1","item_ids":["a","b"]})
            ))
            .is_err()
    );
}

#[test]
fn repeated_terminal_identity_fields_cannot_contradict_the_manifest() {
    let frozen = manifest(&["a"]);
    for (field, replacement) in [
        ("pack_id", json!("foreign")),
        ("input_digest", json!("foreign")),
        ("group_id", json!("g2")),
        ("expected_ids", json!(["foreign"])),
        ("source_ids", json!(["foreign"])),
        ("publication_groups", json!(["g1", "g2"])),
    ] {
        let mut parser = FrameCollector::new(&frozen);
        parser
            .feed(
                &[
                    start(&frozen),
                    item("a", "one"),
                    line(json!({"type":"group_end","group_id":"g1","item_ids":["a"]})),
                ]
                .concat(),
            )
            .unwrap();
        let mut terminal = json!({"type":"pack_end","item_ids":["a"],"blocked_ids":[]});
        terminal[field] = replacement;
        assert!(parser.feed(&line(terminal)).is_err());
        assert_eq!(parser.drain_saved().len(), 1);
    }
}

#[test]
fn no_item_after_group_end_and_no_blocked_or_missing_pack_manifest() {
    let frozen = manifest(&["a"]);
    let prefix = [
        start(&frozen),
        item("a", "one"),
        line(json!({"type":"group_end","group_id":"g1","item_ids":["a"]})),
    ]
    .concat();
    for invalid in [
        header("a"),
        json!({"type":"pack_end","item_ids":["a"],"blocked_ids":["blocked"]}),
        json!({"type":"pack_end","item_ids":["a"]}),
        json!({"type":"pack_end","item_ids":["a","a"],"blocked_ids":[]}),
    ] {
        let mut parser = FrameCollector::new(&frozen);
        parser.feed(&prefix).unwrap();
        assert!(parser.feed(&line(invalid)).is_err());
    }
}
