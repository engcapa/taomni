use crate::rdp::RdpOptions;
use crate::rdp::input::KeyEvent;
use crate::rdp::input::PointerEvent;
use crate::rdp::input::PointerWheelEvent;
use crate::terminal::network::NetworkSettings;
use serde::Deserialize;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub enum RdpControl {
    Key(KeyEvent),
    UnicodeText(String),
    ReleaseInput,
    Pointer(PointerEvent),
    Wheel(PointerWheelEvent),
    Resize {
        width: u16,
        height: u16,
    },
    /// Ask the server to redraw the whole desktop (TS_REFRESH_RECT_PDU).
    Refresh,
    ClipboardOffer {
        formats: u32,
    },
    ClipboardData {
        format: u32,
        data: Vec<u8>,
    },
    ClipboardFiles {
        paths: Vec<String>,
    },
    Ack,
    Disconnect,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum WsIncomingText {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "ack")]
    Ack,
    #[serde(rename = "clipboard")]
    Clipboard { text: String },
    #[serde(rename = "clipboard_files")]
    ClipboardFiles { paths: Vec<String> },
    #[serde(rename = "unicode")]
    Unicode { text: String },
    #[serde(rename = "release_input")]
    ReleaseInput,
    #[serde(rename = "resize")]
    Resize { width: u16, height: u16 },
    #[serde(rename = "refresh")]
    Refresh,
    #[serde(rename = "disconnect")]
    Disconnect,
}

pub struct RdpSession {
    pub control_tx: UnboundedSender<RdpControl>,
    pub ws_port: u16,
    pub ws_token: String,
    pub cancel: CancellationToken,
}

pub struct RdpSpawnConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub options: RdpOptions,
    pub network: Option<NetworkSettings>,
}
