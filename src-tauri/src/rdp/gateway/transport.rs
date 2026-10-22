use super::authentication::build_ntlm_authenticate_authorization;
use super::authentication::build_ntlm_negotiate_message;
use super::authentication::current_ntlm_filetime;
use super::authentication::random_client_challenge;
use super::bootstrap::GatewayInitialPackets;
use super::bootstrap::RPC_HTTP_CONTENT_LENGTH;
use super::http::HttpResponseHead;
use super::http::build_basic_authorization;
use super::http::build_rpc_in_request_with_auth;
use super::http::build_rpc_out_request_with_auth;
use super::http::parse_http_response_head;
use super::http::www_authenticate_token;
use super::ntlm;
use crate::rdp::GatewayOpt;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpStream;
pub(super) type GatewayTlsStream = crate::rdp::tls::TlsStream<TcpStream>;

#[derive(Clone, Copy, Debug)]
pub(super) enum RpcHttpChannel {
    In,
    Out,
}

impl RpcHttpChannel {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::In => "RPC_IN_DATA",
            Self::Out => "RPC_OUT_DATA",
        }
    }

    pub(super) fn content_length(self, initial_packets: &GatewayInitialPackets) -> u64 {
        match self {
            Self::In => RPC_HTTP_CONTENT_LENGTH,
            Self::Out => initial_packets.conn_a1_pdu.len() as u64,
        }
    }

    pub(super) fn headers(
        self,
        initial_packets: &GatewayInitialPackets,
        authorization: Option<&str>,
    ) -> Vec<u8> {
        match self {
            Self::In => build_rpc_in_request_with_auth(
                &initial_packets.http_host,
                &initial_packets.rdg_path,
                self.content_length(initial_packets),
                None,
                authorization,
                Some(&initial_packets.session_id),
            ),
            Self::Out => build_rpc_out_request_with_auth(
                &initial_packets.http_host,
                &initial_packets.rdg_path,
                self.content_length(initial_packets),
                None,
                authorization,
                Some(&initial_packets.session_id),
            ),
        }
    }
}

pub(super) async fn connect_authenticated_rpc_channel(
    g: &GatewayOpt,
    initial_packets: &GatewayInitialPackets,
    channel: RpcHttpChannel,
) -> Result<GatewayTlsStream, String> {
    let mut stream = connect_gateway_tls(g).await?;
    match g.auth.as_str() {
        "basic" => {
            let authorization =
                build_basic_authorization(&g.username, g.password.as_deref().unwrap_or_default());
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&authorization)),
                channel,
            )
            .await?;
            let head = read_final_http_response_head_async(&mut stream).await?;
            ensure_http_success(&head, channel.label())?;
            Ok(stream)
        }
        "ntlm" => {
            let type1_message = build_ntlm_negotiate_message(&g.username);
            let type1 = format!("NTLM {}", B64.encode(&type1_message));
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&type1)),
                channel,
            )
            .await?;
            let mut head = read_final_http_response_head_async(&mut stream).await?;
            if (200..300).contains(&head.status_code) {
                return Ok(stream);
            }
            if head.status_code != 401 {
                ensure_http_success(&head, channel.label())?;
                return Ok(stream);
            }

            let mut challenge_token = www_authenticate_token(&head, "NTLM");
            drain_http_response_body(&mut stream, &head, channel.label()).await?;
            if challenge_token.as_deref().unwrap_or_default().is_empty() {
                write_rpc_http_headers(
                    &mut stream,
                    &channel.headers(initial_packets, Some(&type1)),
                    channel,
                )
                .await?;
                head = read_final_http_response_head_async(&mut stream).await?;
                if head.status_code != 401 {
                    ensure_http_success(&head, channel.label())?;
                    return Ok(stream);
                }
                challenge_token = www_authenticate_token(&head, "NTLM");
                drain_http_response_body(&mut stream, &head, channel.label()).await?;
            }

            let token = challenge_token.filter(|s| !s.is_empty()).ok_or_else(|| {
                format!(
                    "rdg http: {} 401 response did not include an NTLM challenge",
                    channel.label()
                )
            })?;
            let challenge_bytes = B64.decode(token.as_bytes()).map_err(|e| {
                format!(
                    "rdg http: {} NTLM challenge is not valid base64: {}",
                    channel.label(),
                    e
                )
            })?;
            let challenge = ntlm::parse_challenge(&challenge_bytes).map_err(|e| {
                format!(
                    "rdg http: {} NTLM challenge parse failed: {}",
                    channel.label(),
                    e
                )
            })?;
            let type3 = build_ntlm_authenticate_authorization(
                g,
                &type1_message,
                &challenge_bytes,
                &challenge,
                random_client_challenge(),
                current_ntlm_filetime()?,
            )?;
            write_rpc_http_headers(
                &mut stream,
                &channel.headers(initial_packets, Some(&type3)),
                channel,
            )
            .await?;
            let head = read_final_http_response_head_async(&mut stream).await?;
            ensure_http_success(&head, channel.label())?;
            Ok(stream)
        }
        other => Err(format!(
            "rdg: auth '{}' not supported (basic | ntlm)",
            other
        )),
    }
}

pub(super) async fn write_rpc_http_headers<S>(
    stream: &mut S,
    headers: &[u8],
    channel: RpcHttpChannel,
) -> Result<(), String>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(headers)
        .await
        .map_err(|e| format!("rdg: write {} headers: {}", channel.label(), e))
}

pub(super) async fn connect_gateway_tls(g: &GatewayOpt) -> Result<GatewayTlsStream, String> {
    let addr = format!("{}:{}", g.host.trim(), g.port);
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("rdg: connect {}: {}", addr, e))?;
    tcp.set_nodelay(true)
        .map_err(|e| format!("rdg: set TCP_NODELAY: {}", e))?;
    let verified = crate::rdp::tls::upgrade(
        tcp,
        g.host.trim(),
        g.port,
        g.certificate_fingerprint.as_deref(),
    )
    .await
    .map_err(|e| format!("rdg: TLS handshake with {}: {}", g.host.trim(), e))?;
    tracing::debug!(
        fingerprint = %verified.fingerprint,
        pinned = verified.used_pin,
        "RD Gateway certificate verified"
    );
    Ok(verified.stream)
}

pub(super) async fn read_final_http_response_head_async<S>(
    stream: &mut S,
) -> Result<HttpResponseHead, String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let head = read_http_response_head_async(stream).await?;
        if head.status_code != 100 {
            return Ok(head);
        }
    }
}

pub(super) async fn read_http_response_head_async<S>(
    stream: &mut S,
) -> Result<HttpResponseHead, String>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(1024);
    let mut one = [0u8; 1];
    loop {
        stream
            .read_exact(&mut one)
            .await
            .map_err(|e| format!("rdg http: read response head: {}", e))?;
        buf.push(one[0]);
        if buf.ends_with(b"\r\n\r\n") {
            let (head, _) = parse_http_response_head(&buf)?;
            return Ok(head);
        }
        if buf.len() > 64 * 1024 {
            return Err("rdg http: response head exceeds 64 KiB".into());
        }
    }
}

pub(super) fn ensure_http_success(head: &HttpResponseHead, channel: &str) -> Result<(), String> {
    if (200..300).contains(&head.status_code) {
        Ok(())
    } else {
        Err(format!(
            "rdg http: {} failed with HTTP {} {}",
            channel, head.status_code, head.reason
        ))
    }
}

pub(super) async fn drain_http_response_body<S>(
    stream: &mut S,
    head: &HttpResponseHead,
    channel: &str,
) -> Result<(), String>
where
    S: AsyncRead + Unpin,
{
    if head
        .header("Transfer-Encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        return drain_chunked_http_body(stream, channel).await;
    }

    let len = match head.header("Content-Length") {
        Some(raw) => raw.parse::<usize>().map_err(|e| {
            format!(
                "rdg http: {} invalid Content-Length '{}': {}",
                channel, raw, e
            )
        })?,
        None => 0,
    };

    let mut remaining = len;
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let n = remaining.min(buf.len());
        stream
            .read_exact(&mut buf[..n])
            .await
            .map_err(|e| format!("rdg http: {} drain response body: {}", channel, e))?;
        remaining -= n;
    }
    Ok(())
}

pub(super) async fn drain_chunked_http_body<S>(stream: &mut S, channel: &str) -> Result<(), String>
where
    S: AsyncRead + Unpin,
{
    loop {
        let line = read_http_line_async(stream).await?;
        let size_text = line
            .split_once(';')
            .map(|(size, _)| size)
            .unwrap_or(line.as_str())
            .trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|e| {
            format!(
                "rdg http: {} invalid chunk size '{}': {}",
                channel, size_text, e
            )
        })?;
        if size == 0 {
            loop {
                let trailer = read_http_line_async(stream).await?;
                if trailer.is_empty() {
                    return Ok(());
                }
            }
        }
        let mut remaining = size + 2; // chunk data plus trailing CRLF.
        let mut buf = [0u8; 4096];
        while remaining > 0 {
            let n = remaining.min(buf.len());
            stream
                .read_exact(&mut buf[..n])
                .await
                .map_err(|e| format!("rdg http: {} drain chunked body: {}", channel, e))?;
            remaining -= n;
        }
    }
}

pub(super) async fn read_http_line_async<S>(stream: &mut S) -> Result<String, String>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(128);
    let mut one = [0u8; 1];
    loop {
        stream
            .read_exact(&mut one)
            .await
            .map_err(|e| format!("rdg http: read line: {}", e))?;
        buf.push(one[0]);
        if buf.ends_with(b"\r\n") {
            buf.truncate(buf.len() - 2);
            return String::from_utf8(buf)
                .map_err(|e| format!("rdg http: line is not UTF-8: {}", e));
        }
        if buf.len() > 8192 {
            return Err("rdg http: line exceeds 8 KiB".into());
        }
    }
}
