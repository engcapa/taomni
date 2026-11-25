use super::*;
use taomni_mail_api::{
    ImapFlagUpdate,
    archive_scan::{ArchiveScanAction, POP3_CLEAR_ERROR},
    imap_flag_cache::ImapFlagCacheAction,
};

#[tauri::command]
pub async fn mail_mark_read(
    config: MailAccountConfig,
    folder: String,
    uids: Option<Vec<u32>>,
    all: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailMarkReadResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::mark_read(
            &state,
            &config.session_id,
            folder.trim(),
            uids,
            all.unwrap_or(false),
        )
        .await;
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let account = resolve_config(&state, config)?;
    let db = state.mail_db(&account.config.session_id)?;
    let transport = read_actions::ReadFlagTransport::new(
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        state.legacy.mail.mail_imap_pool.clone(),
        account,
        Some(state.plugins.clone()),
    );
    read_actions::mark_read_cached(
        transport,
        db,
        &folder,
        uids.unwrap_or_default(),
        all.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn mail_clear_cache(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if pop3_store::is_hosted(&state, &account_id).await? {
        return Err(POP3_CLEAR_ERROR.into());
    }
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    state.legacy.mail.mail_imap_pool.invalidate(&account_id);
    if module_host::owns_archive_scan(&state.plugins) {
        return module_host::run_archive_scan(
            state.plugins.clone(),
            state.mail_db(&account_id)?,
            account_id,
            ArchiveScanAction::ClearCache,
        )
        .await;
    }

    tokio::task::spawn_blocking({
        let cache = state.mail_db(&account_id)?;
        move || {
            let db = cache.lock()?;
            let tx = db
                .unchecked_transaction()
                .map_err(|error| error.to_string())?;
            if pop3::has_local_store(&tx, &account_id).map_err(|error| error.to_string())? {
                return Err(POP3_CLEAR_ERROR.into());
            }
            taomni_mail_storage::cache::clear_cached_account(&tx, &account_id)
                .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn mail_set_flags(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<MailFlagResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::set_flags(
            &state,
            &config.session_id,
            folder.trim(),
            &uids,
            &add.unwrap_or_default(),
            &remove.unwrap_or_default(),
        )
        .await;
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let add = add.unwrap_or_default();
    let remove = remove.unwrap_or_default();
    let target_uids = uids.into_iter().filter(|uid| *uid > 0).collect::<Vec<_>>();
    if target_uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(MailFlagResult { folder, updated: 0 });
    }

    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let publish_to_host = module_host::publishes_imap_flags(&state.plugins);
    let update = ImapFlagUpdate {
        folder: folder.clone(),
        uids: target_uids,
        add,
        remove,
    };
    if module_host::sets_imap_flags(&state.plugins) {
        module_host::set_imap_flags(state.plugins.clone(), &account, &update).await?;
    } else {
        legacy_imap!({
            let update = update.clone();
            let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
            let handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &account,
                    &handle,
                    ImapSessionOpts::default(),
                    |imap| {
                        imap.set_flags(&update.folder, &update.uids, &update.add, &update.remove)
                    },
                )
            })
            .await
            .map_err(|e| format!("mail set flags task failed: {e}"))?
        })?;
    }

    let updated = update.uids.len();
    if publish_to_host {
        let cache = state.mail_db(&account_id)?;
        module_host::publish_imap_flags(
            state.plugins.clone(),
            cache,
            account_id,
            ImapFlagCacheAction::Update { flags: update },
        )
        .await?;
        return Ok(MailFlagResult { folder, updated });
    }
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        let tx = db.unchecked_transaction()?;
        update_cached_flags(
            &tx,
            account_id,
            &update.folder,
            &update.uids,
            &update.add,
            &update.remove,
        )?;
        tx.commit()
    })
    .await?;
    Ok(MailFlagResult { folder, updated })
}

#[tauri::command]
pub async fn mail_move_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target_folder: String,
    operation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailMoveResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::move_or_copy(
            &state,
            &config.session_id,
            folder.trim(),
            &uids,
            target_folder.trim(),
            false,
        )
        .await;
    }
    if folder.trim() == target_folder.trim() {
        return Err("source and target folders must differ".into());
    }
    transfer_messages(
        config,
        folder,
        uids,
        target_folder,
        operation_id,
        mutations::Kind::Move,
        state,
    )
    .await
}

#[tauri::command]
pub async fn mail_copy_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target_folder: String,
    operation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailMoveResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::move_or_copy(
            &state,
            &config.session_id,
            folder.trim(),
            &uids,
            target_folder.trim(),
            true,
        )
        .await;
    }
    transfer_messages(
        config,
        folder,
        uids,
        target_folder,
        operation_id,
        mutations::Kind::Copy,
        state,
    )
    .await
}

pub(super) async fn transfer_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target: String,
    operation_id: Option<String>,
    kind: mutations::Kind,
    state: State<'_, AppState>,
) -> Result<MailMoveResult, String> {
    let folder = folder.trim().to_string();
    let target = target.trim().to_string();
    if folder.is_empty() || target.is_empty() {
        return Err("source and target folders are required".into());
    }
    let mutation = run_mail_mutation(
        config,
        folder.clone(),
        uids,
        target.clone(),
        kind,
        false,
        operation_id,
        state,
    )
    .await?;
    Ok(MailMoveResult {
        folder,
        target,
        count: mutation.completed_uids.len(),
        mutation: Some(mutation),
    })
}

#[tauri::command]
pub async fn mail_delete_messages(
    config: MailAccountConfig,
    folder: String,
    uids: Option<Vec<u32>>,
    all: Option<bool>,
    operation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailDeleteResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::delete(
            &state,
            &config.session_id,
            folder.trim(),
            uids,
            all.unwrap_or(false),
        )
        .await;
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let mutation = run_mail_mutation(
        config,
        folder.clone(),
        uids.unwrap_or_default(),
        String::new(),
        mutations::Kind::Delete,
        all.unwrap_or(false),
        operation_id,
        state,
    )
    .await?;
    Ok(MailDeleteResult {
        folder,
        deleted: mutation.completed_uids.len(),
        mutation: Some(mutation),
    })
}

pub(super) async fn run_mail_mutation(
    config: MailAccountConfig,
    folder: String,
    uids: Vec<u32>,
    target: String,
    kind: mutations::Kind,
    all: bool,
    operation_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<mutations::Progress, String> {
    let account = resolve_config(&state, config)?;
    let db = state.mail_db(&account.config.session_id)?;
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let gate = state.legacy.mail.mutation_gate(&account.config.session_id);
    let registry = state.plugins.clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        mutations::run_cached(
            #[cfg(any(test, feature = "legacy-mail-imap"))]
            &pool,
            &gate,
            &account,
            &runtime,
            &db,
            &folder,
            uids,
            &target,
            kind,
            all,
            operation_id,
            Some(&registry),
        )
    })
    .await
    .map_err(|e| format!("mail mutation task failed: {e}"))?
}
