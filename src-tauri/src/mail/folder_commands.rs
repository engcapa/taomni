//! Update the server folder tree, then commit its metadata to the mailbox cache.

use taomni_mail_api::ImapFolderChange;
use taomni_mail_engine::cache::apply_folder_change;

use super::*;

#[tauri::command]
pub async fn mail_create_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let name = name.trim();
    if pop3::is_pop3(&config) {
        return local_cmds::create_folder(&state, &config.session_id, name).await;
    }
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    change_folder(
        &state,
        config,
        ImapFolderChange::Create { name: name.into() },
    )
    .await
}

#[tauri::command]
pub async fn mail_rename_folder(
    config: MailAccountConfig,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let (from, to) = (from.trim(), to.trim());
    if pop3::is_pop3(&config) {
        return local_cmds::rename_folder(&state, &config.session_id, from, to).await;
    }
    if from.is_empty() || to.is_empty() {
        return Err("current and new folder names are required".into());
    }
    change_folder(
        &state,
        config,
        ImapFolderChange::Rename {
            from: from.into(),
            to: to.into(),
        },
    )
    .await
}

#[tauri::command]
pub async fn mail_delete_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    let name = name.trim();
    if pop3::is_pop3(&config) {
        return local_cmds::delete_folder(&state, &config.session_id, name).await;
    }
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    change_folder(
        &state,
        config,
        ImapFolderChange::Delete { name: name.into() },
    )
    .await
}

async fn change_folder(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    change: ImapFolderChange,
) -> Result<Vec<MailFolder>, String> {
    let account = resolve_config(state, config)?;
    let account_id = account.config.session_id.clone();
    let previous = match &change {
        ImapFolderChange::Rename { from, .. } => Some(from.clone()),
        ImapFolderChange::Delete { name } => Some(name.clone()),
        ImapFolderChange::Create { .. } => None,
    };
    let folders = if module_host::changes_imap_folders(&state.plugins) {
        module_host::change_imap_folder(state.plugins.clone(), &account, change).await?
    } else {
        legacy_imap!({
            let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &account,
                    &runtime,
                    // A disconnect during LIST may follow a successful mutation.
                    ImapSessionOpts {
                        retry_on_error: false,
                        ..Default::default()
                    },
                    |imap| {
                        imap.change_folder(&change)?;
                        imap.list_folders(&account.config.session_id)
                    },
                )
            })
            .await
            .map_err(|error| format!("mail folder update task failed: {error}"))?
        })?
    };
    if folders.iter().any(|folder| folder.account_id != account_id) {
        return Err("Mail module returned folders for a different account".into());
    }
    with_mail_db_async(state, &account_id, move |db, account_id| {
        apply_folder_change(db, account_id, previous.as_deref(), &folders)?;
        Ok(folders)
    })
    .await
}
