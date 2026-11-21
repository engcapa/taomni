//! Read or export the original MIME message for a saved mail account.

use super::*;

#[tauri::command]
pub async fn mail_fetch_raw(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if pop3::is_pop3(&config) {
        return local_cmds::raw(&state, &config.session_id, folder.trim(), uid)
            .map(|raw| String::from_utf8_lossy(&raw).to_string());
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let saved_folder = folder.clone();
    if let Some(original) = with_mail_original(&state, &config.session_id, move |db, account| {
        storage::open(db, account, &saved_folder, uid)
    })
    .await?
    {
        return decode_mail_original(move || {
            Ok(String::from_utf8_lossy(&original.read()?).into_owned())
        })
        .await;
    }
    let raw = fetch_original_from_server(&state, config, &folder, uid).await?;
    Ok(String::from_utf8_lossy(&raw).to_string())
}

#[tauri::command]
pub async fn mail_save_raw(
    config: MailAccountConfig,
    folder: String,
    uid: u32,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<MailDownloadAttachmentResult, String> {
    if pop3::is_pop3(&config) {
        let raw = local_cmds::raw(&state, &config.session_id, folder.trim(), uid)?;
        let path = write_attachment_file(target_path.trim(), &raw)?;
        return Ok(MailDownloadAttachmentResult {
            path,
            name: None,
            content_type: Some("message/rfc822".into()),
            size: raw.len(),
        });
    }
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    if target_path.trim().is_empty() {
        return Err("target path is required".into());
    }
    let saved_folder = folder.clone();
    let saved_target = target_path.clone();
    if let Some(original) = with_mail_original(&state, &config.session_id, move |db, account| {
        storage::open(db, account, &saved_folder, uid)
    })
    .await?
    {
        let size = decode_mail_original(move || original.export(Path::new(&saved_target))).await?;
        return Ok(MailDownloadAttachmentResult {
            path: target_path,
            name: None,
            content_type: Some("message/rfc822".into()),
            size: size as usize,
        });
    }
    let raw = fetch_original_from_server(&state, config, &folder, uid).await?;
    tokio::task::spawn_blocking(move || publish_original(&target_path, &raw))
        .await
        .map_err(|error| format!("mail save raw task failed: {error}"))?
}

async fn fetch_original_from_server(
    state: &State<'_, AppState>,
    config: MailAccountConfig,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    let account = resolve_config(state, config)?;
    if module_host::fetches_imap_raw(&state.plugins) {
        let first = module_host::fetch_imap_raw(state.plugins.clone(), &account, folder, uid).await;
        if first
            .as_ref()
            .is_err_and(|error| is_imap_transport_error(error))
        {
            return module_host::fetch_imap_raw(state.plugins.clone(), &account, folder, uid).await;
        }
        return first;
    }
    let pool = Arc::clone(&state.legacy.mail.mail_imap_pool);
    let runtime = tokio::runtime::Handle::current();
    let folder = folder.to_owned();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &runtime,
            ImapSessionOpts::default(),
            |imap| imap.fetch_raw(&folder, uid),
        )
    })
    .await
    .map_err(|error| format!("mail fetch raw task failed: {error}"))?
}

fn publish_original(
    target_path: &str,
    bytes: &[u8],
) -> Result<MailDownloadAttachmentResult, String> {
    let path = Path::new(target_path);
    attachment_files::publish_mail_bytes(path, bytes)?;
    Ok(MailDownloadAttachmentResult {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned()),
        content_type: Some("message/rfc822".into()),
        size: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_original_bytes_over_existing_eml() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("message.eml");
        std::fs::write(&target, b"older export").unwrap();

        let original = b"Subject: Source\r\n\r\noriginal bytes: \xff\r\n";
        let exported = publish_original(target.to_str().unwrap(), original).unwrap();

        assert_eq!(std::fs::read(target).unwrap(), original);
        assert_eq!(exported.content_type.as_deref(), Some("message/rfc822"));
        assert_eq!(exported.size, original.len());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
