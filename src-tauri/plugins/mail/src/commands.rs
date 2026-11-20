use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_mail_engine::{
    cache,
    drafts::{MailDraftSaveRequest, delete_mail_draft, list_mail_drafts_page, save_mail_draft},
};
use taomni_plugin_api::{ErrorCode, RpcError};

use super::store::{Store, unavailable};

const LIST_FOLDERS: &str = "mail_list_cached_folders";
const LIST_MESSAGES: &str = "mail_list_cached_messages";
const READ_BODY: &str = "mail_get_cached_body";
const LIST_DRAFTS: &str = "mail_list_drafts";
const SAVE_DRAFT: &str = "mail_save_draft";
const DELETE_DRAFT: &str = "mail_delete_draft";
pub(super) const METHODS: [&str; 6] = [
    LIST_FOLDERS,
    LIST_MESSAGES,
    READ_BODY,
    LIST_DRAFTS,
    SAVE_DRAFT,
    DELETE_DRAFT,
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    account_id: String,
    folder: String,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    account_id: String,
    folder: String,
    uid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftsPage {
    account_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftSave {
    account_id: String,
    draft: MailDraftSaveRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftDelete {
    account_id: String,
    draft_id: String,
}

pub(super) fn invoke(
    store: &Store,
    method: &str,
    params: Option<Value>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Value, RpcError> {
    match method {
        LIST_FOLDERS => {
            let input: Account = decode(params)?;
            let folders = store.query(&input.account_id, |db| {
                cache::list_cached_folders(db, &input.account_id)
            })?;
            encode(folders)
        }
        LIST_MESSAGES => {
            let input: Page = decode(params)?;
            let messages = store.query(&input.account_id, |db| {
                cache::list_cached_messages(
                    db,
                    &input.account_id,
                    &input.folder,
                    input.limit.unwrap_or(200).min(1000),
                    input.offset.unwrap_or(0),
                )
            })?;
            encode(messages)
        }
        READ_BODY => {
            let input: Message = decode(params)?;
            let body = store.query(&input.account_id, |db| {
                cache::get_cached_body(db, &input.account_id, &input.folder, input.uid)
            })?;
            encode(body)
        }
        LIST_DRAFTS => {
            let input: DraftsPage = decode(params)?;
            let drafts = store.query(&input.account_id, |db| {
                list_mail_drafts_page(
                    db,
                    &input.account_id,
                    input.limit.unwrap_or(50).min(100),
                    input.offset.unwrap_or(0),
                )
            })?;
            encode(drafts)
        }
        SAVE_DRAFT => {
            let input: DraftSave = decode(params)?;
            let account = input.account_id.trim();
            store.mutate(account, true, check, |db| {
                let saved = save_mail_draft(db, account, input.draft).map_err(|_| unavailable())?;
                encode(saved)
            })
        }
        DELETE_DRAFT => {
            let input: DraftDelete = decode(params)?;
            let draft_id = input.draft_id.trim();
            if draft_id.is_empty() {
                return Err(RpcError::from_code(ErrorCode::InvalidParams));
            }
            let account = input.account_id.trim();
            store.mutate(account, false, check, |db| {
                delete_mail_draft(db, account, draft_id).map_err(|_| unavailable())
            })?;
            Ok(Value::Null)
        }
        _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
    }
}

fn decode<T: DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or_default())
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))
}

fn encode(value: impl Serialize) -> Result<Value, RpcError> {
    let value = serde_json::to_value(value).map_err(|_| unavailable())?;
    // Leave room in the SDK's 4 MiB frame for the response envelope.
    if serde_json::to_vec(&value).map_err(|_| unavailable())?.len() > 4 * 1024 * 1024 - 4096 {
        return Err(RpcError::new(
            ErrorCode::InvalidState,
            "MAIL_RESULT_TOO_LARGE",
        ));
    }
    Ok(value)
}
