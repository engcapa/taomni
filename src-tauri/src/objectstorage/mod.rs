//! Object storage (S3 / S3-compatible / Azure Blob) connection sessions and
//! management.
//!
//! Mirrors the database module's multi-backend dispatch: one S3-family engine
//! (rusty-s3 over the shared reqwest client) covers AWS S3, Alibaba OSS via its
//! S3-compatible endpoint, and any S3-compatible provider (MinIO, Cloudflare
//! R2, Backblaze B2, Wasabi, Tencent COS, Ceph, ...); the official
//! `azure_storage_blob` SDK covers Azure Blob. Sessions persist in the shared
//! `sessions` table (`SessionType::S3` / `SessionType::AzureBlob`) with the
//! provider, endpoint, addressing style, auth type and `vault:` credential
//! refs carried in `options_json`. See `memory/object-storage-feature.md`.

pub mod azure;
pub mod config;
pub mod credentials;
pub mod s3;
pub mod session;
pub mod transfer;
pub mod types;

use std::path::PathBuf;
use std::sync::Arc;

use rusty_s3::Credentials;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::filebrowser::transfer as ft;
use crate::proxy::ResolvedProxy;
use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use azure::{AzureAuth, AzureClient};
use config::ObjectStorageConfig;
use s3::S3Client;
use session::OssHandle;
use types::{BucketEntry, ObjectListPage, ObjectMetadata};

pub use session::ObjectStorageSession;

/// Resolve a possibly-`vault:` reference to plaintext. Returns the original
/// string when it isn't a vault reference (inline plaintext).
fn resolve(state: &State<'_, AppState>, value: &Option<String>) -> Result<Option<String>, String> {
    match value.as_deref().filter(|s| !s.is_empty()) {
        Some(v) => match state.vault.resolve(v)? {
            Some(z) => Ok(Some((*z).clone())),
            None => Ok(Some(v.to_string())),
        },
        None => Ok(None),
    }
}

/// Build a live session from a connection config (credential resolution +
/// client construction). Does not insert it into the registry.
async fn build_session(
    state: &State<'_, AppState>,
    session_id: String,
    config: ObjectStorageConfig,
) -> Result<ObjectStorageSession, String> {
    match config.provider.as_str() {
        "azure" => {
            let (handle, forward_task) = build_azure(state, &config).await?;
            Ok(ObjectStorageSession {
                session_id,
                handle,
                default_location: config.default_container.clone(),
                cancel: CancellationToken::new(),
                forward_task,
                default_storage_class: config.storage_class.clone(),
            })
        }
        _ => {
            // Resolve credentials per the selected source (P6): static keys
            // (vault-resolved), environment, or a shared-config profile.
            let creds = match config.aws_auth.as_deref() {
                Some("environment") => credentials::from_environment()?,
                Some("profile") => {
                    credentials::from_profile(config.aws_profile.as_deref()).await?
                }
                _ => {
                    let key = resolve(state, &config.access_key_id)?
                        .ok_or("access key id is required")?;
                    let secret = resolve(state, &config.secret_access_key)?
                        .ok_or("secret access key is required")?;
                    let token = resolve(state, &config.session_token)?;
                    match token {
                        Some(t) => Credentials::new_with_token(key, secret, t),
                        None => Credentials::new(key, secret),
                    }
                }
            };

            // A profile may carry the region; use it when the form left region
            // blank (matters for AWS endpoint derivation).
            let mut config = config;
            if config.region.as_deref().unwrap_or("").is_empty()
                && config.aws_auth.as_deref() == Some("profile")
            {
                config.region = credentials::profile_region(config.aws_profile.as_deref());
            }

            let ep = config.resolve_s3_endpoint()?;
            let (http, forward_task) =
                build_http_client(state, config.network.as_ref(), &ep.url).await?;
            let default_location = ep.default_bucket.clone();
            let client = S3Client::new(http, creds, ep.url, ep.region, ep.style);
            Ok(ObjectStorageSession {
                session_id,
                handle: OssHandle::S3(client),
                default_location,
                cancel: CancellationToken::new(),
                forward_task,
                default_storage_class: config.storage_class.clone(),
            })
        }
    }
}

/// Construct the Azure handle plus any network-forward task. Auth precedence:
/// connection string, then the explicit `azure_auth` selector / present secret
/// (account key, SAS, or Entra ID bearer token).
async fn build_azure(
    state: &State<'_, AppState>,
    config: &ObjectStorageConfig,
) -> Result<(OssHandle, Option<JoinHandle<()>>), String> {
    let (account, base, auth) = if let Some(cs) = resolve(state, &config.connection_string)? {
        azure::parse_connection_string(&cs)?
    } else {
        let account = config
            .account_name
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or("azure account name is required")?;
        let base = azure::azure_base_url(
            &account,
            config.endpoint.as_deref(),
            config.endpoint_suffix.as_deref(),
        )?;
        let auth = resolve_azure_auth(state, config).await?;
        (account, base, auth)
    };

    let (http, forward_task) = build_http_client(state, config.network.as_ref(), &base).await?;
    Ok((
        OssHandle::Azure(AzureClient::new(http, account, base, auth)),
        forward_task,
    ))
}

/// Pick the Azure auth method from the explicit selector or, failing that, the
/// first present secret. `bearer` mints an Entra ID token (pasted or via the
/// Azure CLI).
async fn resolve_azure_auth(
    state: &State<'_, AppState>,
    config: &ObjectStorageConfig,
) -> Result<AzureAuth, String> {
    if config.azure_auth.as_deref() == Some("bearer") {
        let pasted = resolve(state, &config.azure_bearer_token)?;
        let token = azure::acquire_bearer_token(pasted.as_deref()).await?;
        return Ok(AzureAuth::Bearer(token));
    }
    if let Some(key) = resolve(state, &config.account_key)? {
        return Ok(AzureAuth::SharedKey(azure::decode_account_key(&key)?));
    }
    if let Some(sas) = resolve(state, &config.sas_token)? {
        return Ok(AzureAuth::Sas(sas.trim_start_matches('?').to_string()));
    }
    Err("provide an account key, SAS token, connection string, or Entra ID token".into())
}

/// Build the reqwest client for an object-storage engine, applying network
/// routing (P7):
/// - per-session HTTP/SOCKS5 proxy → native `reqwest` proxy;
/// - per-session SSH jump host → a loopback forwarder to the endpoint plus a
///   `reqwest` DNS override so TLS SNI / cert / Host stay correct;
/// - otherwise the app-level global proxy, like every other outbound module.
///
/// Returns the client and, for the jump path, the forwarder task (kept alive
/// for the session's lifetime).
async fn build_http_client(
    state: &State<'_, AppState>,
    network: Option<&NetworkSettings>,
    endpoint: &Url,
) -> Result<(reqwest::Client, Option<JoinHandle<()>>), String> {
    let mut builder = reqwest::Client::builder();
    let mut forward_task = None;

    let uses_proxy = network
        .map(|n| !matches!(n.proxy_kind.as_str(), "" | "none"))
        .unwrap_or(false);

    if uses_proxy {
        let mut net = network.cloned().expect("uses_proxy implies Some");
        if net.uses_jump_host() {
            crate::terminal::resolve_jump_credentials(state, &mut net)?;
            let host = endpoint
                .host_str()
                .ok_or("endpoint has no host for SSH-jump routing")?
                .to_string();
            let port = endpoint.port_or_known_default().unwrap_or(443);
            let fwd = crate::database::forward::start(host.clone(), port, net).await?;
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], fwd.local_port));
            builder = builder.resolve(&host, addr);
            forward_task = Some(fwd.task);
        } else {
            crate::terminal::resolve_proxy_session(state, &mut net)?;
            net.resolve_proxy_pass(&state.vault)?;
            let proxy = ResolvedProxy {
                kind: net.proxy_kind.clone(),
                host: net.proxy_host.clone(),
                port: net.proxy_port,
                username: net.proxy_user.clone(),
                password: net.proxy_pass.clone(),
            };
            builder = proxy.apply_to(builder);
        }
    } else if let Some(p) = crate::proxy::resolve_default(state).ok().flatten() {
        builder = p.apply_to(builder);
    }

    let client = builder
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;
    Ok((client, forward_task))
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<ObjectStorageSession>, String> {
    state
        .oss_sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active object-storage session for {session_id}"))
}

/// Open an object-storage connection and register it under `session_id`. An
/// existing session under the same id is replaced.
#[tauri::command]
pub async fn storage_attach(
    session_id: String,
    config: ObjectStorageConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = build_session(&state, session_id.clone(), config).await?;
    if let Some(old) = state
        .oss_sessions
        .write()
        .await
        .insert(session_id, Arc::new(session))
    {
        old.close();
    }
    Ok(())
}

/// Tear down a live object-storage session. Idempotent.
#[tauri::command]
pub async fn storage_detach(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(sess) = state.oss_sessions.write().await.remove(&session_id) {
        sess.close();
    }
    Ok(())
}

/// Connectivity check against an already-attached session.
#[tauri::command]
pub async fn storage_ping(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    get_session(&state, &session_id).await?.ping().await
}

/// Attach to a throwaway session, ping, and detach — used by the editor's
/// "Test connection" button.
#[tauri::command]
pub async fn storage_test_connection(
    config: ObjectStorageConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let probe_id = format!("storage-test-{}", uuid::Uuid::new_v4());
    let session = build_session(&state, probe_id, config).await?;
    let result = session.ping().await;
    session.close();
    result
}

#[tauri::command]
pub async fn storage_list_buckets(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<BucketEntry>, String> {
    get_session(&state, &session_id).await?.list_buckets().await
}

#[tauri::command]
pub async fn storage_list_objects(
    session_id: String,
    bucket: String,
    prefix: Option<String>,
    continuation: Option<String>,
    state: State<'_, AppState>,
) -> Result<ObjectListPage, String> {
    let sess = get_session(&state, &session_id).await?;
    sess.list_objects(&bucket, prefix.as_deref().unwrap_or(""), continuation.as_deref(), 1000)
        .await
}

#[tauri::command]
pub async fn storage_get_object_bytes(
    session_id: String,
    bucket: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    get_session(&state, &session_id)
        .await?
        .get_object_bytes(&bucket, &key)
        .await
}

#[tauri::command]
pub async fn storage_put_object_bytes(
    session_id: String,
    bucket: String,
    key: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .put_object_bytes(&bucket, &key, data)
        .await
}

#[tauri::command]
pub async fn storage_delete_object(
    session_id: String,
    bucket: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .delete_object(&bucket, &key)
        .await
}

#[tauri::command]
pub async fn storage_create_folder(
    session_id: String,
    bucket: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .create_folder(&bucket, &prefix)
        .await
}

#[tauri::command]
pub async fn storage_create_bucket(
    session_id: String,
    bucket: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id).await?.create_bucket(&bucket).await
}

#[tauri::command]
pub async fn storage_delete_bucket(
    session_id: String,
    bucket: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id).await?.delete_bucket(&bucket).await
}

/// Recursively delete a "folder" (everything under `prefix`).
#[tauri::command]
pub async fn storage_delete_prefix(
    session_id: String,
    bucket: String,
    prefix: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .delete_prefix(&bucket, &prefix)
        .await
}

#[tauri::command]
pub async fn storage_head_object(
    session_id: String,
    bucket: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<ObjectMetadata, String> {
    get_session(&state, &session_id).await?.head_object(&bucket, &key).await
}

#[tauri::command]
pub async fn storage_copy_object(
    session_id: String,
    src_bucket: String,
    src_key: String,
    dst_bucket: String,
    dst_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .copy_object(&src_bucket, &src_key, &dst_bucket, &dst_key)
        .await
}

/// Rename or move an object (server-side copy + delete source).
#[tauri::command]
pub async fn storage_move_object(
    session_id: String,
    src_bucket: String,
    src_key: String,
    dst_bucket: String,
    dst_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    get_session(&state, &session_id)
        .await?
        .move_object(&src_bucket, &src_key, &dst_bucket, &dst_key)
        .await
}

/// Generate a shareable read-only URL (presigned GET for S3, service SAS for
/// Azure), valid for `ttl_secs` seconds.
#[tauri::command]
pub async fn storage_share_url(
    session_id: String,
    bucket: String,
    key: String,
    ttl_secs: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    get_session(&state, &session_id)
        .await?
        .presign_get(&bucket, &key, ttl_secs)
}

/// Download an object to a local path, streaming with progress events
/// (`storage-progress-{transferId}` / `storage-transfer-complete-{transferId}`).
#[tauri::command]
pub async fn storage_download(
    session_id: String,
    transfer_id: String,
    bucket: String,
    key: String,
    local_path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = ft::register(&state, &transfer_id).await;
    let dest = PathBuf::from(&local_path);
    let result = session
        .download_to_file(&bucket, &key, &dest, &transfer_id, &handle, &app_handle)
        .await;
    ft::unregister(&state, &transfer_id).await;
    let final_path = dest.to_string_lossy().to_string();
    let payload = match &result {
        Ok(_) => ft::CompletePayload::ok(Some(final_path)),
        Err(e) => ft::CompletePayload::err(e),
    };
    let _ = app_handle.emit(&format!("storage-transfer-complete-{}", transfer_id), payload);
    result
}

/// Upload a local file to an object key, streaming with progress events.
/// `storage_class` overrides the session's default tier for this upload.
#[tauri::command]
pub async fn storage_upload(
    session_id: String,
    transfer_id: String,
    bucket: String,
    key: String,
    local_path: String,
    storage_class: Option<String>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let handle = ft::register(&state, &transfer_id).await;
    let local = PathBuf::from(&local_path);
    let result = session
        .upload_from_file(
            &local,
            &bucket,
            &key,
            storage_class.as_deref(),
            &transfer_id,
            &handle,
            &app_handle,
        )
        .await;
    ft::unregister(&state, &transfer_id).await;
    let payload = match &result {
        Ok(_) => ft::CompletePayload::ok(Some(key.clone())),
        Err(e) => ft::CompletePayload::err(e),
    };
    let _ = app_handle.emit(&format!("storage-transfer-complete-{}", transfer_id), payload);
    result
}

#[tauri::command]
pub async fn storage_cancel_transfer(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ft::cancel(&state, &transfer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn storage_pause_transfer(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ft::pause(&state, &transfer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn storage_resume_transfer(transfer_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ft::resume(&state, &transfer_id).await;
    Ok(())
}
