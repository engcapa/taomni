//! RDP (Remote Desktop Protocol) client and WebSocket relay.
//!
//! This module mirrors the VNC architecture (`crate::vnc`):
//!
//! - The Tauri command `rdp_connect` opens a transport (direct TCP, HTTP/SOCKS5
//!   proxy via [`crate::terminal::network::establish_transport`], or RD
//!   Gateway), performs the X.224 / RDP Negotiation handshake, and binds a
//!   loopback WebSocket the frontend canvas connects to.
//! - The relay (`ws.rs`) bridges WS frames from the canvas to RDP fast-path
//!   input PDUs and back, multiplexing display, audio, clipboard, and drive
//!   redirection over a single tagged binary frame format.
//! - Virtual channels live in `cliprdr.rs`, `rdpsnd.rs`, and `rdpdr.rs`.
//! - RD Gateway's MS-TSGU transport (RPC-over-HTTPS twin-channel) lives in
//!   `gateway.rs`.
//!
//! The first cut focuses on *correct framing and codecs* — every PDU encoder /
//! decoder in this module ships with round-trip unit tests. Wire-level
//! integration with a real Windows host happens behind the same WS protocol,
//! so the canvas does not need to know which transport carried the bytes.

pub mod cliprdr;
pub mod frame;
pub mod gateway;
pub mod input;
pub mod pdu;
pub mod rdpdr;
pub mod rdpsnd;
pub mod rfx;
pub mod session;
pub mod transport;
pub mod ws;

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;
use crate::terminal::network::NetworkSettings;
use crate::vault::Vault;
use crate::rdp::ws::{spawn_rdp_relay, RdpControl, RdpSpawnConfig};

/// Configuration parsed out of `SessionConfig.options_json` for an RDP
/// session. Mirrors the TS-side `RdpOptions` in `src/types/rdp.ts`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOptions {
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default = "default_color_depth")]
    pub color_depth: u8,
    #[serde(default = "default_screen_w")]
    pub screen_w: u16,
    #[serde(default = "default_screen_h")]
    pub screen_h: u16,
    #[serde(default = "default_true")]
    pub nla: bool,
    #[serde(default)]
    pub performance: PerformanceFlags,
    #[serde(default = "default_true")]
    pub redirect_clipboard: bool,
    #[serde(default = "default_audio_mode")]
    pub redirect_audio: String, // "play" | "off"
    #[serde(default)]
    pub redirect_drive: DriveRedirectOpt,
    #[serde(default)]
    pub gateway: Option<GatewayOpt>,
}

fn default_color_depth() -> u8 { 32 }
fn default_screen_w() -> u16 { 1920 }
fn default_screen_h() -> u16 { 1080 }
fn default_true() -> bool { true }
fn default_audio_mode() -> String { "play".into() }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceFlags {
    #[serde(default)] pub wallpaper: bool,
    #[serde(default)] pub themes: bool,
    #[serde(default = "default_true")] pub font_smooth: bool,
    #[serde(default = "default_true")] pub disable_full_window_drag: bool,
    #[serde(default = "default_true")] pub disable_menu_animations: bool,
    #[serde(default = "default_true")] pub disable_cursor_shadow: bool,
}

impl Default for PerformanceFlags {
    fn default() -> Self {
        Self {
            wallpaper: false,
            themes: false,
            font_smooth: true,
            disable_full_window_drag: true,
            disable_menu_animations: true,
            disable_cursor_shadow: true,
        }
    }
}

impl PerformanceFlags {
    /// Encode to the `performanceFlags` bitmask documented in MS-RDPBCGR
    /// 2.2.1.11.1.1.1 (TS_EXTENDED_INFO_PACKET.performanceFlags).
    pub fn to_bitmask(&self) -> u32 {
        let mut m = 0u32;
        if !self.wallpaper { m |= 0x0000_0001; } // PERF_DISABLE_WALLPAPER
        if !self.font_smooth { m |= 0x0000_0080; } // PERF_DISABLE_FONT_SMOOTHING (sense inverted in spec)
        if self.disable_full_window_drag { m |= 0x0000_0002; }
        if self.disable_menu_animations { m |= 0x0000_0004; }
        if !self.themes { m |= 0x0000_0008; } // PERF_DISABLE_THEMING
        if self.disable_cursor_shadow { m |= 0x0000_0020; }
        m
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRedirectOpt {
    #[serde(default)] pub enabled: bool,
    #[serde(default)] pub label: String,
    #[serde(default)] pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayOpt {
    pub host: String,
    #[serde(default = "default_gateway_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_gateway_auth")]
    pub auth: String, // "basic" | "ntlm"
    #[serde(default = "default_true")]
    pub use_session_creds: bool,
}

fn default_gateway_port() -> u16 { 443 }
fn default_gateway_auth() -> String { "ntlm".into() }

impl RdpOptions {
    pub fn from_json(raw: Option<&str>) -> Self {
        let s = match raw { Some(s) if !s.trim().is_empty() => s, _ => return Self::default() };
        match serde_json::from_str::<Self>(s) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("invalid RDP options_json: {}", e);
                Self::default()
            }
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RdpConnectResult {
    pub session_id: String,
    pub ws_port: u16,
}

/// Resolve a possibly-vault-referenced secret. Mirrors the helper used by
/// `vnc_connect`. Errors map to `VAULT_LOCKED` strings the UI already handles.
fn resolve_secret(vault: &Vault, value: Option<&str>) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match vault.resolve(v)? {
            Some(plain) => Ok(Some((*plain).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn rdp_connect(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<RdpConnectResult, String> {
    let session_id = Uuid::new_v4().to_string();

    let resolved_password = resolve_secret(&state.vault, password.as_deref())?;
    let mut options = RdpOptions::from_json(options_json.as_deref());
    if let Some(g) = options.gateway.as_mut() {
        if let Some(p) = g.password.as_deref() {
            if let Some(plain) = state.vault.resolve(p)? {
                g.password = Some((*plain).clone());
            }
        }
    }
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    if let Some(n) = network.as_mut() {
        n.resolve_proxy_pass(&state.vault)?;
    }

    let session = spawn_rdp_relay(RdpSpawnConfig {
        host,
        port,
        username,
        password: resolved_password,
        options,
        network,
    })
    .await?;

    let result = RdpConnectResult {
        session_id: session_id.clone(),
        ws_port: session.ws_port,
    };

    let mut sessions = state.rdp_sessions.write().await;
    sessions.insert(session_id, session);
    Ok(result)
}

#[tauri::command]
pub async fn rdp_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.rdp_sessions.write().await;
    if let Some(s) = sessions.remove(&session_id) {
        let _ = s.control_tx.send(RdpControl::Disconnect);
        s.cancel.cancel();
    }
    Ok(())
}

/// Run a transport-level handshake (X.224 + RDP Negotiation) without spawning
/// the relay. Used by the SessionEditor "Test connection" button.
#[tauri::command]
pub async fn rdp_test_connection(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    options_json: Option<String>,
    network_settings_json: Option<String>,
) -> Result<String, String> {
    let _ = (username, password); // reserved for full NLA test in step 2.

    let mut options = RdpOptions::from_json(options_json.as_deref());
    if let Some(g) = options.gateway.as_mut() {
        if let Some(p) = g.password.as_deref() {
            if let Some(plain) = state.vault.resolve(p)? {
                g.password = Some((*plain).clone());
            }
        }
    }
    let mut network = NetworkSettings::from_json(network_settings_json.as_deref());
    if let Some(n) = network.as_mut() {
        n.resolve_proxy_pass(&state.vault)?;
    }

    let mut stream =
        transport::open_transport(&host, port, network.as_ref(), options.gateway.as_ref()).await?;
    let neg = pdu::nego::negotiate_request(&options);
    pdu::nego::send_negotiation(&mut stream, &neg).await?;
    let resp = pdu::nego::recv_negotiation(&mut stream).await?;
    Ok(format!(
        "RDP negotiation OK — selected protocol={}, flags=0x{:02x}",
        resp.selected_protocol_label(),
        resp.flags
    ))
}
