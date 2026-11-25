//! Read migrated attachments through the active host. A modular profile can
//! still have a cache from before the installed Mail package owned the files.
use std::fs::File;
use std::io::{self, Seek};
use std::path::Path;
use taomni_mail_api::attachment_cache::AttachmentKey;

use super::{local_storage, module_host::attachment_cache, storage};
use crate::state::AppState;

pub(super) async fn load(
    state: &AppState,
    key: &AttachmentKey,
    target: &Path,
) -> Result<Option<u64>, String> {
    if let Some(size) =
        attachment_cache::save_to_target(state.plugins.clone(), key.clone(), target).await?
    {
        return Ok(Some(size));
    }
    let core = state.core.clone();
    let registry = state.plugins.clone();
    let migrated = state.legacy.mail.migrated.clone();
    let root = state.mail_cache_root().to_owned();
    let part = key.clone();
    let target = target.to_owned();
    let cached = tokio::task::spawn_blocking(move || {
        let (_, found) = local_storage::import_source(
            &core,
            &registry,
            migrated,
            &root,
            &part.account_id,
            |db, account| {
                taomni_mail_storage::migration::legacy_attachment(
                    db,
                    account,
                    &part.folder,
                    part.uid,
                    &part.part,
                )
                .map_err(storage::as_sql_error)
            },
        )?;
        found
            .flatten()
            .map(|mut source| {
                let size = publish_cached_file(&mut source, &target).map_err(|e| e.to_string())?;
                Ok::<_, String>((source, size))
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some((mut source, size)) = cached else {
        return Ok(None);
    };
    if source.rewind().is_ok() {
        let _ = attachment_cache::store(
            state.plugins.clone(),
            key.clone(),
            tokio::fs::File::from_std(source),
            size,
        )
        .await;
    }
    Ok(Some(size))
}

pub(super) fn publish_cached_file(source: &mut File, target: &Path) -> io::Result<u64> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    let size = io::copy(source, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    temp.persist(target).map_err(|e| e.error)?;
    Ok(size)
}
