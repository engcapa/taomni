use super::*;

impl MediaGenerationKind {
    pub(super) fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            other => Err(format!(
                "Invalid media generation kind '{other}': expected 'image' or 'video'."
            )),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }
}

pub(super) fn resolve_ai_api_key(
    provider_id: &str,
    api_key: &str,
    state: &AppState,
) -> Result<String, String> {
    if !api_key.starts_with(crate::vault::VAULT_REF_PREFIX) {
        if api_key.trim().is_empty() {
            return Err(format!("Provider '{provider_id}' is missing an API key."));
        }
        return Ok(api_key.to_string());
    }
    match state.vault.resolve(api_key) {
        Ok(Some(plaintext)) => Ok(plaintext.to_string()),
        Ok(None) => Ok(api_key.to_string()),
        Err(e) => {
            if e.contains(crate::vault::ERR_VAULT_LOCKED) {
                Err(format!(
                    "VAULT_LOCKED: provider '{provider_id}' needs the vault unlocked to load its API key"
                ))
            } else {
                Err(e)
            }
        }
    }
}

pub(super) fn provider_api_url(provider_base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        provider_base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

pub(super) fn provider_gateway_root(provider_base_url: &str) -> String {
    provider_base_url
        .trim_end_matches('/')
        .strip_suffix("/v1")
        .unwrap_or_else(|| provider_base_url.trim_end_matches('/'))
        .to_string()
}

pub(super) fn provider_error(status: u16, body: String) -> String {
    let parsed: Result<Value, _> = serde_json::from_str(&body);
    let message = parsed
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| error.as_str())
                })
                .map(str::to_string)
        })
        .unwrap_or(body);
    format!("Provider error {status}: {message}")
}

pub(super) fn decode_base64_image(value: &str) -> Result<(Vec<u8>, String), String> {
    let trimmed = value.trim();
    let (mime, data) = if let Some(rest) = trimmed.strip_prefix("data:") {
        let Some((mime, b64)) = rest.split_once(";base64,") else {
            return Err("Invalid Data URI image response.".into());
        };
        (mime.to_string(), b64)
    } else {
        ("image/png".to_string(), trimmed)
    };
    let bytes = BASE64_STANDARD
        .decode(data)
        .map_err(|e| format!("Decode generated image: {e}"))?;
    let inferred = infer_image_mime(&bytes).unwrap_or(mime);
    Ok((bytes, inferred))
}

pub(super) fn infer_image_mime(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png".into())
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg".into())
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp".into())
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif".into())
    } else {
        None
    }
}

pub(super) fn extension_for_mime(mime: &str, fallback: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => match fallback {
            "image" => "png",
            "video" => "mp4",
            _ => "bin",
        },
    }
}

pub(super) fn generation_output_path(
    app: &AppHandle,
    kind: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    let base = crate::resolved_app_data_dir(app)?
        .join("ai-generations")
        .join(chrono::Local::now().format("%Y-%m-%d").to_string());
    std::fs::create_dir_all(&base).map_err(|e| format!("Create generation output dir: {e}"))?;
    Ok(base.join(format!(
        "{}-{}-{}.{}",
        kind,
        chrono::Local::now().format("%H%M%S"),
        Uuid::new_v4().simple(),
        ext
    )))
}

pub(super) async fn save_generated_bytes(
    app: &AppHandle,
    kind: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<PathBuf, String> {
    let ext = extension_for_mime(mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Save generated {kind}: {e}"))?;
    Ok(path)
}

pub(super) async fn download_url_to_file(
    client: &Client,
    app: &AppHandle,
    kind: &str,
    url: &str,
    default_mime: &str,
) -> Result<(PathBuf, String, u64), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download generated {kind}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_mime)
        .to_string();
    let ext = extension_for_mime(&mime, kind);
    let path = generation_output_path(app, kind, ext)?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Create generated {kind} file: {e}"))?;
    let mut total = 0_u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download generated {kind}: {e}"))?;
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("Generated {kind} is too large."))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write generated {kind}: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Flush generated {kind}: {e}"))?;
    Ok((path, mime, total))
}

pub(super) async fn generate_image_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    prompt: &str,
    size: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .image_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_IMAGE_MODEL)
        .to_string();
    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "return_base64": true,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "images/generations"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Generate image: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let api_resp: AgnesImageResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse image response: {e}"))?;
    let first = api_resp
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "Image generation returned no data.".to_string())?;
    let remote_url = first.url.clone();
    let (path, mime, size) = if let Some(b64) = first.b64_json {
        let (bytes, mime) = decode_base64_image(&b64)?;
        let path = save_generated_bytes(app, "image", &bytes, &mime).await?;
        let size = bytes.len() as u64;
        (path, mime, size)
    } else if let Some(url) = &first.url {
        download_url_to_file(client, app, "image", url, "image/png").await?
    } else {
        return Err("Image generation response contained neither b64_json nor url.".into());
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-image.png")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url,
        video_id: None,
        model,
    })
}

pub(super) fn validate_video_num_frames(num_frames: u32) -> Result<u32, String> {
    if num_frames == 0 || num_frames > 441 {
        return Err("num_frames must be between 1 and 441.".into());
    }
    if (num_frames + 7) % 8 != 0 {
        return Err("num_frames must follow the 8n + 1 rule, for example 81 or 121.".into());
    }
    Ok(num_frames)
}

pub(super) async fn generate_video_file(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    req: &ChatGenerateMediaRequest,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    let model = provider
        .video_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(AGNES_DEFAULT_VIDEO_MODEL)
        .to_string();
    let num_frames = validate_video_num_frames(req.num_frames.unwrap_or(DEFAULT_VIDEO_NUM_FRAMES))?;
    let frame_rate = req
        .frame_rate
        .unwrap_or(DEFAULT_VIDEO_FRAME_RATE)
        .clamp(1, 60);
    let body = json!({
        "model": model,
        "prompt": prompt,
        "height": req.height.unwrap_or(DEFAULT_VIDEO_HEIGHT),
        "width": req.width.unwrap_or(DEFAULT_VIDEO_WIDTH),
        "num_frames": num_frames,
        "frame_rate": frame_rate,
    });
    let resp = client
        .post(provider_api_url(&provider.base_url, "videos"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Create video task: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), body));
    }
    let create_resp: AgnesVideoCreateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse video task response: {e}"))?;
    let video_id = create_resp
        .video_id
        .clone()
        .or(create_resp.id.clone())
        .or(create_resp.task_id.clone())
        .ok_or_else(|| "Video task response did not include video_id or task_id.".to_string())?;
    let gateway_root = provider_gateway_root(&provider.base_url);
    let mut last_status = create_resp.status.unwrap_or_else(|| "queued".into());
    let mut last_progress = 0_u32;
    let mut final_url: Option<String> = None;
    for _ in 0..VIDEO_POLL_ATTEMPTS {
        let resp = client
            .get(format!("{gateway_root}/agnesapi"))
            .bearer_auth(api_key)
            .query(&[
                ("video_id", video_id.as_str()),
                ("model_name", model.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Poll video task: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(provider_error(status.as_u16(), body));
        }
        let result: AgnesVideoResultResponse = resp
            .json()
            .await
            .map_err(|e| format!("Parse video result response: {e}"))?;
        last_status = result.status.unwrap_or(last_status);
        last_progress = result.progress.unwrap_or(last_progress);
        if last_status == "completed" {
            final_url = result.remixed_from_video_id.or(result.video_url);
            break;
        }
        if last_status == "failed" {
            return Err(format!(
                "Video generation failed: {}",
                result
                    .error
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown error".into())
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(VIDEO_POLL_INTERVAL_SECS)).await;
    }
    let Some(remote_url) = final_url else {
        return Err(format!(
            "Video generation timed out while status was '{last_status}' ({last_progress}%)."
        ));
    };
    let (path, mime, size) =
        download_url_to_file(client, app, "video", &remote_url, "video/mp4").await?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("generated-video.mp4")
        .to_string();
    Ok(GeneratedMediaFile {
        path,
        name,
        size,
        mime,
        remote_url: Some(remote_url),
        video_id: Some(video_id),
        model,
    })
}

pub(super) fn provider_supports_media_generation(
    provider: &crate::ai::config::LlmProviderConfig,
    kind: MediaGenerationKind,
) -> bool {
    match kind {
        MediaGenerationKind::Image => provider.capabilities.image_generation,
        MediaGenerationKind::Video => provider.capabilities.video_generation,
    }
}

pub(super) async fn generate_media_with_provider_key(
    client: &Client,
    app: &AppHandle,
    provider: &crate::ai::config::LlmProviderConfig,
    api_key: &str,
    req: &ChatGenerateMediaRequest,
    kind: MediaGenerationKind,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    match kind {
        MediaGenerationKind::Image => {
            let size = req
                .size
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_IMAGE_SIZE);
            generate_image_file(client, app, provider, api_key, prompt, size).await
        }
        MediaGenerationKind::Video => {
            generate_video_file(client, app, provider, api_key, req, prompt).await
        }
    }
}

pub(super) fn build_provider_http_client(
    state: &AppState,
    provider: &crate::ai::config::LlmProviderConfig,
    timeout: std::time::Duration,
) -> Result<Client, String> {
    let proxy_url = {
        let db = state
            .db
            .lock()
            .map_err(|_| "session database is unavailable".to_string())?;
        crate::ai::config::resolve_provider_proxy_url(provider, Some(&db), Some(&state.vault))?
    };
    let mut builder = Client::builder().no_proxy().timeout(timeout);
    if let Some(proxy_url) = proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("Create provider HTTP client: {e}"))
}

pub(super) async fn generate_media_with_provider_keys(
    state: &AppState,
    app: &AppHandle,
    provider_id: &str,
    provider: &crate::ai::config::LlmProviderConfig,
    req: &ChatGenerateMediaRequest,
    kind: MediaGenerationKind,
    prompt: &str,
) -> Result<GeneratedMediaFile, String> {
    let api_keys = provider.effective_api_keys();
    let key_count = api_keys.len();
    let mut last_err: Option<String> = None;
    let client = build_provider_http_client(state, provider, std::time::Duration::from_secs(360))?;

    for _ in 0..key_count {
        let key_index = {
            let ai_ctx = state.ai_ctx.read().await;
            ai_ctx.llm.next_key_index(provider_id, key_count)
        };
        let Some(api_key_ref) = api_keys.get(key_index).copied() else {
            continue;
        };
        let api_key = match resolve_ai_api_key(provider_id, api_key_ref, state) {
            Ok(api_key) => api_key,
            Err(err) => {
                last_err = Some(err);
                continue;
            }
        };
        match generate_media_with_provider_key(&client, app, provider, &api_key, req, kind, prompt)
            .await
        {
            Ok(file) => return Ok(file),
            Err(err) => {
                tracing::warn!(
                    provider = %provider_id,
                    kind = kind.as_str(),
                    error = %err,
                    "media generation key failed, trying next key"
                );
                last_err = Some(err);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| format!("Provider '{provider_id}' has no API keys.")))
}

#[tauri::command]
pub async fn chat_generate_media(
    req: ChatGenerateMediaRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ChatGenerateMediaResponse, String> {
    {
        let ai_ctx = state.ai_ctx.read().await;
        if ai_ctx.config.fully_disabled {
            return Err("AI is fully disabled.".into());
        }
    }
    let kind = MediaGenerationKind::parse(&req.kind)?;
    let attachments = validate_chat_attachments(&req.attachments)?;
    let (thread, history) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let thread = store::get_thread(&db, &req.thread_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Thread '{}' not found", req.thread_id))?;
        let history = store::list_messages(&db, &req.thread_id).map_err(|e| e.to_string())?;
        (thread, history)
    };
    if thread.mode != kind.as_str() {
        return Err(format!(
            "Thread '{}' is a {} thread, not a {} generation thread.",
            thread.id,
            thread.mode,
            kind.as_str()
        ));
    }

    let (clean_prompt, redacted_count) = redact::redact(&req.prompt);
    let ai_config = AiConfig::load(&default_ai_config_path());

    let generated = if let Some(profile_id) =
        crate::agent::acp_bridge::profile_id_from_provider_id(&thread.provider_id)
    {
        let bridge = &ai_config.acp_bridge;
        let profile = bridge
            .profile(profile_id)
            .cloned()
            .ok_or_else(|| format!("ACP profile '{profile_id}' is not configured."))?;
        if !bridge.enabled
            || !profile.enabled
            || ai_config.fully_disabled
            || ai_config.full_local_mode
        {
            return Err("Grok CLI is unavailable in full-local / fully-disabled mode or its ACP profile is disabled.".into());
        }
        let supports_media = match kind {
            MediaGenerationKind::Image => profile.supports_image_generation(),
            MediaGenerationKind::Video => profile.supports_video_generation(),
        };
        if !supports_media {
            return Err(format!(
                "ACP profile '{profile_id}' does not support {} generation.",
                kind.as_str()
            ));
        }
        acp::generate_grok_media(
            &app,
            state.inner(),
            &req.thread_id,
            bridge,
            &profile,
            kind,
            &clean_prompt,
            &attachments,
        )
        .await?
    } else if let Some(group_id) = provider_group_id_from_route(&thread.provider_id) {
        let route_id = thread.provider_id.clone();
        let attempt_count = {
            let ai_ctx = state.ai_ctx.read().await;
            ai_ctx.llm.provider_group_len(&route_id).unwrap_or(0)
        };
        if attempt_count == 0 {
            return Err(format!(
                "Provider group '{group_id}' is not configured or has no providers."
            ));
        }

        let mut saw_supported_provider = false;
        let mut last_err: Option<String> = None;
        let mut generated: Option<GeneratedMediaFile> = None;
        for _ in 0..attempt_count {
            let provider_id = {
                let ai_ctx = state.ai_ctx.read().await;
                ai_ctx.llm.next_provider_in_group(&route_id)
            };
            let Some(provider_id) = provider_id else {
                continue;
            };
            let Some(provider) = ai_config.llm.providers.get(&provider_id).cloned() else {
                continue;
            };
            if !provider_supports_media_generation(&provider, kind) {
                continue;
            }
            saw_supported_provider = true;
            match generate_media_with_provider_keys(
                state.inner(),
                &app,
                &provider_id,
                &provider,
                &req,
                kind,
                &clean_prompt,
            )
            .await
            {
                Ok(file) => {
                    generated = Some(file);
                    break;
                }
                Err(err) => {
                    tracing::warn!(
                        group = %route_id,
                        provider = %provider_id,
                        kind = kind.as_str(),
                        error = %err,
                        "media generation provider failed, trying next group provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        if let Some(file) = generated {
            file
        } else if !saw_supported_provider {
            return Err(format!(
                "Provider group '{group_id}' does not support {} generation.",
                kind.as_str()
            ));
        } else {
            return Err(last_err.unwrap_or_else(|| {
                format!(
                    "Provider group '{group_id}' failed to generate {}.",
                    kind.as_str()
                )
            }));
        }
    } else {
        let provider = ai_config
            .llm
            .providers
            .get(&thread.provider_id)
            .cloned()
            .ok_or_else(|| format!("Provider '{}' is not configured.", thread.provider_id))?;
        if !provider_supports_media_generation(&provider, kind) {
            return Err(format!(
                "Provider '{}' does not support {} generation.",
                thread.provider_id,
                kind.as_str()
            ));
        }
        generate_media_with_provider_keys(
            state.inner(),
            &app,
            &thread.provider_id,
            &provider,
            &req,
            kind,
            &clean_prompt,
        )
        .await?
    };
    let display_path = normalize_path_for_display(generated.path.to_string_lossy().to_string());
    let mut assistant_content = match kind {
        MediaGenerationKind::Image => format!("Generated image saved to:\n{display_path}"),
        MediaGenerationKind::Video => format!("Generated video saved to:\n{display_path}"),
    };
    if let Some(remote_url) = &generated.remote_url {
        assistant_content.push_str("\n\nRemote URL:\n");
        assistant_content.push_str(remote_url);
    }
    if let Some(video_id) = &generated.video_id {
        assistant_content.push_str("\n\nVideo ID: ");
        assistant_content.push_str(video_id);
    }
    let ts = now();
    let user_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "user".into(),
        content: clean_prompt,
        created_at: ts,
        redacted: redacted_count > 0,
        attachments,
    };
    let assistant_msg = store::ChatMessage {
        id: Uuid::new_v4().to_string(),
        thread_id: req.thread_id.clone(),
        role: "assistant".into(),
        content: assistant_content,
        created_at: ts + 1,
        redacted: false,
        attachments: vec![store::ChatAttachment {
            id: Uuid::new_v4().to_string(),
            kind: kind.as_str().into(),
            path: display_path.clone(),
            name: generated.name,
            size: generated.size,
            mime: Some(generated.mime),
            preview_url: generated.remote_url.clone(),
        }],
    };
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        store::insert_message(&db, &user_msg).map_err(|e| e.to_string())?;
        store::insert_message(&db, &assistant_msg).map_err(|e| e.to_string())?;
        if history.is_empty() {
            let title = user_msg.content.chars().take(40).collect::<String>();
            store::update_thread_title(&db, &req.thread_id, &title).map_err(|e| e.to_string())?;
        }
    }

    Ok(ChatGenerateMediaResponse {
        user_message: user_msg,
        assistant_message: assistant_msg,
        redacted_count,
        saved_path: display_path,
        remote_url: generated.remote_url,
        video_id: generated.video_id,
        model: generated.model,
    })
}
