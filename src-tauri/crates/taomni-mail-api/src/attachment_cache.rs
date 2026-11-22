use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentKey {
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub part: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentCacheRequest {
    pub key: AttachmentKey,
    pub exchange: Endpoint,
    /// A read returns the size or a cache miss. A write publishes exactly
    /// this many bytes after the sender closes its half of the stream.
    pub write_size: Option<u64>,
}
