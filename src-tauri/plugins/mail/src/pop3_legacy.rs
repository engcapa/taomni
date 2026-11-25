//! Serve retained (unmigrated) POP3 mailboxes in the signed Mail host.

#[cfg(test)]
mod tests;

use std::{
    ops::Deref,
    path::{Path, PathBuf},
    sync::Arc,
};

use rusqlite::{Connection, OpenFlags};
use taomni_mail_api::{
    MailIncomingProtocol,
    imap_exchange::write_body_frame,
    pop3_exchange::{Pop3SyncOutcome, read_ledger_message, write_ledger_message},
    pop3_store::{LegacyMailboxRequest, LegacyPop3Round, LocalMailboxAction},
};
use taomni_mail_engine::{
    cache::{cached_header, list_cached_messages, search_contacts},
    database::{ProcessLock, mail_db_file_stem},
    pop3::{local_store, sqlite_ledger, sync_inbox},
    search::search_cached_messages,
    storage::query::complete_pending_attachment_backfill,
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::routed_tcp::Endpoint;
use tokio::runtime::Runtime;

use super::{
    account_cache::lock_account_cache,
    incoming::{open_pop3, while_current, with_socket},
    pop3_store::{encode, index, mutate},
    store::{Store, apply_change, connect, unavailable, validate_account},
};

const OWNERSHIP_CHANGED: &str =
    "POP3 mailbox ownership has changed. Retry from the current account";

pub(super) fn round(
    runtime: &Runtime,
    operation: &Operation,
    store: Arc<Store>,
    request: LegacyPop3Round,
) -> Result<Result<(), String>, RpcError> {
    if request.connection.protocol != MailIncomingProtocol::Pop3 {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let account = request.account_id;
    let database = request.database;
    validate_legacy_target(&store, &database, &account)?;
    let (mut peer, _) = match runtime.block_on(while_current(operation, request.reply.connect()))? {
        Ok(connection) => connection,
        Err(error) => return Ok(Err(error)),
    };
    {
        let check = || operation.check_current();
        check()?;
        let _access = lock_account_cache(&database, &account)
            .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
        let mut db = connect(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        complete_pending_attachment_backfill(&db).map_err(|_| unavailable())?;
        apply_change(&mut db, &check, |tx| {
            local_store::ensure_local_folders(tx, &account).map_err(|_| unavailable())
        })?;
    }
    let outcome: Result<Pop3SyncOutcome, String> = with_socket(
        runtime,
        operation,
        request.connection,
        move |stream, input| {
            let mut client = open_pop3(stream, &input)?;
            let ledger = sqlite_ledger(
                || LockedDatabase::open(&store, &database, &account),
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
            read_ledger_message::<LegacyMailboxRequest>(&mut peer),
        ))?
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
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
    request: LegacyMailboxRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    use LocalMailboxAction::*;

    let account = request.account_id.as_str();
    validate_legacy_target(store, &request.database, account)?;
    if matches!(&request.action, Initialize | Archive(_)) {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    check()?;
    let _access = lock_account_cache(&request.database, account)
        .map_err(|error| RpcError::new(ErrorCode::InvalidState, error))?;
    check()?;
    let mut db = connect(&request.database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    complete_pending_attachment_backfill(&db).map_err(|_| unavailable())?;
    match request.action {
        Messages {
            folder,
            limit,
            offset,
        } => encode(
            &list_cached_messages(&db, account, &folder, limit, offset)
                .map_err(|_| unavailable())?,
        ),
        Body { folder, uid } => {
            encode(&local_store::local_body(&db, account, &folder, uid).map_err(|_| unavailable())?)
        }
        Raw { folder, uid } => {
            encode(&local_store::local_raw(&db, account, &folder, uid).map_err(|_| unavailable())?)
        }
        Header { folder, uid } => {
            encode(&cached_header(&db, account, &folder, uid).map_err(|_| unavailable())?)
        }
        Search(query) => {
            encode(&search_cached_messages(&db, account, &query).map_err(|_| unavailable())?)
        }
        SearchContacts { query, limit } => {
            encode(&search_contacts(&db, account, &query, limit).map_err(|_| unavailable())?)
        }
        SearchIndex { bodies } => {
            encode(&index::search_rows(&db, account, bodies).map_err(|_| unavailable())?)
        }
        Delete { folder, uids } => encode(
            &local_store::delete_local(&db, account, &folder, uids.as_deref())
                .map_err(|_| unavailable())?,
        ),
        DeleteFolder { name } => {
            if name.eq_ignore_ascii_case("INBOX") {
                return Err(RpcError::new(
                    ErrorCode::InvalidParams,
                    "the local INBOX cannot be deleted",
                ));
            }
            local_store::delete_local_folder(&db, account, &name).map_err(|_| unavailable())?;
            encode(&local_store::list_local_folders(&db, account).map_err(|_| unavailable())?)
        }
        Originals { folder } => encode(
            &local_store::list_local_originals(&db, account, &folder).map_err(|_| unavailable())?,
        ),
        Initialize | Archive(_) => Err(RpcError::from_code(ErrorCode::InvalidParams)),
        action => apply_change(&mut db, check, |tx| mutate(tx, account, action)),
    }
}

fn validate_legacy_target(store: &Store, database: &Path, account: &str) -> Result<(), RpcError> {
    validate_account(account)?;
    let filename = format!("{}.db", mail_db_file_stem(account));
    if !database.is_absolute()
        || database.file_name().and_then(|name| name.to_str()) != Some(&filename)
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    if store.owns_pop3_cache(account)? {
        return Err(RpcError::new(ErrorCode::InvalidState, OWNERSHIP_CHANGED));
    }
    Ok(())
}

struct LockedDatabase {
    _access: ProcessLock,
    db: Connection,
}

impl LockedDatabase {
    fn open(store: &Store, database: &PathBuf, account: &str) -> Result<Self, String> {
        let access = lock_account_cache(database, account)?;
        if store.owns_pop3_cache(account).map_err(|e| e.message)? {
            return Err(OWNERSHIP_CHANGED.into());
        }
        let db = connect(database, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.message)?;
        Ok(Self {
            _access: access,
            db,
        })
    }
}

impl Deref for LockedDatabase {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.db
    }
}
