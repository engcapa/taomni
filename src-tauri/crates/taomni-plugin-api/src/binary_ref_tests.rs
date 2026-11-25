use super::*;

fn descriptor() -> BinaryRef {
    BinaryRef {
        stream_url: "ws://127.0.0.1:43521/frame".into(),
        token: "one-time".into(),
        content_type: "image/png".into(),
        byte_len: 5,
        sha256: "0".repeat(64),
    }
}

#[test]
fn binary_stream_retains_the_existing_descriptor_wire_shape() {
    let value = descriptor();
    let wire = serde_json::json!({
        "streamUrl": "ws://127.0.0.1:43521/frame",
        "token": "one-time",
        "contentType": "image/png",
        "byteLen": 5,
        "sha256": "0".repeat(64)
    });
    assert_eq!(serde_json::to_value(&value).unwrap(), wire);
    let decoded: BinaryRef = serde_json::from_value(wire).unwrap();
    assert_eq!(decoded, value);
    assert!(decoded.validate().is_ok());
}

#[test]
fn binary_stream_requires_an_exact_loopback_authority_and_nonzero_port() {
    for url in [
        "ws://127.0.0.1:43521/frame",
        "wss://127.0.0.1:65535/frame?request=123",
        "ws://127.0.0.1:1",
    ] {
        let mut value = descriptor();
        value.stream_url = url.into();
        assert!(value.validate().is_ok(), "{url}");
    }
    for url in [
        "ws://127.0.0.1:43521@outside.invalid/frame",
        "wss://127.0.0.1:43521@127.0.0.2/frame",
        "ws://127.0.0.1:43521\\@outside.invalid/frame",
        "ws://127.0.0.1:43521%40outside.invalid/frame",
        "ws://127.0.0.1:43521.outside.invalid/frame",
        "ws://127.0.0.1:43521:99/frame",
        "ws://127.0.0.1:/frame",
        "ws://127.0.0.1:0/frame",
        "ws://127.0.0.1:65536/frame",
        "ws://127.0.0.1:-1/frame",
        "ws://127.0.0.1:+80/frame",
        "ws://127.0.0.1:80\n/frame",
        "ws://127.0.0.1:80/frame\r\nX-Header: injected",
        "ws://127.0.0.1:80/frame#fragment",
        "ws://0.0.0.0:80/frame",
        "ws://127.0.0.2:80/frame",
        "ws://localhost:80/frame",
        "ws://[::1]:80/frame",
        "http://127.0.0.1:80/frame",
    ] {
        let mut value = descriptor();
        value.stream_url = url.into();
        assert_eq!(
            value.validate().unwrap_err().code,
            ErrorCode::InvalidParams as i32,
            "{url:?}"
        );
    }
}

#[test]
fn binary_stream_requires_a_real_hex_digest_and_token() {
    let mut value = descriptor();
    value.sha256 = "0123456789aBcDeF".repeat(4);
    assert!(value.validate().is_ok());
    for digest in [
        "g".repeat(64),
        "0".repeat(63),
        "0".repeat(65),
        "é".repeat(32),
    ] {
        value.sha256 = digest;
        assert_eq!(
            value.validate().unwrap_err().code,
            ErrorCode::InvalidParams as i32
        );
    }
    value = descriptor();
    value.token.clear();
    assert_eq!(
        value.validate().unwrap_err().code,
        ErrorCode::InvalidParams as i32
    );
}
