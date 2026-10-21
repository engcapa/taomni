use super::protocol::ProtocolHeaders;
use crate::database::QueryResult;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone)]
pub struct PrestoClient {
    pub(super) client: reqwest::Client,
    pub(super) base_url: String,
    pub(super) user: String,
    pub(super) password: Option<String>,
    /// Presto (`X-Presto-*`) or Trino (`X-Trino-*`) protocol header set.
    pub(super) headers: ProtocolHeaders,
    pub(super) catalog: Arc<AsyncMutex<Option<String>>>,
    pub(super) schema: Arc<AsyncMutex<Option<String>>>,
    pub(super) current_next_uri: Arc<AsyncMutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrestoColumn {
    pub(super) name: String,
    #[serde(rename = "type")]
    pub(super) type_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrestoResults {
    #[serde(default)]
    pub(super) next_uri: Option<String>,
    #[serde(default)]
    pub(super) columns: Vec<PrestoColumn>,
    #[serde(default)]
    pub(super) data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    pub(super) update_count: Option<u64>,
    #[serde(default)]
    pub(super) error: Option<PrestoError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrestoError {
    pub(super) message: String,
    #[serde(default)]
    pub(super) error_name: Option<String>,
    #[serde(default)]
    pub(super) error_location: Option<PrestoErrorLocation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrestoErrorLocation {
    pub(super) line_number: u64,
    pub(super) column_number: u64,
}

pub(super) struct StatementOutcome {
    pub(super) result: QueryResult,
}
