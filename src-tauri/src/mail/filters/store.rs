use taomni_mail_api::{FILTER_RULES, MailboxRequest, filter_cache::FilterCacheAction};
use taomni_mail_storage::filters::{
    MailFilter, ensure_filter_mark,
    rules::{self, FilterRulesAction, FilterRulesImport, FilterRulesReply},
};

use crate::{
    mail::{local_storage, mail_db_task, module_host, pop3_store},
    state::AppState,
};

pub(super) async fn run(
    state: &AppState,
    account: &str,
    action: FilterRulesAction,
) -> Result<Vec<MailFilter>, String> {
    let writes = action.writes();
    if !local_storage::is_hosted(state, account, FILTER_RULES).await? {
        let mailbox = state.mail_db(account)?;
        let reply = mail_db_task(mailbox, account.to_owned(), move |db, account| {
            if !writes {
                return action.execute(db, account);
            }
            let transaction = db.unchecked_transaction()?;
            let reply = action.execute(&transaction, account)?;
            transaction.commit()?;
            Ok(reply)
        })
        .await?;
        return finish(state, account, writes, reply).await;
    }
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let migrated = state.legacy.mail.migrated.clone();
    let legacy_root = state.mail_cache_root().to_owned();
    let source_account = account.to_owned();
    let reply: FilterRulesReply = module_host::local_mailbox(
        state.plugins.clone(),
        FILTER_RULES,
        MailboxRequest {
            account_id: account.to_owned(),
            action,
        },
        move || {
            let (replace_staged, snapshot) = local_storage::import_source(
                &core,
                &registry,
                migrated,
                &legacy_root,
                &source_account,
                rules::read_account,
            )?;
            Ok(FilterRulesImport {
                snapshot,
                replace_staged,
            })
        },
    )
    .await?;
    finish(state, account, writes, reply).await
}

async fn finish(
    state: &AppState,
    account: &str,
    writes: bool,
    reply: FilterRulesReply,
) -> Result<Vec<MailFilter>, String> {
    let rules = reply.into_result()?;
    if writes {
        // UIDVALIDITY and its filter mark share the live message cache.
        // Saving a rule only affects arrivals after this baseline.
        let cache_support = module_host::owns_imap_filter_cache(&state.plugins);
        if cache_support && pop3_store::is_hosted(state, account).await? {
            pop3_store::hosted::<()>(
                state,
                account,
                taomni_mail_api::pop3_store::LocalMailboxAction::InitializeFilterMark {
                    folder: "INBOX".into(),
                },
            )
            .await?;
        } else if cache_support {
            module_host::imap_filter_cache(
                state,
                account,
                FilterCacheAction::Baseline {
                    folder: "INBOX".into(),
                },
            )
            .await?;
        } else {
            mail_db_task(
                state.mail_db(account)?,
                account.to_owned(),
                |db, account| ensure_filter_mark(db, account, "INBOX"),
            )
            .await?;
        }
    }
    Ok(rules)
}
