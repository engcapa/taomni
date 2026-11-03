//! Independent, text-only, one-shot protocol invocation. Existing LLM providers
//! are deliberately not used or modified. Callbacks contain candidate visible
//! text: publish it only after validating the final receipt's status.
//!
//! The caller supplies proxy/deadline policy through the client and must disable
//! client retries and redirects (especially cross-origin x-api-key forwarding).
//! This module never retries, reconnects, changes models, or executes tools.

mod chat;
mod decoder;
mod messages;
mod receipt;
mod request;
mod responses;
mod sse;

pub use receipt::{InvocationReceipt, InvocationStatus, InvocationUsage};
pub use request::{InvocationProtocol, InvocationRequest};

use futures::StreamExt;
use tokio_util::sync::CancellationToken;

use decoder::Decoder;
use sse::SseDecoder;

/// Execute exactly one streamed generation, or decode a JSON response if the
/// server explicitly returns a JSON content type. Cancellation drops the local
/// request/stream; it does not claim remote generation or billing has stopped.
/// All errors intentionally exclude URLs, headers and provider-supplied bodies.
pub async fn invoke_stream(
    client: reqwest::Client,
    req: InvocationRequest,
    cancel: CancellationToken,
    mut on_text: impl FnMut(&str) + Send,
) -> Result<InvocationReceipt, String> {
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    let request = request::build(&client, &req)?;
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        response = client.execute(request) => response.map_err(|_| "Invocation HTTP request failed")?,
    };
    if !response.status().is_success() {
        return Err(http_failure(response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut decoder = Decoder::new(req.protocol, req.model);
    if content_type == "application/json" || content_type.ends_with("+json") {
        let bytes = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled()),
            bytes = response.bytes() => bytes.map_err(|_| "Invocation JSON response was interrupted")?,
        };
        let value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON in invocation response")?;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        decoder.json(&value, &mut on_text)?;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        return decoder.finish();
    }
    if content_type != "text/event-stream" {
        return Err("Invocation expected text/event-stream or application/json".into());
    }
    let mut stream = response.bytes_stream();
    let mut sse = SseDecoder::default();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else {
            sse.finish()?;
            return decoder.finish();
        };
        let chunk = chunk.map_err(|_| "Invocation response stream was interrupted")?;
        for event in sse.push(&chunk)? {
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            decoder.event(event, &mut on_text)?;
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            if decoder.is_terminal() {
                return decoder.finish();
            }
        }
    }
}

fn cancelled() -> String {
    "Invocation cancelled".into()
}

fn http_failure(status: reqwest::StatusCode) -> String {
    // Never surface the response body: gateways may echo the authentication key.
    format!("Invocation HTTP failure ({})", status.as_u16())
}

#[cfg(test)]
mod tests;
