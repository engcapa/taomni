use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use taomni_mail_engine::{
    MailMessageBody, cache,
    contacts::{self, ContactWriteError, MailAddressBookEntry},
    drafts::{MailDraftSaveRequest, delete_mail_draft, list_mail_drafts_page, save_mail_draft},
    parse_body_message,
    pop3::local_store::read_local_raw,
    storage,
};
use taomni_plugin_api::{ErrorCode, RpcError};

use super::store::{Store, unavailable};

const LIST_FOLDERS: &str = "mail_list_cached_folders";
const LIST_MESSAGES: &str = "mail_list_cached_messages";
const READ_BODY: &str = "mail_get_cached_body";
const LIST_DRAFTS: &str = "mail_list_drafts";
const SAVE_DRAFT: &str = "mail_save_draft";
const DELETE_DRAFT: &str = "mail_delete_draft";
const LIST_CONTACTS: &str = "mail_list_address_book";
const SAVE_CONTACT: &str = "mail_save_address_book_entry";
const DELETE_CONTACT: &str = "mail_delete_address_book_entry";
const SEARCH_CONTACTS: &str = "mail_search_contacts";
pub(super) const METHODS: [&str; 12] = [
    taomni_mail_api::INITIALIZE_IMAP_MAILBOX,
    taomni_mail_api::IMAP_MAILBOX_OWNER,
    LIST_FOLDERS,
    LIST_MESSAGES,
    READ_BODY,
    LIST_DRAFTS,
    SAVE_DRAFT,
    DELETE_DRAFT,
    LIST_CONTACTS,
    SAVE_CONTACT,
    DELETE_CONTACT,
    SEARCH_CONTACTS,
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
struct AccountPage {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveContact {
    account_id: String,
    entry: MailAddressBookEntry,
    #[serde(default)]
    carddav: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteContact {
    account_id: String,
    uid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactSearch {
    account_id: String,
    query: String,
    limit: Option<u32>,
}

enum SavedBody {
    Archive(storage::OpenMessage),
    Cached(MailMessageBody),
    LocalOriginal(Vec<u8>),
}

pub(super) fn invoke(
    store: &Store,
    method: &str,
    params: Option<Value>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Value, RpcError> {
    match method {
        taomni_mail_api::INITIALIZE_IMAP_MAILBOX => {
            let input: Account = decode(params)?;
            encode(super::imap_initialization::initialize(
                store,
                &input.account_id,
                check,
            )?)
        }
        taomni_mail_api::IMAP_MAILBOX_OWNER => {
            let input: Account = decode(params)?;
            encode(store.owns_imap_cache(&input.account_id)?)
        }
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
            encode(read_body(store, &input, check)?)
        }
        LIST_DRAFTS => {
            let input: AccountPage = decode(params)?;
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
        LIST_CONTACTS => {
            let input: AccountPage = decode(params)?;
            let entries = store.query(&input.account_id, |db| {
                contacts::list_entries_page(
                    db,
                    &input.account_id,
                    input.limit.unwrap_or(100).clamp(1, 500),
                    input.offset.unwrap_or(0),
                )
            })?;
            encode(entries)
        }
        SAVE_CONTACT => {
            let input: SaveContact = decode(params)?;
            let default_book = if input.carddav { "carddav" } else { "local" };
            store.mutate(&input.account_id, true, check, |db| {
                let saved = contacts::save_entry(db, &input.account_id, input.entry, default_book)
                    .map_err(|error| match error {
                        ContactWriteError::InvalidEntry(message) => {
                            RpcError::new(ErrorCode::InvalidParams, message)
                        }
                        ContactWriteError::Database(_) => unavailable(),
                    })?;
                encode(saved)
            })
        }
        DELETE_CONTACT => {
            let input: DeleteContact = decode(params)?;
            let removed = store.mutate(&input.account_id, false, check, |db| {
                contacts::delete_entry(db, &input.account_id, input.uid.trim())
                    .map_err(|_| unavailable())
            })?;
            encode(removed)
        }
        SEARCH_CONTACTS => {
            let input: ContactSearch = decode(params)?;
            let entries = store.query(&input.account_id, |db| {
                contacts::search_recipient_suggestions(
                    db,
                    &input.account_id,
                    &input.query,
                    input.limit.unwrap_or(8).clamp(1, 20),
                )
            })?;
            encode(entries)
        }
        _ => Err(RpcError::from_code(ErrorCode::MethodNotFound)),
    }
}

fn read_body(
    store: &Store,
    message: &Message,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Option<MailMessageBody>, RpcError> {
    let Message {
        account_id,
        folder,
        uid,
    } = message;
    let body = store.query(account_id, |db| {
        if let Some(original) = storage::open_with(db, account_id, folder, *uid, |path| {
            store.open_owned_file(path).map_err(|error| error.message)
        })
        .map_err(storage::as_sql_error)?
        {
            return Ok(Some(SavedBody::Archive(original)));
        }
        if let Some(cached) = cache::get_cached_body(db, account_id, folder, *uid)? {
            return Ok(Some(SavedBody::Cached(cached)));
        }
        Ok(read_local_raw(db, account_id, folder, *uid)?.map(SavedBody::LocalOriginal))
    })?;
    let (raw, source, parse_limit, cached_at) = match body {
        None => return Ok(None),
        Some(SavedBody::Cached(body)) => return Ok(Some(body)),
        Some(SavedBody::Archive(original)) => {
            let stored_at = original.stored_at;
            let raw = original.read_with(|| check().map_err(|error| error.message));
            check()?;
            let raw = raw.map_err(|_| unavailable())?;
            let limit = raw.len();
            (raw, "archive", limit, Some(stored_at))
        }
        Some(SavedBody::LocalOriginal(raw)) => (raw, "cache", 8 * 1024 * 1024, None),
    };
    check()?;
    let mut message = parse_body_message(
        account_id,
        folder,
        *uid,
        Some(raw.len() as u32),
        &raw,
        parse_limit,
    );
    message.body_cached_at = cached_at;
    check()?;
    Ok(Some(cache::cached_to_body(message, source)))
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
