//! ASR installation is explicit, serialized and verified before atomic publication.
use super::catalog::{self, MODELS};
use crate::{
    proxy::{AppProxyConfig, ResolvedProxy},
    state::AppState,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A download takes one snapshot; changing settings affects the next download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DownloadProxyConfig {
    pub mode: String,
    pub custom: AppProxyConfig,
}
impl Default for DownloadProxyConfig {
    fn default() -> Self {
        Self {
            mode: "app".into(),
            custom: AppProxyConfig::default(),
        }
    }
}
fn selected_proxy_config(
    settings: &DownloadProxyConfig,
    app: AppProxyConfig,
) -> Result<Option<AppProxyConfig>, String> {
    let config = match settings.mode.as_str() {
        "none" => return Ok(None),
        "app" => app,
        "custom" => AppProxyConfig {
            enabled: true,
            ..settings.custom.clone()
        },
        _ => return Err("Unknown model download proxy mode".into()),
    };
    if !config.enabled {
        return Ok(None);
    }
    match config.mode.as_str() {
        "session" if !config.session_id.trim().is_empty() => {}
        "manual"
            if !config.host.trim().is_empty()
                && config.port > 0
                && ["http", "socks5"].contains(&config.kind.as_str()) => {}
        _ => return Err("Configure the model download proxy before downloading".into()),
    }
    Ok(Some(config))
}
fn download_client(proxy: Option<&ResolvedProxy>) -> Result<reqwest::Client, String> {
    // Always disable OS/environment auto-proxy. Only the selected route applies.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(1800));
    if let Some(proxy) = proxy {
        let url = proxy.to_url();
        // Resolve destination names at the SOCKS proxy, including HF redirects.
        let url = if proxy.kind == "socks5" {
            url.replacen("socks5://", "socks5h://", 1)
        } else {
            url
        };
        builder =
            builder.proxy(reqwest::Proxy::all(&url).map_err(|_| "Invalid model download proxy")?);
    }
    builder
        .build()
        .map_err(|_| "Cannot create model download client".into())
}
fn resolve_download_proxy(
    state: &AppState,
    settings: &DownloadProxyConfig,
) -> Result<Option<ResolvedProxy>, String> {
    let app = if settings.mode == "app" {
        AppProxyConfig::load(&crate::proxy::default_app_proxy_path())
    } else {
        AppProxyConfig::default()
    };
    let Some(config) = selected_proxy_config(settings, app)? else {
        return Ok(None);
    };
    crate::proxy::resolve(state, &config)?
        .map(Some)
        .ok_or_else(|| "Selected model download proxy is unavailable".into())
}

#[derive(Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    model: catalog::Model,
    installed: bool,
    license: &'static str,
    catalog_version: &'static str,
    available_version: &'static str,
    installed_version: Option<String>,
    update_available: bool,
    integrity: &'static str,
}
fn inventory(m: &catalog::Model, root: &std::path::Path, verify: bool) -> ModelStatus {
    let target = catalog::version_path(root, m);
    let exists = target.is_file();
    let mut installed = std::fs::metadata(&target)
        .map(|v| v.len() == m.bytes)
        .unwrap_or(false);
    let integrity = if !exists {
        "missing"
    } else if !installed {
        "corrupt"
    } else if verify {
        if catalog::verify(m, &target).is_ok() {
            "verified"
        } else {
            installed = false;
            "corrupt"
        }
    } else {
        "unverified"
    };
    let previous = std::fs::read_dir(root.join(m.id))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .find_map(|entry| {
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != m.sha256
                && version.len() == 64
                && version.bytes().all(|b| b.is_ascii_hexdigit())
                && entry.path().join(m.filename).is_file()
            {
                Some(version)
            } else {
                None
            }
        });
    let legacy = root.join(m.id).join(m.filename).is_file();
    ModelStatus {
        model: m.clone(),
        license: "MIT",
        catalog_version: catalog::CATALOG_VERSION,
        available_version: &m.sha256[..12],
        installed_version: if exists {
            Some(m.sha256[..12].into())
        } else {
            previous
                .as_ref()
                .map(|v| v[..12].into())
                .or_else(|| legacy.then(|| "legacy".into()))
        },
        update_available: !installed && (previous.is_some() || legacy),
        installed,
        integrity,
    }
}
#[tauri::command]
pub fn voice_models() -> Vec<ModelStatus> {
    let root = crate::models::store::models_root();
    MODELS.iter().map(|m| inventory(m, &root, false)).collect()
}
/// Explicit integrity/version check uses the catalog shipped with this app.
/// No unreviewed upstream revision or network source silently changes the model.
#[tauri::command]
pub async fn voice_check_models() -> Result<Vec<ModelStatus>, String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    tokio::task::spawn_blocking(|| {
        let root = crate::models::store::models_root();
        MODELS.iter().map(|m| inventory(m, &root, true)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn voice_install_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    source_path: Option<String>,
) -> Result<(), String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    let m = catalog::model(&model_id)?;
    let target = catalog::path(m);
    std::fs::create_dir_all(target.parent().ok_or("Invalid model directory")?)
        .map_err(|e| e.to_string())?;
    let part = target.with_extension("bin.part");
    let result: Result<(), String> = async {
        if let Some(source) = source_path {
            if tokio::fs::metadata(&source)
                .await
                .map_err(|e| e.to_string())?
                .len()
                != m.bytes
            {
                return Err("Incorrect model file size".into());
            }
            let dest = part.clone();
            tokio::task::spawn_blocking(move || std::fs::copy(source, dest))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
        } else {
            // Explicit downloads use the official source; offline import works without network.
            let origin = format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}",
                catalog::UPSTREAM_REVISION
            );
            let settings = state.ai_ctx.read().await.config.asr.download_proxy.clone();
            let proxy = resolve_download_proxy(&state, &settings)?;
            let client = download_client(proxy.as_ref())?;
            let response = client
                .get(format!("{origin}/{}", m.filename))
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let mut file = tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = response.bytes_stream();
            let mut bytes = 0u64;
            let mut last = std::time::Instant::now();
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                bytes += chunk.len() as u64;
                if bytes > m.bytes {
                    return Err("Model exceeds expected size".into());
                }
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                if last.elapsed().as_millis() >= 200 || bytes == m.bytes {
                    let _ = app.emit(
                        "voice-model-progress",
                        serde_json::json!({"model_id": m.id, "bytes": bytes, "total": m.bytes}),
                    );
                    last = std::time::Instant::now();
                }
            }
            file.sync_all().await.map_err(|e| e.to_string())?;
        }
        let install_target = target.clone();
        let install_part = part.clone();
        tokio::task::spawn_blocking(move || publish_verified(m, &install_part, &install_target))
            .await
            .map_err(|e| e.to_string())??;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

fn publish_verified(
    m: &catalog::Model,
    part: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    catalog::verify(m, part)?;
    if target.exists() {
        if catalog::verify(m, target).is_ok() {
            // Never delete a valid current file on reinstall, including Windows.
            return std::fs::remove_file(part).map_err(|e| e.to_string());
        }
        // This is only the corrupt current revision; previous revisions have
        // different directories and are never modified by this transaction.
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    std::fs::rename(part, target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_proxy_modes_do_not_fall_back_to_another_route() {
        let app = AppProxyConfig {
            enabled: true,
            host: "app-proxy".into(),
            ..Default::default()
        };
        let mut settings = DownloadProxyConfig::default();
        assert_eq!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .unwrap()
                .host,
            "app-proxy"
        );
        assert!(
            selected_proxy_config(&settings, AppProxyConfig::default())
                .unwrap()
                .is_none()
        );
        settings.mode = "none".into();
        assert!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .is_none()
        );
        settings.mode = "custom".into();
        assert!(selected_proxy_config(&settings, app.clone()).is_err());
        settings.custom.host = "custom-proxy".into();
        assert_eq!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .unwrap()
                .host,
            "custom-proxy"
        );
        settings.custom.mode = "session".into();
        assert!(selected_proxy_config(&settings, app.clone()).is_err());
        settings.custom.session_id = "saved-proxy".into();
        assert_eq!(
            selected_proxy_config(&settings, app)
                .unwrap()
                .unwrap()
                .session_id,
            "saved-proxy"
        );
        let legacy: DownloadProxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.mode, "app");
        assert_eq!(
            serde_json::from_str::<DownloadProxyConfig>(&serde_json::to_string(&settings).unwrap())
                .unwrap(),
            settings
        );
    }

    #[tokio::test]
    async fn download_http_proxy_carries_redirected_requests() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for destination in ["model.invalid", "cdn.invalid"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(
                    request.starts_with(&format!("GET http://{destination}/weights ")),
                    "{request}"
                );
                let response = if destination == "model.invalid" {
                    "HTTP/1.1 302 Found\r\nLocation: http://cdn.invalid/weights\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let proxy = ResolvedProxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };
        let response = download_client(Some(&proxy))
            .unwrap()
            .get("http://model.invalid/weights")
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "abc");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn download_https_uses_connect_and_socks_uses_remote_dns() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count])
                    .starts_with("CONNECT huggingface.co:443 HTTP/1.1")
            );
            socket
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let mut proxy = ResolvedProxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };
        assert!(
            download_client(Some(&proxy))
                .unwrap()
                .get("https://huggingface.co/weights")
                .send()
                .await
                .is_err()
        );
        server.await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        proxy.port = listener.local_addr().unwrap().port();
        proxy.kind = "socks5".into();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 2];
            socket.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            socket.read_exact(&mut methods).await.unwrap();
            socket.write_all(&[5, 0]).await.unwrap();
            let mut connect = [0; 5];
            socket.read_exact(&mut connect).await.unwrap();
            assert_eq!(&connect[..4], &[5, 1, 0, 3]); // Domain name, not local DNS.
            let mut host = vec![0; connect[4] as usize];
            socket.read_exact(&mut host).await.unwrap();
            assert_eq!(host, b"model.invalid");
            let mut port = [0; 2];
            socket.read_exact(&mut port).await.unwrap();
            assert_eq!(u16::from_be_bytes(port), 80);
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
                .await
                .unwrap();
        });
        assert_eq!(
            download_client(Some(&proxy))
                .unwrap()
                .get("http://model.invalid/weights")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "abc"
        );
        server.await.unwrap();
    }

    #[test]
    fn download_no_proxy_ignores_environment() {
        // Isolate process environment from concurrent tests (no unsafe set_var).
        const CHILD: &str = "TAOMNI_TEST_DIRECT_DOWNLOAD_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "asr::models::tests::download_no_proxy_ignores_environment",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("http_proxy", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env("all_proxy", "http://127.0.0.1:1")
                .env("NO_PROXY", "")
                .env("no_proxy", "")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = [0; 2048];
                socket.read(&mut data).await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                    )
                    .await
                    .unwrap();
            });
            assert_eq!(
                download_client(None)
                    .unwrap()
                    .get(format!("http://{addr}/weights"))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "abc"
            );
            server.await.unwrap();
        });
    }

    #[test]
    fn detects_catalog_updates_and_corruption_without_removing_old_versions() {
        let root = tempfile::tempdir().unwrap();
        let old = catalog::Model {
            id: "test",
            filename: "model.bin",
            bytes: 3,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
        let current = catalog::Model {
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ..old.clone()
        };
        let old_path = catalog::version_path(root.path(), &old);
        std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
        std::fs::write(&old_path, b"old").unwrap();
        let status = inventory(&current, root.path(), false);
        assert!(status.update_available);
        assert!(!status.installed);
        assert_eq!(status.installed_version.as_deref(), Some("aaaaaaaaaaaa"));
        let path = catalog::version_path(root.path(), &current);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"bad").unwrap();
        assert_eq!(inventory(&current, root.path(), true).integrity, "corrupt");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        let part = path.with_extension("bin.part");
        std::fs::write(&part, b"bad").unwrap();
        assert!(publish_verified(&current, &part, &path).is_err());
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        assert_eq!(std::fs::read(&path).unwrap(), b"bad");
        std::fs::write(&part, b"abc").unwrap();
        publish_verified(&current, &part, &path).unwrap();
        assert!(!part.exists());
        let status = inventory(&current, root.path(), true);
        assert!(status.installed);
        assert!(!status.update_available);
        assert_eq!(status.integrity, "verified");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
    }
}
