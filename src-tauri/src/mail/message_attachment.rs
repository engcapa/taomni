//! Save cached attachments or fetch them through the signed Mail host.

use super::*;

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
    let result = if module_host::fetches_imap_attachment(&state.plugins) {
        download_host_attachment(
            &state,
            &account,
            &folder,
            uid,
            attachment_index,
            target_path,
            section.as_deref(),
        )
        .await?
    } else {
        download_legacy_attachment(
            &state,
            account,
            folder,
            uid,
            attachment_index,
            target_path,
            section,
        )
        .await?
    };
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

async fn download_host_attachment(
    state: &State<'_, AppState>,
    account: &ResolvedMailAccount,
    folder: &str,
    uid: u32,
    index: usize,
    target_path: String,
    section: Option<&str>,
) -> Result<MailDownloadAttachmentResult, String> {
    let first = module_host::fetch_imap_attachment(
        state.plugins.clone(),
        account,
        folder,
        uid,
        index,
        section,
    )
    .await;
    let attachment = if first
        .as_ref()
        .is_err_and(|error| is_imap_transport_error(error))
    {
        module_host::fetch_imap_attachment(
            state.plugins.clone(),
            account,
            folder,
            uid,
            index,
            section,
        )
        .await?
    } else {
        first?
    };
    decode_mail_original(move || {
        attachment_files::publish_mail_bytes(Path::new(&target_path), &attachment.bytes)?;
        Ok(MailDownloadAttachmentResult {
            path: target_path,
            name: attachment.name,
            content_type: attachment.content_type,
            size: attachment.bytes.len(),
        })
    })
    .await
}

async fn download_legacy_attachment(
    state: &State<'_, AppState>,
    account: ResolvedMailAccount,
    folder: String,
    uid: u32,
    attachment_index: usize,
    target_path: String,
    section: Option<String>,
) -> Result<MailDownloadAttachmentResult, String> {
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| {
                imap.download_attachment(
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
    .map_err(|e| format!("mail attachment download task failed: {e}"))?
}
