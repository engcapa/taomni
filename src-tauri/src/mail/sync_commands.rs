use super::*;

/// Sync headers for one folder.
///
/// `refresh_folders`: when true (default), run IMAP LIST so the folder tree is
/// refreshed. Quiet/background polls pass false to skip LIST when the SQLite
/// cache already has folders; selected-folder headers still sync.
#[tauri::command]
pub async fn mail_sync_headers(
    config: MailAccountConfig,
    folder: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    include_bodies: Option<bool>,
    refresh_folders: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailSyncResult, String> {
    let account = resolve_config(&state, config)?;
    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "INBOX".to_string());
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();
    let offset = offset.unwrap_or(0);
    let limit = limit
        .unwrap_or(account.config.sync.max_fetch_per_sync)
        .max(1)
        .min(2000);
    let include_bodies = include_bodies.unwrap_or(false);
    let refresh_folders = refresh_folders.unwrap_or(true);

    let cached_folders = if cache_enabled {
        with_mail_db_async(&state, &account_id, |db, account_id| {
            list_cached_folders(db, account_id)
        })
        .await?
    } else {
        Vec::new()
    };
    let do_list = should_list_remote_folders(refresh_folders, cached_folders.len());

    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let mut result = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::background(),
            |imap| {
                let base_folders = if do_list {
                    imap.list_folders(&account.config.session_id)?
                } else {
                    // Clone: with_imap_session may invoke this FnMut twice on retry.
                    cached_folders.clone()
                };
                let (selected_folder, cached, has_more) =
                    imap.sync_folder(&account, &folder, offset, limit, include_bodies)?;
                let folders = folders_for_header_sync(base_folders, selected_folder.clone());
                let cached_bodies = cached.iter().filter(|m| m.body_cached_at.is_some()).count();
                Ok((
                    folders,
                    selected_folder,
                    cached,
                    cached_bodies,
                    has_more,
                    do_list,
                ))
            },
        )
    })
    .await
    .map_err(|e| format!("mail sync task failed: {e}"))??;

    if cache_enabled {
        result = with_mail_db_async(&state, &account_id, move |db, account_id| {
            cache_sync_result(
                db,
                &account_id,
                &result.0,
                &result.2,
                &result.1.name,
                &cache_settings,
            )?;
            Ok(result)
        })
        .await?;
    }

    tracing::debug!(
        account_id = %account_id,
        folder = %result.1.name,
        listed_remote = result.5,
        refresh_folders,
        "mail sync headers folders source"
    );

    let synced_at = now_ts();
    let messages = result.2.drain(..).map(|m| m.header).collect::<Vec<_>>();
    Ok(MailSyncResult {
        account_id,
        folder: result.1.name,
        folders: result.0,
        fetched_messages: messages.len(),
        cached_bodies: result.3,
        messages,
        synced_at,
        offset,
        limit,
        has_more: result.4,
    })
}

/// Sync one folder by one bounded, gap-free step (see `sync.rs`). Callers
/// repeat while `more` is true: `auto` initialises, repairs a pre-watermark
/// cache or fetches every message newer than the cached span; `backfill`
/// walks older history; `reconcile*` removes server-side deletions and
/// refreshes flags.
#[tauri::command]
pub async fn mail_sync_folder(
    config: MailAccountConfig,
    folder: Option<String>,
    mode: Option<MailSyncRequestMode>,
    limit: Option<u32>,
    include_bodies: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailFolderSyncResult, String> {
    if pop3::is_pop3(&config) {
        let name = folder.clone().unwrap_or_else(|| "INBOX".into());
        return local_cmds::sync_folder(&state, config, name.trim()).await;
    }
    let account = resolve_config(&state, config)?;
    let folder = folder
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| "INBOX".to_string());
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();
    let params = StepParams {
        request: mode.unwrap_or_default(),
        limit: limit
            .unwrap_or(account.config.sync.max_fetch_per_sync)
            .clamp(1, 2000) as usize,
        include_bodies: include_bodies.unwrap_or(false),
        condstore: false,
    };
    // Without a cache there is nothing to resume from: every call is a fresh
    // newest page.
    let sync_state = if cache_enabled {
        let state_folder = folder.clone();
        with_mail_db_async(&state, &account_id, move |db, account_id| {
            sync::load_folder_sync_state(db, account_id, &state_folder)
        })
        .await?
    } else {
        FolderSyncState::default()
    };

    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let step_folder = folder.clone();
    let started_ms = sync::now_ms();
    let result = tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::background(),
            |imap| {
                let params = StepParams {
                    condstore: imap.has_capability("CONDSTORE"),
                    ..params
                };
                imap.sync_folder_step(&account, &step_folder, &sync_state, &params)
            },
        )
    })
    .await
    .map_err(|e| format!("mail sync task failed: {e}"))?;

    let mut outcome = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            if cache_enabled {
                let error = e.clone();
                let _ = with_mail_db_async(&state, &account_id, move |db, account_id| {
                    sync::record_folder_error(db, account_id, &folder, &error)
                })
                .await;
            }
            return Err(e);
        }
    };
    if !cache_enabled {
        outcome.mode = sync::MailSyncMode::Uncached;
        outcome.more = false;
        return Ok(sync::step_result(&account_id, outcome, None));
    }
    with_mail_db_async(&state, &account_id, move |db, account_id| {
        let applied =
            sync::apply_folder_step(db, account_id, &outcome, &cache_settings, started_ms)?;
        Ok(sync::step_result(account_id, outcome, Some(applied)))
    })
    .await
}

/// Refresh the folder tree and run one catch-up (plus reconcile) step for
/// every folder. Folders that still have work left are reported in
/// `pendingFolders`; failures in `failedFolders` (never silently skipped).
#[tauri::command]
pub async fn mail_sync_all_folders(
    config: MailAccountConfig,
    limit: Option<u32>,
    include_bodies: Option<bool>,
    full_reconcile: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MailSyncAllResult, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::sync_all(&state, config).await;
    }
    let account = resolve_config(&state, config)?;
    let cache_enabled = account.config.cache.enabled;
    let cache_settings = account.config.cache.clone();
    let account_id = account.config.session_id.clone();
    let limit = limit
        .unwrap_or(account.config.sync.max_fetch_per_sync)
        .clamp(1, 2000) as usize;
    let include_bodies = include_bodies.unwrap_or(false);
    let reconcile_mode = if full_reconcile.unwrap_or(false) {
        MailSyncRequestMode::ReconcileFull
    } else {
        MailSyncRequestMode::Reconcile
    };
    let skip_unchanged = cache_enabled && reconcile_mode == MailSyncRequestMode::Reconcile;
    let pool = Arc::clone(&state.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    let listed = {
        let pool = Arc::clone(&pool);
        let account = account.clone();
        let handle = handle.clone();
        tokio::task::spawn_blocking(move || {
            with_imap_session(
                &pool,
                &account,
                &handle,
                ImapSessionOpts::background(),
                |imap| imap.list_folders(&account.config.session_id),
            )
        })
        .await
        .map_err(|e| format!("mail folder listing task failed: {e}"))??
    };
    if cache_enabled {
        let tree = listed.clone();
        with_mail_db_async(&state, &account_id, move |db, account_id| {
            sync_folder_tree(db, account_id, &tree)
        })
        .await?;
    }
    let mut folders = listed;
    let mut failed = Vec::new();
    let mut pending = Vec::new();
    let mut skipped = Vec::new();
    let mut new_unseen_by_folder: HashMap<String, usize> = HashMap::new();
    let mut fetched_messages = 0usize;
    let mut cached_bodies = 0usize;
    for folder in &mut folders {
        if folder_is_noselect(folder)
            || !folders::folder_visible(folder, account.config.sync.subscribed_only)
        {
            continue;
        }
        let name = folder.name.clone();
        let folder_state = if cache_enabled {
            let name = name.clone();
            with_mail_db_async(&state, &account_id, move |db, account_id| {
                sync::load_folder_sync_state(db, account_id, &name)
            })
            .await?
        } else {
            FolderSyncState::default()
        };
        let started_ms = sync::now_ms();
        // Release the account's background lane between folders. A transient
        // disconnect retries only this folder; already committed progress is
        // visible immediately and is never replayed as a whole-account batch.
        let result = {
            let pool = Arc::clone(&pool);
            let account = account.clone();
            let handle = handle.clone();
            let name = name.clone();
            let listed_folder = folder.clone();
            tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &account,
                    &handle,
                    ImapSessionOpts::background(),
                    |imap| {
                        let condstore = imap.has_capability("CONDSTORE");
                        let mut folder_state = folder_state.clone();
                        if skip_unchanged && condstore {
                            if let Some(status) = imap.folder_status(&name, condstore) {
                                if folders::folder_unchanged(&folder_state, &status) {
                                    let mut folder = listed_folder.clone();
                                    folder.total = status.messages;
                                    folder.unread = status.unseen;
                                    folder.uid_next = status.uid_next;
                                    folder.uid_validity = status.uid_validity;
                                    return Ok((Vec::new(), Vec::new(), Some(folder), None));
                                }
                            }
                        }
                        let mut folder_outcomes = Vec::new();
                        let mut pending = Vec::new();
                        let mut error = None;
                        // A repair (pre-watermark cache) is followed by the real catch-up.
                        for _ in 0..2 {
                            let params = StepParams {
                                request: MailSyncRequestMode::Auto,
                                limit,
                                include_bodies,
                                condstore,
                            };
                            match imap.sync_folder_step(&account, &name, &folder_state, &params) {
                                Ok(outcome) => {
                                    folder_state = sync::advance_state(&folder_state, &outcome);
                                    let repaired = outcome.mode == sync::MailSyncMode::Repair
                                        && !outcome.watermark.needs_repair;
                                    let more = outcome.more;
                                    folder_outcomes.push(outcome);
                                    if !repaired {
                                        if more {
                                            pending.push(name.clone());
                                        }
                                        break;
                                    }
                                }
                                Err(e) => {
                                    error = Some(e);
                                    break;
                                }
                            }
                        }
                        let caught_up = error.is_none()
                            && folder_outcomes
                                .last()
                                .is_some_and(|outcome: &FolderStepOutcome| !outcome.more);
                        if caught_up && folder_state.high.is_some() {
                            let params = StepParams {
                                request: reconcile_mode,
                                limit,
                                include_bodies,
                                condstore,
                            };
                            match imap.sync_folder_step(&account, &name, &folder_state, &params) {
                                Ok(outcome) => {
                                    if outcome.more {
                                        pending.push(name.clone());
                                    }
                                    folder_outcomes.push(outcome);
                                }
                                Err(e) => error = Some(e),
                            }
                        }
                        if let Some(ref e) = error {
                            if is_imap_transport_error(e) {
                                return Err(e.clone());
                            }
                        }
                        Ok((folder_outcomes, pending, None, error))
                    },
                )
            })
            .await
            .map_err(|e| format!("mail folder sync task failed: {e}"))?
        };
        let (outcomes, folder_pending, unchanged, error) = match result {
            Ok(result) => result,
            Err(error) => (Vec::new(), Vec::new(), None, Some(error)),
        };
        if let Some(unchanged) = unchanged {
            *folder = unchanged;
            skipped.push(name.clone());
        }
        pending.extend(folder_pending);
        for outcome in &outcomes {
            fetched_messages += outcome.messages.len();
            cached_bodies += outcome
                .messages
                .iter()
                .filter(|m| m.body_cached_at.is_some())
                .count();
            if outcome.new_unseen > 0 {
                *new_unseen_by_folder.entry(name.clone()).or_default() += outcome.new_unseen;
            }
            *folder = outcome.folder.clone();
        }
        if let Some(error) = &error {
            failed.push(MailFolderError {
                name: name.clone(),
                error: error.clone(),
            });
        }
        if cache_enabled {
            let cache_settings = cache_settings.clone();
            let metadata = folder.clone();
            with_mail_db_async(&state, &account_id, move |db, account_id| {
                upsert_folder(db, &metadata)?;
                for outcome in &outcomes {
                    sync::apply_folder_step(db, account_id, outcome, &cache_settings, started_ms)?;
                }
                if let Some(error) = error {
                    sync::record_folder_error(db, account_id, &name, &error)?;
                }
                Ok(())
            })
            .await?;
        }
        tokio::task::yield_now().await;
    }
    pending.sort();
    pending.dedup();
    let folders = if cache_enabled {
        with_mail_db_async(&state, &account_id, |db, account_id| {
            list_cached_folders(db, account_id)
        })
        .await?
    } else {
        folders
    };

    Ok(MailSyncAllResult {
        account_id,
        folders,
        fetched_messages,
        new_messages: new_unseen_by_folder.values().sum(),
        new_unseen_by_folder,
        failed_folders: failed,
        pending_folders: pending,
        unchanged_folders: skipped,
        cached_bodies,
        synced_at: now_ts(),
    })
}

pub(super) fn folder_is_noselect(folder: &MailFolder) -> bool {
    folder
        .flags
        .iter()
        .any(|flag| flag.to_ascii_lowercase().contains("noselect"))
}

/// Mirror the remote folder tree: upsert listed folders (metadata only) and
/// drop cached folders the server no longer lists.
pub(super) fn sync_folder_tree(
    conn: &Connection,
    account_id: &str,
    listed: &[MailFolder],
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in listed {
        upsert_folder(&tx, folder)?;
    }
    let names: HashSet<&str> = listed.iter().map(|folder| folder.name.as_str()).collect();
    let cached = list_cached_folders(&tx, account_id)?;
    for folder in cached {
        if !names.contains(folder.name.as_str()) {
            tx.execute(
                "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
                params![account_id, folder.name],
            )?;
            tx.execute(
                "DELETE FROM mail_folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, folder.name],
            )?;
        }
    }
    tx.commit()
}
