use super::*;

#[tauri::command]
pub async fn mail_test_connection(
    config: MailAccountConfig,
    state: State<'_, AppState>,
) -> Result<MailTestConnectionResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::test_connection(&state, config).await;
    }
    let account = resolve_config(&state, config)?;
    let folder_count = if module_host::checks_incoming(&state.plugins) {
        module_host::check_incoming(state.plugins.clone(), &account).await?
    } else {
        legacy_imap!({
            let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
            let handle = tokio::runtime::Handle::current();
            let incoming = account.clone();
            tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &incoming,
                    &handle,
                    ImapSessionOpts {
                        force_fresh: true,
                        retry_on_error: false,
                        ..ImapSessionOpts::default()
                    },
                    |imap| imap.list_folders(&incoming.config.session_id),
                )
                .map(|folders| folders.len())
            })
            .await
            .map_err(|error| format!("mail test task failed: {error}"))?
        })?
    };
    module_host::test_smtp(state.plugins.clone(), &account).await?;
    Ok(MailTestConnectionResult {
        imap_ok: true,
        smtp_ok: true,
        folder_count,
    })
}

#[tauri::command]
pub async fn mail_list_cached_folders(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MailFolder>, String> {
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        list_cached_folders(db, &account_id)
    })
    .await
}

#[tauri::command]
pub async fn mail_list_cached_messages(
    account_id: String,
    folder: String,
    limit: Option<u32>,
    offset: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<MailMessageHeader>, String> {
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        list_cached_messages(
            db,
            &account_id,
            &folder,
            limit.unwrap_or(DEFAULT_MESSAGE_LIMIT as u32).min(1000),
            offset.unwrap_or(0),
        )
    })
    .await
}

#[tauri::command]
pub async fn mail_send_message(
    config: MailAccountConfig,
    request: MailSendRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MailSendResult, String> {
    send_message(config, request, Some(app), state).await
}

pub(super) async fn send_message(
    config: MailAccountConfig,
    request: MailSendRequest,
    app: Option<AppHandle>,
    state: State<'_, AppState>,
) -> Result<MailSendResult, String> {
    if pop3::is_pop3(&config) {
        validate_send_request(&request)?;
        return local_cmds::send(&state, config, request).await;
    }
    let account = resolve_config(&state, config)?;
    validate_send_request(&request)?;
    let account_id = account.config.session_id.clone();
    let sent_request = request.clone();
    let remote_draft = match request.draft_id.clone() {
        Some(draft_id) => draft_store::get(&state, &account_id, &draft_id)
            .await?
            .and_then(|draft| draft.remote_location()),
        None => None,
    };
    let db = state.mail_db(&account_id)?;
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let registry = state.plugins.clone();
    let (message, pending) =
        outgoing::prepare_send(registry.clone(), &account, request, remote_draft).await?;
    let response = module_host::send_smtp(registry.clone(), &account, message).await?;
    let result = MailSendResult {
        accepted: true,
        response,
        sent_copy_folder: None,
        sent_copy_error: None,
    };
    if result.accepted {
        // Owned by the backend, not the composer or tab. SMTP acceptance is
        // returned immediately; neither cache contention nor APPEND can turn
        // an accepted message into a send error (and an unsafe SMTP retry).
        tokio::spawn(async move {
            let cached_account_id = account_id.clone();
            let contacts = tokio::task::spawn_blocking(move || {
                let db = db.lock().map_err(|e| e.to_string())?;
                init_mail_tables(&db).map_err(|e| e.to_string())?;
                upsert_sent_contacts(&db, &cached_account_id, &sent_request)
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
            if let Err(error) = contacts {
                tracing::warn!(%account_id, %error, "mail sent; contact cache update failed");
            }
            if let Some(pending) = pending {
                let stored = module_host::store_sent_copy(
                    registry,
                    #[cfg(any(test, feature = "legacy-mail-imap"))]
                    pool,
                    account,
                    pending,
                )
                .await;
                let (folder, error) = match stored {
                    Ok(folder) => (folder, None),
                    Err(error) => (None, Some(error)),
                };
                if let Some(error) = &error {
                    tracing::warn!(%account_id, %error, "mail sent; storing Sent copy failed");
                }
                if let Some(app) = app {
                    let _ = app.emit(
                        "mail-sent-copy",
                        MailSentCopyEvent {
                            account_id,
                            folder,
                            error,
                        },
                    );
                }
            }
        });
    }
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MailSentCopyEvent {
    pub(super) account_id: String,
    pub(super) folder: Option<String>,
    pub(super) error: Option<String>,
}
