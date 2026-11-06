use super::{config::Config, protocol::Frame};
use crate::proxy::ResolvedProxy;
use futures::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use zeroize::Zeroizing;

pub type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct Token {
    value: Zeroizing<String>,
    expires: Instant,
}
#[derive(Clone)]
pub struct Network {
    pub client: reqwest::Client,
    pub config: Config,
    secret: Arc<Zeroizing<String>>,
    proxy: Option<ResolvedProxy>,
    token: Arc<Mutex<Option<Token>>>,
    pub(super) base: String,
}
impl Network {
    pub fn new(
        config: Config,
        secret: Zeroizing<String>,
        proxy: Option<ResolvedProxy>,
    ) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(15));
        if let Some(p) = &proxy {
            builder = builder.proxy(
                reqwest::Proxy::all(p.to_url().replacen("socks5://", "socks5h://", 1))
                    .map_err(|_| "invalid_proxy")?,
            );
        }
        Ok(Self {
            client: builder.build().map_err(|_| "feishu_client_failed")?,
            config,
            secret: Arc::new(secret),
            proxy,
            token: Arc::new(Mutex::new(None)),
            base: "https://open.feishu.cn".into(),
        })
    }
    async fn post(&self, route: &str, body: &Value, token: Option<&str>) -> Result<Value, String> {
        let mut req = self.client.post(format!("{}{route}", self.base)).json(body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let mut response = req
            .send()
            .await
            .map_err(|_| "feishu_network_failed_check_proxy")?;
        if !response.status().is_success() {
            return Err(format!("feishu_http_{}", response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "feishu_response_failed")?
        {
            if bytes.len() + chunk.len() > 512 * 1024 {
                return Err("feishu_response_too_large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "feishu_invalid_response")?;
        match value["code"].as_i64() {
            Some(0) => Ok(value),
            Some(code) => Err(format!("feishu_api_{code}")),
            _ => Err("feishu_invalid_response".into()),
        }
    }
    async fn token(&self) -> Result<Zeroizing<String>, String> {
        let mut slot = self.token.lock().await;
        if let Some(t) = slot.as_ref().filter(|t| t.expires > Instant::now()) {
            return Ok(t.value.clone());
        }
        let value = self
            .post(
                "/open-apis/auth/v3/tenant_access_token/internal",
                &json!({"app_id":self.config.app_id,"app_secret":self.secret.as_str()}),
                None,
            )
            .await?;
        let token = value["tenant_access_token"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("feishu_invalid_token")?;
        let seconds = value["expire"]
            .as_u64()
            .filter(|v| *v > 60)
            .ok_or("feishu_invalid_token_expiry")?;
        let value = Zeroizing::new(token.to_owned());
        *slot = Some(Token {
            value: value.clone(),
            expires: Instant::now() + Duration::from_secs(seconds.min(7200) - 60),
        });
        Ok(value)
    }
    pub async fn send(
        &self,
        chat: &str,
        kind: &str,
        content: &Value,
        uuid: &str,
    ) -> Result<(), String> {
        let token = self.token().await?;
        let result = self
            .post(
                "/open-apis/im/v1/messages?receive_id_type=chat_id",
                &json!({"receive_id":chat,
            "msg_type":kind,"content":content.to_string(),"uuid":uuid}),
                Some(token.as_str()),
            )
            .await;
        // Expired/invalid tenant tokens are refreshed on the next bounded retry.
        if result.as_ref().is_err_and(|e| {
            matches!(
                e.as_str(),
                "feishu_api_99991663" | "feishu_api_99991664" | "feishu_api_99991668"
            )
        }) {
            *self.token.lock().await = None;
        }
        result.map(|_| ())
    }
    pub async fn connect(&self) -> Result<(Socket, i32, Duration), String> {
        let value = self
            .post(
                "/callback/ws/endpoint",
                &json!({"AppID":self.config.app_id,"AppSecret":self.secret.as_str()}),
                None,
            )
            .await?;
        let raw = value["data"]["URL"]
            .as_str()
            .ok_or("feishu_missing_ws_endpoint")?;
        let url = url::Url::parse(raw).map_err(|_| "feishu_invalid_ws_endpoint")?;
        let host = url.host_str().ok_or("feishu_invalid_ws_endpoint")?;
        let secure = url.scheme() == "wss" && (host == "feishu.cn" || host.ends_with(".feishu.cn"));
        #[cfg(test)]
        let secure = secure
            || (self.base.starts_with("http://127.0.0.1:")
                && host == "127.0.0.1"
                && url.scheme() == "ws");
        if !secure || !url.username().is_empty() || url.password().is_some() {
            return Err("feishu_untrusted_ws_endpoint".into());
        }
        let service = url
            .query_pairs()
            .find(|(k, _)| k == "service_id")
            .and_then(|(_, v)| v.parse::<i32>().ok())
            .ok_or("feishu_missing_service_id")?;
        let proxy = self
            .proxy
            .as_ref()
            .map(|p| crate::terminal::network::NetworkSettings {
                proxy_kind: p.kind.clone(),
                proxy_host: p.host.clone(),
                proxy_port: p.port,
                proxy_user: p.username.clone(),
                proxy_pass: p.password.clone(),
                ip_version: "auto".into(),
                tcp_nodelay: true,
                ..Default::default()
            });
        let connection = async {
            let stream = crate::terminal::network::establish_transport(
                host,
                url.port_or_known_default().ok_or("feishu_invalid_port")?,
                proxy.as_ref(),
            )
            .await
            .map_err(|_| "feishu_ws_network_failed_check_proxy")?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(512 * 1024))
                .max_frame_size(Some(512 * 1024));
            tokio_tungstenite::client_async_tls_with_config(raw, stream, Some(config), None)
                .await
                .map_err(|_| "feishu_ws_handshake_failed")
        };
        let (socket, _) = tokio::time::timeout(Duration::from_secs(20), connection)
            .await
            .map_err(|_| "feishu_ws_connect_timeout")??;
        let ping = value["data"]["ClientConfig"]["PingInterval"]
            .as_u64()
            .unwrap_or(120)
            .clamp(1, 300);
        Ok((socket, service, Duration::from_secs(ping)))
    }
}
pub async fn write(socket: &mut Socket, frame: Frame) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Binary(frame.encode_to_vec().into())),
    )
    .await
    .map_err(|_| "feishu_ws_write_timeout")?
    .map_err(|_| "feishu_ws_write_failed".into())
}
pub async fn read(socket: &mut Socket) -> Result<Frame, String> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Binary(v))) => {
                return Frame::decode(v).map_err(|_| "feishu_invalid_frame".into());
            }
            Some(Ok(Message::Ping(v))) => socket
                .send(Message::Pong(v))
                .await
                .map_err(|_| "feishu_ws_write_failed")?,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                return Err("feishu_ws_disconnected".into());
            }
            _ => {}
        }
    }
}
