//! A single POP3 synchronization session on a core-authorized route.

use serde::{Deserialize, Serialize};
use taomni_plugin_stream::routed_tcp::Endpoint;

use crate::IncomingTest;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pop3Exchange {
    pub connection: IncomingTest,
    pub exchange: Endpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Pop3Command {
    Uidl,
    Retrieve { number: u32 },
    Delete { number: u32 },
    Quit,
}
