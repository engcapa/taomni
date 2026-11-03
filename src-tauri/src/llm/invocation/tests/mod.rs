mod chat;
mod messages;
mod request;
mod responses;
mod sse;

use serde_json::Value;

use super::decoder::Decoder;
use super::sse::{Event, SseDecoder};
use super::{InvocationProtocol, InvocationReceipt, InvocationRequest};

fn request(protocol: InvocationProtocol) -> InvocationRequest {
    InvocationRequest {
        protocol,
        base_url: "https://example.test/v1".into(),
        model: "requested-model".into(),
        api_key: "secret-never-print".into(),
        max_output_tokens: 4096,
        system: "Trusted instructions".into(),
        prompt: "User input".into(),
    }
}

fn event(kind: &str, value: Value) -> Event {
    Event {
        kind: kind.into(),
        data: value.to_string(),
    }
}

fn wire(kind: &str, value: Value) -> String {
    format!("event: {kind}\ndata: {value}\n\n")
}

fn decode_chunks(
    protocol: InvocationProtocol,
    input: &[u8],
    chunk_size: usize,
) -> Result<(String, InvocationReceipt), String> {
    let mut sse = SseDecoder::default();
    let mut decoder = Decoder::new(protocol, "requested-model".into());
    let mut output = String::new();
    for chunk in input.chunks(chunk_size) {
        for event in sse.push(chunk)? {
            decoder.event(event, &mut |s| output.push_str(s))?;
        }
    }
    sse.finish()?;
    Ok((output, decoder.finish()?))
}

fn json_response(
    protocol: InvocationProtocol,
    value: Value,
) -> Result<(String, InvocationReceipt), String> {
    let mut decoder = Decoder::new(protocol, "requested-model".into());
    let mut text = String::new();
    decoder.json(&value, &mut |s| text.push_str(s))?;
    Ok((text, decoder.finish()?))
}
