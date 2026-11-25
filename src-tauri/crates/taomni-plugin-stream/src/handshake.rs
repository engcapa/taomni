use subtle::ConstantTimeEq;
use tokio_tungstenite::tungstenite::{
    handshake::server::{Callback, ErrorResponse, Request, Response},
    http::{HeaderValue, StatusCode},
    protocol::WebSocketConfig,
};

use crate::CHUNK_BYTES;

pub(crate) fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(CHUNK_BYTES))
        .max_frame_size(Some(CHUNK_BYTES))
        .write_buffer_size(0)
        .max_write_buffer_size(CHUNK_BYTES * 2)
}

pub(crate) struct Authorization<'a> {
    pub authority: &'a str,
    pub path: &'a str,
    pub bearer: &'a HeaderValue,
}

impl Callback for Authorization<'_> {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        let headers = request.headers();
        let authorized = request.uri().path_and_query().is_some_and(|uri| uri.as_str() == self.path)
            && headers.get_all("host").iter().count() == 1
            && headers.get("host").is_some_and(|value| value == self.authority)
            && headers.get_all("authorization").iter().count() == 1
            && headers.get("authorization").is_some_and(|value| {
                bool::from(value.as_bytes().ct_eq(self.bearer.as_bytes()))
            })
            // Native peers have no Origin. Never expose a bearer stream to WebViews.
            && !headers.contains_key("origin");
        if authorized {
            Ok(response)
        } else {
            let mut rejected =
                ErrorResponse::new(Some("Binary stream authorization rejected".into()));
            *rejected.status_mut() = StatusCode::FORBIDDEN;
            Err(rejected)
        }
    }
}
