use super::super::sse::{Event, SseDecoder};

#[test]
fn every_byte_split_preserves_utf8_multiline_comments_and_crlf() {
    let bytes = "\u{feff}: heartbeat\r\nevent: sample\r\nid: 1\r\nretry: 0\r\ndata: {\r\ndata: \"text\":\"你好🌍\"}\r\n\r\n".as_bytes();
    let expected = vec![Event {
        kind: "sample".into(),
        data: "{\n\"text\":\"你好🌍\"}".into(),
    }];
    for split in 0..=bytes.len() {
        let mut parser = SseDecoder::default();
        let mut events = parser.push(&bytes[..split]).unwrap();
        events.extend(parser.push(&bytes[split..]).unwrap());
        parser.finish().unwrap();
        assert_eq!(events, expected, "split at {split}");
    }
}

#[test]
fn one_byte_chunks_handle_cr_and_multiple_events() {
    let mut parser = SseDecoder::default();
    let mut events = Vec::new();
    for byte in b"event: one\rdata: a\r\rdata:b\n\ndata:\n\n" {
        events.extend(parser.push(&[*byte]).unwrap());
    }
    parser.finish().unwrap();
    assert_eq!(
        events,
        vec![
            Event {
                kind: "one".into(),
                data: "a".into()
            },
            Event {
                kind: "".into(),
                data: "b".into()
            },
            Event {
                kind: "".into(),
                data: "".into()
            },
        ]
    );
}

#[test]
fn data_removes_only_one_optional_space() {
    let mut parser = SseDecoder::default();
    let events = parser.push(b"data:  leading \ndata:trail \n\n").unwrap();
    assert_eq!(events[0].data, " leading \ntrail ");
}

#[test]
fn comments_do_not_dispatch_or_inherit_event_type() {
    let mut parser = SseDecoder::default();
    assert!(parser.push(b"event: stale\n: ping\n\n").unwrap().is_empty());
    let events = parser.push(b"data: ok\n\n").unwrap();
    assert_eq!(events[0].kind, "");
}

#[test]
fn invalid_utf8_and_unterminated_frames_are_errors() {
    assert!(SseDecoder::default().push(b"data: \xff\n\n").is_err());
    for input in [b"data: x".as_slice(), b"data: x\n", b"data: \xe4\xbd"] {
        let mut parser = SseDecoder::default();
        parser.push(input).unwrap();
        assert!(parser.finish().is_err());
    }
}

#[test]
fn eof_without_any_data_is_not_synthesized_as_an_event() {
    let parser = SseDecoder::default();
    parser.finish().unwrap();
}
