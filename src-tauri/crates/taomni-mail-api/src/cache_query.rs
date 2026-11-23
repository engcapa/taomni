//! Read a single account cache through the signed Mail host.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{pop3_store::LocalMailboxAction, search::MailSearchQuery};

pub const QUERY_ACCOUNT_CACHE: &str = "mail/query-account-cache";
pub const MAX_CACHE_QUERY_BYTES: u64 = 1024 * 1024;
pub const MAX_CACHE_REPLY_BYTES: u64 = taomni_plugin_stream::MAX_PAYLOAD_BYTES as u64;
pub const MAX_CACHED_MESSAGE_PAGE: u32 = 1_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheQueryRequest {
    pub account_id: String,
    pub database: PathBuf,
    pub query: CacheQuery,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum CacheQuery {
    Folders,
    Messages {
        folder: String,
        limit: u32,
        offset: u32,
    },
    Search(MailSearchQuery),
}

impl From<CacheQuery> for LocalMailboxAction {
    fn from(query: CacheQuery) -> Self {
        match query {
            CacheQuery::Folders => Self::Folders,
            CacheQuery::Messages {
                folder,
                limit,
                offset,
            } => Self::Messages {
                folder,
                limit,
                offset,
            },
            CacheQuery::Search(query) => Self::Search(query),
        }
    }
}
