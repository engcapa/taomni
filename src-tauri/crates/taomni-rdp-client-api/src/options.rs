use serde::{Deserialize, Serialize};

/// Configuration parsed out of `SessionConfig.options_json` for an RDP
/// session. Mirrors the TS-side `RdpOptions` in `src/types/rdp.ts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[serde(default = "default_nla")]
    pub nla: bool,
    /// Optional SHA-256 pin for a self-signed/private-CA RDP certificate.
    /// System trust is always attempted first.
    #[serde(default)]
    pub certificate_fingerprint: Option<String>,
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

fn default_color_depth() -> u8 {
    32
}
fn default_screen_w() -> u16 {
    1920
}
fn default_screen_h() -> u16 {
    1080
}
fn default_nla() -> bool {
    true
}
fn default_true() -> bool {
    true
}
fn default_audio_mode() -> String {
    "play".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceFlags {
    #[serde(default)]
    pub wallpaper: bool,
    #[serde(default)]
    pub themes: bool,
    #[serde(default = "default_true")]
    pub font_smooth: bool,
    #[serde(default = "default_true")]
    pub disable_full_window_drag: bool,
    #[serde(default = "default_true")]
    pub disable_menu_animations: bool,
    #[serde(default = "default_true")]
    pub disable_cursor_shadow: bool,
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
        if !self.wallpaper {
            m |= 0x0000_0001;
        } // PERF_DISABLE_WALLPAPER
        if !self.font_smooth {
            m |= 0x0000_0080;
        } // PERF_DISABLE_FONT_SMOOTHING (sense inverted in spec)
        if self.disable_full_window_drag {
            m |= 0x0000_0002;
        }
        if self.disable_menu_animations {
            m |= 0x0000_0004;
        }
        if !self.themes {
            m |= 0x0000_0008;
        } // PERF_DISABLE_THEMING
        if self.disable_cursor_shadow {
            m |= 0x0000_0020;
        }
        m
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveRedirectOpt {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub path: String,
    /// Expose the mapped directory without allowing the remote host to mutate it.
    #[serde(default = "default_true")]
    pub read_only: bool,
}

impl Default for DriveRedirectOpt {
    fn default() -> Self {
        Self {
            enabled: false,
            label: String::new(),
            path: String::new(),
            read_only: true,
        }
    }
}

impl RdpOptions {
    pub fn from_json(raw: Option<&str>) -> Self {
        let s = match raw {
            Some(s) if !s.trim().is_empty() => s,
            _ => return Self::default(),
        };
        match serde_json::from_str::<Self>(s) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("invalid RDP options_json: {}", e);
                Self::default()
            }
        }
    }
}

impl Default for RdpOptions {
    fn default() -> Self {
        Self {
            domain: None,
            color_depth: default_color_depth(),
            screen_w: default_screen_w(),
            screen_h: default_screen_h(),
            nla: default_nla(),
            certificate_fingerprint: None,
            performance: PerformanceFlags::default(),
            redirect_clipboard: default_true(),
            redirect_audio: default_audio_mode(),
            redirect_drive: DriveRedirectOpt::default(),
            gateway: None,
        }
    }
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
    /// Optional SHA-256 pin for the HTTPS certificate presented by RD Gateway.
    #[serde(default)]
    pub certificate_fingerprint: Option<String>,
}

fn default_gateway_port() -> u16 {
    443
}
fn default_gateway_auth() -> String {
    "ntlm".into()
}
