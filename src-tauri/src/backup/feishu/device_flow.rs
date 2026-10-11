//! Only the registration/device OAuth protocol needed by backups.
//! Adapted from larksuite/cli v1.0.97 internal/auth (MIT).
//! Copyright (c) 2026 Lark Technologies Pte. Ltd. See resources/licenses/lark-cli-MIT.txt.
use crate::backup::{credentials::ConnectionSecrets, model::now_ms, network};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub const SCOPES: &str = "offline_access drive:file:upload drive:file:download drive:drive.metadata:readonly space:folder:create space:document:retrieve";
pub const CANCELLED: &str = "Feishu authorization cancelled";
pub const EXPIRED: &str = "Feishu authorization expired; connect again";

pub struct FlowClient {
    client: Client,
    registration: String,
    authorization: String,
    token: String,
    user_info: String,
}
pub struct Challenge {
    pub verification_url: String,
    pub user_code: String,
    device_code: Zeroizing<String>,
    deadline: tokio::time::Instant,
    interval: u64,
}
pub struct RegisteredApp {
    pub id: String,
    pub secret: Zeroizing<String>,
}
pub struct UserIdentity {
    pub open_id: String,
    pub name: String,
    pub tenant_key: String,
}

impl FlowClient {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            registration: "https://accounts.feishu.cn/oauth/v1/app/registration".into(),
            authorization: "https://accounts.feishu.cn/oauth/v1/device_authorization".into(),
            token: "https://open.feishu.cn/open-apis/authen/v2/oauth/token".into(),
            user_info: "https://open.feishu.cn/open-apis/authen/v1/user_info".into(),
        }
    }
    pub async fn begin_registration(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Challenge, String> {
        let (status, value) = response(
            self.client.post(&self.registration).form(&[
                ("action", "begin"),
                ("archetype", "PersonalAgent"),
                ("auth_method", "client_secret"),
                ("request_user_info", "open_id tenant_brand"),
            ]),
            cancel,
        )
        .await?;
        checked(status, &value)?;
        challenge(&value, true)
    }
    pub async fn begin_authorization(
        &self,
        id: &str,
        secret: &str,
        cancel: &CancellationToken,
    ) -> Result<Challenge, String> {
        let (status, value) = response(
            self.client
                .post(&self.authorization)
                .basic_auth(id, Some(secret))
                .form(&[("client_id", id), ("scope", SCOPES)]),
            cancel,
        )
        .await?;
        checked(status, &value)?;
        challenge(&value, false)
    }
    pub async fn registered(
        &self,
        challenge: &Challenge,
        cancel: &CancellationToken,
    ) -> Result<RegisteredApp, String> {
        let mut interval = challenge.interval;
        let mut first = true;
        loop {
            if !first {
                before_deadline(challenge.deadline, wait(interval, cancel)).await?;
            }
            first = false;
            let request = self.client.post(&self.registration).form(&[
                ("action", "poll"),
                ("device_code", challenge.device_code.as_str()),
            ]);
            let (status, value) =
                before_deadline(challenge.deadline, response(request, cancel)).await?;
            if value["user_info"]["tenant_brand"]
                .as_str()
                .is_some_and(|s| s != "feishu" && !s.is_empty())
            {
                return Err("This account requires international Lark; Feishu backups currently support feishu.cn".into());
            }
            if poll_status(status, &value, &mut interval)? {
                continue;
            }
            let id = value["client_id"].as_str().unwrap_or_default();
            let secret = value["client_secret"].as_str().unwrap_or_default();
            if id.is_empty() || secret.is_empty() {
                continue;
            }
            if !super::cli_config::valid_app_id(id) {
                return Err("Feishu returned an invalid application identifier".into());
            }
            return Ok(RegisteredApp {
                id: id.into(),
                secret: Zeroizing::new(secret.into()),
            });
        }
    }
    pub async fn authorized(
        &self,
        id: &str,
        secret: &str,
        challenge: &Challenge,
        cancel: &CancellationToken,
    ) -> Result<ConnectionSecrets, String> {
        let mut interval = challenge.interval;
        loop {
            before_deadline(challenge.deadline, wait(interval, cancel)).await?;
            let request = self.client.post(&self.token).form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", id),
                ("client_secret", secret),
                ("device_code", challenge.device_code.as_str()),
            ]);
            let (status, value) =
                before_deadline(challenge.deadline, response(request, cancel)).await?;
            if poll_status(status, &value, &mut interval)? {
                continue;
            }
            return token_bundle(&value, None);
        }
    }
    pub async fn identity(
        &self,
        bearer: &str,
        cancel: &CancellationToken,
    ) -> Result<UserIdentity, String> {
        let (status, value) =
            response(self.client.get(&self.user_info).bearer_auth(bearer), cancel).await?;
        checked(status, &value)?;
        let data = &value["data"];
        let open_id = data["open_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Feishu did not return the authorized user's identity")?;
        Ok(UserIdentity {
            open_id: open_id.into(),
            name: data["name"].as_str().unwrap_or_default().into(),
            tenant_key: data["tenant_key"].as_str().unwrap_or_default().into(),
        })
    }
    pub async fn refresh(
        &self,
        id: &str,
        stored: &ConnectionSecrets,
        cancel: &CancellationToken,
    ) -> Result<ConnectionSecrets, (String, bool)> {
        let request=self.client.post(&self.token).json(&serde_json::json!({"grant_type":"refresh_token","client_id":id,"client_secret":stored.app_secret,"refresh_token":stored.refresh_token}));
        let (status, value) = response(request, cancel).await.map_err(|error| {
            let uncertain = !error.starts_with("Cannot connect to backup service");
            (error, uncertain)
        })?;
        if let Err(error) = checked(status, &value) {
            // A definitive service rejection (including rate limit) did not issue tokens.
            return Err((error, false));
        }
        if value["code"].as_i64() != Some(0) {
            return Err((
                "Feishu refresh response omitted its success code".into(),
                true,
            ));
        }
        token_bundle(&value, Some(stored)).map_err(|error| (error, true))
    }
}

async fn response(
    request: RequestBuilder,
    cancel: &CancellationToken,
) -> Result<(StatusCode, Value), String> {
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(CANCELLED.into()),
        result=tokio::time::timeout(Duration::from_secs(30),async {
            let mut response=request.send().await.map_err(network::network_error)?;
            let status=response.status();
            let mut bytes=Zeroizing::new(Vec::new());
            while let Some(chunk)=response.chunk().await.map_err(network::network_error)? {
                if bytes.len()+chunk.len()>1024*1024 {return Err("Feishu authentication response exceeds the size limit".into());}
                bytes.extend_from_slice(&chunk);
            }
            let value=serde_json::from_slice(&bytes).map_err(|_|"Invalid Feishu authentication response")?;
            Ok((status,value))
        })=>result.map_err(|_|"Feishu authentication request timed out; check the selected proxy")?,
    }
}
pub fn validate_verification_url(url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid Feishu browser authorization URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !matches!(
            (url.host_str(), url.path()),
            (Some("accounts.feishu.cn"), "/oauth/v1/device/verify")
                | (Some("open.feishu.cn"), "/page/cli")
        )
    {
        return Err("Feishu returned an untrusted browser authorization URL".into());
    }
    Ok(())
}
fn challenge(value: &Value, registration: bool) -> Result<Challenge, String> {
    let code = value["device_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 8192)
        .ok_or("Feishu did not return a valid device code")?;
    let user_code = value["user_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 256)
        .ok_or("Feishu did not return a valid browser verification code")?;
    let verification_url = if registration {
        let mut url = reqwest::Url::parse("https://open.feishu.cn/page/cli").unwrap();
        url.query_pairs_mut().append_pair("user_code", user_code);
        url.to_string()
    } else {
        value["verification_uri_complete"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| value["verification_uri"].as_str())
            .ok_or("Feishu did not return a browser authorization URL")?
            .into()
    };
    validate_verification_url(&verification_url)?;
    let seconds = value["expire_in"]
        .as_u64()
        .filter(|n| *n > 0)
        .or_else(|| value["expires_in"].as_u64().filter(|n| *n > 0))
        .unwrap_or(if registration { 600 } else { 240 })
        .min(3600);
    let interval = value["interval"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(5)
        .min(60);
    Ok(Challenge {
        verification_url,
        user_code: user_code.into(),
        device_code: Zeroizing::new(code.into()),
        deadline: tokio::time::Instant::now() + Duration::from_secs(seconds),
        interval,
    })
}
fn checked(status: StatusCode, value: &Value) -> Result<(), String> {
    if status.is_success()
        && value.get("error").is_none()
        && value["code"].as_i64().unwrap_or(0) == 0
    {
        return Ok(());
    }
    // Do not include server descriptions: they can echo credentials or codes.
    Err(match value["error"].as_str().unwrap_or_default() {
        "invalid_client"=>"Feishu application credentials are invalid; reconnect the same application after repairing its credentials".into(),
        "invalid_scope"=>"Feishu rejected required backup permissions; check application availability and reconnect".into(),
        "access_denied"=>"Feishu authorization was declined".into(),
        "expired_token"|"invalid_grant"=>EXPIRED.into(),
        _=>format!("Feishu authentication failed (HTTP {}, code {}); reconnect or check account restrictions",status.as_u16(),value["code"].as_i64().unwrap_or(-1)),
    })
}
fn poll_status(status: StatusCode, value: &Value, interval: &mut u64) -> Result<bool, String> {
    match value["error"].as_str().unwrap_or_default() {
        "authorization_pending" => Ok(true),
        "slow_down" => {
            *interval = (*interval + 5).min(60);
            Ok(true)
        }
        _ => {
            checked(status, value)?;
            Ok(false)
        }
    }
}
async fn wait(seconds: u64, cancel: &CancellationToken) -> Result<(), String> {
    tokio::select! {biased;_=cancel.cancelled()=>Err(CANCELLED.into()),_=tokio::time::sleep(Duration::from_secs(seconds))=>Ok(())}
}
async fn before_deadline<T>(
    deadline: tokio::time::Instant,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| EXPIRED.to_string())?
}
pub fn missing_scopes(scope: &str) -> Vec<&'static str> {
    let granted: std::collections::HashSet<_> = scope.split_whitespace().collect();
    SCOPES
        .split_whitespace()
        .filter(|s| !granted.contains(s))
        .collect()
}
fn token_bundle(
    value: &Value,
    previous: Option<&ConnectionSecrets>,
) -> Result<ConnectionSecrets, String> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Feishu token response has no access token; reconnect")?;
    let refresh = value["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            previous
                .map(|p| p.refresh_token.as_str())
                .filter(|s| !s.is_empty())
        })
        .ok_or("Feishu did not grant offline_access; authorize all backup permissions")?;
    let scope = value["scope"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| previous.map(|p| p.granted_scopes.as_str()))
        .unwrap_or_default();
    let missing = missing_scopes(scope);
    if !missing.is_empty() {
        return Err(format!(
            "Feishu did not confirm required permissions: {}. Authorize all backup permissions",
            missing.join(", ")
        ));
    }
    let expires = value["expires_in"]
        .as_i64()
        .filter(|n| *n > 0)
        .unwrap_or(7200)
        .min(86400);
    let refresh_expires_at = value["refresh_token_expires_in"]
        .as_i64()
        .filter(|n| *n > 0)
        .map(|n| now_ms() + n.min(365 * 86400) * 1000)
        .or_else(|| previous.map(|p| p.refresh_expires_at))
        .unwrap_or(now_ms() + 604800 * 1000);
    Ok(ConnectionSecrets {
        app_id: String::new(),
        app_secret: String::new(),
        access_token: access.into(),
        refresh_token: refresh.into(),
        expires_at: now_ms() + expires * 1000,
        refresh_expires_at,
        granted_scopes: scope.into(),
        generation: previous.map(|p| p.generation + 1).unwrap_or(1),
        refresh_in_flight: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_are_sets_and_urls_are_official() {
        assert!(missing_scopes(SCOPES).is_empty());
        assert!(!missing_scopes(&format!("{SCOPES}x")).is_empty());
        for url in [
            "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=fixture",
            "https://open.feishu.cn/page/cli?user_code=fixture",
        ] {
            assert!(validate_verification_url(url).is_ok());
        }
        for url in [
            "http://accounts.feishu.cn/oauth/v1/device/verify",
            "https://accounts.feishu.cn.evil.test/oauth/v1/device/verify",
            "https://open.feishu.cn/anything",
            "https://evil@accounts.feishu.cn/oauth/v1/device/verify",
        ] {
            assert!(validate_verification_url(url).is_err());
        }
        let mut interval = 5;
        assert!(
            poll_status(
                StatusCode::BAD_REQUEST,
                &serde_json::json!({"error":"slow_down"}),
                &mut interval
            )
            .unwrap()
        );
        assert_eq!(interval, 10);
        assert_eq!(
            poll_status(
                StatusCode::BAD_REQUEST,
                &serde_json::json!({"error":"expired_token"}),
                &mut interval
            )
            .unwrap_err(),
            EXPIRED
        );
    }
    #[test]
    fn refresh_retains_scope_and_initial_auth_requires_it() {
        let value =
            serde_json::json!({"access_token":"fixture","refresh_token":"new","expires_in":3600});
        assert!(token_bundle(&value, None).is_err());
        let mut old = ConnectionSecrets::default();
        old.granted_scopes = SCOPES.into();
        old.generation = 4;
        old.refresh_expires_at = now_ms() + 100_000;
        let refreshed = token_bundle(&value, Some(&old)).unwrap();
        assert_eq!(refreshed.generation, 5);
        assert_eq!(refreshed.refresh_expires_at, old.refresh_expires_at);
    }
    #[tokio::test]
    async fn cancelled_request_and_poll_expiry_stop_activity() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let client = FlowClient::new(Client::builder().no_proxy().build().unwrap());
        assert_eq!(
            client.begin_registration(&cancel).await.err().unwrap(),
            CANCELLED
        );
        let challenge = Challenge {
            verification_url: String::new(),
            user_code: String::new(),
            device_code: Zeroizing::new("fixture".into()),
            deadline: tokio::time::Instant::now(),
            interval: 5,
        };
        assert_eq!(
            client
                .authorized(
                    "cli_fixture",
                    "secret",
                    &challenge,
                    &CancellationToken::new()
                )
                .await
                .err()
                .unwrap(),
            EXPIRED
        );
    }
    #[tokio::test]
    async fn real_http_device_protocol_uses_basic_full_scopes_and_form_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            for body in [
                serde_json::json!({"device_code":"fixture","user_code":"CODE","verification_uri_complete":"https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=fixture","interval":1}),
                serde_json::json!({"access_token":"access","refresh_token":"refresh","scope":SCOPES,"expires_in":7200}),
                serde_json::json!({"code":0,"data":{"open_id":"ou_fixture","name":"Test","tenant_key":"tenant"}}),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = vec![];
                let mut buf = [0; 4096];
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(start) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&data[..start]).to_lowercase();
                        let len = header
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= start + 4 + len {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(data).unwrap());
                let body = body.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            }
            requests
        });
        let mut client = FlowClient::new(Client::builder().no_proxy().build().unwrap());
        client.authorization = format!("http://{addr}/device");
        client.token = format!("http://{addr}/token");
        client.user_info = format!("http://{addr}/user");
        let cancel = CancellationToken::new();
        let challenge = client
            .begin_authorization("cli_fixture", "secret", &cancel)
            .await
            .unwrap();
        let tokens = client
            .authorized("cli_fixture", "secret", &challenge, &cancel)
            .await
            .unwrap();
        assert_eq!(
            client
                .identity(&tokens.access_token, &cancel)
                .await
                .unwrap()
                .open_id,
            "ou_fixture"
        );
        let requests = server.await.unwrap();
        assert!(requests[0].to_lowercase().contains("authorization: basic "));
        assert!(requests[0].contains("drive%3Afile%3Aupload"));
        assert!(
            requests[1]
                .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
        );
        assert!(requests[1].contains("client_secret=secret"));
        assert!(
            requests[2]
                .to_lowercase()
                .contains("authorization: bearer access")
        );
    }
}
