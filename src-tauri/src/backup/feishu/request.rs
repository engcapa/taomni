//! Retry only requests whose failed outcome is safe to replay.
use crate::backup::{
    failure::{self, FailureKind},
    network,
    provider::TransferContext,
};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde_json::Value;
use std::{future::Future, time::Duration};

const ATTEMPTS: u32 = 3;

async fn backoff(
    ctx: &TransferContext,
    attempt: u32,
    hint: Option<Duration>,
) -> Result<(), String> {
    ctx.progress("retrying", 0, None);
    failure::wait(
        hint.unwrap_or(Duration::from_secs(1 << attempt.min(2))),
        &ctx.cancel,
    )
    .await
}

/// `read_only` permits replay after an unknown server/network outcome.
/// Writes retry only definitive rejection (401/429); a lost write response is
/// returned to the job, whose next attempt reconciles the remote artifact.
pub async fn json<F, R, Fut>(
    build: F,
    mut bearer: String,
    refresh: R,
    read_only: bool,
    ctx: &TransferContext,
) -> Result<Value, String>
where
    F: Fn(&str) -> RequestBuilder,
    R: Fn(String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let mut refreshed = false;
    let mut retries = 0;
    loop {
        ctx.check()?;
        let response = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err("BACKUP_CANCELLED".into()),
            result = build(&bearer).send() => result,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if read_only && retries < ATTEMPTS - 1 {
                    backoff(ctx, retries, None).await?;
                    retries += 1;
                    continue;
                }
                return Err(network::network_error(error));
            }
        };
        let status = response.status();
        let hint = failure::retry_after(response.headers());
        let value = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err("BACKUP_CANCELLED".into()),
            result = response.json::<Value>() => result,
        };
        // Preserve HTTP failure classification even when a gateway returns HTML.
        let value = match value {
            Ok(value) => value,
            Err(_) if !status.is_success() => Value::Null,
            Err(_) => {
                return Err(failure::tagged(
                    FailureKind::Transient,
                    "Invalid Feishu response; reconcile and retry",
                ));
            }
        };
        let code = value["code"].as_i64().unwrap_or(0);
        if status.is_success() && code == 0 && value.get("error").is_none() {
            return Ok(value);
        }
        let kind = failure::http_kind(status, code);
        if kind == FailureKind::Authorization && !refreshed {
            bearer = refresh(bearer.clone()).await?;
            refreshed = true;
            continue;
        }
        if kind == FailureKind::Transient
            && retries < ATTEMPTS - 1
            && (read_only || status == StatusCode::TOO_MANY_REQUESTS || code == 99991400)
        {
            backoff(ctx, retries, hint).await?;
            retries += 1;
            continue;
        }
        return Err(failure::tagged(
            kind,
            &format!(
                "Feishu request failed (HTTP {}, code {code})",
                status.as_u16()
            ),
        ));
    }
}

/// Status-level retries for byte downloads; body/range validation stays in transfer.
pub async fn download<F, R, Fut>(
    build: F,
    mut bearer: String,
    refresh: R,
    ctx: &TransferContext,
) -> Result<Response, String>
where
    F: Fn(&str) -> RequestBuilder,
    R: Fn(String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let mut refreshed = false;
    let mut retries = 0;
    loop {
        ctx.check()?;
        let result = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err("BACKUP_CANCELLED".into()),
            result = build(&bearer).send() => result,
        };
        match result {
            Ok(mut response) => {
                let status = response.status();
                if status.is_success() || status == StatusCode::RANGE_NOT_SATISFIABLE {
                    return Ok(response);
                }
                let hint = failure::retry_after(response.headers());
                // Feishu may return token errors as HTTP 400 with an API code.
                // Bound the error body; never consume successful archive bytes here.
                let mut body = Vec::new();
                while body.len() < 65_536 {
                    let chunk = tokio::select! {
                        _ = ctx.cancel.cancelled() => return Err("BACKUP_CANCELLED".into()),
                        result = response.chunk() => result,
                    };
                    match chunk {
                        Ok(Some(chunk)) if body.len() + chunk.len() <= 65_536 => {
                            body.extend_from_slice(&chunk)
                        }
                        _ => break,
                    }
                }
                let code = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|value| value["code"].as_i64())
                    .unwrap_or(0);
                let kind = failure::http_kind(status, code);
                if kind == FailureKind::Authorization && !refreshed {
                    bearer = refresh(bearer.clone()).await?;
                    refreshed = true;
                    continue;
                }
                if kind == FailureKind::Transient && retries < ATTEMPTS - 1 {
                    drop(response);
                    backoff(ctx, retries, hint).await?;
                    retries += 1;
                    continue;
                }
                return Err(failure::tagged(
                    kind,
                    &format!("Backup download failed (HTTP {})", status.as_u16()),
                ));
            }
            Err(error) => {
                if retries >= ATTEMPTS - 1 {
                    return Err(network::network_error(error));
                }
                backoff(ctx, retries, None).await?;
                retries += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let size = socket.read(&mut bytes).await.unwrap();
                requests.push(String::from_utf8_lossy(&bytes[..size]).into_owned());
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (url, task)
    }
    #[tokio::test]
    async fn rejected_token_refreshes_once_then_rate_limit_retries_with_new_token() {
        let (url, server) = server(vec![
            (401, "{}"),
            (429, "{}"),
            (200, r#"{"code":0,"data":{"ok":true}}"#),
        ])
        .await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let value = json(
            |token| client.get(&url).bearer_auth(token),
            "old".into(),
            |old| {
                assert_eq!(old, "old");
                count.fetch_add(1, Ordering::SeqCst);
                async { Ok("new".into()) }
            },
            true,
            &crate::backup::jobs::idle_context(),
        )
        .await
        .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(value["data"]["ok"], true);
        let requests = server.await.unwrap();
        assert!(requests[0].contains("Bearer old"));
        assert!(requests[1].contains("Bearer new"));
        assert!(requests[2].contains("Bearer new"));
    }
    #[tokio::test]
    async fn unknown_write_outcome_is_not_replayed_but_read_503_is_retried() {
        let (url, server) = server(vec![(503, "gateway unavailable")]).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = json(
            |token| client.post(&url).bearer_auth(token).body("payload"),
            "old".into(),
            |_| async { panic!("must not refresh") },
            false,
            &crate::backup::jobs::idle_context(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure::classify(&error), FailureKind::Transient);
        assert_eq!(server.await.unwrap().len(), 1);
        let (url, server) =
            self::server(vec![(503, "gateway unavailable"), (200, r#"{"code":0}"#)]).await;
        json(
            |token| client.get(&url).bearer_auth(token),
            "old".into(),
            |_| async { panic!("must not refresh") },
            true,
            &crate::backup::jobs::idle_context(),
        )
        .await
        .unwrap();
        assert_eq!(server.await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn second_unauthorized_response_requires_authorization_without_refresh_loop() {
        let (url, server) = server(vec![(401, "{}"), (401, "{}")]).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = json(
            |token| client.get(&url).bearer_auth(token),
            "old".into(),
            |_| async { Ok("new".into()) },
            true,
            &crate::backup::jobs::idle_context(),
        )
        .await
        .unwrap_err();
        assert_eq!(failure::classify(&error), FailureKind::Authorization);
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn download_refreshes_api_token_error_and_preserves_archive_body() {
        let (url, server) =
            server(vec![(400, r#"{"code":99991668}"#), (200, "archive-bytes")]).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = download(
            |token| client.get(&url).bearer_auth(token),
            "old".into(),
            |_| async { Ok("new".into()) },
            &crate::backup::jobs::idle_context(),
        )
        .await
        .unwrap();
        assert_eq!(response.text().await.unwrap(), "archive-bytes");
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].contains("Bearer new"));
    }
}
