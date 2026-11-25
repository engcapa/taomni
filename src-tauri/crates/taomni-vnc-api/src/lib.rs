//! Shared connection requests and desktop-owned transport for the VNC host.

pub mod error;
pub mod forward;
pub mod policy;
pub mod quality;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{
    forward::ForwardRoute,
    policy::{VncClipboardPolicy, VncSecurityPolicy},
    quality::VncPictureQuality,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionRequest {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub forward: Option<ForwardRoute>,
    #[serde(default)]
    pub security_policy: VncSecurityPolicy,
    #[serde(default)]
    pub clipboard_policy: VncClipboardPolicy,
    #[serde(default)]
    pub picture_quality: VncPictureQuality,
    #[serde(default)]
    pub view_only: bool,
    pub shared: Option<bool>,
    #[serde(default)]
    pub allow_unencrypted: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Started {
    pub session_id: String,
    pub ws_port: u16,
    pub ws_token: String,
}
