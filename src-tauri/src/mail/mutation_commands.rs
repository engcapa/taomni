use super::*;

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
        );
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let account = resolve_config(&state, config)?;
    let db = state.mail_db(&account.config.session_id)?;
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        read_actions::mark_read_cached(
            &pool,
            &account,
            &handle,
            &db,
            &folder,
            uids.unwrap_or_default(),
            all.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| format!("mail mark read task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_clear_cache(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if with_mail_db(&state, &account_id, |db| {
        pop3::has_local_store(db, &account_id)
    })? {
        return Err("This POP3 account keeps its mail only on this computer; clearing the cache would delete it.".into());
    }
    state.mail.mail_imap_pool.invalidate(&account_id);
    with_mail_db(&state, &account_id, |db| {
        db.execute(
            "DELETE FROM mail_messages WHERE account_id = ?1",
            params![account_id],
        )?;
        db.execute(
            "DELETE FROM mail_folders WHERE account_id = ?1",
            params![account_id],
        )?;
        Ok(())
    })
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
        );
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
    let folder_for_task = folder.clone();
    let uids_for_task = target_uids.clone();
    let add_for_task = add.clone();
    let remove_for_task = remove.clone();
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.set_flags(
                    &folder_for_task,
                    &uids_for_task,
                    &add_for_task,
                    &remove_for_task,
                )
            },
        )
    })
    .await
    .map_err(|e| format!("mail set flags task failed: {e}"))??;

    let updated = target_uids.len();
    let cached_folder = folder.clone();
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        let tx = db.unchecked_transaction()?;
        update_cached_flags(&tx, account_id, &cached_folder, &target_uids, &add, &remove)?;
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
        );
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
        );
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
        );
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
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        mutations::run_cached(
            &pool,
            &account,
            &runtime,
            &db,
            &folder,
            uids,
            &target,
            kind,
            all,
            operation_id,
        )
    })
    .await
    .map_err(|e| format!("mail mutation task failed: {e}"))?
}

#[tauri::command]
pub async fn mail_create_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::create_folder(&state, &config.session_id, name.trim());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let name_for_task = name.clone();
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.create_folder(&name_for_task)?;
                imap.list_folders(&account.config.session_id)
            },
        )
    })
    .await
    .map_err(|e| format!("mail create folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}

#[tauri::command]
pub async fn mail_rename_folder(
    config: MailAccountConfig,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::rename_folder(&state, &config.session_id, from.trim(), to.trim());
    }
    let from = from.trim().to_string();
    let to = to.trim().to_string();
    if from.is_empty() || to.is_empty() {
        return Err("current and new folder names are required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let from_for_task = from.clone();
    let to_for_task = to.clone();
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.rename_folder(&from_for_task, &to_for_task)?;
                imap.list_folders(&account.config.session_id)
            },
        )
    })
    .await
    .map_err(|e| format!("mail rename folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        purge_cached_folder(db, &account_id, &from)?;
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}

#[tauri::command]
pub async fn mail_delete_folder(
    config: MailAccountConfig,
    name: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::delete_folder(&state, &config.session_id, name.trim());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("folder name is required".into());
    }
    let account_id = config.session_id.clone();
    let account = resolve_config(&state, config)?;
    let name_for_task = name.clone();
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let folders = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.delete_folder(&name_for_task)?;
                imap.list_folders(&account.config.session_id)
            },
        )
    })
    .await
    .map_err(|e| format!("mail delete folder task failed: {e}"))??;

    with_mail_db(&state, &account_id, |db| {
        purge_cached_folder(db, &account_id, &name)?;
        for folder in &folders {
            upsert_folder(db, folder)?;
        }
        Ok(())
    })?;
    Ok(folders)
}
