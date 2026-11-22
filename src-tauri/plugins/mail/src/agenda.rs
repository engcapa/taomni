use taomni_mail_engine::{agenda::AgendaAction, database::MailboxRequest};
use taomni_plugin_api::RpcError;

use super::store::{Store, unavailable};

pub(super) fn execute(
    store: &Store,
    request: MailboxRequest<AgendaAction>,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let account = request.account_id.as_str();
    let action = request.action;
    let result = if action.writes() {
        store.mutate(account, true, check, |db| {
            action.execute(db, account).map_err(|_| unavailable())
        })?
    } else {
        store.query(account, |db| action.execute(db, account))?
    };
    serde_json::to_vec(&result).map_err(|_| unavailable())
}
