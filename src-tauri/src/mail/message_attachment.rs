//! Save cached attachments or fetch them through the signed Mail host.

use super::*;
use module_host::imap_archive_original;
use taomni_mail_api::archive_original::ImapArchiveAction;
use taomni_mail_api::{ATTACHMENT_CACHE, attachment_cache::AttachmentKey};

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
        )
        .await;
    }
    let target_path = target_path.trim().to_string();
    if target_path.is_empty() {
        return Err("attachment download path is required".into());
    }
    let section = section
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if imap_archive_original::supported(&state.plugins) {
        if let Some(receipt) = imap_archive_original::save(
            state.plugins.clone(),
            state.mail_db(&config.session_id)?,
            &config.session_id,
            &folder,
            uid,
            ImapArchiveAction::Attachment {
                index: attachment_index,
                section: section.clone(),
            },
            Path::new(&target_path),
        )
        .await?
        {
            return Ok(MailDownloadAttachmentResult {
                path: target_path,
                name: receipt.name,
                content_type: receipt.content_type,
                size: receipt.size,
            });
        }
    } else if let Some(original) =
        message_source::open_legacy_original(&state, &config.session_id, &folder, uid).await?
    {
        return decode_mail_original(move || {
            let raw = original.read()?;
            let attachment = match section.as_deref() {
                Some(section) => extract_attachment_section(&raw, section),
                None => extract_attachment(&raw, attachment_index),
            }?;
            let path = write_attachment_file(&target_path, &attachment.bytes)?;
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
    // Resolve cache paths from the shared DB handle on each I/O operation,
    // including after a concurrent storage relocation. File copies run off Tokio.
    let cache_key = account.config.cache.attachment_cache.then(|| {
        section
            .clone()
            .unwrap_or_else(|| format!("i{attachment_index}"))
    });
    let cache_account = account.config.session_id.clone();
    let cache_folder = folder.clone();
    if let Some(part) = &cache_key
        && local_storage::is_hosted(&state, &cache_account, ATTACHMENT_CACHE).await?
    {
        let key = AttachmentKey {
            account_id: cache_account,
            folder: cache_folder,
            uid,
            part: part.clone(),
        };
        if let Some(size) = attachment_storage::load(&state, &key, Path::new(&target_path)).await? {
            return Ok(MailDownloadAttachmentResult {
                path: target_path,
                name: None,
                content_type: None,
                size: size as usize,
            });
        }
        return download_host_attachment(
            &state,
            &account,
            &folder,
            uid,
            attachment_index,
            target_path,
            section.as_deref(),
            Some(key),
        )
        .await;
    }
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
                let size = attachment_storage::publish_cached_file(&mut cached, target)
                    .map_err(|e| e.to_string())?;
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
            None,
        )
        .await?
    } else {
        legacy_imap!({
            download_legacy_attachment(
                &state,
                account,
                folder,
                uid,
                attachment_index,
                target_path,
                section,
            )
            .await
        })?
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
    cache_key: Option<AttachmentKey>,
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
    let (result, bytes) = decode_mail_original(move || {
        attachment_files::publish_mail_bytes(Path::new(&target_path), &attachment.bytes)?;
        Ok((
            MailDownloadAttachmentResult {
                path: target_path,
                name: attachment.name,
                content_type: attachment.content_type,
                size: attachment.bytes.len(),
            },
            attachment.bytes,
        ))
    })
    .await?;
    if let Some(key) = cache_key {
        // Cache the bytes that were actually saved, even if the destination
        // was later replaced by another download. The user file is complete.
        let _ = module_host::attachment_cache::store(
            state.plugins.clone(),
            key,
            bytes.as_slice(),
            bytes.len() as u64,
        )
        .await;
    }
    Ok(result)
}

#[cfg(any(test, feature = "legacy-mail-imap"))]
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
