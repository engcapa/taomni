//! The input for invitation replies and read receipts sent by the Mail host.

use serde::{Deserialize, Serialize};

use crate::calendar::MailInvite;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponseRequest {
    pub email_address: String,
    pub display_name: Option<String>,
    pub stamp: i64,
    pub response: MailResponse,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MailResponse {
    Invitation {
        invite: Box<MailInvite>,
        response: String,
    },
    Receipt(Receipt),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub uid: u32,
    pub message_id: Option<String>,
    pub subject: String,
    pub recipient: String,
    pub automatic: bool,
}
