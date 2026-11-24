use serde::de::DeserializeOwned;
use taomni_mail_api::{CALDAV_AGENDA, MailboxRequest};
use taomni_mail_storage::agenda::{AgendaAction, handoff};

use crate::{
    mail::{local_storage, module_host},
    state::AppState,
};

pub(super) async fn run<T: DeserializeOwned + Send + 'static>(
    state: &AppState,
    account: &str,
    action: AgendaAction,
) -> Result<T, String> {
    if !local_storage::is_hosted(state, account, CALDAV_AGENDA).await? {
        let db = state.mail_db(account)?;
        let result = crate::mail::mail_db_task(db, account.to_owned(), move |db, account| {
            let tx = db.unchecked_transaction()?;
            let result = action.execute(&tx, account)?;
            tx.commit()?;
            Ok(result)
        })
        .await?;
        return serde_json::from_value(result).map_err(|error| error.to_string());
    }
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let migrated = state.legacy.mail.migrated.clone();
    let legacy_root = state.mail_cache_root().to_owned();
    let account = account.to_owned();
    module_host::local_mailbox(
        state.plugins.clone(),
        CALDAV_AGENDA,
        MailboxRequest {
            account_id: account.clone(),
            action,
        },
        move || {
            let (replace_staged, snapshot) = local_storage::import_source(
                &core,
                &registry,
                migrated,
                &legacy_root,
                &account,
                handoff::read_account,
            )?;
            Ok(handoff::AgendaImport {
                replace_staged,
                snapshot: snapshot.unwrap_or_default(),
            })
        },
    )
    .await
}
