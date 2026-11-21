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
        .map_err(|error| format!("mail test task failed: {error}"))??
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
pub async fn mail_download_attachment(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    attachment_index: usize,
    target_path: String,
    section: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailDownloadAttachmentResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::download_attachment(
            &state,
            &config.session_id,
            folder.trim(),
            uid,
            attachment_index,
            target_path.trim(),
        );
    }
    let target_path = target_path.trim().to_string();
    if target_path.is_empty() {
        return Err("attachment download path is required".into());
    }
    let saved_folder = folder.clone();
    let saved_target = target_path.clone();
    let saved_section = section.clone();
    let original = with_mail_original(&state, &config.session_id, move |db, account| {
        storage::open(db, account, &saved_folder, uid)
    })
    .await?;
    if let Some(original) = original {
        return decode_mail_original(move || {
            let raw = original.read()?;
            let attachment = match saved_section
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(section) => extract_attachment_section(&raw, section),
                None => extract_attachment(&raw, attachment_index),
            }?;
            let path = write_attachment_file(&saved_target, &attachment.bytes)?;
            Ok(MailDownloadAttachmentResult {
                path,
                name: attachment.name,
                content_type: attachment.content_type,
                size: attachment.bytes.len(),
            })
        })
        .await;
    }
    let account = resolve_config(&state, config)?;
    let section = section
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Resolve cache paths from the shared DB handle on each I/O operation,
    // including after a concurrent storage relocation. File copies run off Tokio.
    let cache_key = account.config.cache.attachment_cache.then(|| {
        section
            .clone()
            .unwrap_or_else(|| format!("i{attachment_index}"))
    });
    let cache_account = account.config.session_id.clone();
    let cache_folder = folder.clone();
    if let Some(key) = cache_key.clone() {
        let folder = cache_folder.clone();
        let cached = with_mail_db_async(&state, &cache_account, move |db, id| {
            let root = Path::new(db.path().unwrap_or(""))
                .parent()
                .unwrap_or(Path::new("."));
            let path = parts::attachment_cache_path(
                root,
                &crate::state::mail_db_file_stem(id),
                &folder,
                uid,
                &key,
            );
            Ok(std::fs::File::open(path).ok())
        })
        .await?;
        if let Some(mut cached) = cached {
            // The open descriptor survives relocation/cleanup. Copying a large
            // attachment must not keep every other mailbox operation waiting.
            return decode_mail_original(move || {
                let target = Path::new(&target_path);
                let parent = target
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                let mut temp =
                    tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                let size =
                    std::io::copy(&mut cached, temp.as_file_mut()).map_err(|e| e.to_string())?;
                temp.as_file().sync_all().map_err(|e| e.to_string())?;
                temp.persist(target).map_err(|e| e.error.to_string())?;
                Ok(MailDownloadAttachmentResult {
                    path: target_path,
                    name: None,
                    content_type: None,
                    size: size as usize,
                })
            })
            .await;
        }
    }
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.download_attachment(
                    &account,
                    &folder,
                    uid,
                    attachment_index,
                    &target_path,
                    section.as_deref(),
                )
            },
        )
    })
    .await
    .map_err(|e| format!("mail attachment download task failed: {e}"))??;
    if let Some(key) = cache_key {
        let source = result.path.clone();
        let temp = with_mail_db_async(&state, &cache_account, |db, _| {
            Ok(
                tempfile::NamedTempFile::new_in(Path::new(db.path().unwrap()).parent().unwrap())
                    .ok(),
            )
        })
        .await?;
        let prepared = decode_mail_original(move || {
            let Some(mut temp) = temp else {
                return Ok(None);
            };
            let Ok(mut source) = std::fs::File::open(source) else {
                return Ok(None);
            };
            if std::io::copy(&mut source, temp.as_file_mut()).is_err() {
                return Ok(None);
            }
            Ok(Some(temp))
        })
        .await?;
        with_mail_db_async(&state, &cache_account, move |db, id| {
            let root = Path::new(db.path().unwrap_or(""))
                .parent()
                .unwrap_or(Path::new("."));
            let path = parts::attachment_cache_path(
                root,
                &crate::state::mail_db_file_stem(id),
                &cache_folder,
                uid,
                &key,
            );
            if let Some(temp) = prepared {
                if std::fs::create_dir_all(path.parent().unwrap()).is_ok() {
                    // A concurrent move to another filesystem can make rename
                    // fail; optional caching must not fail the saved download.
                    let _ = temp.persist(&path);
                }
            }
            Ok(())
        })
        .await?;
    }
    Ok(result)
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
        Some(draft_id) => {
            with_mail_db_async(&state, &account_id, move |db, account_id| {
                outgoing::remote_draft_location(db, account_id, &draft_id)
            })
            .await?
        }
        None => None,
    };
    let db = state.mail_db(&account_id)?;
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let (envelope, mime, pending, account) = tokio::task::spawn_blocking(move || {
        let (message, pending) = outgoing::prepare_send(&account, &request, remote_draft)?;
        Ok::<_, String>((
            message.envelope().clone(),
            message.formatted(),
            pending,
            account,
        ))
    })
    .await
    .map_err(|e| format!("mail send task failed: {e}"))??;
    let response =
        super::module_host::send_smtp(state.plugins.clone(), &account, envelope, mime).await?;
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
        tokio::task::spawn_blocking(move || {
            let contacts = (|| -> Result<(), String> {
                let db = db.lock().map_err(|e| e.to_string())?;
                init_mail_tables(&db).map_err(|e| e.to_string())?;
                upsert_sent_contacts(&db, &account_id, &sent_request).map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(error) = contacts {
                tracing::warn!(%account_id, %error, "mail sent; contact cache update failed");
            }
            if let Some(pending) = pending {
                let stored = outgoing::store_pending_copy(&pool, &account, pending, &handle);
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
