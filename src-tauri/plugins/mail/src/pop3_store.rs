//! Read and mutate the local mailbox through the verified host's account store.

mod archive;
pub(super) mod index;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use taomni_mail_api::{
    MailIncomingProtocol, MailboxRequest,
    imap_exchange::write_body_frame,
    pop3_exchange::{Pop3SyncOutcome, read_ledger_message, write_ledger_message},
    pop3_store::{LocalMailboxAction, OwnedPop3Round},
};
use taomni_mail_engine::{
    cache::{
        cached_header, list_cached_messages, reindex_cached_contacts, search_contacts,
        upsert_sent_contacts,
    },
    filters::{ensure_filter_mark, set_filter_mark},
    pop3::{local_store, sqlite_ledger, sync_inbox},
    search::search_cached_messages,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    incoming::{open_pop3, while_current, with_socket},
    store::{Store, unavailable},
};

pub(super) fn round(
    runtime: &Runtime,
    operation: &Operation,
    store: Arc<Store>,
    request: OwnedPop3Round,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Pop3 {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (mut peer, _) = match runtime.block_on(while_current(operation, request.reply.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let account = request.account_id;
    store.require_pop3_owner(&account)?;
    let check = || operation.check_current();
    store.mutate(&account, true, &check, |db| {
        local_store::ensure_local_folders(db, &account).map_err(|_| unavailable())
    })?;
    let outcome: Result<Pop3SyncOutcome, String> = with_socket(
        runtime,
        operation,
        request.connection,
        move |stream, input| {
            let mut client = open_pop3(stream, &input)?;
            let ledger = sqlite_ledger(
                || {
                    store
                        .open_writable_mailbox(&account)
                        .map(Box::new)
                        .map_err(|e| e.message)
                },
                &account,
            );
            sync_inbox(&mut client, &ledger, request.leave_days)
        },
    )?;
    runtime
        .block_on(while_current(
            operation,
            write_ledger_message(&mut peer, &outcome),
        ))?
        .map_err(|_| unavailable())?;
    Ok(Ok(()))
}

pub(super) fn serve(
    runtime: &Runtime,
    operation: &Operation,
    store: &Store,
    endpoint: Endpoint,
) -> Result<Result<(), String>, RpcError> {
    let (mut peer, _) = match runtime.block_on(while_current(operation, endpoint.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    let request = runtime
        .block_on(while_current(
            operation,
            read_ledger_message::<MailboxRequest<LocalMailboxAction>>(&mut peer),
        ))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    if let LocalMailboxAction::Archive(taomni_mail_api::pop3_store::LocalArchiveAction::Export {
        entry,
        attachment_index,
    }) = &request.action
    {
        return archive::export(
            runtime,
            operation,
            store,
            &request.account_id,
            entry,
            *attachment_index,
            &mut peer,
        );
    }
    let bytes = execute(store, request, &|| operation.check_current())?;
    runtime
        .block_on(while_current(
            operation,
            write_body_frame(&mut peer, &bytes),
        ))?
        .map_err(|_| unavailable())?;
    Ok(Ok(()))
}

fn execute(
    store: &Store,
    request: MailboxRequest<LocalMailboxAction>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    use LocalMailboxAction::*;

    let account = request.account_id.as_str();
    if !matches!(&request.action, Initialize) {
        store.require_pop3_owner(account)?;
    }
    match request.action {
        Initialize => {
            store.mutate(account, true, check, |db| {
                local_store::ensure_local_folders(db, account).map_err(|_| unavailable())
            })?;
            check()?;
            let directory = store.pop3_data(account)?;
            taomni_mail_engine::pop3::ownership::mark_owned(&directory, account)
                .map_err(|_| unavailable())?;
            encode(&())
        }
        Messages {
            folder,
            limit,
            offset,
        } => encode(&store.query(account, |db| {
            list_cached_messages(db, account, &folder, limit, offset)
        })?),
        Body { folder, uid } => encode(&store.query(account, |db| {
            local_store::local_body(db, account, &folder, uid)
        })?),
        Raw { folder, uid } => encode(&store.query(account, |db| {
            local_store::local_raw(db, account, &folder, uid)
        })?),
        Header { folder, uid } => {
            encode(&store.query(account, |db| cached_header(db, account, &folder, uid))?)
        }
        Search(query) => {
            encode(&store.query(account, |db| search_cached_messages(db, account, &query))?)
        }
        SearchContacts { query, limit } => {
            encode(&store.query(account, |db| search_contacts(db, account, &query, limit))?)
        }
        SearchIndex { bodies } => {
            encode(&store.query(account, |db| index::search_rows(db, account, bodies))?)
        }
        Archive(action) => archive::execute(store, account, action, check),
        Delete { folder, uids } => {
            let db = store.open_writable_mailbox(account)?;
            taomni_mail_engine::storage::query::complete_pending_attachment_backfill(&db)
                .map_err(|_| unavailable())?;
            encode(
                &local_store::delete_local(&db, account, &folder, uids.as_deref())
                    .map_err(|_| unavailable())?,
            )
        }
        DeleteFolder { name } => {
            if name.eq_ignore_ascii_case("INBOX") {
                return Err(RpcError::new(
                    ErrorCode::InvalidParams,
                    "the local INBOX cannot be deleted",
                ));
            }
            let db = store.open_writable_mailbox(account)?;
            taomni_mail_engine::storage::query::complete_pending_attachment_backfill(&db)
                .map_err(|_| unavailable())?;
            local_store::delete_local_folder(&db, account, &name).map_err(|_| unavailable())?;
            encode(&local_store::list_local_folders(&db, account).map_err(|_| unavailable())?)
        }
        Originals { folder } => encode(&store.query(account, |db| {
            local_store::list_local_originals(db, account, &folder)
        })?),
        action => store.mutate(account, true, check, |db| mutate(db, account, action)),
    }
}

pub(super) fn mutate(
    db: &Connection,
    account: &str,
    action: LocalMailboxAction,
) -> Result<Vec<u8>, RpcError> {
    use LocalMailboxAction::*;

    match action {
        Folders => (),
        ReindexContacts => {
            return encode(&reindex_cached_contacts(db, account).map_err(|_| unavailable())?);
        }
        FilterCandidates {
            folder,
            incoming,
            uids,
        } => {
            return encode(
                &index::candidates(db, account, &folder, incoming, uids)
                    .map_err(|_| unavailable())?,
            );
        }
        InitializeFilterMark { folder } => {
            ensure_filter_mark(db, account, &folder).map_err(|_| unavailable())?;
            return encode(&());
        }
        AdvanceFilterMark { folder, uid } => {
            set_filter_mark(db, account, &folder, uid).map_err(|_| unavailable())?;
            return encode(&());
        }
        MarkRead { folder, uids } => {
            return encode(
                &local_store::mark_local_read(db, account, &folder, uids)
                    .map_err(|_| unavailable())?,
            );
        }
        SetFlags {
            folder,
            uids,
            add,
            remove,
        } => {
            local_store::set_local_flags(db, account, &folder, &uids, &add, &remove)
                .map_err(|_| unavailable())?;
            return encode(&());
        }
        MoveOrCopy {
            folder,
            uids,
            target,
            copy,
        } => {
            local_store::ensure_local_folders(db, account).map_err(|_| unavailable())?;
            return encode(
                &local_store::move_local_in_transaction(db, account, &folder, &uids, &target, copy)
                    .map_err(|_| unavailable())?,
            );
        }
        CreateFolder { name } => {
            local_store::create_local_folder(db, account, &name).map_err(|_| unavailable())?;
        }
        RenameFolder { from, to } => {
            local_store::rename_local_folder_in_transaction(db, account, &from, &to)
                .map_err(|_| unavailable())?;
        }
        Append {
            folder,
            originals,
            sent_recipients,
        } => {
            let count = local_store::import_local_messages(db, account, &folder, &originals)
                .map_err(|_| unavailable())?;
            upsert_sent_contacts(db, account, sent_recipients.iter().map(String::as_str))
                .map_err(|_| unavailable())?;
            return encode(&count);
        }
        _ => return Err(RpcError::from_code(ErrorCode::InvalidParams)),
    }
    encode(&local_store::list_local_folders(db, account).map_err(|_| unavailable())?)
}

pub(super) fn encode(value: &impl Serialize) -> Result<Vec<u8>, RpcError> {
    serde_json::to_vec(value).map_err(|_| unavailable())
}
