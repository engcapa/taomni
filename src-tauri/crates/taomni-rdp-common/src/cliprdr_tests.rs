use super::*;

#[test]
fn header_round_trip() {
    let h = ClipHeader {
        msg_type: CB_FORMAT_LIST,
        msg_flags: CB_RESPONSE_OK,
        data_len: 42,
    };
    let buf = h.encode();
    let h2 = ClipHeader::parse(&buf).unwrap();
    assert_eq!(h, h2);
}

#[test]
fn header_parse_rejects_truncated() {
    assert!(ClipHeader::parse(&[1, 2, 3]).is_err());
}

#[test]
fn format_list_round_trip() {
    let entries = vec![
        ClipFormat {
            id: CF_UNICODETEXT,
            name: String::new(),
        },
        ClipFormat {
            id: 0x0000_C001,
            name: FORMAT_NAME_FGW.into(),
        },
        ClipFormat {
            id: 0x0000_C002,
            name: FORMAT_NAME_FCONT.into(),
        },
    ];
    let body = encode_format_list(&entries);
    let decoded = decode_format_list(&body).unwrap();
    assert_eq!(decoded, entries);
}

#[test]
fn format_list_handles_unicode_names() {
    let entries = vec![
        ClipFormat {
            id: 0x0001,
            name: "中文".into(),
        },
        ClipFormat {
            id: 0x0002,
            name: "🎉".into(),
        },
    ];
    let body = encode_format_list(&entries);
    let decoded = decode_format_list(&body).unwrap();
    assert_eq!(decoded, entries);
}

#[test]
fn caps_payload_layout() {
    let buf = build_caps_pdu(CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED, 2);
    // cCapabilitiesSets
    assert_eq!(u16::from_le_bytes([buf[0], buf[1]]), 1);
    // capabilitySetType
    assert_eq!(u16::from_le_bytes([buf[4], buf[5]]), 1);
    assert_eq!(u16::from_le_bytes([buf[6], buf[7]]), 12);
    let version = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    assert_eq!(version, 2);
    let flags = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    assert_eq!(flags, CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED);
}

#[test]
fn file_descriptor_round_trip_single() {
    let f = FileDescriptor {
        name: "report.docx".into(),
        size: 8_388_608,
        is_directory: false,
        attributes: FILE_ATTRIBUTE_NORMAL,
    };
    let body = encode_file_group(std::slice::from_ref(&f)).unwrap();
    let parsed = decode_file_group(&body).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].name, "report.docx");
    assert_eq!(parsed[0].size, 8_388_608);
    assert!(!parsed[0].is_directory);
}

#[test]
fn file_descriptor_round_trip_multi_with_directory() {
    let files = vec![
        FileDescriptor {
            name: "src".into(),
            size: 0,
            is_directory: true,
            attributes: FILE_ATTRIBUTE_DIRECTORY,
        },
        FileDescriptor {
            name: "Cargo.lock".into(),
            size: 654_321,
            is_directory: false,
            attributes: FILE_ATTRIBUTE_NORMAL,
        },
    ];
    let body = encode_file_group(&files).unwrap();
    let parsed = decode_file_group(&body).unwrap();
    assert_eq!(parsed, files);
}

#[test]
fn file_descriptor_handles_long_unicode_name() {
    // 100 CJK characters fits within the 260 UTF-16 unit cap.
    let name: String = std::iter::repeat('日').take(100).collect();
    let f = FileDescriptor {
        name: name.clone(),
        size: 1024,
        is_directory: false,
        attributes: FILE_ATTRIBUTE_NORMAL,
    };
    let body = encode_file_group(std::slice::from_ref(&f)).unwrap();
    let parsed = decode_file_group(&body).unwrap();
    assert_eq!(parsed[0].name, name);
}

#[test]
fn file_descriptor_rejects_oversize_name() {
    let name: String = std::iter::repeat('A').take(260).collect();
    let f = FileDescriptor {
        name,
        size: 0,
        is_directory: false,
        attributes: FILE_ATTRIBUTE_NORMAL,
    };
    assert!(encode_file_group(std::slice::from_ref(&f)).is_err());
}

#[test]
fn decode_rejects_truncated_group() {
    let mut body = vec![3, 0, 0, 0]; // claim 3 entries
    body.extend_from_slice(&[0; FILE_DESCRIPTOR_BYTES]); // only one
    assert!(decode_file_group(&body).is_err());
}

#[test]
fn file_contents_request_round_trip_with_clip_id() {
    let req = FileContentsRequest {
        stream_id: 0x1234_5678,
        list_index: 7,
        flags: FILECONTENTS_RANGE,
        position: 0x1_0000_0001,
        cb_requested: 65_536,
        clip_data_id: Some(42),
    };
    let buf = encode_file_contents_request(&req);
    let parsed = decode_file_contents_request(&buf).unwrap();
    assert_eq!(parsed, req);
}

#[test]
fn file_contents_request_optional_clip_id() {
    let req = FileContentsRequest {
        stream_id: 1,
        list_index: 0,
        flags: FILECONTENTS_SIZE,
        position: 0,
        cb_requested: 8,
        clip_data_id: None,
    };
    let buf = encode_file_contents_request(&req);
    let parsed = decode_file_contents_request(&buf).unwrap();
    assert_eq!(parsed, req);
}

#[test]
fn file_contents_response_layout() {
    let r = encode_file_contents_response(99, &[1, 2, 3, 4]);
    assert_eq!(r[0..4], 99u32.to_le_bytes());
    assert_eq!(&r[4..], &[1, 2, 3, 4]);
}
