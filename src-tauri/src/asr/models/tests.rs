use super::download::download_to_part;
#[cfg(test)]
use super::download::publish_verified;
use super::download::publish_verified_cancellable;
use super::download::retire_replaced_model;
use super::installation::CANCELLATION;
use super::installation::InstallationTracker;
use super::installation::voice_cancel_model_installation;
use super::inventory::inventory;
use super::proxy::DownloadProxyConfig;
use super::proxy::download_client;
use super::proxy::selected_proxy_config;
use super::sherpa_inventory::SHERPA_REVISION_FILE;
use super::sherpa_inventory::active_sherpa_dir;
use crate::asr::catalog;
use crate::proxy::AppProxyConfig;
use crate::proxy::ResolvedProxy;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

#[test]
fn incomplete_bundle_keeps_previous_revision_and_rejects_unsafe_marker() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let old = "a".repeat(40);
    let new = "b".repeat(40);
    std::fs::create_dir(root.join(&old)).unwrap();
    std::fs::create_dir(root.join(&new)).unwrap();
    std::fs::write(root.join(&old).join(SHERPA_REVISION_FILE), &old).unwrap();
    std::fs::write(root.join(".active"), &old).unwrap();
    std::fs::write(root.join(&new).join("encoder.part"), b"partial").unwrap();
    assert_eq!(active_sherpa_dir(root.into(), &new), root.join(&old));
    std::fs::write(root.join(&new).join(SHERPA_REVISION_FILE), &new).unwrap();
    assert_eq!(active_sherpa_dir(root.into(), &new), root.join(&new));
    std::fs::remove_file(root.join(&new).join(SHERPA_REVISION_FILE)).unwrap();
    std::fs::write(root.join(".active"), "../escape").unwrap();
    assert_eq!(active_sherpa_dir(root.into(), &new), root);
}

#[test]
fn replacement_keeps_working_weights_until_new_hash_is_verified() {
    let root = tempfile::tempdir().unwrap();
    let old = catalog::Model {
        id: "old",
        filename: "old.bin",
        bytes: 3,
        sha256: "old",
    };
    let new = catalog::Model {
        id: "new",
        filename: "new.bin",
        bytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    };
    let old_path = catalog::version_path(root.path(), &old);
    let new_path = catalog::version_path(root.path(), &new);
    std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(new_path.parent().unwrap()).unwrap();
    std::fs::write(&old_path, b"old").unwrap();
    assert!(retire_replaced_model(root.path(), &old, &new).is_err());
    std::fs::write(&new_path, b"bad").unwrap();
    assert!(retire_replaced_model(root.path(), &old, &new).is_err());
    assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
    std::fs::write(&new_path, b"abc").unwrap();
    retire_replaced_model(root.path(), &old, &new).unwrap();
    assert!(!old_path.exists());
    assert_eq!(std::fs::read(new_path).unwrap(), b"abc");
}
#[test]
fn stale_download_cancel_does_not_stop_a_new_job() {
    let token = CancellationToken::new();
    *CANCELLATION.lock().unwrap() = Some(("new-job".into(), token.clone()));
    voice_cancel_model_installation("old-job".into());
    assert!(!token.is_cancelled());
    voice_cancel_model_installation("new-job".into());
    assert!(token.is_cancelled());
    CANCELLATION.lock().unwrap().take();
}

#[tokio::test]
async fn download_range_resume_restart_and_invalid_range() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (status, range, body, valid) in [
        (
            "206 Partial Content",
            "Content-Range: bytes 3-5/6\r\n",
            "def",
            true,
        ),
        ("200 OK", "", "abcdef", true),
        (
            "206 Partial Content",
            "Content-Range: bytes 2-5/6\r\n",
            "cdef",
            false,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("model.part");
        std::fs::write(&part, b"abc").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count])
                    .to_lowercase()
                    .contains("range: bytes=3-")
            );
            socket.write_all(format!("HTTP/1.1 {status}\r\n{range}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let result = download_to_part(
            &download_client(None).unwrap(),
            &format!("http://{addr}/model"),
            6,
            &part,
            &CancellationToken::new(),
            |_, _| {},
        )
        .await;
        server.await.unwrap();
        assert_eq!(result.is_ok(), valid, "{result:?}");
        assert_eq!(
            std::fs::read(part).unwrap(),
            if valid {
                b"abcdef".as_slice()
            } else {
                b"abc".as_slice()
            }
        );
    }
}

#[tokio::test]
async fn cancelling_download_preserves_partial_and_allows_resume() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = tempfile::tempdir().unwrap();
    let part = root.path().join("model.part");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let release_server = cancel.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        socket.read(&mut request).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc")
            .await
            .unwrap();
        release_server.cancelled().await;
    });
    let signal = cancel.clone();
    let observed = part.clone();
    let cancellation = tokio::spawn(async move {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while tokio::fs::metadata(&observed)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
                < 3
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        signal.cancel();
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        download_to_part(
            &download_client(None).unwrap(),
            &format!("http://{addr}/model"),
            6,
            &part,
            &cancel,
            |_, _| {},
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), "CANCELLED");
    cancellation.await.unwrap();
    server.await.unwrap();
    assert_eq!(std::fs::read(&part).unwrap(), b"abc");
    // The next request resumes the file produced by actual cancellation.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        let count = socket.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..count])
                .to_lowercase()
                .contains("range: bytes=3-")
        );
        socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-5/6\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndef").await.unwrap();
    });
    download_to_part(
        &download_client(None).unwrap(),
        &format!("http://{addr}/model"),
        6,
        &part,
        &CancellationToken::new(),
        |_, _| {},
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(std::fs::read(&part).unwrap(), b"abcdef");
    let model = catalog::Model {
        id: "test",
        filename: "model.bin",
        bytes: 6,
        sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    };
    let target = root.path().join("model.bin");
    assert!(publish_verified_cancellable(&model, &part, &target, Some(&cancel)).is_err());
    assert!(!target.exists());
    publish_verified(&model, &part, &target).unwrap();
    assert_eq!(std::fs::read(target).unwrap(), b"abcdef");
}

#[test]
fn installation_snapshot_survives_observers_and_retains_terminal_results() {
    let tracker = InstallationTracker::default();
    let model = catalog::model("whisper-base").unwrap();
    assert!(tracker.snapshot().is_none());
    let connecting = tracker.update(model, "test-job", "connecting", 0, None);
    tracker.update(model, "test-job", "downloading", 1024, None);
    let reopened = tracker.snapshot().unwrap();
    assert_eq!(reopened.bytes, 1024);
    assert_eq!(reopened.phase, "downloading");
    assert!(reopened.revision > connecting.revision);
    let verifying = tracker.update(model, "test-job", "verifying", model.bytes, None);
    assert_eq!(verifying.phase, "verifying"); // 100% transfer is not completion.
    tracker.update(
        model,
        "test-job",
        "failed",
        1024,
        Some("connection lost".into()),
    );
    assert_eq!(
        tracker.snapshot().unwrap().error.as_deref(),
        Some("connection lost")
    );
    let retry = tracker.update(model, "test-job", "connecting", 0, None);
    assert!(retry.revision > verifying.revision);
    assert!(retry.error.is_none());
    tracker.update(model, "test-job", "complete", model.bytes, None);
    let completed = tracker.snapshot().unwrap();
    assert_eq!(completed.phase, "complete");
    assert_eq!(completed.bytes, completed.total);
    let status = inventory(model, tempfile::tempdir().unwrap().path(), false);
    assert_eq!(status.download_url, catalog::download_url(model));
    assert!(status.download_url.contains(catalog::UPSTREAM_REVISION));
    assert!(status.download_url.ends_with("ggml-base.bin?download=true"));
}

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
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
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
