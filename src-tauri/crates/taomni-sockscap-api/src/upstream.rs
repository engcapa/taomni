use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpstreamKind {
    // Native Rust dialers (no external core needed).
    Http,
    Socks5,
    Ssh,
    // xray-core–backed protocols. Each is realized by spawning a bundled
    // xray-core process with a local SOCKS inbound + a protocol outbound; the
    // relay then dials that local SOCKS port through the existing socks5 egress.
    // SSR is intentionally omitted — modern cores dropped it and it is obsolete.
    Shadowsocks,
    Trojan,
    Vmess,
    Vless,
    Wireguard,
}

impl Default for UpstreamKind {
    fn default() -> Self {
        Self::Http
    }
}

impl UpstreamKind {
    /// Protocols realized by spawning the bundled xray-core sidecar rather than
    /// a native in-process dialer.
    pub fn requires_core(self) -> bool {
        matches!(
            self,
            Self::Shadowsocks | Self::Trojan | Self::Vmess | Self::Vless | Self::Wireguard
        )
    }

    /// Lowercase tag used in commands / xray outbound `protocol` fields.
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Socks5 => "socks5",
            Self::Ssh => "ssh",
            Self::Shadowsocks => "shadowsocks",
            Self::Trojan => "trojan",
            Self::Vmess => "vmess",
            Self::Vless => "vless",
            Self::Wireguard => "wireguard",
        }
    }
}

/// Protocol-specific upstream parameters.
///
/// Flat + all-defaulted so old configs (which never wrote this object)
/// deserialize cleanly, and so a single struct covers every xray protocol
/// without a serde-tagged enum churn. Only the fields relevant to the selected
/// [`UpstreamKind`] are read by the xray config generator; the rest stay at
/// their defaults. Secrets (password / uuid / private key / pre-shared key) are
/// carried as `vault:<id>` references in [`UpstreamRef::password_ref`] and the
/// `*_ref` fields here — never plaintext on disk.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamParams {
    // --- Shadowsocks ---
    /// AEAD cipher, e.g. `aes-256-gcm`, `chacha20-ietf-poly1305`, `2022-blake3-aes-256-gcm`.
    #[serde(default)]
    pub method: String,

    // --- VMess / VLESS ---
    /// `vault:<id>` reference for the client UUID (never plaintext on disk).
    #[serde(default)]
    pub uuid_ref: String,
    /// VMess encryption security, e.g. `auto`, `aes-128-gcm`, `none`.
    #[serde(default)]
    pub security: String,
    /// VLESS flow control, e.g. `xtls-rprx-vision` (empty = none).
    #[serde(default)]
    pub flow: String,
    /// VLESS encryption (usually `none`).
    #[serde(default)]
    pub encryption: String,

    // --- Transport (shared by trojan/vmess/vless) ---
    /// `tcp` | `ws` | `grpc` | `http` | `httpupgrade` (empty = tcp).
    #[serde(default)]
    pub network: String,
    /// WebSocket / HTTPUpgrade path or gRPC serviceName.
    #[serde(default)]
    pub path: String,
    /// WebSocket / HTTP Host header (empty = use SNI/host).
    #[serde(default)]
    pub ws_host: String,

    // --- TLS / REALITY ---
    /// `none` | `tls` | `reality` (empty = none).
    #[serde(default)]
    pub tls: String,
    /// TLS SNI / server name (empty = upstream host).
    #[serde(default)]
    pub sni: String,
    /// ALPN list, e.g. ["h2","http/1.1"].
    #[serde(default)]
    pub alpn: Vec<String>,
    /// uTLS fingerprint, e.g. `chrome`.
    #[serde(default)]
    pub fingerprint: String,
    /// Skip TLS cert verification (insecure; user opt-in).
    #[serde(default)]
    pub allow_insecure: bool,
    /// REALITY public key.
    #[serde(default)]
    pub reality_public_key: String,
    /// REALITY short id.
    #[serde(default)]
    pub reality_short_id: String,

    // --- WireGuard ---
    /// `vault:<id>` reference for the local private key.
    #[serde(default)]
    pub private_key_ref: String,
    /// Peer public key.
    #[serde(default)]
    pub peer_public_key: String,
    /// `vault:<id>` reference for the optional pre-shared key.
    #[serde(default)]
    pub pre_shared_key_ref: String,
    /// Local tunnel addresses (e.g. ["10.0.0.2/32"]).
    #[serde(default)]
    pub local_address: Vec<String>,
    /// Interface MTU (0 = xray default).
    #[serde(default)]
    pub mtu: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRef {
    pub kind: UpstreamKind,
    /// When set, resolve host/port/auth from a saved Proxy or SSH session.
    #[serde(default)]
    pub session_id: String,
    /// Manual fields (used when `session_id` is empty).
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// `vault:<id>` only — never plaintext on disk. For xray protocols this is
    /// the primary secret (SS password / trojan password); protocol-specific
    /// secrets (uuid, wg keys) live in [`UpstreamParams`] as their own refs.
    #[serde(default)]
    pub password_ref: String,
    /// Protocol-specific parameters (only meaningful for xray-core kinds).
    #[serde(default)]
    pub params: UpstreamParams,
}
