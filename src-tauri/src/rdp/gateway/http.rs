use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
// ── HTTP request line builders ─────────────────────────────────────────

/// Build the HTTP/1.1 request line + minimum headers for an RPC_IN_DATA
/// channel. Returns the bytes ready to append to a TLS stream.
pub fn build_rpc_in_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_IN_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization: None,
        session_id: None,
    })
}

pub fn build_rpc_out_request(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_OUT_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization: None,
        session_id: None,
    })
}

pub fn build_rpc_in_request_with_auth(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
    authorization: Option<&str>,
    session_id: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_IN_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization,
        session_id,
    })
}

pub fn build_rpc_out_request_with_auth(
    host: &str,
    rdg_path: &str,
    content_length: u64,
    cookie: Option<&str>,
    authorization: Option<&str>,
    session_id: Option<&str>,
) -> Vec<u8> {
    build_rpc_request_line(RpcHttpRequest {
        method: "RPC_OUT_DATA",
        host,
        rdg_path,
        content_length,
        cookie,
        authorization,
        session_id,
    })
}

#[derive(Debug, Clone, Copy)]
pub(super) struct RpcHttpRequest<'a> {
    pub(super) method: &'a str,
    pub(super) host: &'a str,
    pub(super) rdg_path: &'a str,
    pub(super) content_length: u64,
    pub(super) cookie: Option<&'a str>,
    pub(super) authorization: Option<&'a str>,
    pub(super) session_id: Option<&'a str>,
}

pub(super) fn build_rpc_request_line(req: RpcHttpRequest<'_>) -> Vec<u8> {
    let mut s = String::new();
    s.push_str(&format!("{} {} HTTP/1.1\r\n", req.method, req.rdg_path));
    s.push_str(&format!("Host: {}\r\n", req.host));
    s.push_str("Cache-Control: no-cache\r\n");
    s.push_str("Connection: Keep-Alive\r\n");
    s.push_str("Pragma: no-cache\r\n");
    if let Some(session_id) = req.session_id {
        s.push_str(&format!(
            "Pragma: ResourceTypeUuid=44e265dd-7daf-42cd-8560-3cdb6e7a2729, SessionId={}\r\n",
            session_id
        ));
    }
    s.push_str("Accept: application/rpc\r\n");
    s.push_str("Content-Type: application/rpc\r\n");
    s.push_str("User-Agent: MSRPC\r\n");
    s.push_str("Protocol: 1.0\r\n");
    s.push_str(&format!("Content-Length: {}\r\n", req.content_length));
    if let Some(a) = req.authorization {
        s.push_str(&format!("Authorization: {}\r\n", a));
    }
    if let Some(c) = req.cookie {
        s.push_str(&format!("Cookie: {}\r\n", c));
    }
    s.push_str("\r\n");
    s.into_bytes()
}

pub fn build_basic_authorization(username: &str, password: &str) -> String {
    format!("Basic {}", B64.encode(format!("{}:{}", username, password)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponseHead {
    pub status_code: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
}

impl HttpResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn headers_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers
            .iter()
            .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub fn parse_http_response_head(buf: &[u8]) -> Result<(HttpResponseHead, usize), String> {
    let end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .ok_or_else(|| "rdg http: response headers are incomplete".to_string())?;
    let text = std::str::from_utf8(&buf[..end])
        .map_err(|e| format!("rdg http: response headers are not UTF-8: {}", e))?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .ok_or_else(|| "rdg http: missing status line".to_string())?;
    let mut parts = status.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        return Err(format!("rdg http: invalid status line '{}'", status));
    }
    let code = parts
        .next()
        .ok_or_else(|| format!("rdg http: missing status code in '{}'", status))?
        .parse::<u16>()
        .map_err(|e| format!("rdg http: invalid status code in '{}': {}", status, e))?;
    let reason = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(format!("rdg http: malformed header '{}'", line));
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok((
        HttpResponseHead {
            status_code: code,
            reason,
            headers,
        },
        end,
    ))
}

pub fn www_authenticate_token(head: &HttpResponseHead, scheme: &str) -> Option<String> {
    for value in head.headers_named("WWW-Authenticate") {
        for part in value.split(',') {
            let trimmed = part.trim();
            if trimmed.eq_ignore_ascii_case(scheme) {
                return Some(String::new());
            }
            if trimmed.len() > scheme.len()
                && trimmed[..scheme.len()].eq_ignore_ascii_case(scheme)
                && trimmed.as_bytes().get(scheme.len()) == Some(&b' ')
            {
                return Some(trimmed[scheme.len() + 1..].trim().to_string());
            }
        }
    }
    None
}
