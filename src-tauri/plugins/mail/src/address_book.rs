use taomni_mail_api::MailboxRequest;
use taomni_mail_engine::contacts::{ContactWriteError, mailbox::BookAction};
use taomni_plugin_api::{ErrorCode, RpcError};

use super::store::{Store, unavailable};

pub(super) fn execute(
    store: &Store,
    request: MailboxRequest<BookAction>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let account = request.account_id.as_str();
    let action = request.action;
    let result = if action.writes() {
        store.mutate(account, true, check, |db| {
            action.execute(db, account).map_err(|error| match error {
                ContactWriteError::InvalidEntry(message) => {
                    RpcError::new(ErrorCode::InvalidParams, message)
                }
                ContactWriteError::Database(_) => unavailable(),
            })
        })
    } else {
        store.query(account, |db| {
            let snapshot = db.unchecked_transaction()?;
            let result = action
                .execute(&snapshot, account)
                .map_err(|error| match error {
                    ContactWriteError::Database(error) => error,
                    ContactWriteError::InvalidEntry(_) => rusqlite::Error::InvalidQuery,
                })?;
            snapshot.commit()?;
            Ok(result)
        })
    };
    // A user validation error is part of the completed request. Send it on the
    // data connection so the caller receives it even if the control reply races EOF.
    let reply = match result {
        Ok(value) => Ok(value),
        Err(error) if error.code == ErrorCode::InvalidParams.as_i32() => Err(error.message),
        Err(error) => return Err(error),
    };
    serde_json::to_vec(&reply).map_err(|_| unavailable())
}
