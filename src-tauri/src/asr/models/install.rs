use super::download::download_to_part;
use super::download::publish_verified_cancellable;
use super::download::retire_replaced_model;
use super::installation::CANCELLATION;
use super::installation::INSTALL;
use super::installation::InstallationReporter;
use super::proxy::download_client;
use super::proxy::resolve_download_proxy;
use crate::asr::catalog;
use crate::state::AppState;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn voice_install_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    source_path: Option<String>,
    replace_model_id: Option<String>,
) -> Result<(), String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    let m = catalog::model(&model_id)?;
    let previous = if let Some(old) = replace_model_id.as_deref() {
        if catalog::replacement(old) != Some(m.id) {
            return Err("Invalid model replacement".into());
        }
        Some(catalog::model(old)?)
    } else {
        None
    };
    let target = catalog::path(m);
    let offline = source_path.is_some();
    let part = target.with_extension(if offline {
        "bin.import.part"
    } else {
        "bin.part"
    });
    let cancel = CancellationToken::new();
    let job_id = uuid::Uuid::new_v4().to_string();
    *CANCELLATION.lock().unwrap() = Some((job_id.clone(), cancel.clone()));
    let mut reporter = InstallationReporter {
        app: &app,
        model: m,
        job_id,
        bytes: 0,
        offset: 0,
        finished: false,
    };
    reporter.report(
        if source_path.is_some() {
            "importing"
        } else {
            "connecting"
        },
        0,
        None,
    );
    let result: Result<(), String> = async {
        std::fs::create_dir_all(target.parent().ok_or("Invalid model directory")?)
            .map_err(|e| e.to_string())?;
        if m.id == "sensevoice-small" {
            let token_model = &catalog::SENSE_TOKENS;
            let token_target = target.with_file_name("tokens.txt");
            if catalog::verify(token_model, &token_target).is_err() {
                let token_part = token_target.with_extension("txt.part");
                if let Some(source) = source_path.as_ref() {
                    let source_tokens = std::path::Path::new(source).with_file_name("tokens.txt");
                    tokio::fs::copy(source_tokens, &token_part).await.map_err(
                        |_| "MODEL_MISSING: place tokens.txt beside the imported SenseVoice model",
                    )?;
                } else {
                    let settings = state.ai_ctx.read().await.config.asr.download_proxy.clone();
                    let proxy = resolve_download_proxy(&state, &settings)?;
                    let client = download_client(proxy.as_ref())?;
                    download_to_part(
                        &client,
                        &catalog::download_url(token_model),
                        token_model.bytes,
                        &token_part,
                        &cancel,
                        |phase, bytes| reporter.report(phase, bytes, None),
                    )
                    .await?;
                }
                publish_verified_cancellable(
                    token_model,
                    &token_part,
                    &token_target,
                    Some(&cancel),
                )?;
            }
            reporter.offset = token_model.bytes;
        }
        if let Some(source) = source_path {
            if tokio::fs::metadata(&source)
                .await
                .map_err(|e| e.to_string())?
                .len()
                != m.bytes
            {
                return Err("Incorrect model file size".into());
            }
            // Separate import scratch file preserves a paused network download.
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut input = tokio::fs::File::open(source)
                .await
                .map_err(|e| e.to_string())?;
            let mut output = tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?;
            let mut buffer = vec![0; 1024 * 1024];
            let mut bytes = 0;
            loop {
                let count = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("CANCELLED".into()),
                    read = input.read(&mut buffer) => read.map_err(|e| e.to_string())?,
                };
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > m.bytes {
                    return Err("Model exceeds expected size".into());
                }
                output
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|e| e.to_string())?;
                reporter.report("importing", bytes, None);
            }
            output.sync_all().await.map_err(|e| e.to_string())?;
        } else {
            let settings = state.ai_ctx.read().await.config.asr.download_proxy.clone();
            let proxy = resolve_download_proxy(&state, &settings)?;
            let client = download_client(proxy.as_ref())?;
            download_to_part(
                &client,
                &catalog::download_url(m),
                m.bytes,
                &part,
                &cancel,
                |phase, bytes| reporter.report(phase, bytes, None),
            )
            .await?;
        }
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        reporter.report("verifying", m.bytes, None);
        let install_target = target.clone();
        let install_part = part.clone();
        let verification_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            publish_verified_cancellable(
                m,
                &install_part,
                &install_target,
                Some(&verification_cancel),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(old) = previous {
            // Explicit replacement only. Publication and verification precede
            // any config migration or removal of the user's working f16 file.
            let mut ai = state.ai_ctx.write().await;
            if ai.config.asr.active == old.id {
                let mut updated = ai.config.clone();
                updated.asr.active = m.id.into();
                updated
                    .save(&crate::ai::config::default_ai_config_path())
                    .map_err(|e| e.to_string())?;
                ai.config = updated;
                ai.asr = std::sync::Arc::new(super::super::manager::AsrManager::configured(
                    m.id,
                    &ai.config.asr.language,
                ));
            }
            retire_replaced_model(&crate::models::store::models_root(), old, m)?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = &result {
        // Interrupted network transfers remain resumable; rejected weights do not.
        if offline || error.starts_with("MODEL_CORRUPT") {
            let _ = std::fs::remove_file(&part);
        }
        let bytes = std::fs::metadata(&part).map(|v| v.len()).unwrap_or(0);
        reporter.report(
            if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            },
            bytes,
            (error != "CANCELLED").then(|| error.clone()),
        );
    } else {
        if offline {
            let _ = std::fs::remove_file(target.with_extension("bin.part"));
        }
        reporter.report("complete", m.bytes, None);
    }
    result
}
